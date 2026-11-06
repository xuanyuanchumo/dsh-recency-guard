import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from './i18n.ts'
import {
  IDENTITY,
  SpatialGrid,
  centerOf,
  centerOn,
  clampPan,
  fitToView,
  matchNodes,
  panBy,
  screenToWorld,
  traceFrom,
  zoomBy,
  type Point,
  type Size,
  type Viewport,
} from './viewport.ts'
import {
  DRAG_THRESHOLD,
  NODE_HEIGHT,
  NODE_WIDTH,
  VIEWPORT_HEIGHT_WIDE,
  buildNodeIndex,
  colorOf,
  edgeColor,
  edgeCurvatures,
  edgeGeometry,
  filterGraph,
  graphBounds,
  hitNodesOf,
  kindCounts,
  layoutPositionsOf,
  neighborsOf,
  degreeOf,
  shapePath,
  withLayout,
  zoomLabel,
  type ColorMode,
  type LayoutMode,
} from './graph-model.ts'
import { GraphDetails, GraphToolbar, GraphTooltip } from './GraphParts.tsx'
import type { GraphData, GraphNode } from '../../src/graph-data.ts'

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
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [size, setSize] = useState<Size>({ width: 0, height })
  const [query, setQuery] = useState('')
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('layered')
  const [colorMode, setColorMode] = useState<ColorMode>('tone')
  const [onlyConnected, setOnlyConnected] = useState(false)
  // 布局切换的显式计数：只有用户点「布局」才允许重新 fit（铁律：轮询不得重置缩放）。
  const [layoutEpoch, setLayoutEpoch] = useState(0)
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
      }),
    [positionedNodes, graph.edges, hidden, onlyConnected, focusId],
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
   * 滚轮必须用**非 passive** 监听器原生挂载。
   *
   * 为什么不用 React 的 `onWheel`：React 17+ 把 wheel 挂在 root 上且是
   * **passive** 的，于是 `event.preventDefault()` 被浏览器忽略（控制台会报
   * "Unable to preventDefault inside passive event listener invocation"）。
   * 后果是用户缩放图谱时**页面跟着一起滚**——图被滚出视野，交互直接残废。
   * 实测证据（沙箱 sb-rg-c5）：合成 wheel 后视口 scale 0.5245→0.6032 正常，
   * 但同时抛出该 console error。
   *
   * 正确做法：在容器元素上 `{ passive: false }` 挂原生监听，并用 ref 桥接
   * 最新的 handler，避免因 viewport 变化反复解绑/重绑。
   */
  const wheelHandlerRef = useRef(onWheel)
  wheelHandlerRef.current = onWheel
  useEffect(() => {
    const host = wrapRef.current
    if (host === null) return undefined
    const listener = (event: WheelEvent): void => wheelHandlerRef.current(event)
    host.addEventListener('wheel', listener, { passive: false })
    return () => host.removeEventListener('wheel', listener)
  }, [])

  const onPointerDown = useCallback((event: { clientX: number; clientY: number }): void => {
    // 节点上的按下已在节点侧 stopPropagation，走到这里的一定是画布空白。
    suppressClickRef.current = false
    dragRef.current = { active: true, moved: false, x: event.clientX, y: event.clientY }
  }, [])

  const onPointerMove = useCallback(
    (event: { clientX: number; clientY: number }): void => {
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

  const onPointerUp = useCallback((): void => {
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
    },
    [apply, viewport, size, positionedById, centreOfNode, onFocusChange],
  )

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

  /** Esc 一次退出全部观察态（高亮 + 搜索 + 悬停）。 */  const onKeyDown = useCallback(
    (event: { key: string; preventDefault?: () => void }): void => {
      if (event.key === 'Escape') {
        event.preventDefault?.()
        onFocusChange(null)
        setQuery('')
        setHoverId(null)
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
      }
    },
    [doZoom, doFit, onFocusChange],
  )

  // 高亮集：聚焦节点沿边双向追溯（BFS：最少跳数 = 用户心里的「直接相关」）。
  const highlighted = useMemo(() => {
    if (focusId === null) return new Set<string>()
    return traceFrom(focusId, visibleEdges, 'both')
  }, [focusId, visibleEdges])

  const matches = useMemo(() => matchNodes(visibleNodes, query), [visibleNodes, query])
  const matchIds = useMemo(() => new Set(matches.map((node) => node.id)), [matches])
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
        }}
        canReset={focusId !== null || query !== ''}
        query={query}
        onQuery={setQuery}
        matches={matches}
        onLocate={locateNode}
        counts={counts}
        hidden={hidden}
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
                const geometry = edgeGeometry(from, to, curvatures[index] ?? 0)
                return (
                  <g key={edge.id}>
                    <path
                      d={geometry.path}
                      fill="none"
                      stroke={active ? 'var(--dsw-alias-brand-primary)' : edgeColor(edge)}
                      strokeWidth={active ? 2 : 1.2}
                      strokeOpacity={focusId === null ? 0.9 : active ? 1 : 0.22}
                      markerEnd={active ? 'url(#rg-arrow-active)' : 'url(#rg-arrow)'}
                    />
                    {/* 方向文字只给高亮边：每条边都标会让图面变成文字噪声。 */}
                    {active && geometry.labelAnchor !== null && (
                      <text x={geometry.labelAnchor.x} y={geometry.labelAnchor.y - 4} textAnchor="middle" className="rg-graph-edge-label">
                        {edge.kind === 'produces' ? t('graph.edgeProduces') : t('graph.edgeConsumes')}
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
                    transform={`translate(${node.x},${node.y})`}
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
        <span className="rg-graph-hint">{t('graph.hint')}</span>
      </div>
    </div>
  )
}
