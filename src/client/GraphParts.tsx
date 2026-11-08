import type { ReactElement } from 'react'
import { useRef } from 'react'
import { t } from './i18n.ts'
import type { GraphNode } from '../../src/graph-data.ts'
import {
  KIND_ORDER,
  kindKey,
  legendColorOf,
  legendShapeOf,
  shapePath,
  type ColorMode,
  type LayoutMode,
  type EdgeDetail,
  type LinkRange,
} from './graph-model.ts'
// 小地图类型来自 minimap-model（v0.12 拆分，保持 graph-model 在复杂度预算内）。
import type { MinimapNodeRect, MinimapViewportRect } from './minimap-model.ts'

/**
 * 图谱的**展示层**部件 —— 只接收已经算好的事实，不含任何派生逻辑。
 *
 * 为什么单独成文件：图谱组件此前是一个 700+ 行的「状态 + 派生 + 渲染」三合一，
 * 改一处渲染要在整文件里找上下文。拆开后，本文件的所有分支都可以用
 * 「给定 props → 给定 DOM」来读，而 `graph-model.ts` 承担可测试的派生。
 *
 * 纪律：文案全部走 `t()`；颜色只用主题变量；颜色不是唯一通道
 * （每个色块旁边都有文字或形状）。
 */

/** 工具栏。 */
export interface GraphToolbarProps {
  layoutMode: LayoutMode
  onLayoutMode: (mode: LayoutMode) => void
  colorMode: ColorMode
  onColorMode: (mode: ColorMode) => void
  onZoom: (factor: number) => void
  onFit: () => void
  onReset: () => void
  canReset: boolean
  query: string
  onQuery: (value: string) => void
  /** 结果列表的**当前窗口**（排名连续，且必定容得下当前命中）。 */
  matches: GraphNode[]
  /** 全部命中数（指示器的分母；`matches.length` 只是窗口大小，不能当总数）。 */
  matchTotal: number
  /** 被省略的命中数（>0 ⇒ 必须给出「省略 N 条 + 展开」，不许静默截断）。 */
  matchOmitted: number
  /** 当前命中的**真实序数**（1 基；0 = 无命中）。窗口会滑动，用窗口下标就会
   *  把「第 12 个」报成「第 8 个」—— 数字必须来自全量而非窗口。 */
  matchOrdinal: number
  /** 当前命中的 id（比下标更稳：窗口滑动、类型过滤、节点增减都不会让高亮错位）。 */
  currentMatchId: string | null
  onToggleResults: () => void
  onLocate: (id: string) => void
  /** 请求下一个匹配（回车；取模与窗口滑动在图谱侧由 searchSummary 完成）。 */
  onMatchNext: () => void
  counts: Record<string, number>
  hidden: ReadonlySet<string>
  onToggleKind: (kind: GraphNode['kind']) => void
  onlyConnected: boolean
  onToggleConnected: () => void
  connectedAvailable: boolean
  /** 「只看关联」的跳数档位（仅在开关打开时显示；见 GraphToolbar 里的档位条）。 */
  linkRange: LinkRange
  onLinkRange: (range: LinkRange) => void
  /** 小地图开关（概览导航）。 */
  minimapVisible: boolean
  onToggleMinimap: () => void
  /** 全部可见节点（图例的代表形状从实际数据导出，不复制映射 —— 单一真相源）。 */
  allNodes: GraphNode[]
}

const LAYOUT_MODES: readonly LayoutMode[] = ['layered', 'radial']
const COLOR_MODES: readonly ColorMode[] = ['tone', 'kind', 'stage']
const LINK_RANGES: readonly LinkRange[] = ['hops1', 'hops2', 'closure']

export function GraphToolbar(props: GraphToolbarProps): ReactElement {
  return (
    <div className="rg-graph-toolbar" role="toolbar" aria-label={t('graph.title')}>
      <div className="rg-graph-zoom" role="group" aria-label={t('graph.zoomGroup')}>
        <button type="button" className="rg-button rg-button-icon" onClick={() => props.onZoom(1.15)} aria-label={t('graph.zoomIn')} title={t('graph.zoomIn')}>
          +
        </button>
        <button type="button" className="rg-button rg-button-icon" onClick={() => props.onZoom(1 / 1.15)} aria-label={t('graph.zoomOut')} title={t('graph.zoomOut')}>
          −
        </button>
        <button type="button" className="rg-button rg-button-icon" onClick={props.onFit} aria-label={t('graph.fit')} title={t('graph.fit')}>
          ⤢
        </button>
      </div>

      <span className="rg-graph-search" role="search">
        <input
          className="rg-search-input"
          type="text"
          value={props.query}
          placeholder={t('graph.search')}
          onChange={(event) => props.onQuery(event.target.value)}
          onKeyDown={(event) => {
            // 回车循环遍历（v0.11）：多匹配时依次跳转而不是永远停在第一个。
            // 游标由面板持有（locateMatch），这里只报告「用户又要下一个」。
            // 守卫用 matchTotal 而不是 matches.length：matches 是**窗口**，
            // 窗口为 0（显示上限被改成 0，或结果全部被折叠）时全量命中依然存在，
            // 用窗口长度会把 Enter 悄悄禁用 —— 快捷键失效比少一行列表严重。
            if (event.key === 'Enter' && props.matchTotal > 0) {
              event.preventDefault?.()
              props.onMatchNext()
            }
            if (event.key === 'Escape') props.onQuery('')
            // 搜索框里的按键不该冒泡到画布（否则输入 `0` 会触发「适配视图」）。
            event.stopPropagation()
          }}
          aria-label={t('graph.search')}
          aria-keyshortcuts="Enter"
        />
        {props.query.trim() !== '' && (
          <ul className="rg-search-results" role="listbox" aria-label={t('graph.searchResults')}>
            {/* 空态判定同样用 matchTotal：matches 是窗口，窗口空但全量非空时
                说「没有匹配的节点」是一句假话（而它是唯一会被用户读到的结论）。 */}
            {props.matchTotal === 0 ? (
              <li className="rg-search-noresult">{t('graph.noResults')}</li>
            ) : (
              <>
                {props.matches.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => props.onLocate(node.id)}
                      aria-current={node.id === props.currentMatchId}
                    >
                      <span className={`rg-dot rg-dot-${node.tone}`} aria-hidden />
                      {node.label}
                    </button>
                  </li>
                ))}
                {/* 省略计数 + 展开：此前数据层就只给 8 条，用户永远不会知道
                    还有第 9 个匹配存在（「报 N 只列 5」的同款缺陷）。 */}
                {props.matchOmitted > 0 && (
                  <li className="rg-search-omitted">
                    <button type="button" className="rg-link" onClick={props.onToggleResults}>
                      {t('graph.searchMore', { count: props.matchOmitted })}
                    </button>
                  </li>
                )}
              </>
            )}
          </ul>
        )}
        {/* 第 n/m 指示：分母必须是**全量命中数**、分子必须是**真实序数**。
            用 matches.length 会把「匹配 20 个」显示成「第 1/8 个」—— 一句可验证
            的假话；用窗口下标则会在窗口滑动后把第 12 个报成第 8 个。 */}
        {props.query.trim() !== '' && props.matchTotal > 1 && (
          <span className="rg-search-index" role="status">
            {t('graph.matchIndex', { index: props.matchOrdinal, total: props.matchTotal })}
          </span>
        )}
      </span>

      <Segmented
        label={t('graph.layout.label')}
        options={LAYOUT_MODES.map((mode) => ({ value: mode, label: t(`graph.layout.${mode}`) }))}
        active={props.layoutMode}
        onSelect={(value) => props.onLayoutMode(value as LayoutMode)}
      />
      <Segmented
        label={t('graph.colorBy')}
        options={COLOR_MODES.map((mode) => ({ value: mode, label: t(`graph.color.${mode}`) }))}
        active={props.colorMode}
        onSelect={(value) => props.onColorMode(value as ColorMode)}
      />

      {/* 「只看关联」的范围档位（v0.11.5）。
          此前这个开关只有二值且语义是传递闭包：在一张连通的 40 节点图上，
          闭包 = 整张图，于是按钮按下后画面毫无变化 —— 它是个摆设。
          档位把「直接相关 / 链路 / 全连通」三种真实问题分开，切换才看得见差别。 */}
      {props.onlyConnected && (
        <Segmented
          label={t('graph.linkRange.label')}
          options={LINK_RANGES.map((range) => ({ value: range, label: t(`graph.linkRange.${range}`) }))}
          active={props.linkRange}
          onSelect={(value) => props.onLinkRange(value as LinkRange)}
        />
      )}

      <button
        type="button"
        className={`rg-button rg-button-small${props.onlyConnected ? ' rg-button-active' : ''}`}
        onClick={props.onToggleConnected}
        disabled={!props.connectedAvailable}
        aria-pressed={props.onlyConnected}
        title={t('graph.onlyConnectedHint')}
      >
        {t('graph.onlyConnected')}
      </button>

      <button
        type="button"
        className={`rg-button rg-button-small${props.minimapVisible ? ' rg-button-active' : ''}`}
        onClick={props.onToggleMinimap}
        aria-pressed={props.minimapVisible}
        title={t('graph.minimapHint')}
      >
        {t('graph.minimap')}
      </button>

      <button
        type="button"
        className="rg-button rg-button-small"
        onClick={props.onReset}
        disabled={!props.canReset}
        aria-label={t('graph.reset')}
      >
        {t('graph.reset')}
      </button>

      {/* 类型图例：既是图例（带计数）也是开关（点击隐藏该类型）。
          v0.11：图例颜色跟随当前着色口径（此前固定语义色，与「按类型」口径下
          节点实际颜色不一致）；同时展示形状通道（色盲/灰度打印的第二编码）。 */}
      <span className="rg-graph-legend" role="group" aria-label={t('graph.legend')}>
        {KIND_ORDER.filter((kind) => (props.counts[kind] ?? 0) > 0).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`rg-legend-chip${props.hidden.has(kind) ? ' rg-legend-chip-off' : ''}`}
            onClick={() => props.onToggleKind(kind)}
            aria-pressed={!props.hidden.has(kind)}
            title={t('graph.legendToggle', { kind: t(kindKey(kind)) })}
          >
            <svg className="rg-legend-shape" viewBox="-8 -8 16 16" aria-hidden>
              <path d={shapePath(legendShapeOf(kind, props.allNodes), 7, 0)} fill={legendColorOf(kind, props.colorMode)} />
            </svg>
            {t(kindKey(kind))}
            <span className="rg-legend-count">{props.counts[kind] ?? 0}</span>
          </button>
        ))}
      </span>
    </div>
  )
}

interface SegmentedOption {
  value: string
  label: string
}

/** 分段控件 —— 单选语义用 `aria-pressed` 而不是 `<select>`（切换无二次确认）。 */
function Segmented({
  label,
  options,
  active,
  onSelect,
}: {
  label: string
  options: SegmentedOption[]
  active: string
  onSelect: (value: string) => void
}): ReactElement {
  return (
    <span className="rg-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="rg-segment"
          aria-pressed={option.value === active}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}

/** 详情侧栏。 */
export interface GraphDetailsProps {
  node: GraphNode
  degree: { in: number; out: number }
  upstream: string[]
  downstream: string[]
  labelOf: (id: string) => { label: string; tone: GraphNode['tone']; detail?: string }
  onLocate: (id: string) => void
  onClose: () => void
}

export function GraphDetails(props: GraphDetailsProps): ReactElement {
  const { node } = props
  const groups: Array<{ title: string; ids: string[] }> = [
    { title: t('graph.neighborsUp'), ids: props.upstream },
    { title: t('graph.neighborsDown'), ids: props.downstream },
  ]
  return (
    <aside className="rg-graph-aside" aria-label={t('graph.details')}>
      <header className="rg-graph-aside-header">
        <span className={`rg-dot rg-dot-${node.tone}`} aria-hidden />
        <strong className="rg-graph-aside-title" title={node.label}>
          {node.label}
        </strong>
        <button type="button" className="rg-button rg-button-icon" onClick={props.onClose} aria-label={t('graph.closeDetails')}>
          ✕
        </button>
      </header>
      <dl className="rg-dl rg-dl-compact">
        <dt>{t('graph.kindLabel')}</dt>
        <dd>{t(kindKey(node.kind))}</dd>
        <dt>{t('graph.refLabel')}</dt>
        <dd className="rg-mono">{node.ref ?? '—'}</dd>
        <dt>{t('graph.degreeLabel')}</dt>
        <dd>{t('graph.degreeValue', { in: props.degree.in, out: props.degree.out })}</dd>
      </dl>
      {groups.map((group) =>
        group.ids.length === 0 ? null : (
          <div className="rg-graph-neighbors" key={group.title}>
            <h4 className="rg-graph-neighbor-title">
              {group.title}
              <span className="rg-count">{group.ids.length}</span>
            </h4>
            <ul className="rg-graph-neighbor-list">
              {group.ids.map((id) => {
                const neighbour = props.labelOf(id)
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="rg-graph-neighbor-link"
                      onClick={() => props.onLocate(id)}
                      title={neighbour.detail ?? neighbour.label}
                    >
                      <span className={`rg-dot rg-dot-${neighbour.tone}`} aria-hidden />
                      <span className="rg-ellipsis">{neighbour.label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ),
      )}
      {node.detail && <p className="rg-graph-aside-detail">{node.detail}</p>}
      <div className="rg-graph-aside-actions">
        <button type="button" className="rg-button rg-button-small" onClick={() => props.onLocate(node.id)}>
          {t('graph.locate')}
        </button>
      </div>
    </aside>
  )
}

/**
 * 边的详情侧栏（v0.11.3 图谱交互补齐）。
 *
 * 此前边完全不可交互：`edge.label` 是死数据、用户无法回答「这条边是谁
 * 生产给谁、什么语义」。现在点击/hover 边后可读完整语义，且**不替代**
 * 节点详情 —— 两者互斥（单一选中态），避免侧栏内容打架。
 */
export interface EdgeDetailsProps {
  detail: EdgeDetail
  onClose: () => void
}

export function EdgeDetails({ detail, onClose }: EdgeDetailsProps): ReactElement {
  return (
    <aside className="rg-graph-aside" aria-label={t('graph.edgeDetails')}>
      <header className="rg-graph-aside-header">
        <span className="rg-dot rg-dot-info" aria-hidden />
        <strong className="rg-graph-aside-title">{t('graph.edgeDetails')}</strong>
        <button type="button" className="rg-button rg-button-icon" onClick={onClose} aria-label={t('graph.closeDetails')}>
          ✕
        </button>
      </header>
      <dl className="rg-dl rg-dl-compact">
        <dt>{t('graph.edgeFrom')}</dt>
        <dd className="rg-ellipsis" title={detail.fromLabel}>
          {detail.fromLabel}
        </dd>
        <dt>{t('graph.edgeTo')}</dt>
        <dd className="rg-ellipsis" title={detail.toLabel}>
          {detail.toLabel}
        </dd>
        <dt>{t('graph.edgeKind')}</dt>
        <dd>{t(edgeKindKey(detail.kind))}</dd>
      </dl>
      {detail.label !== undefined && <p className="rg-graph-aside-detail">{detail.label}</p>}
    </aside>
  )
}

/** 边语义 → i18n 键。 */
export function edgeKindKey(kind: EdgeDetail['kind']): string {
  switch (kind) {
    case 'produces':
      return 'graph.edgeProduces'
    case 'consumes':
      return 'graph.edgeConsumes'
    case 'transitions':
      return 'graph.edgeTransitions'
    case 'ranks':
    default:
      return 'graph.edgeRanks'
  }
}

/**
 * 小地图（Overview + 缩略导航）—— 纯展示：所有矩形由 graph-model 的投影算好传来。
 *
 * 为什么值得有它：图谱能缩到 0.25，一张 60 节点的图缩到底之后用户只剩
 * 「一团」，没有任何参照回答「我在哪、还有多少没看」。小地图把这件事
 * 变成一块 152×96 的常驻画面，并且**可点可拖** —— 拖框即平移，不需要先放大再找。
 *
 * 三条实现纪律：
 * - 只做投影不做逻辑：矩形、视口框都来自 graph-model 的纯函数（可单测）。
 * - 交互走 pointer capture：否则指针滑出小地图就断掉拖拽，框会「粘住」。
 * - 键盘可达性**不靠它**：小地图是鼠标捷径（`role="img"` + 说明文字），
 *   等价的键盘路径是画布上的方向键 + 搜索定位。把 SVG 做成可 Tab 的
 *   「控件」反而更糟：读屏会播报一个只能说出坐标、不能用键操作的假按钮。
 *   这条边界要说清楚，别在注释里写「aria-hidden 的都有等价入口」这种
 *   本组件并不成立的话。
 */
export interface GraphMinimapProps {
  width: number
  height: number
  /** 节点矩形（已投影到小地图坐标）。 */
  rects: MinimapNodeRect[]
  /** 当前视口框（已投影）。 */
  view: MinimapViewportRect
  /** 导航请求：参数是**小地图本地坐标**（换算成世界坐标由调用方用闭式逆投影完成）。 */
  onNavigate: (point: { x: number; y: number }) => void
  /** 选中节点在小地图里的方块（null = 没有选中；用户仍想知道它在整张图的哪个方向）。
   *  只取几何：小地图上的焦点环不携带 fill（颜色通道已由节点方块用掉）。 */
  focusRect: Pick<MinimapNodeRect, 'x' | 'y' | 'w' | 'h'> | null
}

export function GraphMinimap({ width, height, rects, view, focusRect, onNavigate }: GraphMinimapProps): ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const draggingRef = useRef(false)

  /** 客户端坐标 → 小地图坐标（svg 等比缩放，用 getBoundingClientRect 换算）。 */
  const localPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 }
    return { x: ((clientX - box.left) / box.width) * width, y: ((clientY - box.top) / box.height) * height }
  }

  // 事件**必须**拦在这里往外冒泡：小地图渲染在 .rg-graph-viewport 内部，
  // 而那个容器上有 onPointerDown（拖画布平移）与 onClick（点空白清选中）。
  // 不拦的结果是两个都发生：拖小地图的同时画布也被拖着平移（两套坐标系
  // 互相拉扯，框会抖动漂移），抬手那一刻还会触发容器 click ⇒ 刚选中的节点
  // 被清空。这类「子控件被父容器的通用手势吃掉」是嵌套交互控件的头号缺陷。
  return (
    <svg
      ref={svgRef}
      className="rg-minimap"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={t('graph.minimap')}
      onPointerDown={(event) => {
        event.stopPropagation()
        draggingRef.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
        onNavigate(localPoint(event.clientX, event.clientY))
      }}
      onPointerMove={(event) => {
        event.stopPropagation()
        if (!draggingRef.current) return
        onNavigate(localPoint(event.clientX, event.clientY))
      }}
      onPointerUp={(event) => {
        event.stopPropagation()
        draggingRef.current = false
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }}
      onPointerCancel={(event) => {
        event.stopPropagation()
        draggingRef.current = false
      }}
      onClick={(event) => {
        // 小地图的点击不是「画布空白」：不能让容器的清选中逻辑跟着跑。
        event.stopPropagation()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {rects.map((rect) => (
        <rect
          key={rect.id}
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          rx={1}
          fill={rect.fill}
          fillOpacity={0.75}
        />
      ))}
      {/* 视口框：描边不加填充 —— 填充会把底下的节点方块盖成一片，
          而「哪块没被框住」正是用户要看的信息。
          全览态（zoomedOut）由模型层返回「铺满整块画布」的框，因此这里
          不需要条件渲染：不画框会让用户以为小地图坏了，铺满才是诚实表达。 */}
      <rect
        className={`rg-minimap-view${view.zoomedOut ? ' rg-minimap-view-all' : ''}`}
        x={view.x}
        y={view.y}
        width={Math.max(4, view.w)}
        height={Math.max(4, view.h)}
        rx={2}
        fill="none"
        stroke="var(--dsw-alias-brand-primary)"
        strokeWidth={1.5}
      />
      {/* 选中节点的方块：小地图同时回答「我选中了什么、它在整张图的哪里」——
          此前这个问题只在主画布可见区内有答案（选中的节点被滚出视野就消失了）。 */}
      {focusRect !== null && (
        <rect
          className="rg-minimap-focus"
          x={focusRect.x}
          y={focusRect.y}
          width={Math.max(3, focusRect.w)}
          height={Math.max(2, focusRect.h)}
          rx={1}
          fill="none"
          stroke="var(--dsw-alias-state-warn-primary)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  )
}

/** 悬停浮层 —— 鼠标停在节点上时显示被卡片截断的完整事实。 */
export interface GraphTooltipProps {
  node: GraphNode
  degree: { in: number; out: number }
  x: number
  y: number
  /** 容器宽度，用于把浮层挡在视口内。 */
  containerWidth: number
}

export function GraphTooltip({ node, degree, x, y, containerWidth }: GraphTooltipProps): ReactElement {
  // 浮层宽度是固定的：先按半宽把锚点夹进容器，浮层的对齐才可预测
  // （否则靠近右缘的节点会让浮层被裁掉一半，恰好是最需要读的 detail 被裁）。
  const halfWidth = 130
  const left = Math.min(Math.max(x, halfWidth), Math.max(halfWidth, containerWidth - halfWidth))
  return (
    <div className="rg-graph-tooltip" style={{ left, top: y }} role="presentation" aria-hidden>
      <span className="rg-tooltip-title">
        <span className={`rg-dot rg-dot-${node.tone}`} aria-hidden />
        {node.label}
      </span>
      <span className="rg-tooltip-meta">
        {t(kindKey(node.kind))} · {t('graph.degreeValue', { in: degree.in, out: degree.out })}
      </span>
      {node.detail && <span className="rg-tooltip-detail">{node.detail}</span>}
    </div>
  )
}
