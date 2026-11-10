import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from '../i18n/i18n.ts'
import {
  IDENTITY,
  SpatialGrid,
  centerOf,
  centerOn,
  clampPan,
  fitToView,
  isWorldPointVisible,
  matchNodes,
  panBy,
  pinchViewport,
  screenToWorld,
  searchSummary,
  traceFrom,
  zoomBy,
  type Point,
  type Size,
  type Viewport,
} from './viewport.ts'
import {
  DRAG_THRESHOLD,
  EDGE_WIDTH_MAX,
  NODE_HEIGHT,
  NODE_WIDTH,
  VIEWPORT_HEIGHT_NARROW,
  VIEWPORT_HEIGHT_WIDE,
  buildNodeIndex,
  colorOf,
  directionalCandidate,
  degreeTally,
  edgeColor,
  edgeCurvatures,
  edgeDetailOf,
  edgeGeometry,
  edgeWidthOf,
  filterGraph,
  graphBounds,
  hitNodesOf,
  kHopNeighborhood,
  kindCounts,
  layoutPositionsOf,
  linkRangeHops,
  neighborsOf,
  degreeOf,
  shapePath,
  withLayout,
  zoomLabel,
  type ColorMode,
  type LayoutMode,
  type LinkRange,
} from './graph-model.ts'
// 小地图几何在 minimap-model.ts（v0.12 拆分：graph-model 的复杂度热点越预算）。
import {
  minimapNodeRects,
  minimapProjection,
  minimapViewportRect,
  minimapToWorld,
  type MinimapCanvas,
} from './minimap-model.ts'
import { EdgeDetails, GraphDetails, GraphMinimap, GraphToolbar, GraphTooltip, edgeKindKey } from './GraphParts.tsx'
import type { GraphData, GraphNode } from '../../shared/graph-contract.ts'

/**
 * 小地图画布尺寸（模块级常量，而不是每次渲染新建对象）。
 *
 * 为什么钉成常量：小地图的视口框尺寸**就是**它的比例尺 —— 每次渲染都换
 * 一个新对象会让 useMemo 的依赖抖动（虽然值相同），更重要的是窄形态
 * 下面板宽度不足时，152px 会顶掉图谱本身，所以由形态决定档位。
 */
const MINIMAP_CANVAS: MinimapCanvas = { width: 152, height: 96 }
const MINIMAP_CANVAS_NARROW: MinimapCanvas = { width: 112, height: 72 }

/**
 * 搜索结果下拉的初始行数（**渲染层**截断）。
 *
 * 为什么与「回车循环的范围」必须是两个数：此前 matchNodes 的 limit=8 同时
 * 扮演这两个角色，于是匹配 20 个时第 9~20 个既看不见也跳不到，而指示器
 * 报的总数还是 8 —— 一句假陈述。显示截断见 GraphParts（带展开按钮），
 * 循环范围用全量（见 locateMatchNext）。
 */
const SEARCH_RESULTS_INITIAL = 8

/**
 * 可交互图谱 —— 能力之间的生产/消费关系。
 *
 * ## 交互契约（全部可由鼠标与键盘完成）
 *
 * 1. **滚轮缩放以指针为锚**：指针下的图坐标保持不动（见 viewport.zoomAt 的推导）。
 * 2. **每次视口变化都过 `clampPan`**：图永远不会被拖到找不回来的地方 ——
 *    没有手势能救回一块拖出屏幕的图，那是死锁不只是不美观。
 * 3. **fit 只做一次**（`fittedRef` 守卫）：数据轮询会让 `nodes` 引用变化，
 *    若每次都重新 fit，用户刚调好的缩放会被重置 —— 这是 CLAUDE.md 写的铁律。
 *    **显式切换布局**是用户意图，允许重新 fit（走 `layoutEpoch`，与轮询无关）；
 *    容器尺寸变化则只重新**钳制平移**，不动缩放（铁律优先于美观）。
 * 4. **点击与拖拽区分**：位移累计小于 `DRAG_THRESHOLD` 才算点击；节点上的按下
 *    是「拖节点」、空白处是「拖画布」，两者互不抢事件（节点侧 stopPropagation）。
 * 5. **单击选中、双击居中**：单击只改高亮（轻量探索），双击才移动视野（明确意图）。
 * 6. **Esc 一次退出全部观察态**（高亮 + 搜索 + 悬停）：只清一半会让人以为键没生效。
 * 7. **选中状态由面板持有**（受控 `focusId`）：面板的能力清单要跟着点亮同一行，
 *    选中态必须只有一个真相源（组件内部自持就做不到联动）。
 *
 * ## 性能契约
 *
 * `id→node` 索引每个数组只建一次（useMemo）；派生计算全在 `graph-model.ts`
 * 的纯函数里，边的几何（裁剪 + 曲线 + 标签锚点）一次算清 —— 此前控制点被
 * 算两次，标签锚点会随参数漂移离开曲线。
 *
 * ## 可访问性
 *
 * - 每个节点是 `role="button"` + `aria-label` + `aria-pressed`，可 Tab 聚焦、回车选中。
 * - 颜色不是唯一通道：节点带形状、文字标签与计数。
 * - 悬停浮层是纯装饰（`aria-hidden`），完整信息另有 `<title>` 与详情侧栏承载。
 */
export interface GuardGraphProps {
  graph: GraphData
  /** 视口高度（窄形态由面板传入更矮的值）。 */
  height?: number
  /** 选中的节点（受控：面板与图谱共用同一份选中态）。 */
  focusId: string | null
  onFocusChange: (id: string | null) => void
  /**
   * 面板发起的「请居中到这个节点」请求。
   *
   * 为什么要一个显式的 nonce 而不是只传 id：同一个节点被再次点击时
   * id 没变，effect 不会重跑 —— 用户会以为按钮失灵。nonce 让每次请求
   * 都是新事实（图谱不需要知道是谁发的）。
   */
  locateRequest?: { id: string; nonce: number } | null
}

export function GuardGraph({ graph, height = VIEWPORT_HEIGHT_WIDE, focusId, onFocusChange, locateRequest = null }: GuardGraphProps): ReactElement {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY)
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** 悬停/选中的边（v0.11.3：边此前完全不可交互）。 */
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [size, setSize] = useState<Size>({ width: 0, height })
  const [query, setQuery] = useState('')
  // 搜索遍历游标（v0.11）：回车在匹配列表里循环前进；查询变化时归零。
  const [matchIndex, setMatchIndex] = useState(0)
  /** 搜索结果列表的展开态（截断只在渲染层，展开按钮见 GraphParts）。
   *  与 query/matchIndex 声明在一起：它和这两者属于**同一件事**（这次搜索），
   *  分散在两处会让「查询变化要重置哪些状态」这个问题只在一半的地方被回答。 */
  const [showAllResults, setShowAllResults] = useState(false)
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('layered')
  const [colorMode, setColorMode] = useState<ColorMode>('tone')
  const [onlyConnected, setOnlyConnected] = useState(false)
  /**
   * 「只看关联 / 聚焦」的跳数档位（v0.11.5）。
   *
   * 为什么缺省 1 跳而不是闭包：此前聚焦态的高亮集是**传递闭包**
   * （`traceFrom`），在一连通图上等于全图 —— 于是「选中节点」什么都不改变，
   * 用户以为点击没生效。1 跳才是「直接相关」的默认含义，闭包留给显式档位。
   */
  const [linkRange, setLinkRange] = useState<LinkRange>('hops1')
  /** 小地图开关（概览导航）。缺省开：缩到 0.25 时没有参照物就是「迷失」本身。 */
  const [minimapVisible, setMinimapVisible] = useState(true)
  // 布局切换的显式计数：只有用户点「布局」才允许重新 fit（铁律：轮询不得重置缩放）。
  const [layoutEpoch, setLayoutEpoch] = useState(0)
  // 触摸/笔指针的快照（v0.11.4）：两个指针同时按下即进入捏合缩放。
  const pointersRef = useRef(new Map<number, Point>())
  const pinchPrevRef = useRef<{ a: Point; b: Point } | null>(null)
  // 节点拖拽的布局偏移（世界坐标）：键 = 节点 id。只在用户拖动后出现，
  // 数据轮询不会重置它 —— 布局是用户的调整，不是轮询的产物。
  const [offsets, setOffsets] = useState<Record<string, Point>>({})
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ active: boolean; moved: boolean; x: number; y: number }>({
    active: false,
    moved: false,
    x: 0,
    y: 0,
  })
  const nodeDragRef = useRef<{ id: string; moved: boolean; x: number; y: number } | null>(null)
  // 拖动结束后的第一次 click 必须被吞掉：pointerup 在 click 之前发生，
  // 若不在这里记录「刚拖过」，单击选择会被拖拽误触发。
  const suppressClickRef = useRef(false)
  const fittedRef = useRef(false)
  /** 已处理的面板居中请求序号（nonce 去重，见 GuardGraphProps.locateRequest）。 */
  const lastLocateNonceRef = useRef(0)

  const counts = useMemo(() => kindCounts(graph.nodes), [graph.nodes])

  // 布局投影（分层 = 宿主给的确定性坐标；环形 = 客户端闭式坐标）。
  const positions = useMemo(() => layoutPositionsOf(graph.nodes, layoutMode), [graph.nodes, layoutMode])
  const positionedNodes = useMemo(() => withLayout(graph.nodes, positions, offsets), [graph.nodes, positions, offsets])

  // 过滤（隐藏类型 + 只看关联）与边集**一次成型**：节点集与边集必须同源，
  // 否则图上会出现指向被隐藏节点的箭头。
  const view = useMemo(
    () =>
      filterGraph(positionedNodes, graph.edges, {
        hidden,
        onlyConnectedWith: onlyConnected ? focusId : null,
        maxHops: linkRangeHops(linkRange),
      }),
    [positionedNodes, graph.edges, hidden, onlyConnected, focusId, linkRange],
  )
  const visibleNodes = view.nodes
  const visibleEdges = view.edges

  const nodeById = useMemo(() => buildNodeIndex(visibleNodes), [visibleNodes])
  const positionedById = useMemo(() => buildNodeIndex(positionedNodes), [positionedNodes])
  const grid = useMemo(() => new SpatialGrid(hitNodesOf(visibleNodes)), [visibleNodes])
  const bounds = useMemo(() => graphBounds(visibleNodes), [visibleNodes])
  const curvatures = useMemo(() => edgeCurvatures(visibleEdges), [visibleEdges])
  const stageOfColumn = useMemo(() => {
    const map = new Map<number, string>()
    for (const column of graph.columns) map.set(column.index, column.stage ?? '')
    return map
  }, [graph.columns])

  const apply = useCallback(
    (next: Viewport): void => {
      setViewport(clampPan(next, size, bounds))
    },
    [size, bounds],
  )

  // 测量容器尺寸（真实像素首次渲染后才可用）。
  useEffect(() => {
    const measure = (): void => {
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      setSize({ width: rect.width, height })
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null
    if (observer && wrapRef.current) observer.observe(wrapRef.current)
    return () => observer?.disconnect()
  }, [height])

  // 首次 fit：只做一次（fittedRef 守卫），数据轮询不重置用户的缩放。
  useEffect(() => {
    if (fittedRef.current) return
    if (size.width === 0) return
    fittedRef.current = true
    setViewport(clampPan(fitToView(bounds, size), size, bounds))
    // bounds 仅在首次 fit 时读取（size 就绪那一刻）；此后由用户交互驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  /**
   * 尺寸变化只重新钳制平移、**不动缩放**。
   *
   * 为什么与「切布局重 fit」区别对待：容器变宽变窄是环境事实（拖窗口、折叠侧栏），
   * 用户的缩放意图仍然有效；重新 fit 会把它抹掉 —— 那正是铁律要防的事。
   */
  useEffect(() => {
    if (!fittedRef.current) return
    setViewport((current) => clampPan(current, size, bounds))
  }, [size, bounds])

  // 显式切换布局：整张图换了投影，旧视口大概率对着空白，这时重 fit 才是对的。
  useEffect(() => {
    if (layoutEpoch === 0 || !fittedRef.current) return
    setViewport(clampPan(fitToView(bounds, size), size, bounds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutEpoch])

  const doFit = useCallback((): void => {
    setViewport(clampPan(fitToView(bounds, size), size, bounds))
  }, [bounds, size])

  const doZoom = useCallback(
    (factor: number): void => {
      apply(zoomBy(viewport, centerOf(size), factor))
    },
    [apply, viewport, size],
  )

  const onWheel = useCallback(
    (event: { preventDefault?: () => void; clientX: number; clientY: number; deltaY: number }): void => {
      event.preventDefault?.()
      const rect = wrapRef.current?.getBoundingClientRect()
      const anchor = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
      apply(zoomBy(viewport, anchor, event.deltaY < 0 ? 1.15 : 1 / 1.15))
    },
    [apply, viewport],
  )

  /**
   * 滚轮：**普通滚轮滚动页面，Ctrl/⌘ + 滚轮缩放图谱。**
   *
   * 为什么不用 React 的 `onWheel`：React 17+ 把 wheel 挂在 root 上且是
   * **passive** 的，`event.preventDefault()` 被浏览器忽略（控制台报
   * "Unable to preventDefault inside passive event listener invocation"）。
   *
   * 为什么普通滚轮不再缩放：面板内容很长（实测约 4000px），而宿主槽位只有
   * 一屏高。滚轮一旦被图谱吞掉，用户把指针移到图上就**再也滚不到下方数据**——
   * 这是比"少一个手势"严重得多的可用性缺陷。图谱的放大/缩小/适应在工具栏
   * 一直是按钮形态（rg-graph-zoom），所以缩放并没有失去入口，只是主手势让位。
   * Ctrl/⌘ + 滚轮既符合地图/画布类界面的通行约定，也顺便压掉了浏览器缩放。
   */
  const wheelHandlerRef = useRef(onWheel)
  wheelHandlerRef.current = onWheel
  useEffect(() => {
    const host = wrapRef.current
    if (host === null) return undefined
    const listener = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      wheelHandlerRef.current(event)
    }
    host.addEventListener('wheel', listener, { passive: false })
    return () => host.removeEventListener('wheel', listener)
  }, [])

  const onPointerDown = useCallback((event: { pointerId?: number; clientX: number; clientY: number }): void => {
    // 节点上的按下已在节点侧 stopPropagation，走到这里的一定是画布空白。
    const id = event.pointerId ?? 0
    pointersRef.current.set(id, { x: event.clientX, y: event.clientY })
    // v0.11.4：两个指针同时在场 ⇒ 进入捏合缩放，取消本次平移拖拽。
    if (pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()]
      pinchPrevRef.current = { a: a ?? { x: 0, y: 0 }, b: b ?? { x: 0, y: 0 } }
      dragRef.current = { active: false, moved: false, x: 0, y: 0 }
      return
    }
    suppressClickRef.current = false
    dragRef.current = { active: true, moved: false, x: event.clientX, y: event.clientY }
  }, [])

  const onPointerMove = useCallback(
    (event: { pointerId?: number; clientX: number; clientY: number }): void => {
      // 优先级 0（v0.11.4）：双指捏合 —— 中点世界点在缩放中不动，中点位移平移画布。
      const id = event.pointerId ?? 0
      if (pointersRef.current.has(id)) pointersRef.current.set(id, { x: event.clientX, y: event.clientY })
      if (pointersRef.current.size >= 2 && pinchPrevRef.current !== null) {
        const [a, b] = [...pointersRef.current.values()]
        const next = { a: a ?? { x: 0, y: 0 }, b: b ?? { x: 0, y: 0 } }
        const prev = pinchPrevRef.current
        setViewport((current) => clampPan(pinchViewport(current, prev, next), size, bounds))
        pinchPrevRef.current = next
        return
      }
      // 优先级 1：正在拖节点 —— 位移换算成世界坐标增量写入偏移。
      const nodeDrag = nodeDragRef.current
      if (nodeDrag !== null) {
        const dx = event.clientX - nodeDrag.x
        const dy = event.clientY - nodeDrag.y
        if (!nodeDrag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
        nodeDrag.moved = true
        nodeDrag.x = event.clientX
        nodeDrag.y = event.clientY
        // 屏幕 1px = 世界 1/scale；scale 用当前视口（拖动中不变）。
        const scale = viewport.scale
        setOffsets((current) => {
          const prior = current[nodeDrag.id] ?? { x: 0, y: 0 }
          return { ...current, [nodeDrag.id]: { x: prior.x + dx / scale, y: prior.y + dy / scale } }
        })
        return
      }
      // 优先级 2：拖画布平移。
      const drag = dragRef.current
      if (!drag.active) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      // 位移不足阈值时不算拖拽 —— 否则节点上的点击会被拖拽吃掉。
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
      drag.moved = true
      drag.x = event.clientX
      drag.y = event.clientY
      // 函数式更新：连续 pointermove 必须在同一 tick 里累加，
      // 用闭包里的旧值会「拖得越快越跟不上手」。
      setViewport((current) => clampPan(panBy(current, dx, dy), size, bounds))
    },
    [viewport.scale, size, bounds],
  )

  const onPointerUp = useCallback((event?: { pointerId?: number }): void => {
    // v0.11.4：移除抬起的指针；捏合结束时清空快照（下一次两指重新取样）。
    pointersRef.current.delete(event?.pointerId ?? 0)
    if (pointersRef.current.size < 2) pinchPrevRef.current = null
    if (nodeDragRef.current !== null && nodeDragRef.current.moved) suppressClickRef.current = true
    nodeDragRef.current = null
    dragRef.current = { active: false, moved: false, x: 0, y: 0 }
  }, [])

  const onNodePointerDown = useCallback(
    (event: { clientX: number; clientY: number; stopPropagation: () => void }, nodeId: string): void => {
      // 拖节点而不是拖画布：拦截事件，画布的 pan 不得启动。
      event.stopPropagation()
      suppressClickRef.current = false
      nodeDragRef.current = { id: nodeId, moved: false, x: event.clientX, y: event.clientY }
    },
    [],
  )

  const onClick = useCallback(
    (event: { clientX: number; clientY: number }): void => {
      if (dragRef.current.moved || suppressClickRef.current) return
      const rect = wrapRef.current?.getBoundingClientRect()
      const world = screenToWorld(viewport, {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      })
      const hit = grid.hit(world)
      onFocusChange(hit === null ? null : hit.id)
      // 空白处点击 = 清空边选中（单一选中态：节点与边互斥）。
      if (hit === null) setSelectedEdgeId(null)
    },
    [grid, viewport, onFocusChange],
  )

  const centreOfNode = useCallback(
    (node: GraphNode): Point => ({ x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 }),
    [],
  )

  /** 双击节点：视口居中到该节点（明确意图才移动视野，单击只改高亮）。 */
  const onNodeDoubleClick = useCallback(
    (node: GraphNode): void => {
      apply(centerOn(viewport, size, centreOfNode(node)))
      onFocusChange(node.id)
    },
    [apply, viewport, size, centreOfNode, onFocusChange],
  )

  /** 搜索结果 / 邻居 / 「居中定位」 → 定位：居中 + 选中 + 清搜索框。 */
  const locateNode = useCallback(
    (nodeId: string): void => {
      const node = positionedById.get(nodeId)
      if (!node) return
      apply(centerOn(viewport, size, centreOfNode(node)))
      onFocusChange(nodeId)
      setQuery('')
      setMatchIndex(0)
    },
    [apply, viewport, size, positionedById, centreOfNode, onFocusChange],
  )

  /**
   * 回车循环跳转（v0.11）：游标 +1 取模 → 定位到下一个匹配。
   * matches 变化（输入变了）时游标归零由下面的 effect 负责 ——
   * 定位与归零分开写，避免「输入和跳转抢同一个 state 更新」。
   * （声明位置在 `matches` 之后 —— useCallback 依赖块级作用域变量。）
   */

  // 查询文本变化 ⇒ 游标归零（新搜索从第一个匹配开始）+ 收起结果列表。
  // 为什么收起也要一起：上一次搜索按了「展开全部 40 条」，换一个只有 2 个
  // 命中的词，那个展开态还留着 ⇒ 用户看到一个空的「展开」按钮和一个
  // 比命中数还长的列表容器。视图状态属于**这一次**搜索。
  useEffect(() => {
    setMatchIndex(0)
    setShowAllResults(false)
  }, [query])

  /** 面板发起的居中请求：nonce 变化才执行（同一个节点被再次请求也要真的居中）。 */
  useEffect(() => {
    if (locateRequest === null) return
    if (locateRequest.nonce === lastLocateNonceRef.current) return
    lastLocateNonceRef.current = locateRequest.nonce
    const node = positionedById.get(locateRequest.id)
    if (!node) return
    setViewport(clampPan(centerOn(viewport, size, centreOfNode(node)), size, bounds))
    // 只在请求（nonce）变化时执行；视口/边界取当次渲染的最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateRequest])

  // 高亮集：聚焦节点沿边双向追溯。**跳数由档位决定**（v0.11.5）。
  // 为什么不再是「至少 2 跳的 BFS 闭包」：闭包在一连通图上等于全图，
  // 于是选中节点什么都不改变（「点了没反应」的实测根源）。
  // BFS 的最少跳数正好是「直接相关」，缺省 1 跳才有可见的聚焦效果。
  const highlighted = useMemo(() => {
    if (focusId === null) return new Set<string>()
    const hops = linkRangeHops(linkRange)
    return hops === null ? traceFrom(focusId, visibleEdges, 'both') : kHopNeighborhood(focusId, visibleEdges, hops)
  }, [focusId, visibleEdges, linkRange])

  /**
   * 边宽的事实源：一次遍历全边的度数表。
   *
   * 为什么不能按边调 `degreeOf`：那是 O(V·E)（本仓库已在孤立判定上踩过一次）。
   * 也为什么不直接用 `node.weight`：weight 只投影了「是否暴露」（0/1），
   * 用它做视觉编码等于把「暴露」和「连接度」塞进同一个通道 —— 这里要的是度数。
   * 刻度的参考上界是**常量**（`EDGE_DEGREE_SUM_MAX`），不随当前数据变化：
   * 相对刻度会让轮询改变所有既有边的视觉含义。
   */
  const edgeDegrees = useMemo(() => degreeTally(visibleEdges), [visibleEdges])

  /**
   * 小地图：投影 + 节点矩形 + 视口框。
   *
   * 为什么在模型层算而不是在 GraphMinimap 里算：小地图与主视口必须共用
   * **同一个 bounds**（`graphBounds(visibleNodes)`）。若小地图自己再算一遍
   * 边界，主图上被拖拽偏移的节点不会同步（偏移是视图事实），框就会
   * 与真实视野错位 —— 一个「说谎的指南针」比没有指南针更糟。
   *
   * 画布尺寸按**视口高度**选档：窄形态（侧栏/分屏，340px）挂一块 152×96
   * 会吃掉近三分之一画面，参照物反而遮住了要看的东西。
   */
  const minimapCanvas = height <= VIEWPORT_HEIGHT_NARROW ? MINIMAP_CANVAS_NARROW : MINIMAP_CANVAS
  const minimapProj = useMemo(() => minimapProjection(bounds, minimapCanvas), [bounds])
  const minimapRects = useMemo(
    () => minimapNodeRects(visibleNodes, minimapProj, (node) => colorOf(node, colorMode, (column) => stageOfColumn.get(column))),
    [visibleNodes, minimapProj, colorMode, stageOfColumn],
  )
  // 视口框只需 proj + viewport + size：画布尺寸已经进了 proj（figureWidth/Height），
  // 再传一次 canvas 会诱导「拿画布尺寸当阈值」的那个全览判定错误。
  const minimapView = useMemo(
    () => minimapViewportRect(minimapProj, viewport, size),
    [minimapProj, viewport, size],
  )
  /**
   * 选中节点在小地图里的方块。
   *
   * 为什么单独画：主画布一滚，选中节点就离开可见区 —— 那一刻用户唯一的
   * 问题是「我选的东西在哪」。小地图上的焦点环让这个问题**始终**有答案，
   * 而不需要先把视野调回去。
   */
  const minimapFocusRect = useMemo(() => {
    if (focusId === null) return null
    const rect = minimapRects.find((candidate) => candidate.id === focusId)
    return rect === undefined ? null : { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  }, [minimapRects, focusId])

  /**
   * 拖/点小地图 = 把该处的**世界点**放到主视口中心。
   *
   * 参数是小地图本地坐标（组件不该知道世界系），这里用闭式逆投影换算 ——
   * 正逆成对（worldToMinimap / minimapToWorld）才能被单测钉死往返误差。
   */
  const navigateFromMinimap = useCallback(
    (point: Point): void => {
      const world = minimapToWorld(minimapProj, point)
      apply(centerOn(viewport, size, world))
    },
    [apply, minimapProj, viewport, size],
  )

  /**
   * 方向键换焦点（v0.11.5 键盘可达性补齐）。
   *
   * 此前只有 Tab：60 个节点要按 60 次才走得完，且顺序是 DOM 顺序（= 布局列序），
   * 与屏幕上的位置毫无关系 —— 键盘用户根本「看不到」图的结构。
   * 方向键按**二维邻近**选下一个节点，走的是用户眼睛看到的网格。
   * 落点不可达时保持原焦点（返回 null 不 blur —— 把焦点丢回容器会让
   * 后续按键全部失效，用户以为键盘坏了）。
   */
  const moveFocusByArrow = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down'): void => {
      const nodes = visibleNodes.map((node) => ({ id: node.id, x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 }))
      if (nodes.length === 0) return
      const current = focusId === null ? undefined : positionedById.get(focusId)
      // 起点：已选中的节点；没有选中时以**当前视口中心**为原点 ——
      // 「从屏幕中心朝右找最近的」才是键盘用户在无选中状态下的直觉，
      // 用 nodes[0]（= 布局第一列第一个）会让第一次按键跳到看不见的地方。
      const centreWorld = {
        x: (size.width / 2 - viewport.tx) / viewport.scale,
        y: (size.height / 2 - viewport.ty) / viewport.scale,
      }
      const from = current ? { x: current.x + NODE_WIDTH / 2, y: current.y + NODE_HEIGHT / 2 } : centreWorld
      const targetId = directionalCandidate(from, direction, nodes)
      // 返回 null = 该方向到头了。焦点留在原地，**不 blur** ——
      // 把焦点丢回容器会让后续按键全部失效（用户会以为键盘坏了）。
      if (targetId === null) return
      onFocusChange(targetId)
      // 焦点是**DOM**焦点：选中态变了但焦点还在画布上，键盘用户会失去位置感。
      // 用 data 属性线性匹配而不是 CSS 选择器：能力 id 里全是 `.`（guard.observe），
      // CSS.escape 给出的是标识符转义（`guard\.observe`），放进属性值里**匹配不上**，
      // 这类「看起来对、实际选不中」的缺陷在浏览器里只会表现为「方向键时好时坏」。
      const host = wrapRef.current
      let element: Element | null = null
      if (host) {
        for (const candidate of host.querySelectorAll('[data-node-id]')) {
          if (candidate.getAttribute('data-node-id') === targetId) {
            element = candidate
            break
          }
        }
      }
      // SVG 元素的 focus() 在 lib.dom 里挂在 SVGElement 上，但 querySelectorAll
      // 返回的是 Element —— 显式窄化成「有 focus 方法的对象」而不是 as any，
      // 这样严格模式仍能查出其它误用。
      const focusable = element as (Element & { focus?: () => void }) | null
      focusable?.focus?.()
      // 只在目标**跑出可见区**时才移动视野：每次按键都居中会让画面一直跳，
      // 反而看不清「走到了哪」—— 键盘导航要的是连续性。判定在 viewport.ts
      // 里做纯函数（`isWorldPointVisible`），因此这条规则可单测而不是只能手点。
      const node = positionedById.get(targetId)
      if (node) {
        const centre = { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 }
        // 容差 = 半张卡片的屏幕宽度：节点中心离边缘不足半张卡 ⇒ 焦点环已被裁掉。
        const margin = (NODE_WIDTH * viewport.scale) / 2
        if (!isWorldPointVisible(viewport, size, centre, margin)) apply(centerOn(viewport, size, centre))
      }
    },
    [focusId, positionedById, visibleNodes, onFocusChange, apply, viewport, size],
  )

  // 搜索结果：**全量**命中 + 显示层切片 + 游标取模一次算清（searchSummary）。
  // 为什么不能像以前那样让 matchNodes 默认只给 8 条：那 8 条同时被当成
  // 「显示列表」和「回车循环的范围」，于是匹配 20 个时指示器说 1/8、
  // 剩下 12 个根本跳不到（数据层截断）。现在 total 来自全量，
  // 显示条数与循环范围各归各的源头，UI 不可能自相矛盾。
  const allMatches = useMemo(() => matchNodes(visibleNodes, query), [visibleNodes, query])
  const search = useMemo(
    () =>
      searchSummary(allMatches, showAllResults ? Number.POSITIVE_INFINITY : SEARCH_RESULTS_INITIAL, matchIndex),
    [allMatches, showAllResults, matchIndex],
  )
  const matches = search.visible

  /**
   * 画布键盘面（Esc / +−0 / 方向键）。
   *
   * 声明位置在 `moveFocusByArrow` **之后**：useCallback 的依赖数组要引用它，
   * 放在前面会拿到尚未初始化的块级变量（tsc 直接报 TDZ 错误，而不是运行时才炸）。
   */
  const onKeyDown = useCallback(
    (event: { key: string; preventDefault?: () => void }): void => {
      if (event.key === 'Escape') {
        event.preventDefault?.()
        onFocusChange(null)
        setQuery('')
        setHoverId(null)
        // v0.11.3：边选中也是观察态 —— Esc 一次退出全部（只清一半会让人以为键没生效）。
        setSelectedEdgeId(null)
        setHoverEdgeId(null)
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault?.()
        doZoom(1.15)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault?.()
        doZoom(1 / 1.15)
        return
      }
      if (event.key === '0') {
        event.preventDefault?.()
        doFit()
        return
      }
      // 方向键：在画布上按**二维邻近**换焦点（此前键盘只有 Tab 一条路）。
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault?.()
        moveFocusByArrow(event.key.slice(6).toLowerCase() as 'left' | 'right' | 'up' | 'down')
      }
    },
    [doZoom, doFit, onFocusChange, moveFocusByArrow],
  )

  /**
   * 回车循环跳转（v0.11，v0.11.5 修范围）：游标 +1 取模 → 定位到下一个匹配。
   *
   * 关键修正：循环范围从 `matches`（**显示**的前 8 条）改成 `search.all`
   * （全量命中）。此前匹配 20 个时，第 9~20 个根本跳不到，而指示器还显示
   * 「第 1/8 个」—— 那不是「少显示几条」，是「有些结果不存在」的假陈述。
   */
  const locateMatchNext = useCallback((): void => {
    const all = search.all
    if (all.length === 0) return
    const next = (search.cycleIndex + 1) % all.length
    setMatchIndex(next)
    const node = all[next]
    if (!node) return
    apply(centerOn(viewport, size, centreOfNode(node)))
    onFocusChange(node.id)
  }, [search, apply, viewport, size, centreOfNode, onFocusChange])
  // 画布上的命中描边用**全量**命中：下拉列表是「先显示几条」，而图上的
  // 虚线框回答的是「我的搜索结果都在哪」—— 只描前 8 个会让第 9 个结果
  // 在图上隐身（列表里也跳不到，用户会以为搜索没生效）。
  const matchIds = useMemo(() => new Set(search.all.map((node) => node.id)), [search.all])
  const focusNode = focusId === null ? undefined : nodeById.get(focusId)
  const focusDegree = useMemo(() => (focusId === null ? { in: 0, out: 0 } : degreeOf(focusId, visibleEdges)), [focusId, visibleEdges])
  const focusNeighbors = useMemo(
    () => (focusId === null ? { upstream: [], downstream: [] } : neighborsOf(focusId, visibleEdges, nodeById)),
    [focusId, visibleEdges, nodeById],
  )
  const labelOf = useCallback(
    (id: string): { label: string; tone: GraphNode['tone']; detail?: string } => {
      const node = nodeById.get(id)
      return node ? { label: node.label, tone: node.tone, detail: node.detail } : { label: id, tone: 'neutral' }
    },
    [nodeById],
  )

  /**
   * 选中边的详情投影（v0.11.3）。
   *
   * 用**可见节点索引**解析端点：类型过滤后不再可见的边不应留下「幽灵详情」。
   * 选中态与节点详情互斥：有节点聚焦时优先显示节点详情。
   */
  const selectedEdgeDetail = useMemo(() => {
    if (selectedEdgeId === null) return null
    const edge = visibleEdges.find((e) => e.id === selectedEdgeId)
    if (!edge) return null
    return edgeDetailOf(edge, nodeById)
  }, [selectedEdgeId, visibleEdges, nodeById])

  // 悬停浮层的屏幕坐标（节点顶部中央）。世界坐标 → 屏幕坐标用当前视口一次算清。
  const hoverNode = hoverId === null ? undefined : nodeById.get(hoverId)
  const tooltip = hoverNode
    ? {
        x: hoverNode.x * viewport.scale + viewport.tx + (NODE_WIDTH * viewport.scale) / 2,
        y: hoverNode.y * viewport.scale + viewport.ty - 8,
        node: hoverNode,
      }
    : null

  if (graph.nodes.length === 0) {
    return <p className="rg-empty">{t('graph.empty')}</p>
  }

  const selectedLabel = focusNode?.label ?? null

  return (
    <div className="rg-graph" data-recency-guard-graph="">
      <GraphToolbar
        layoutMode={layoutMode}
        onLayoutMode={(mode) => {
          if (mode === layoutMode) return
          setLayoutMode(mode)
          setLayoutEpoch((epoch) => epoch + 1)
        }}
        colorMode={colorMode}
        onColorMode={setColorMode}
        onZoom={doZoom}
        onFit={doFit}
        onReset={() => {
          onFocusChange(null)
          setQuery('')
          setHoverId(null)
          setHoverEdgeId(null)
          setSelectedEdgeId(null)
          // 拖拽偏移一并清零（v0.11）：「重置」若不还原用户拖乱的布局，
          // 节点拖飞后只能刷新页面 —— 那不是重置，是摆设。
          setOffsets({})
        }}
        canReset={focusId !== null || query !== '' || Object.keys(offsets).length > 0}
        query={query}
        onQuery={setQuery}
        matches={matches}
        matchTotal={search.total}
        matchOmitted={search.omitted}
        matchOrdinal={search.cycleIndex + 1}
        currentMatchId={search.all[search.cycleIndex]?.id ?? null}
        onToggleResults={() => setShowAllResults((current) => !current)}
        onLocate={locateNode}
        onMatchNext={locateMatchNext}
        counts={counts}
        hidden={hidden}
        allNodes={visibleNodes}
        onToggleKind={(kind) =>
          setHidden((current) => {
            const next = new Set(current)
            if (next.has(kind)) next.delete(kind)
            else next.add(kind)
            return next
          })
        }
        onlyConnected={onlyConnected}
        onToggleConnected={() => setOnlyConnected((current) => !current)}
        connectedAvailable={focusId !== null}
        linkRange={linkRange}
        onLinkRange={setLinkRange}
        minimapVisible={minimapVisible}
        onToggleMinimap={() => setMinimapVisible((current) => !current)}
      />

      <div className="rg-graph-body">
        <div
          ref={wrapRef}
          className="rg-graph-viewport"
          style={{ height: `${height}px` }}
          /* 滚轮**不**在这里挂：React 的 onWheel 是 passive 的，preventDefault
             无效会让缩放连带滚动整个页面。原生非 passive 监听器见上方
             wheelHandlerRef 的 effect。 */
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoverId(null)}
          onClick={onClick}
          onKeyDown={onKeyDown}
          tabIndex={0}
          role="application"
          aria-label={t('graph.title')}
          /* 键位声明给读屏：graph.hint 是**视觉**上的提示文字，
             aria-keyshortcuts 才是辅助技术读的机读键位表（两者都要有 ——
             一个给人看，一个给 AT 播报）。 */
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - 0 Escape Enter"
        >
          <svg width="100%" height="100%" role="presentation">
            {/* 箭头 marker：produces 方向 = 生产方 → 消费方。
                方向是这张图的语义核心，没有箭头用户只能猜「谁指向谁」。 */}
            <defs>
              <marker id="rg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--dsw-alias-border-l3)" />
              </marker>
              <marker id="rg-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--dsw-alias-brand-primary)" />
              </marker>
            </defs>
            <g transform={`translate(${viewport.tx},${viewport.ty}) scale(${viewport.scale})`}>
              {/* 列标题：分层布局的列语义（阶段）直接写在图上；环形布局没有列语义，不画。 */}
              {layoutMode === 'layered' &&
                graph.columns.map((column) => {
                  const columnNodes = visibleNodes.filter((node) => !offsets[node.id] && node.column === column.index)
                  const first = columnNodes[0]
                  if (!first) return null
                  return (
                    <text key={`col-${column.index}`} x={first.x} y={-16} className="rg-graph-column-title">
                      {column.label}
                    </text>
                  )
                })}
              {visibleEdges.map((edge, index) => {
                const from = nodeById.get(edge.from)
                const to = nodeById.get(edge.to)
                if (!from || !to) return null
                const active = focusId !== null && highlighted.has(edge.from) && highlighted.has(edge.to)
                const hoveredEdge = hoverEdgeId === edge.id
                const selectedEdge = selectedEdgeId === edge.id
                const geometry = edgeGeometry(from, to, curvatures[index] ?? 0)
                // 粗细 = 两端度数之和的对数刻度（枢纽链路更粗，但不会被 20 度压扁）。
                const baseWidth = edgeWidthOf(edgeDegrees, edge)
                return (
                  <g key={edge.id}>
                    {/* 命中热区（v0.11.3）：细线无法点击，叠一条透明宽描边只做命中，
                        不参与视觉。pointerEvents='stroke' 让它只在线条附近响应。 */}
                    <path
                      d={geometry.path}
                      className="rg-edge-hit"
                      onPointerEnter={() => setHoverEdgeId(edge.id)}
                      onPointerLeave={() => setHoverEdgeId((current) => (current === edge.id ? null : current))}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedEdgeId(edge.id)
                        onFocusChange(null)
                      }}
                    />
                    <path
                      d={geometry.path}
                      fill="none"
                      stroke={
                        selectedEdge || hoveredEdge || active ? 'var(--dsw-alias-brand-primary)' : edgeColor(edge)
                      }
                      strokeWidth={
                        selectedEdge
                          ? EDGE_WIDTH_MAX + 0.8
                          : hoveredEdge
                            ? baseWidth + 1
                            : active
                              ? baseWidth + 0.6
                              : baseWidth
                      }
                      strokeOpacity={focusId === null && selectedEdgeId === null ? 0.9 : selectedEdge || hoveredEdge || active ? 1 : 0.22}
                      markerEnd={selectedEdge || hoveredEdge || active ? 'url(#rg-arrow-active)' : 'url(#rg-arrow)'}
                    />
                    {/* 方向文字：高亮/悬停/选中任一时显示（只给被关注的边，
                        每条都标会让图面变成文字噪声）。 */}
                    {(active || hoveredEdge || selectedEdge) && geometry.labelAnchor !== null && (
                      <text x={geometry.labelAnchor.x} y={geometry.labelAnchor.y - 4} textAnchor="middle" className="rg-graph-edge-label">
                        {t(edgeKindKey(edge.kind))}
                      </text>
                    )}
                    {/* 边自带 label 是数据事实（此前完全没被渲染）——与语义标签分开画。 */}
                    {selectedEdge && geometry.labelAnchor !== null && edge.label !== undefined && (
                      <text x={geometry.labelAnchor.x} y={geometry.labelAnchor.y + 12} textAnchor="middle" className="rg-graph-edge-label">
                        {edge.label}
                      </text>
                    )}
                  </g>
                )
              })}
              {visibleNodes.map((node) => {
                const dimmed = focusId !== null && !highlighted.has(node.id)
                const hovered = hoverId === node.id
                const selected = node.id === focusId
                const matched = matchIds.has(node.id)
                const dragged = nodeDragRef.current?.id === node.id
                return (
                  <g
                    key={node.id}
                    /* 方向键导航的落点句柄：靠 id 查 DOM 会把选择器语法（`.` 是能力 id
                       的常态）交给自己都不认得的 API，因此用一个 data 属性做纯字符串匹配。 */
                    data-node-id={node.id}
                    /* v0.11.3：改用 style transform 以便布局切换有过渡；拖动时关闭过渡，
                       否则节点会「追不上指针」。prefers-reduced-motion 由全局 CSS 降级。 */
                    style={{
                      transform: `translate(${node.x}px, ${node.y}px)`,
                      transition: dragged ? 'none' : undefined,
                    }}
                    opacity={dimmed ? 0.3 : 1}
                    className="rg-graph-node"
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`${node.label}${node.detail ? ` — ${node.detail}` : ''}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressClickRef.current) return
                      onFocusChange(node.id)
                      // 节点与边互斥选中：点节点就退出边详情。
                      setSelectedEdgeId(null)
                    }}
                    onDoubleClick={() => onNodeDoubleClick(node)}
                    onPointerDown={(event) => onNodePointerDown(event, node.id)}
                    onPointerEnter={() => setHoverId(node.id)}
                    onPointerLeave={() => setHoverId((current) => (current === node.id ? null : current))}
                    onFocus={() => setHoverId(node.id)}
                    onBlur={() => setHoverId((current) => (current === node.id ? null : current))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault?.()
                        onFocusChange(node.id)
                      }
                    }}
                  >
                    <rect
                      x={0}
                      y={0}
                      width={NODE_WIDTH}
                      height={NODE_HEIGHT}
                      rx={10}
                      className="rg-graph-node-bg"
                      fill="var(--dsw-alias-bg-layer-1)"
                      stroke={selected || hovered ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}
                      strokeWidth={selected || hovered ? 2 : 1}
                      cursor={dragged ? 'grabbing' : 'grab'}
                    />
                    {/* 搜索命中：额外的虚线描边（颜色之外的第二通道）。 */}
                    {matched && (
                      <rect
                        x={-3}
                        y={-3}
                        width={NODE_WIDTH + 6}
                        height={NODE_HEIGHT + 6}
                        rx={12}
                        fill="none"
                        stroke="var(--dsw-alias-state-warn-primary)"
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                      />
                    )}
                    {/* 形状通道：颜色之外的第二编码。 */}
                    <path
                      d={shapePath(node.shape, 14, NODE_HEIGHT / 2)}
                      fill={colorOf(node, colorMode, (column) => stageOfColumn.get(column))}
                    />
                    <text x={30} y={22} className="rg-graph-node-label">
                      {node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label}
                    </text>
                    {node.detail && (
                      <text x={30} y={40} className="rg-graph-node-detail">
                        {node.detail.length > 28 ? `${node.detail.slice(0, 28)}…` : node.detail}
                      </text>
                    )}
                    {/* 悬停完整提示：被截断的 label / detail 在原生 tooltip 里完整可读。 */}
                    <title>{node.detail ? `${node.label} — ${node.detail}` : node.label}</title>
                  </g>
                )
              })}
            </g>
          </svg>
          {tooltip && (
            <GraphTooltip node={tooltip.node} degree={degreeOf(tooltip.node.id, visibleEdges)} x={tooltip.x} y={tooltip.y} containerWidth={size.width} />
          )}
          {/* 小地图：常驻右下角的「我在哪」。它的视口框跟着 scale/tx/ty 实时动，
              所以它同时是缩放读数的**图形版**（百分比只说大小，不说位置）。 */}
          {minimapVisible && (
            <div className="rg-minimap-wrap">
              <GraphMinimap
                width={minimapCanvas.width}
                height={minimapCanvas.height}
                rects={minimapRects}
                view={minimapView}
                focusRect={minimapFocusRect}
                onNavigate={navigateFromMinimap}
              />
              {/* 说明文字给读屏：小地图是鼠标捷径，键盘/读屏用户从这里得到
                  「这块是什么、怎么用」的答案，而等价的定位入口在主画布
                  （方向键换节点 + 搜索回车定位）。 */}
              <span className="rg-sr-only">{t('graph.minimapHint')}</span>
            </div>
          )}
          {/* 过滤把图滤空了：必须说出来，而不是留一块干净的空白 ——
              「干净空白」与「什么都没显示出来」在观感上完全一样（假绿）。 */}
          {visibleNodes.length === 0 && (hidden.size > 0 || onlyConnected) && (
            <div className="rg-graph-filtered-empty" role="status">
              {t('graph.filteredEmpty')}
              <button
                type="button"
                className="rg-link"
                onClick={() => {
                  setHidden(new Set())
                  setOnlyConnected(false)
                }}
              >
                {t('graph.filteredEmptyReset')}
              </button>
            </div>
          )}
        </div>

        {focusNode && (
          <GraphDetails
            node={focusNode}
            degree={focusDegree}
            upstream={focusNeighbors.upstream}
            downstream={focusNeighbors.downstream}
            labelOf={labelOf}
            onLocate={locateNode}
            onClose={() => onFocusChange(null)}
          />
        )}
        {/* 无节点聚焦时显示选中的边详情（两者互斥，侧栏不会打架）。 */}
        {!focusNode && selectedEdgeDetail !== null && (
          <EdgeDetails detail={selectedEdgeDetail} onClose={() => setSelectedEdgeId(null)} />
        )}
      </div>

      {/* 状态条：缩放的「轨迹」在数字上可读（百分比 + 计数 + 当前选中）。 */}
      <div className="rg-graph-status" role="status">
        <span className="rg-graph-zoom-label">{t('graph.zoomLevel')} {zoomLabel(viewport.scale)}</span>
        <span>{t('graph.counts', { nodes: visibleNodes.length, edges: visibleEdges.length })}</span>
        {selectedLabel !== null && (
          <span className="rg-graph-status-selected">
            {t('graph.selected')}: <strong>{selectedLabel}</strong>
          </span>
        )}
        <span className="rg-graph-hint">
          {t('graph.hint')} · {t('graph.arrowHint')}
        </span>
      </div>
    </div>
  )
}
