import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from './i18n.ts'
import {
  IDENTITY,
  SpatialGrid,
  clampPan,
  clipToRect,
  fitToView,
  panBy,
  screenToWorld,
  traceFrom,
  zoomBy,
  centerOf,
  type HitNode,
  type Size,
  type Viewport,
} from './viewport.ts'
import type { GraphData, GraphNode } from '../../src/graph-data.ts'

/**
 * 可交互图谱 —— 能力的生产消费关系。
 *
 * ## 交互契约
 *
 * 1. **滚轮缩放以指针为锚**：指针下的图坐标保持不动（见 `zoomAt` 的推导）。
 * 2. **每次视口变化都过 `clampPan`**：图永远不会被拖到找不回来的地方。
 * 3. **fit 只做一次**（ref 守卫）：数据轮询会让 `nodes` 引用变化，若每次都
 *    重新 fit，用户刚调好的缩放会被重置 —— 这是最容易犯且最难察觉的错。
 * 4. **点击与拖拽区分**：指针移动累计位移小于阈值才算点击。
 * 5. **Esc 一次退出全部观察模式**（高亮 + 追溯）：只清一半会让人以为键没生效。
 *
 * ## 可访问性
 *
 * - 每个节点是带 `role="button"` 与 `aria-label` 的 `<g>`，可 Tab 聚焦。
 * - 颜色不是唯一通道：节点带文字标签与不同形状。
 * - 工具栏按钮有 `aria-label`。
 */

export interface GuardGraphProps {
  graph: GraphData
}

export interface GraphView {
  viewport: Viewport
  focusId: string | null
  highlighted: Set<string>
}

const NODE_WIDTH = 200
const NODE_HEIGHT = 56
const VIEWPORT_HEIGHT = 460
const DRAG_THRESHOLD = 3

/** 节点 id → 节点（过滤边时判断两端是否可见）。 */
function byIdOf(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>()
  for (const node of nodes) map.set(node.id, node)
  return map
}

/** 节点类型的图例标签（颜色之外还有文字与形状通道）。 */
const KIND_LEGEND: Array<{ kind: GraphNode['kind']; label: string }> = [
  { kind: 'capability', label: '能力' },
  { kind: 'stage', label: '阶段' },
  { kind: 'metric', label: '指标' },
  { kind: 'bundle', label: '插件' },
  { kind: 'gap', label: '缺口' },
]

/** 语义色 → 主题变量。 */
const TONE_COLOR: Record<GraphNode['tone'], string> = {
  neutral: 'var(--dsw-alias-label-secondary)',
  info: 'var(--dsw-alias-brand-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
}

export function GuardGraph({ graph }: GuardGraphProps): ReactElement {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [size, setSize] = useState<Size>({ width: 0, height: VIEWPORT_HEIGHT })
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ active: boolean; moved: boolean; x: number; y: number }>({
    active: false,
    moved: false,
    x: 0,
    y: 0,
  })
  const fittedRef = useRef(false)

  // 节点尺寸来自布局常量；建立命中索引（网格）。
  const hitNodes = useMemo<HitNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        x: node.x,
        y: node.y,
        w: NODE_WIDTH,
        h: NODE_HEIGHT,
      })),
    [graph.nodes],
  )
  const grid = useMemo(() => new SpatialGrid(hitNodes), [hitNodes])

  // 类型过滤：隐藏某类节点时，只保留两端都可见的边（缺口三角形可整体关掉，
  // 让用户聚焦能力主干）。空集 = 全部可见。
  const visibleNodes = useMemo(
    () => (hidden.size === 0 ? graph.nodes : graph.nodes.filter((n) => !hidden.has(n.kind))),
    [graph.nodes, hidden],
  )
  const visibleEdges = useMemo(
    () =>
      hidden.size === 0
        ? graph.edges
        : graph.edges.filter((e) => {
            const from = byIdOf(graph.nodes).get(e.from)
            const to = byIdOf(graph.nodes).get(e.to)
            return from !== undefined && to !== undefined && !hidden.has(from.kind) && !hidden.has(to.kind)
          }),
    [graph.edges, graph.nodes, hidden],
  )
  // 当前存在的节点类型（图例只显示有的类型，不显示永远为空的开关）。
  const presentKinds = useMemo(() => {
    const set = new Set<string>()
    for (const node of graph.nodes) set.add(node.kind)
    return set
  }, [graph.nodes])

  const bounds = useMemo(
    () => ({
      minX: graph.bounds.minX,
      minY: graph.bounds.minY,
      maxX: graph.bounds.maxX,
      maxY: graph.bounds.maxY,
      width: graph.bounds.maxX - graph.bounds.minX,
      height: graph.bounds.maxY - graph.bounds.minY,
    }),
    [graph.bounds],
  )

  // 测量容器尺寸（真实像素首次渲染后才可用）。
  useEffect(() => {
    const measure = (): void => {
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      setSize({ width: rect.width, height: VIEWPORT_HEIGHT })
    }
    measure()
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null
    if (observer && wrapRef.current) observer.observe(wrapRef.current)
    return () => observer?.disconnect()
  }, [])

  const apply = useCallback(
    (next: Viewport): void => {
      setViewport(clampPan(next, size, bounds))
    },
    [size, bounds],
  )

  // fit 只做一次 —— 数据轮询不应重置用户的缩放。
  useEffect(() => {
    if (fittedRef.current) return
    if (size.width === 0) return
    fittedRef.current = true
    setViewport(clampPan(fitToView(bounds, size), size, bounds))
  }, [size, bounds])

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
      const anchor = {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      }
      apply(zoomBy(viewport, anchor, event.deltaY < 0 ? 1.15 : 1 / 1.15))
    },
    [apply, viewport],
  )

  const onPointerDown = useCallback((event: { clientX: number; clientY: number; pointerId?: number }): void => {
    dragRef.current = { active: true, moved: false, x: event.clientX, y: event.clientY }
  }, [])

  const onPointerMove = useCallback(
    (event: { clientX: number; clientY: number }): void => {
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
    [size, bounds],
  )

  const onPointerUp = useCallback((): void => {
    dragRef.current = { active: false, moved: false, x: 0, y: 0 }
  }, [])

  const onClick = useCallback(
    (event: { clientX: number; clientY: number }): void => {
      if (dragRef.current.moved) return
      const rect = wrapRef.current?.getBoundingClientRect()
      const world = screenToWorld(viewport, {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      })
      const hit = grid.hit(world)
      setFocusId(hit === null ? null : hit.id)
    },
    [grid, viewport],
  )

  // Esc 一次退出全部观察模式。
  const onKeyDown = useCallback(
    (event: { key: string; preventDefault?: () => void }): void => {
      if (event.key === 'Escape') {
        event.preventDefault?.()
        setFocusId(null)
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
    [doZoom, doFit],
  )

  // 高亮集合：聚焦节点沿边双向追溯。
  const highlighted = useMemo(() => {
    if (focusId === null) return new Set<string>()
    return traceFrom(focusId, visibleEdges, 'both')
  }, [focusId, visibleEdges])

  const byId = useMemo(() => byIdOf(graph.nodes), [graph.nodes])

  if (graph.nodes.length === 0) {
    return <p className="rg-empty">{t('graph.empty')}</p>
  }

  return (
    <div className="rg-graph" data-recency-guard-graph="">
      <div className="rg-graph-toolbar" role="toolbar" aria-label={t('graph.title')}>
        <button type="button" className="rg-button rg-button-small" onClick={() => doZoom(1.15)} aria-label={t('graph.zoomIn')}>
          +
        </button>
        <button type="button" className="rg-button rg-button-small" onClick={() => doZoom(1 / 1.15)} aria-label={t('graph.zoomOut')}>
          −
        </button>
        <button type="button" className="rg-button rg-button-small" onClick={doFit} aria-label={t('graph.fit')}>
          ⤢
        </button>
        <button
          type="button"
          className="rg-button rg-button-small"
          onClick={() => setFocusId(null)}
          disabled={focusId === null}
          aria-label={t('graph.reset')}
        >
          ✕
        </button>
        {/* 类型过滤：点击切换该类节点的可见性（全部隐藏某类时相关边一并消失）。 */}
        <span className="rg-graph-legend" role="group" aria-label={t('graph.legend')}>
          {KIND_LEGEND.filter((entry) => presentKinds.has(entry.kind)).map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className={`rg-legend-chip${hidden.has(entry.kind) ? ' rg-legend-chip-off' : ''}`}
              onClick={() =>
                setHidden((current) => {
                  const next = new Set(current)
                  if (next.has(entry.kind)) next.delete(entry.kind)
                  else next.add(entry.kind)
                  return next
                })
              }
              aria-pressed={!hidden.has(entry.kind)}
            >
              {entry.label}
            </button>
          ))}
        </span>
        <span className="rg-graph-hint">{t('graph.hint')}</span>
      </div>

      <div
        ref={wrapRef}
        className="rg-graph-viewport"
        style={{ height: `${VIEWPORT_HEIGHT}px` }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
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
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--dsw-alias-border-l2)" />
            </marker>
            <marker id="rg-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={TONE_COLOR.info} />
            </marker>
          </defs>
          <g transform={`translate(${viewport.tx},${viewport.ty}) scale(${viewport.scale})`}>
            {/* 列标题：分层布局的列语义（阶段）直接写在图上，悬停即可读。 */}
            {graph.columns.map((column) => {
              const columnNodes = visibleNodes.filter((n) => n.column === column.index)
              if (columnNodes.length === 0) return null
              const x = columnNodes[0].x
              return (
                <text key={`col-${column.index}`} x={x} y={-16} className="rg-graph-column-title">
                  {column.label}
                </text>
              )
            })}
            {visibleEdges.map((edge) => {
              const from = byId.get(edge.from)
              const to = byId.get(edge.to)
              if (!from || !to) return null
              const active = highlighted.has(edge.from) && highlighted.has(edge.to)
              // 端点裁剪到节点边界：箭头贴边而不是扎进卡片中心。
              const start = clipToRect(
                from.x + NODE_WIDTH / 2,
                from.y + NODE_HEIGHT / 2,
                to.x + NODE_WIDTH / 2,
                to.y + NODE_HEIGHT / 2,
                { x: from.x, y: from.y, w: NODE_WIDTH, h: NODE_HEIGHT },
              )
              const end = clipToRect(
                to.x + NODE_WIDTH / 2,
                to.y + NODE_HEIGHT / 2,
                from.x + NODE_WIDTH / 2,
                from.y + NODE_HEIGHT / 2,
                { x: to.x, y: to.y, w: NODE_WIDTH, h: NODE_HEIGHT },
              )
              return (
                <line
                  key={edge.id}
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  stroke={active ? TONE_COLOR.info : 'var(--dsw-alias-border-l2)'}
                  strokeWidth={active ? 2 : 1}
                  strokeOpacity={focusId === null ? 1 : active ? 1 : 0.25}
                  markerEnd={active ? 'url(#rg-arrow-active)' : 'url(#rg-arrow)'}
                />
              )
            })}
            {visibleNodes.map((node) => {
              const dimmed = focusId !== null && !highlighted.has(node.id)
              const hovered = hoverId === node.id
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  opacity={dimmed ? 0.3 : 1}
                  role="button"
                  tabIndex={-1}
                  aria-label={`${node.label}${node.detail ? ` — ${node.detail}` : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setFocusId(node.id)
                  }}
                  onPointerEnter={() => setHoverId(node.id)}
                  onPointerLeave={() => setHoverId((current) => (current === node.id ? null : current))}
                >
                  <rect
                    x={0}
                    y={0}
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={10}
                    fill="var(--dsw-alias-bg-layer-1)"
                    stroke={node.id === focusId ? TONE_COLOR.info : hovered ? TONE_COLOR.info : 'var(--dsw-alias-border-l1)'}
                    strokeWidth={node.id === focusId || hovered ? 2 : 1}
                  />
                  {/* 形状通道：颜色之外的第二编码。 */}
                  <path d={shapePath(node.shape, 14, NODE_HEIGHT / 2)} fill={TONE_COLOR[node.tone]} />
                  <text x={30} y={22} className="rg-graph-node-label">
                    {node.label}
                  </text>
                  {node.detail && (
                    <text x={30} y={40} className="rg-graph-node-detail">
                      {node.detail.length > 28 ? `${node.detail.slice(0, 28)}…` : node.detail}
                    </text>
                  )}
                  {/* 悬停完整提示：被截断的 detail 在 tooltip 里完整可读。 */}
                  {node.detail && node.detail.length > 28 && <title>{node.detail}</title>}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}

/** 形状路径 —— 六种形状的公共外形（圆/方/菱/三角/六边/圆角方）。 */
export function shapePath(shape: GraphNode['shape'], size: number, cy: number): string {
  const r = size
  switch (shape) {
    case 'square':
      return `M ${-r} ${cy - r} h ${r * 2} v ${r * 2} h ${-r * 2} Z`
    case 'diamond':
      return `M 0 ${cy - r} L ${r} ${cy} L 0 ${cy + r} L ${-r} ${cy} Z`
    case 'triangle':
      return `M 0 ${cy - r} L ${r} ${cy + r} L ${-r} ${cy + r} Z`
    case 'hexagon':
      return `M ${-r} ${cy - r * 0.6} L ${-r * 0.5} ${cy - r} L ${r * 0.5} ${cy - r} L ${r} ${cy - r * 0.6} L ${r * 0.5} ${cy + r} L ${-r * 0.5} ${cy + r} Z`
    case 'circle':
    default:
      return `M ${-r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`
  }
}
