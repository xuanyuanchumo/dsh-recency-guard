import { useState, type ReactElement, type ReactNode } from 'react'
import { t } from '../i18n/i18n.ts'
import type { GraphData } from '../../shared/graph-contract.ts'
import type { PanelSnapshotView } from './snapshot-view.ts'
import {
  agoLabel,
  capabilityRows,
  decisionEvidenceRows,
  decisionHistory,
  formatClock,
  formatDateTime,
  metricRows,
  namesOf,
  partitionView,
  stabilityView,
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

/**
 * 数值格式化 —— 所有「可能可空」的读数统一走这里。
 *
 * 为什么不在每处写 `value !== null ? value.toFixed(n) : …`：宿主契约里
 * `Metric<T>`、贝叶斯/校准的嵌套读数都可能是 null（或 undefined），
 * 逐个手写判定必然漏一处（v0.16 真机就是 `intervals.cv.toFixed` 漏了）。
 * 统一入口保证「null / undefined / NaN / Infinity」都落到不可判定文案。
 */
function numText(value: unknown, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : t('metrics.undefined')
}

function pctTextOf(value: unknown, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : t('metrics.undefined')
}

/** 比例条形宽度（不可判定时给 0 宽且不渲染数值，绝不画成「0 分条」）。 */
function barPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) : 0
}

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
        <span className="rg-card-title" title={title}>
          {title}
        </span>
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

export function KpiStrip({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
  const metrics = snapshot.metrics
  // 稳定性评分可空（无样本 / 跨分区视图）：null 必须显示「不可判定」，
  // 绝不经过 Math 变成 0 分圆环（那会被读成「稳定性 0%」的假绿）。
  const stability = stabilityView(snapshot.stabilityScore)
  const crashRate = metrics !== null && metrics.crashRate.defined ? metrics.crashRate.value : null
  const pressure = metrics !== null && metrics.crashPressure.defined ? metrics.crashPressure.value : null
  return (
    <div className="rg-kpis" role="group" aria-label={t('kpi.title')}>
      <div className="rg-kpi">
        <StabilityRing score={snapshot.stabilityScore} />
        <div className="rg-kpi-meta">
          <span className="rg-kpi-label">{t('state.stability')}</span>
          <span className={`rg-kpi-value${stability.defined ? '' : ' rg-metric-undefined'}`}>{stability.text}</span>
        </div>
      </div>
      <div className="rg-kpi">
        <span className={`rg-badge rg-badge-${snapshot.stage}`}>{stageLabelOf(snapshot.stage, snapshot.stageLabel)}</span>
        <span className="rg-kpi-label">{t('state.stage')}</span>
      </div>
      {metrics === null ? (
        // 一行「不可判定 + 原因」代替 4 个假读数（跨分区视图不提供运行时指标）。
        <div className="rg-kpi">
          <span className="rg-kpi-value rg-metric-undefined">{t('metrics.undefined')}</span>
          <span className="rg-kpi-label">{t('metrics.title')}</span>
          <span className="rg-kpi-detail">{t('metrics.unavailableReason')}</span>
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}

/**
 * 稳定性圆环 —— SVG 弧长 = 评分 × 周长（颜色之外还有数字通道）。
 *
 * 评分 null（无样本 / 跨分区视图）时画**空轨道 + 「?」**而不是 0 分圆环：
 * 「不可判定」必须与「0 分」在视觉上可区分，否则用户会把「还没样本」
 * 读成「稳定性崩了」。
 */
function StabilityRing({ score }: { score: number | null }): ReactElement {
  const stability = stabilityView(score)
  const radius = 18
  const circumference = 2 * Math.PI * radius
  const dash = (circumference * stability.percent) / 100
  return (
    <svg
      className={`rg-ring${stability.defined ? '' : ' rg-ring-undefined'}`}
      width="46"
      height="46"
      viewBox="0 0 46 46"
      role="img"
      aria-label={`${t('state.stability')} ${stability.text}`}
    >
      <circle cx="23" cy="23" r={radius} fill="none" stroke="var(--dsw-alias-bg-layer-2)" strokeWidth="5" />
      {stability.defined ? (
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
      ) : null}
      <text x="23" y="27" textAnchor="middle" className="rg-ring-text">
        {stability.defined ? Math.round(stability.percent) : '?'}
      </text>
    </svg>
  )
}

/* ---------- 生命周期 ---------- */

/**
 * 迁移列表的渲染层初始条数（与事件流/风险卡同一纪律：截断只发生在渲染层，
 * 且必须显式给出「省略 N 条 + 展开按钮」）。
 */
const TRANSITIONS_INITIAL = 8

export function LifecycleBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
  const rail = stageRail(snapshot.stage, snapshot.transitions)
  const stability = stabilityView(snapshot.stabilityScore)
  const verdict = snapshot.lastRecoveryVerdict
  // 迁移列表的渲染层上限 + 显式「还有 N 次」按钮。
  // 此前是静默 `slice(-8)`：崩溃 20 次的 profile 只露出最后 8 条，且没有任何
  // 提示说「还有更早的」—— 与 risks 卡当年同款缺陷（CLAUDE.md 已记录过一次）。
  // useState 在任何提前 return 之前调用（Rules of Hooks；本函数没有早退，
  // 但把它写在顶部让「加早退」不会悄悄破坏 hook 顺序）。
  const [showAllTransitions, setShowAllTransitions] = useState(false)
  // 保留**原始下标**而不是切片后的下标：切片后取 key 会让「展开」这一步
  // 把已渲染的行整体重新挂载（key 变了），列表闪一下且滚动位置丢。
  const transitionsIndexed = snapshot.transitions.map((transition, index) => ({ transition, index }))
  const visibleTransitions = showAllTransitions
    ? transitionsIndexed
    : transitionsIndexed.slice(-TRANSITIONS_INITIAL)
  const omittedTransitions = transitionsIndexed.length - visibleTransitions.length
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
          <span className={stability.defined ? undefined : 'rg-metric-undefined'}>{stability.text}</span>
          {stability.defined && (
            <span className="rg-bar" aria-hidden>
              <span className="rg-bar-fill" style={{ width: `${Math.round(stability.percent)}%` }} />
            </span>
          )}
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
        <>
          <ol className="rg-transitions">
            {visibleTransitions.map(({ transition, index }) => (
              <li key={`${transition.at}-${index}`} className="rg-transition">
                <span className={`rg-badge rg-badge-${transition.to}`}>{stageLabelOf(transition.to)}</span>
                <span className="rg-transition-reason" title={transition.reason}>
                  {transition.reason}
                </span>
                <time className="rg-transition-time">{formatClock(transition.at)}</time>
              </li>
            ))}
          </ol>
          {omittedTransitions > 0 && (
            <button type="button" className="rg-link rg-risks-expand" onClick={() => setShowAllTransitions(true)}>
              {t('state.moreTransitions', { count: omittedTransitions })}
            </button>
          )}
          {/* 展开后给一条收起路径 + 总数：收起按钮不该是唯一线索。 */}
          {showAllTransitions && snapshot.transitions.length > TRANSITIONS_INITIAL && (
            <button type="button" className="rg-link" onClick={() => setShowAllTransitions(false)}>
              {t('state.fewerTransitions')} · {snapshot.transitions.length}
            </button>
          )}
        </>
      )}
    </>
  )
}

/* ---------- 指标 ---------- */

export function MetricsBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
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
  snapshot: PanelSnapshotView
  onReenable: (bundle: string) => void
}): ReactElement {
  // Hooks 必须在提前 return 之前（Rules of Hooks）：此前 `risks.length === 0`
  // 的早退在 useState 之前，空列表与非空列表切换时 hook 槽位会错位。
  const [showAllRisks, setShowAllRisks] = useState(false)
  // 旧宿主/跨分区视图可能整段省略 risks：省略 = 无排名可读，不是「零个嫌疑」。
  const risks = snapshot.risks ?? []
  if (risks.length === 0) return <p className="rg-empty">{t('risks.empty')}</p>
  // v0.8.1：默认展开 15 行 + 显式「还有 N 个」展开按钮。
  // 此前静默 slice(0, 8)：装了 20 个插件的 profile 在面板上只看得见 8 个，
  // 且没有任何提示 —— 「排名显示不全」的实测根源就在这里。
  // 用局部 useState 而不是卡片折叠：展开的是列表，不是整张卡。
  const INITIAL_VISIBLE = 15
  const visibleRisks = showAllRisks ? risks : risks.slice(0, INITIAL_VISIBLE)
  const hiddenCount = risks.length - visibleRisks.length
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
              <span className="rg-risk-score">{numText(risk.risk, 2)}</span>
            </div>
            <span className="rg-bar rg-bar-wide" aria-hidden>
              <span className="rg-bar-fill" style={{ width: `${barPercent(risk.risk)}%` }} />
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

export function BackupPolicyBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
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

/**
 * 能力表初始行数（渲染层截断，与 risks / events 卡同款纪律）。
 * 真相在 `capabilityRows` 的全量返回里 —— 这里只决定先画几行。
 */
const CAPABILITY_INITIAL = 8

export function CapabilityBody({
  snapshot,
  graph,
  selectedId,
  onSelect,
}: {
  snapshot: PanelSnapshotView
  graph: GraphData | null
  selectedId: string | null
  onSelect: (id: string | null) => void
}): ReactElement {
  const capability = snapshot.capability
  const [expanded, setExpanded] = useState(false)
  // 跨分区只读视图不还原能力矩阵（宿主发 null）：如实说不可得，不渲染假 0。
  // 提前 return 放在 useState **之后**（Rules of Hooks：hook 槽位必须稳定）。
  if (capability === null) return <p className="rg-empty">{t('capabilities.unavailable')}</p>
  // 全量表只算**一次**：此前判断条件与展开态各调一次 `capabilityRows(graph, 200)`，
  // 一次渲染算两遍全表（每行都要扫一遍边表 ⇒ O(N·E)），而 200 本身是
  // **数据层**截断 —— 能力超过 200 项就会静默消失（CLAUDE.md 明令禁止的那条：
  // 数据给全量，截断只发生在渲染层）。这里默认取全量，显示层再切。
  const allRows = capabilityRows(graph, Number.POSITIVE_INFINITY)
  const rows = expanded ? allRows : allRows.slice(0, CAPABILITY_INITIAL)
  const omittedRows = allRows.length - rows.length
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
        <dd>{Number.isFinite(capability.connectivity) ? `${(capability.connectivity * 100).toFixed(0)}%` : t('metrics.undefined')}</dd>
        <dt>{t('capabilities.components')}</dt>
        <dd>
          {snapshot.graphConnectivity === null
            ? t('metrics.undefined')
            : `${snapshot.graphConnectivity.components} · ${t('capabilities.isolatedCount', { count: snapshot.graphConnectivity.isolated })}`}
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
          {omittedRows > 0 && (
            <button type="button" className="rg-button rg-button-small" onClick={() => setExpanded(true)} aria-expanded={expanded}>
              {t('capabilities.expand', { count: allRows.length })}
            </button>
          )}
          {/* 展开后仍要说清总数：只写「收起」会让人不知道刚才漏了几行。 */}
          {expanded && allRows.length > CAPABILITY_INITIAL && (
            <button type="button" className="rg-button rg-button-small" onClick={() => setExpanded(false)} aria-expanded={expanded}>
              {t('capabilities.collapse')} · {allRows.length}
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

export function DecisionsBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
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

/* ---------- 决策因子证据（v0.13 方向③） ---------- */

/**
 * 决策因子卡片 —— 把「为什么是它被选中」摊开成可读的三因子分解。
 *
 * 诚实边界：旧版决策文件没有 `evidence`，此时**不画假条形图**，
 * 直接说明「该决策未记录因子」。把 0 画成条形会让人误读为「零风险」。
 */
export function DecisionEvidenceBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
  const { rows, hasEvidence } = decisionEvidenceRows(snapshot)
  if (rows.length === 0) return <p className="rg-empty">{t('decisionEvidence.empty')}</p>
  if (!hasEvidence) return <p className="rg-empty">{t('decisionEvidence.legacy')}</p>
  return (
    <>
      <p className="rg-hint">{t('decisionEvidence.hint')}</p>
      <ol className="rg-evidence-list">
        {rows.map((row) => (
          <li key={row.bundle} className={`rg-evidence${row.head ? ' rg-evidence-head' : ''}`}>
            <div className="rg-evidence-head-row">
              <span className={`rg-badge rg-badge-${row.head ? 'warn' : 'neutral'}`}>#{row.rank}</span>
              <strong className="rg-evidence-bundle">{row.bundle}</strong>
              {row.head && <span className="rg-badge rg-badge-error">{t('decisionEvidence.head')}</span>}
              <span className="rg-evidence-risk" title={t('decisionEvidence.riskHint')}>
                {t('decisionEvidence.risk')} {numText(row.risk, 3)}
              </span>
            </div>
            <div className="rg-evidence-bars">
              {(
                [
                  ['recency', t('decisionEvidence.recency'), row.factors.recency, 'info'],
                  ['experimental', t('decisionEvidence.experimental'), row.factors.experimental, 'warn'],
                  ['crashFrequency', t('decisionEvidence.crashFrequency'), row.factors.crashFrequency, 'error'],
                ] as const
              ).map(([key, label, value, tone]) => (
                <div key={key} className="rg-evidence-bar-row">
                  <span className="rg-evidence-bar-label">{label}</span>
                  <span className="rg-evidence-bar-track">
                    <span
                      className={`rg-evidence-bar rg-tone-${tone}`}
                      style={{ width: `${barPercent(value)}%` }}
                    />
                  </span>
                  <span className="rg-evidence-bar-value">{numText(value, 3)}</span>
                </div>
              ))}
            </div>
            <div className="rg-evidence-meta">
              <span title={t('decisionEvidence.streakHint')}>
                {t('decisionEvidence.streak')} {row.streak}
              </span>
              <span title={t('decisionEvidence.changeCountHint')}>
                {t('decisionEvidence.changeCount')} {row.changeCount}
              </span>
              {row.source !== null && (
                <span className={`rg-badge rg-badge-${row.source === 'journal' ? 'success' : 'neutral'}`} title={t('decisionEvidence.sourceHint')}>
                  {t(`decisionEvidence.source.${row.source}`)}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}

/* ---------- 共现验证（v0.13 方向④） ---------- */

/**
 * 共现验证卡片 —— 回答「官方实验插件的活跃是否预示非官方插件出问题」。
 *
 * 这张卡的存在本身就是一种纪律：项目**先验证假设再行动**。所以它显示
 * 「样本数 / 两侧命中率 / 差值 / 能否加权」，而不是显示一个加权值 ——
 * 加权需要额外的严格化论证，当前还没有。
 *
 * 诚实边界：任一侧样本不足 ⇒ 命中率显示「不可判定」而不是 0%
 * （0% 会被读成「这类崩溃从不关插件」，那是伪造的证据）。
 */
export function CooccurrenceBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
  const c = snapshot.cooccurrence
  // 共现验证需要两套样本同时在场；跨分区视图不承诺它。
  if (c === null || c === undefined) return <p className="rg-empty">{t('cooccurrence.unavailable')}</p>
  const rate = (value: unknown): string =>
    typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : t('cooccurrence.undefined')
  const delta =
    typeof c.hitRateDelta === 'number' && Number.isFinite(c.hitRateDelta)
      ? `${(c.hitRateDelta * 100).toFixed(1)} ${t('cooccurrence.points')}`
      : t('cooccurrence.undefined')
  return (
    <>
      <p className="rg-hint">{t('cooccurrence.hint')}</p>
      <dl className="rg-diagnostics">
        <dt>{t('cooccurrence.samples')}</dt>
        <dd>
          {c.samples}（{t('cooccurrence.active')} {c.activeSamples} / {t('cooccurrence.inactive')} {c.inactiveSamples}）
        </dd>
        <dt>{t('cooccurrence.activeRate')}</dt>
        <dd>{rate(c.activeHitRate)}</dd>
        <dt>{t('cooccurrence.inactiveRate')}</dt>
        <dd>{rate(c.inactiveHitRate)}</dd>
        <dt>{t('cooccurrence.delta')}</dt>
        <dd>{delta}</dd>
      </dl>
      <p className="rg-note">{c.label}</p>
      <p className={`rg-note rg-note-${c.mayWeight.allowed ? 'ok' : 'muted'}`}>
        {c.mayWeight.allowed ? t('cooccurrence.mayWeightYes') : t('cooccurrence.mayWeightNo')}
        {c.mayWeight.reason !== '' && ` · ${c.mayWeight.reason}`}
      </p>
    </>
  )
}

/* ---------- 项目隔离 ---------- */

export function PartitionsBody({
  snapshot,
  selectedKey,
  onSelect,
}: {
  snapshot: PanelSnapshotView
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

/** 事件流默认展示条数（超出给「还有 N 条」展开按钮 —— 与 risks 卡同款纪律）。 */
const EVENTS_INITIAL = 12

export function EventsBody({ events }: { events: PanelSnapshotView['recentEvents'] }): ReactElement {
  const [showAll, setShowAll] = useState(false)
  if (events.length === 0) return <p className="rg-empty">{t('panel.emptyHint')}</p>
  // 快照给的是升序尾部；显示按时间倒序（最新在最上）。
  const ordered = [...events].reverse()
  // 快照已按 EVENT_FLOW_LIMIT 截断过一次；这里再补「显示层」截断，且必须显式计数。
  const visible = showAll ? ordered : ordered.slice(0, EVENTS_INITIAL)
  const omitted = ordered.length - visible.length
  return (
    <>
      <ol className="rg-events">
        {visible.map((event, index) => (
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
      {omitted > 0 && (
        <button type="button" className="rg-link rg-risks-expand" onClick={() => setShowAll(true)}>
          {t('events.more', { count: omitted })}
        </button>
      )}
    </>
  )
}

function eventTone(kind: string, detail?: string): string {  if (kind === 'crash-detected') return 'error'
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

/**
 * 误伤校准卡片（v0.14 / M1 / RQ2）。
 *
 * 诚实边界：`rate === null` 有两种含义 ——「还没有自动关闭记录」与
 * 「有记录但样本 < 5」。用 `autoDisables` 区分二者，绝不把任一情形
 * 画成「误伤率 0%」（那是把「没数据」谎报成「没问题」）。
 */
export function CalibrationBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
  const calibration = snapshot.calibration
  // 旧宿主/跨分区视图可能整段省略校准段：不可得 ≠ 阈值 0。
  if (calibration === null || calibration === undefined) {
    return <p className="rg-empty">{t('calibration.unavailable')}</p>
  }
  const { rate, decision, explanation } = calibration
  const sampleShort = rate.value === null
  return (
    <>
      <p className="rg-hint">{explanation}</p>
      <div className="rg-kv">
        <span className="rg-kv-key">{t('calibration.threshold')}</span>
        <span className="rg-kv-value">
          {decision.base} → <strong>{decision.required}</strong>
          {decision.delta > 0 && <span className="rg-badge rg-badge-warn">+{decision.delta}</span>}
        </span>
      </div>
      <div className="rg-kv">
        <span className="rg-kv-key">{t('calibration.rate')}</span>
        <span className="rg-kv-value">
          {sampleShort ? (
            <span className="rg-empty-inline">{t('calibration.insufficient')}</span>
          ) : (
            <>
              {pctTextOf(rate.value!.rate)}
              <span className="rg-evidence-meta">
                {' '}
                （{numText(rate.value!.falsePositives, 0)}/{numText(rate.value!.autoDisables, 0)}，95% 区间{' '}
                {pctTextOf(rate.value!.lower)}–{pctTextOf(rate.value!.upper)}）
              </span>
            </>
          )}
        </span>
      </div>
      {/* 证据链缺口（v0.15 TD-1）：**只在 >0 时显示**。
          它是「记录可能损坏」的信号，常态应为 0；恒显示一个 0 会让用户
          对它脱敏，真出问题时反而看不见。缺口 >0 时上面的误伤率不可信 ——
          两者并排出现，用户才能读出「这个 0% 是记录缺失造成的」。 */}
      {calibration.unattributedRestores > 0 && (
        <div className="rg-kv">
          <span className="rg-kv-key">{t('calibration.evidenceGap')}</span>
          <span className="rg-kv-value">
            <span className="rg-badge rg-badge-warn">{calibration.unattributedRestores}</span>
            <span className="rg-evidence-meta"> {t('calibration.evidenceGapHint')}</span>
          </span>
        </div>
      )}
    </>
  )
}
/**
 * 贝叶斯并行读数卡片（v0.14 / M2 / RQ1）。
 *
 * **并行读数纪律**：这里展示的是第二套口径，与「嫌疑排名」卡里的默认
 * `riskScore` 并列。刻意同时显示两者，让用户看见分歧 ——
 * 只显示一套会把「模型有分歧」这个重要事实藏起来。
 */
export function BayesBody({ snapshot }: { snapshot: PanelSnapshotView }): ReactElement {
  const rows = snapshot.bayes
  // 省略/为 null 是「这一段不可得」，与「有样本但零嫌疑」是两件事。
  if (rows === null || rows === undefined) return <p className="rg-empty">{t('bayes.unavailable')}</p>
  if (rows.length === 0) return <p className="rg-empty">{t('bayes.empty')}</p>
  return (
    <>
      <p className="rg-hint">{t('bayes.hint')}</p>
      <ul className="rg-bayes-list">
        {rows.map((row) => (
          <li key={row.bundle} className="rg-bayes-row">
            <strong className="rg-evidence-bundle">{row.bundle}</strong>
            {/* 样本稀疏 ⇒ 显示「不可判定」，绝不画一个 0 冒充分数。 */}
            {row.defined && row.value !== null ? (
              <>
                <span className="rg-evidence-risk">
                  {t('bayes.posterior')} {numText(row.value.mean, 3)}
                </span>
                <span className="rg-evidence-meta">
                  [{numText(row.value.lower95, 3)}, {numText(row.value.upper95, 3)}]
                </span>
                <span className="rg-evidence-meta">
                  n={numText(row.value.samples, 0)}（命中 {numText(row.value.hits, 0)} / 未命中 {numText(row.value.misses, 0)}）
                </span>
              </>
            ) : (
              <span className="rg-empty-inline">{row.reason !== '' ? row.reason : t('bayes.insufficient')}</span>
            )}
            {row.value !== null && (
              <span className="rg-evidence-meta">
                {t('bayes.score')} {numText(row.value.score, 3)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
