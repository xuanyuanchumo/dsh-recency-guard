import type { ReactElement } from 'react'
import { t } from './i18n.ts'
import type { GraphNode } from '../../src/graph-data.ts'
import { KIND_ORDER, kindKey, legendColorOf, legendShapeOf, shapePath, type ColorMode, type LayoutMode } from './graph-model.ts'

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
  matches: GraphNode[]
  onLocate: (id: string) => void
  /** 当前遍历游标（回车循环跳转的第 n 个匹配）。 */
  matchIndex: number
  /** 请求下一个匹配（回车；循环取模由面板/图谱侧完成）。 */
  onMatchNext: () => void
  counts: Record<string, number>
  hidden: ReadonlySet<string>
  onToggleKind: (kind: GraphNode['kind']) => void
  onlyConnected: boolean
  onToggleConnected: () => void
  connectedAvailable: boolean
  /** 全部可见节点（图例的代表形状从实际数据导出，不复制映射 —— 单一真相源）。 */
  allNodes: GraphNode[]
}

const LAYOUT_MODES: readonly LayoutMode[] = ['layered', 'radial']
const COLOR_MODES: readonly ColorMode[] = ['tone', 'kind', 'stage']

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
            if (event.key === 'Enter' && props.matches.length > 0) {
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
            {props.matches.length === 0 ? (
              <li className="rg-search-noresult">{t('graph.noResults')}</li>
            ) : (
              props.matches.map((node, index) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => props.onLocate(node.id)}
                    aria-current={index === props.matchIndex}
                  >
                    <span className={`rg-dot rg-dot-${node.tone}`} aria-hidden />
                    {node.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        {/* 第 n/m 指示：多匹配时用户必须知道自己在遍历的第几个。 */}
        {props.query.trim() !== '' && props.matches.length > 1 && (
          <span className="rg-search-index" role="status">
            {t('graph.matchIndex', { index: props.matchIndex + 1, total: props.matches.length })}
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
