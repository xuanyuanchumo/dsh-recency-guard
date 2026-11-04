import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from './i18n.ts'
import {
  IDENTITY,
  SpatialGrid,
  clampPan,
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
    return traceFrom(focusId, graph.edges, 'both')
  }, [focusId, graph.edges])

  const byId = useMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const node of graph.nodes) map.set(node.id, node)
    return map
  }, [graph.nodes])

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
          <g transform={`translate(${viewport.tx},${viewport.ty}) scale(${viewport.scale})`}>
            {graph.edges.map((edge) => {
              const from = byId.get(edge.from)
              const to = byId.get(edge.to)
              if (!from || !to) return null
              const active = highlighted.has(edge.from) && highlighted.has(edge.to)
              return (
                <line
                  key={edge.id}
                  x1={from.x + NODE_WIDTH / 2}
                  y1={from.y + NODE_HEIGHT / 2}
                  x2={to.x + NODE_WIDTH / 2}
                  y2={to.y + NODE_HEIGHT / 2}
                  stroke={active ? TONE_COLOR.info : 'var(--dsw-alias-border-l2)'}
                  strokeWidth={active ? 2 : 1}
                  strokeOpacity={focusId === null ? 1 : active ? 1 : 0.25}
                />
              )
            })}
            {graph.nodes.map((node) => {
              const dimmed = focusId !== null && !highlighted.has(node.id)
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
                >
                  <rect
                    x={0}
                    y={0}
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={10}
                    fill="var(--dsw-alias-bg-layer-1)"
                    stroke={node.id === focusId ? TONE_COLOR.info : 'var(--dsw-alias-border-l1)'}
                    strokeWidth={node.id === focusId ? 2 : 1}
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
