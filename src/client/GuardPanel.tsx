import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { t } from './i18n.ts'
import type { FetchResult, PanelAction } from './api.ts'
import { GuardGraph, type GraphView } from './GuardGraph.tsx'
import type { PanelSnapshot } from '../../src/snapshot.ts'
import type { GraphData } from '../../src/graph-data.ts'

/**
 * 管理面板 —— 守护的状态、指标、排名、能力矩阵、图谱与分区。
 *
 * ## 布局原则
 *
 * - **响应式**：用 CSS Grid 的 `auto-fit` + `minmax` 让卡片自动换行，
 *   窄屏（<720px）降为单列。不写死像素宽度。
 * - **颜色不是唯一通道**：每个状态/风险都带文字标签；形状通道在图谱里。
 * - **主题变量**：只用 `--dsw-alias-*` 与 `--dsw-radius-*` 家族，
 *   硬编码颜色仅用于图形本身（SVG 的形状填充）。
 *
 * ## 数据一致性
 *
 * 面板渲染**同一份快照**。快照与图谱分别拉取，但都来自宿主的一次成型投影，
 * 因此界面上不会出现「状态是 A 时刻、指标是 B 时刻」的自相矛盾。
 */

export interface GuardPanelProps {
  fetchSnapshot: () => Promise<FetchResult<PanelSnapshot>>
  fetchGraph: () => Promise<FetchResult<GraphData>>
  postAction: (action: PanelAction, payload?: Record<string, unknown>) => Promise<FetchResult<unknown>>
}

/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL = 5000

export function GuardPanel(props: GuardPanelProps): ReactElement {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    const [snapshotResult, graphResult] = await Promise.all([props.fetchSnapshot(), props.fetchGraph()])
    if (!mounted.current) return
    if (snapshotResult.ok) {
      setSnapshot(snapshotResult.data)
      setFailure(null)
    } else {
      setFailure(snapshotResult.reason)
    }
    if (graphResult.ok) setGraph(graphResult.data)
  }, [props.fetchSnapshot, props.fetchGraph])

  useEffect(() => {
    mounted.current = true
    void load()
    const timer = setInterval(() => void load(), POLL_INTERVAL)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [load])

  const runAction = useCallback(
    async (action: PanelAction, payload: Record<string, unknown> = {}): Promise<void> => {
      setBusy(true)
      try {
        const result = await props.postAction(action, payload)
        if (!result.ok) setFailure(result.reason)
        await load()
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [props.postAction, load],
  )

  if (failure !== null && snapshot === null) {
    return (
      <section className="rg-panel" aria-busy={false}>
        <header className="rg-header">
          <h1 className="rg-title">{t('panel.title')}</h1>
          <p className="rg-subtitle">{t('panel.unavailable')}</p>
        </header>
        <p className="rg-empty" role="status">
          {t('panel.unavailableHint')}
        </p>
        <p className="rg-error" role="alert">
          {failure}
        </p>
      </section>
    )
  }

  if (snapshot === null) {
    return (
      <section className="rg-panel" aria-busy>
        <header className="rg-header">
          <h1 className="rg-title">{t('panel.title')}</h1>
        </header>
        <p className="rg-empty" role="status">
          {t('panel.loading')}
        </p>
      </section>
    )
  }

  return (
    <section className="rg-panel" aria-busy={busy}>
      <header className="rg-header">
        <div>
          <h1 className="rg-title">{t('panel.title')}</h1>
          <p className="rg-subtitle">
            {t('panel.subtitle')} · {snapshot.profile} · {snapshot.projectKey.slice(0, 8)}
          </p>
        </div>
        <div className="rg-actions">
          <button type="button" className="rg-button" onClick={() => void load()} disabled={busy}>
            {t('panel.refresh')}
          </button>
          <button type="button" className="rg-button" onClick={() => void runAction('recover')} disabled={busy}>
            {t('panel.recover')}
          </button>
          <button
            type="button"
            className="rg-button rg-button-danger"
            onClick={() => {
              if (typeof window !== 'undefined' && !window.confirm(t('panel.archiveConfirm'))) return
              void runAction('archive', { reason: '面板手动归档' })
            }}
            disabled={busy}
          >
            {t('panel.archive')}
          </button>
        </div>
      </header>

      <div className="rg-grid">
        <LifecycleCard snapshot={snapshot} />
        <MetricsCard snapshot={snapshot} />
        <RisksCard snapshot={snapshot} onReenable={(bundle) => void runAction('reenable', { bundle })} />
        <CapabilityCard snapshot={snapshot} />
        <PartitionsCard snapshot={snapshot} />
      </div>

      <div className="rg-section">
        <h2 className="rg-section-title">{t('sections.graph')}</h2>
        {graph === null ? (
          <p className="rg-empty">{t('graph.empty')}</p>
        ) : (
          <GuardGraph graph={graph} />
        )}
      </div>

      {failure !== null && (
        <p className="rg-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  )
}

/** 生命周期卡片。 */
function LifecycleCard({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  return (
    <article className="rg-card">
      <h2 className="rg-card-title">{t('sections.state')}</h2>
      <dl className="rg-dl">
        <dt>{t('state.stage')}</dt>
        <dd>
          <span className={`rg-badge rg-badge-${snapshot.stage}`}>{snapshot.stageLabel}</span>
        </dd>
        <dt>{t('state.stability')}</dt>
        <dd>
          {snapshot.stabilityScore.toFixed(2)}
          <span className="rg-bar" aria-hidden>
            <span className="rg-bar-fill" style={{ width: `${Math.round(snapshot.stabilityScore * 100)}%` }} />
          </span>
        </dd>
      </dl>
      <h3 className="rg-card-subtitle">{t('state.transitions')}</h3>
      {snapshot.transitions.length === 0 ? (
        <p className="rg-empty">{t('state.noTransitions')}</p>
      ) : (
        <ol className="rg-transitions">
          {snapshot.transitions.slice(-8).map((transition, index) => (
            <li key={`${transition.at}-${index}`} className="rg-transition">
              <span className={`rg-badge rg-badge-${transition.to}`}>{transition.to}</span>
              <span className="rg-transition-reason">{transition.reason}</span>
              <time className="rg-transition-time">{transition.at.slice(11, 19)}</time>
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

/** 量化指标卡片。 */
function MetricsCard({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const metrics = snapshot.metrics
  const items: Array<{ label: string; metric: { value: number | null; defined: boolean; label: string } }> = [
    { label: t('metrics.crashRate'), metric: metrics.crashRate },
    { label: t('metrics.meanRecoveryTime'), metric: metrics.meanRecoveryTime },
    { label: t('metrics.detectionRate'), metric: metrics.detectionRate },
    { label: t('metrics.isolationPurity'), metric: metrics.isolationPurity },
  ]
  return (
    <article className="rg-card">
      <h2 className="rg-card-title">{t('sections.metrics')}</h2>
      <ul className="rg-metrics">
        {items.map((item) => (
          <li key={item.label} className="rg-metric">
            <span className="rg-metric-label">{item.label}</span>
            <span className={`rg-metric-value${item.metric.defined ? '' : ' rg-metric-undefined'}`}>
              {item.metric.defined ? item.metric.label : t('metrics.undefined')}
            </span>
            {item.metric.defined && item.metric.value !== null && (
              <span className="rg-bar" aria-hidden>
                <span className="rg-bar-fill" style={{ width: `${Math.round(item.metric.value * 100)}%` }} />
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="rg-trend">
        <span className="rg-metric-label">{t('metrics.trend')}</span>
        <span className={`rg-badge rg-badge-${metrics.trend.verdict}`}>
          {t(`trend.${metrics.trend.verdict}`)}
        </span>
        <span className="rg-metric-detail">
          {metrics.trend.samples} samples · slope {metrics.trend.rawSlope}
        </span>
      </div>
    </article>
  )
}

/** 嫌疑排名卡片。 */
function RisksCard({
  snapshot,
  onReenable,
}: {
  snapshot: PanelSnapshot
  onReenable: (bundle: string) => void
}): ReactElement {
  return (
    <article className="rg-card">
      <h2 className="rg-card-title">{t('sections.risks')}</h2>
      {snapshot.risks.length === 0 ? (
        <p className="rg-empty">{t('risks.empty')}</p>
      ) : (
        <ul className="rg-risks">
          {snapshot.risks.slice(0, 8).map((risk) => (
            <li key={risk.bundle} className="rg-risk">
              <div className="rg-risk-main">
                <span className="rg-risk-name">{risk.bundle}</span>
                {risk.experimental && <span className="rg-chip">{t('risks.experimental')}</span>}
                <span className="rg-risk-score">{risk.risk.toFixed(2)}</span>
              </div>
              <span className="rg-bar" aria-hidden>
                <span className="rg-bar-fill" style={{ width: `${Math.round(risk.risk * 100)}%` }} />
              </span>
              <div className="rg-risk-actions">
                <button
                  type="button"
                  className="rg-button rg-button-small"
                  onClick={() => onReenable(risk.bundle)}
                >
                  {t('panel.reenable')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/** 能力矩阵卡片。 */
function CapabilityCard({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const capability = snapshot.capability
  return (
    <article className="rg-card">
      <h2 className="rg-card-title">{t('sections.capabilities')}</h2>
      <dl className="rg-dl">
        <dt>{t('capabilities.total')}</dt>
        <dd>{capability.total}</dd>
        <dt>{t('capabilities.exposed')}</dt>
        <dd>{capability.exposed}</dd>
        <dt>{t('capabilities.connected')}</dt>
        <dd>{capability.connected}</dd>
        <dt>{t('capabilities.connectivity')}</dt>
        <dd>{(capability.connectivity * 100).toFixed(0)}%</dd>
      </dl>
      <h3 className="rg-card-subtitle">{t('capabilities.gaps')}</h3>
      {capability.gaps.length === 0 ? (
        <p className="rg-empty">{t('capabilities.noGaps')}</p>
      ) : (
        <ul className="rg-gaps">
          {capability.gaps.map((gap, index) => (
            <li key={`${gap.kind}-${gap.capability}-${index}`} className="rg-gap">
              <span className="rg-badge rg-badge-error">{gapLabel(gap.kind)}</span>
              <span className="rg-gap-detail">
                {gap.capability} · {gap.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/** 项目分区卡片。 */
function PartitionsCard({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  return (
    <article className="rg-card">
      <h2 className="rg-card-title">{t('partitions.title')}</h2>
      <p className="rg-card-note">{t('partitions.hint')}</p>
      {snapshot.partitions.length === 0 ? (
        <p className="rg-empty">{t('partitions.empty')}</p>
      ) : (
        <ul className="rg-partitions">
          {snapshot.partitions.map((partition) => (
            <li key={partition.key} className="rg-partition">
              <span className="rg-partition-label">{partition.label}</span>
              {partition.key === snapshot.projectKey && (
                <span className="rg-chip">{t('partitions.current')}</span>
              )}
              <span className="rg-partition-workspace">{partition.workspace}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/** 缺口的可读标签。 */
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

export type { GraphView }
