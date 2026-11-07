import { useState, type ReactElement, type ReactNode } from 'react'
import { t } from './i18n.ts'
import type { GraphData } from '../../src/graph-data.ts'
import type { PanelSnapshot } from '../../src/snapshot.ts'
import {
  agoLabel,
  capabilityRows,
  decisionHistory,
  formatClock,
  formatDateTime,
  metricRows,
  namesOf,
  partitionView,
  stageLabelOf,
  stageRail,
  type DecisionEntry,
  type PartitionOption,
} from './panel-model.ts'

/**
 * 面板的**内容卡片** —— 全部是展示层，数据由 GuardPanel 拉取后传下来。
 *
 * 拆分的理由与图谱一致：GuardPanel 曾经是「取数 + 轮询 + 12 个内联渲染块」
 * 的单文件，任何一处排版调整都要在 600 行里定位。现在 GuardPanel 只负责
 * 生命周期（取数/轮询/动作），卡片各自回答「这一块事实怎么读」。
 *
 * 诚实边界贯穿全部卡片：不可判定的读数显示「不可判定」并附原因，
 * 空态与加载态各有自己的文案，绝不把「没有数据」渲染成「一切为零」。
 */

/* ---------- 可折叠卡片骨架 ---------- */

export function Card({
  id,
  title,
  collapsed,
  onToggle,
  children,
  hint,
}: {
  id: string
  title: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
  hint?: string
}): ReactElement {
  // 「扩大」是卡片自身的第二状态（v0.9.1）：默认内容区限高、内部滚动；
  // 扩大后解除限高，让卡片按内容自然伸展。与折叠态独立 ——
  // 折叠是「收起来」，扩大是「摊开来」。
  const [enlarged, setEnlarged] = useState(false)
  return (
    <article
      className={`rg-card${collapsed ? ' rg-card-collapsed' : ''}${enlarged ? ' rg-card-enlarged' : ''}`}
      data-card-id={id}
    >
      <button
        type="button"
        className="rg-card-head"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={`rg-card-body-${id}`}
      >
        <span className="rg-card-title">{title}</span>
        {hint !== undefined && <span className="rg-card-head-hint">{hint}</span>}
        {/* 扩大按钮必须 stopPropagation：它是头部内的第二个动作，
            点它不该触发折叠。 */}
        <span
          className="rg-card-expand"
          role="button"
          tabIndex={0}
          aria-pressed={enlarged}
          aria-label={enlarged ? t('card.shrink') : t('card.enlarge')}
          title={enlarged ? t('card.shrink') : t('card.enlarge')}
          onClick={(event) => {
            event.stopPropagation()
            setEnlarged((current) => !current)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              setEnlarged((current) => !current)
            }
          }}
        >
          {enlarged ? '⤡' : '⤢'}
        </span>
        <span className="rg-card-chevron" aria-hidden>
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {!collapsed && (
        <div className="rg-card-body" id={`rg-card-body-${id}`}>
          {children}
        </div>
      )}
    </article>
  )
}

/* ---------- KPI 摘要条 ---------- */

export function KpiStrip({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const metrics = snapshot.metrics
  const crashRate = metrics.crashRate.defined ? metrics.crashRate.value : null
  const pressure = metrics.crashPressure.defined ? metrics.crashPressure.value : null
  return (
    <div className="rg-kpis" role="group" aria-label={t('kpi.title')}>
      <div className="rg-kpi">
        <StabilityRing score={snapshot.stabilityScore} />
        <div className="rg-kpi-meta">
          <span className="rg-kpi-label">{t('state.stability')}</span>
          <span className="rg-kpi-value">{snapshot.stabilityScore.toFixed(2)}</span>
        </div>
      </div>
      <div className="rg-kpi">
        <span className={`rg-badge rg-badge-${snapshot.stage}`}>{stageLabelOf(snapshot.stage, snapshot.stageLabel)}</span>
        <span className="rg-kpi-label">{t('state.stage')}</span>
      </div>
      <div className="rg-kpi">
        <span className="rg-kpi-value rg-kpi-big">
          {crashRate !== null ? `${(crashRate * 100).toFixed(1)}%` : t('metrics.undefined')}
        </span>
        <span className="rg-kpi-label">{t('metrics.crashRate')}</span>
        {metrics.crashRate.defined && <span className="rg-kpi-detail">{metrics.crashRate.label}</span>}
      </div>
      <div className="rg-kpi">
        <span className="rg-kpi-value rg-kpi-big">{pressure !== null ? pressure.toFixed(2) : t('metrics.undefined')}</span>
        <span className="rg-kpi-label">{t('metrics.crashPressure')}</span>
        {metrics.crashPressure.defined && <span className="rg-kpi-detail">{metrics.crashPressure.label}</span>}
      </div>
      <div className="rg-kpi">
        <span className={`rg-badge rg-badge-${metrics.trend.verdict}`}>{t(`trend.${metrics.trend.verdict}`)}</span>
        <span className="rg-kpi-label">{t('metrics.trend')}</span>
        {metrics.trend.samples > 0 && (
          <span className="rg-kpi-detail">
            {t('metrics.trendSamples', { count: metrics.trend.samples, slope: metrics.trend.rawSlope })}
          </span>
        )}
      </div>
      <div className="rg-kpi">
        <span className="rg-kpi-value">{metrics.changePoint.defined ? t('kpi.changePointYes') : t('kpi.changePointNo')}</span>
        <span className="rg-kpi-label">{t('metrics.changePoint')}</span>
        {metrics.changePoint.defined && metrics.changePoint.value !== null && (
          <span className="rg-kpi-detail">{metrics.changePoint.label}</span>
        )}
      </div>
    </div>
  )
}

/** 稳定性圆环 —— SVG 弧长 = 评分 × 周长（颜色之外还有数字通道）。 */
function StabilityRing({ score }: { score: number }): ReactElement {
  const clamped = Math.min(1, Math.max(0, score))
  const radius = 18
  const circumference = 2 * Math.PI * radius
  const dash = circumference * clamped
  return (
    <svg
      className="rg-ring"
      width="46"
      height="46"
      viewBox="0 0 46 46"
      role="img"
      aria-label={`${t('state.stability')} ${clamped.toFixed(2)}`}
    >
      <circle cx="23" cy="23" r={radius} fill="none" stroke="var(--dsw-alias-bg-layer-2)" strokeWidth="5" />
      <circle
        cx="23"
        cy="23"
        r={radius}
        fill="none"
        stroke="var(--dsw-alias-brand-primary)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference - dash}`}
        transform="rotate(-90 23 23)"
      />
      <text x="23" y="27" textAnchor="middle" className="rg-ring-text">
        {Math.round(clamped * 100)}
      </text>
    </svg>
  )
}

/* ---------- 生命周期 ---------- */

export function LifecycleBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const rail = stageRail(snapshot.stage, snapshot.transitions)
  const verdict = snapshot.lastRecoveryVerdict
  return (
    <>
      {/* 恢复判定条（v0.9.1）：有判定才渲染 —— undefined（从未崩溃过）
          不造一条假判定；act=false（观察轮）用中性色而非红，
          「观察中」不是错误。 */}
      {verdict !== undefined && (
        <p
          className={`rg-verdict${verdict.act ? ' rg-verdict-act' : ' rg-verdict-watch'}`}
          role="status"
        >
          <span className="rg-verdict-tag">{verdict.act ? t('verdict.act') : t('verdict.watch')}</span>
          {verdict.label}
          <span className="rg-verdict-meta">
            {t('verdict.rounds', { rounds: verdict.rounds, required: verdict.required })}
          </span>
        </p>
      )}
      <ol className="rg-stage-rail" aria-label={t('state.stages')}>
        {rail.map((cell) => (
          <li key={cell.stage} className={`rg-stage-cell rg-stage-${cell.state}`} aria-current={cell.state === 'current' ? 'step' : undefined}>
            <span className="rg-stage-dot" aria-hidden />
            <span className="rg-stage-name">{cell.label}</span>
          </li>
        ))}
      </ol>
      <dl className="rg-dl">
        <dt>{t('state.stability')}</dt>
        <dd>
          {snapshot.stabilityScore.toFixed(2)}
          <span className="rg-bar" aria-hidden>
            <span className="rg-bar-fill" style={{ width: `${Math.round(snapshot.stabilityScore * 100)}%` }} />
          </span>
        </dd>
        <dt>{t('state.transitions')}</dt>
        <dd>{snapshot.transitions.length}</dd>
        <dt>{t('state.autoDisabled')}</dt>
        <dd>{snapshot.autoDisabled.length}</dd>
        <dt>{t('state.restored')}</dt>
        <dd>{snapshot.restored.length}</dd>
      </dl>
      {snapshot.transitions.length === 0 ? (
        <p className="rg-empty">{t('state.noTransitions')}</p>
      ) : (
        <ol className="rg-transitions">
          {snapshot.transitions.slice(-8).map((transition, index) => (
            <li key={`${transition.at}-${index}`} className="rg-transition">
              <span className={`rg-badge rg-badge-${transition.to}`}>{stageLabelOf(transition.to)}</span>
              <span className="rg-transition-reason" title={transition.reason}>
                {transition.reason}
              </span>
              <time className="rg-transition-time">{formatClock(transition.at)}</time>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

/* ---------- 指标 ---------- */

export function MetricsBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const rows = metricRows(snapshot)
  return (
    <ul className="rg-metrics">
      {rows.map((row) => (
        <li key={row.key} className="rg-metric">
          <span className="rg-metric-label">{row.label}</span>
          <span className={`rg-metric-value${row.defined ? '' : ' rg-metric-undefined'}`}>{row.value}</span>
          {row.bar !== null && (
            <span className="rg-bar rg-bar-wide" aria-hidden>
              <span className="rg-bar-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, row.bar)) * 100)}%` }} />
            </span>
          )}
          {/* 不可判定 = 说清原因，不是留白（「无数据」与「零」是两件事）。 */}
          {row.reason !== null && <span className="rg-metric-reason">{row.reason}</span>}
        </li>
      ))}
    </ul>
  )
}

/* ---------- 嫌疑排名 ---------- */

export function RisksBody({
  snapshot,
  onReenable,
}: {
  snapshot: PanelSnapshot
  onReenable: (bundle: string) => void
}): ReactElement {
  if (snapshot.risks.length === 0) return <p className="rg-empty">{t('risks.empty')}</p>
  // v0.8.1：默认展开 15 行 + 显式「还有 N 个」展开按钮。
  // 此前静默 slice(0, 8)：装了 20 个插件的 profile 在面板上只看得见 8 个，
  // 且没有任何提示 —— 「排名显示不全」的实测根源就在这里。
  // 用局部 useState 而不是卡片折叠：展开的是列表，不是整张卡。
  const INITIAL_VISIBLE = 15
  const [showAllRisks, setShowAllRisks] = useState(false)
  const visibleRisks = showAllRisks ? snapshot.risks : snapshot.risks.slice(0, INITIAL_VISIBLE)
  const hiddenCount = snapshot.risks.length - visibleRisks.length
  return (
    <>
      <ul className="rg-risks">
        {visibleRisks.map((risk) => (
          <li key={risk.bundle} className="rg-risk">
            <div className="rg-risk-main">
              <span className="rg-risk-name" title={risk.bundle}>
                {risk.bundle}
              </span>
              {risk.experimental && <span className="rg-chip">{t('risks.experimental')}</span>}
              <span className="rg-risk-score">{risk.risk.toFixed(2)}</span>
            </div>
            <span className="rg-bar rg-bar-wide" aria-hidden>
              <span className="rg-bar-fill" style={{ width: `${Math.round(risk.risk * 100)}%` }} />
            </span>
            <span className="rg-risk-detail">{risk.label}</span>
            <div className="rg-risk-actions">
              <button type="button" className="rg-button rg-button-small" onClick={() => onReenable(risk.bundle)}>
                {t('panel.reenable')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button type="button" className="rg-link rg-risks-expand" onClick={() => setShowAllRisks(true)}>
          {t('risks.showMore', { count: hiddenCount })}
        </button>
      )}
    </>
  )
}

/* ---------- 备份策略（v0.9：只读投影 + 指引；改配置走宿主设置页） ---------- */

export function BackupPolicyBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const p = snapshot.backupPolicy
  return (
    <>
      <dl className="rg-dl">
        <dt>{t('backupPolicy.versioned')}</dt>
        <dd>{p.versionedBackups ? t('backupPolicy.on') : t('backupPolicy.off')}</dd>
        <dt>{t('backupPolicy.retain')}</dt>
        <dd>{p.retain}</dd>
        <dt>{t('backupPolicy.editor')}</dt>
        <dd>{p.configEditorAvailable ? t('backupPolicy.on') : t('backupPolicy.off')}</dd>
        <dt>{t('backupPolicy.root')}</dt>
        <dd className="rg-mono" title={p.root}>{p.root}</dd>
      </dl>
      <p className="rg-empty">{t('backupPolicy.hint')}</p>
    </>
  )
}

/* ---------- 能力清单（注册 / 生产 / 消费） ---------- */

export function CapabilityBody({
  snapshot,
  graph,
  selectedId,
  onSelect,
}: {
  snapshot: PanelSnapshot
  graph: GraphData | null
  selectedId: string | null
  onSelect: (id: string | null) => void
}): ReactElement {
  const capability = snapshot.capability
  const [expanded, setExpanded] = useState(false)
  const rows = capabilityRows(graph, expanded ? 200 : 8)
  const exposedCount = graph ? graph.nodes.filter((node) => node.kind === 'capability' && (node.weight ?? 0) > 0).length : capability.exposed

  return (
    <>
      <dl className="rg-dl">
        <dt>{t('capabilities.total')}</dt>
        <dd>{capability.total}</dd>
        <dt>{t('capabilities.exposed')}</dt>
        <dd>
          {capability.exposed}
          {graph !== null && exposedCount !== capability.exposed && (
            <span className="rg-chip rg-chip-warn" title={t('capabilities.exposedMismatch')}>
              {t('capabilities.graphSays', { count: exposedCount })}
            </span>
          )}
        </dd>
        <dt>{t('capabilities.connected')}</dt>
        <dd>{capability.connected}</dd>
        <dt>{t('capabilities.connectivity')}</dt>
        <dd>{(capability.connectivity * 100).toFixed(0)}%</dd>
        <dt>{t('capabilities.components')}</dt>
        <dd>
          {snapshot.graphConnectivity.components} · {t('capabilities.isolatedCount', { count: snapshot.graphConnectivity.isolated })}
        </dd>
      </dl>

      <h3 className="rg-card-subtitle">{t('capabilities.list')}</h3>
      {graph === null ? (
        // 生产/消费链路只在图谱数据里；拿不到就**说清楚**，不假装「没有依赖」。
        <p className="rg-empty">{t('capabilities.graphMissing')}</p>
      ) : rows.length === 0 ? (
        <p className="rg-empty">{t('capabilities.none')}</p>
      ) : (
        <>
          <table className="rg-table">
            <thead>
              <tr>
                <th scope="col">{t('capabilities.colName')}</th>
                <th scope="col">{t('capabilities.colStage')}</th>
                <th scope="col">{t('capabilities.colExposed')}</th>
                <th scope="col">{t('capabilities.colConsumes')}</th>
                <th scope="col">{t('capabilities.colConsumedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={row.id === selectedId ? 'rg-row-selected' : undefined}
                  onClick={() => onSelect(row.id === selectedId ? null : row.id)}
                  aria-selected={row.id === selectedId}
                >
                  <th scope="row">
                    <span className="rg-strong">{row.label}</span>
                    <code className="rg-mono rg-block">{row.id}</code>
                  </th>
                  <td>{row.stage === '' ? '—' : stageLabelOf(row.stage as never, row.stage)}</td>
                  <td>{row.exposed ? t('capabilities.yes') : '—'}</td>
                  <td>
                    <NameList ids={row.consumes} graph={graph} />
                  </td>
                  <td>
                    <NameList ids={row.consumedBy} graph={graph} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {capabilityRows(graph, 200).length > 8 && (
            <button type="button" className="rg-button rg-button-small" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
              {expanded ? t('capabilities.collapse') : t('capabilities.expand', { count: capabilityRows(graph, 200).length })}
            </button>
          )}
        </>
      )}

      <h3 className="rg-card-subtitle">{t('capabilities.gaps')}</h3>
      {capability.gaps.length === 0 ? (
        <p className="rg-empty">{t('capabilities.noGaps')}</p>
      ) : (
        <ul className="rg-gaps">
          {capability.gaps.map((gap, index) => (
            <li key={`${gap.kind}-${gap.capability}-${index}`} className="rg-gap">
              <span className="rg-badge rg-badge-error">{gapLabel(gap.kind)}</span>
              <span className="rg-gap-detail" title={`${gap.capability} · ${gap.detail}`}>
                {gap.capability} · {gap.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** 依赖名字列表 —— 最多两个 chip + 溢出计数（完整清单在 title 里）。 */
function NameList({ ids, graph }: { ids: readonly string[]; graph: GraphData | null }): ReactElement {
  if (ids.length === 0) return <span className="rg-muted">—</span>
  const names = namesOf(ids, graph)
  return (
    <span className="rg-names" title={names.join('、')}>
      {names.slice(0, 2).map((name) => (
        <span key={name} className="rg-chip">
          {name}
        </span>
      ))}
      {names.length > 2 && <span className="rg-chip rg-chip-more">+{names.length - 2}</span>}
    </span>
  )
}

/** 缺口行 —— 把缺口节点画进图里只是一半，另一半是让它在这里可读。 */
function gapLabel(kind: string): string {
  switch (kind) {
    case 'broken-consumption':
      return t('capabilities.gapBroken')
    case 'over-production':
      return t('capabilities.gapOver')
    case 'isolated':
      return t('capabilities.gapIsolated')
    case 'undeclared-registration':
      return t('capabilities.gapUndeclared')
    case 'unregistered-declaration':
      return t('capabilities.gapMissing')
    default:
      return kind
  }
}

/* ---------- 崩溃决策历史 ---------- */

export function DecisionsBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const entries: DecisionEntry[] = decisionHistory(snapshot)
  if (entries.length === 0) return <p className="rg-empty">{t('decisions.empty')}</p>
  return (
    <ol className="rg-decisions">
      {entries.map((entry, index) => (
        <li key={`${entry.kind}-${entry.at}-${index}`} className="rg-decision">
          <span className={`rg-badge rg-badge-${decisionTone(entry.kind)}`}>{t(`decisions.kind.${entry.kind}`)}</span>
          <span className="rg-decision-detail" title={entry.detail}>
            {entry.bundle !== null && <strong className="rg-decision-bundle">{entry.bundle}</strong>}
            {entry.bundle !== null && ' · '}
            {entry.detail}
          </span>
          <time className="rg-decision-time">{entry.at === '' ? t('decisions.unknownTime') : formatDateTime(entry.at)}</time>
        </li>
      ))}
    </ol>
  )
}

function decisionTone(kind: DecisionEntry['kind']): string {
  switch (kind) {
    case 'crash':
      return 'error'
    case 'disabled':
      return 'warn'
    case 'restored':
      return 'success'
    default:
      return 'neutral'
  }
}

/* ---------- 项目隔离 ---------- */

export function PartitionsBody({
  snapshot,
  selectedKey,
  onSelect,
}: {
  snapshot: PanelSnapshot
  selectedKey: string
  onSelect: (key: string) => void
}): ReactElement {
  const view = partitionView(snapshot, selectedKey)
  return (
    <>
      <p className="rg-card-note">{t('partitions.hint')}</p>
      {view.options.length === 0 ? (
        <p className="rg-empty">{t('partitions.empty')}</p>
      ) : (
        <>
          <label className="rg-field">
            <span className="rg-field-label">{t('partitions.select')}</span>
            <select className="rg-select" value={view.selectedKey} onChange={(event) => onSelect(event.target.value)}>
              {view.options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.current ? `${option.label} · ${t('partitions.current')}` : option.label}
                </option>
              ))}
            </select>
          </label>
          <ul className="rg-partitions">
            {view.options.map((option) => (
              <PartitionRow key={option.key} option={option} selected={option.key === view.selectedKey} onSelect={onSelect} />
            ))}
          </ul>
        </>
      )}
      <p className="rg-card-note rg-muted">{t('partitions.writeNote')}</p>
    </>
  )
}

function PartitionRow({
  option,
  selected,
  onSelect,
}: {
  option: PartitionOption
  selected: boolean
  onSelect: (key: string) => void
}): ReactElement {
  return (
    <li className={`rg-partition${selected ? ' rg-partition-selected' : ''}`}>
      <span className="rg-partition-label" title={option.label}>
        {option.label}
      </span>
      {option.current && <span className="rg-chip">{t('partitions.current')}</span>}
      {selected && !option.current && <span className="rg-chip rg-chip-warn">{t('partitions.inspecting')}</span>}
      <span className="rg-partition-workspace" title={option.workspace}>
        {option.workspace}
      </span>
      <time className="rg-partition-time">{formatDateTime(option.lastSeenAt)}</time>
      {!option.current && (
        <button type="button" className="rg-button rg-button-small" onClick={() => onSelect(option.key)}>
          {t('partitions.inspect')}
        </button>
      )}
    </li>
  )
}

/* ---------- 事件流 ---------- */

export function EventsBody({ events }: { events: PanelSnapshot['recentEvents'] }): ReactElement {
  if (events.length === 0) return <p className="rg-empty">{t('panel.emptyHint')}</p>
  return (
    <ol className="rg-events">
      {[...events]
        .slice(-12)
        .reverse()
        .map((event, index) => (
          <li key={`${event.t}-${index}`} className="rg-event">
            <time className="rg-event-time" title={event.t}>
              {formatClock(event.t)}
            </time>
            <span className={`rg-badge rg-badge-${eventTone(event.kind, event.detail)}`}>{event.kind}</span>
            <span className="rg-event-detail" title={event.detail ?? event.bundle ?? ''}>
              {event.bundle !== undefined && <strong>{event.bundle}</strong>}
              {event.bundle !== undefined && event.detail !== undefined && ' · '}
              {event.detail ?? ''}
            </span>
            <span className="rg-event-ago">{agoLabel(event.t)}</span>
          </li>
        ))}
    </ol>
  )
}

function eventTone(kind: string, detail?: string): string {
  if (kind === 'crash-detected') return 'error'
  if (kind === 'restore') return 'success'
  if (kind === 'install' || kind === 'update') return 'info'
  // 两阶段/判定事件（v0.9.1）：观察轮 warn（黄），confirmed 成功（绿）。
  // detail 是 journal 原文，识别前缀而不是另设 kind —— 存储词汇不变，
  // 呈现语义由显示层派生（同 lines 派生 display 的纪律）。
  if (kind === 'note') {
    if (typeof detail === 'string') {
      if (detail.startsWith('两阶段对账')) return detail.includes('confirmed') ? 'success' : 'warn'
      if (detail.startsWith('恢复判定')) return detail.includes('（已行动）') || detail.includes('关闭') ? 'success' : 'warn'
    }
  }
  return 'neutral'
}

/* ---------- 归档 ---------- */

export interface ArchiveEntry {
  dir?: string
  reason?: string
  at?: string
  count?: number
  summary?: { crashSeq?: number; autoDisabled?: string[]; journalEvents?: number }
}

export function ArchivesCard({
  archives,
  reason,
  onArchive,
  busy,
}: {
  archives: ArchiveEntry[]
  /** 输入框的初始值（面板给一个可编辑的建议原因）。 */
  reason: string
  /** 交回用户填写的原文；空串由调用方替换成默认原因（默认文案要走字典）。 */
  onArchive: (reason: string) => void
  busy: boolean
}): ReactElement {
  const [draft, setDraft] = useState(reason)
  return (
    <article className="rg-card" data-card-id="archives">
      <h2 className="rg-card-title">{t('sections.archives')}</h2>
      <p className="rg-card-note">{t('archives.explain')}</p>
      <div className="rg-archive-run">
        <label className="rg-field rg-field-grow">
          <span className="rg-field-label">{t('archives.reasonLabel')}</span>
          <input
            className="rg-input"
            type="text"
            value={draft}
            placeholder={t('archives.reasonPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button type="button" className="rg-button rg-button-danger" onClick={() => onArchive(draft)} disabled={busy}>
          {t('archives.run')}
        </button>
      </div>
      {archives.length === 0 ? (
        <p className="rg-empty">{t('archives.empty')}</p>
      ) : (
        <ul className="rg-archives">
          {archives.map((entry, index) => {
            const summaryParts: string[] = []
            if (typeof entry.summary?.crashSeq === 'number') summaryParts.push(t('archives.summaryCrashes', { count: entry.summary.crashSeq }))
            if (typeof entry.summary?.journalEvents === 'number') summaryParts.push(t('archives.summaryEvents', { count: entry.summary.journalEvents }))
            if (entry.summary?.autoDisabled && entry.summary.autoDisabled.length > 0) {
              summaryParts.push(`${t('archives.summaryDisabled')}: ${entry.summary.autoDisabled.join(', ')}`)
            }
            return (
              <li key={entry.dir ?? index} className="rg-archive">
                <span className="rg-archive-dir" title={entry.dir ?? ''}>
                  {entry.dir ?? `#${index + 1}`}
                </span>
                <span className="rg-archive-meta">
                  {entry.reason !== undefined && entry.reason !== '' ? `${entry.reason} · ` : ''}
                  {t('archives.entries', { count: entry.count ?? 0 })}
                  {entry.at !== undefined && entry.at !== '' ? ` · ${formatDateTime(entry.at)}` : ''}
                </span>
                {/* 旧归档没有 manifest 摘要 ⇒ 诚实省略，不显示一堆 0。 */}
                {summaryParts.length > 0 && <span className="rg-archive-summary">{summaryParts.join(' · ')}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}

/** 归档清单读取的宽容形状校验（宿主返回 unknown，这里只认数组）。 */
export function archiveEntriesOf(payload: unknown): ArchiveEntry[] {
  const archives = (payload as { archives?: unknown } | null)?.archives
  if (!Array.isArray(archives)) return []
  return archives.map((entry) => (typeof entry === 'object' && entry !== null ? (entry as ArchiveEntry) : {}))
}
