import type { ReactElement } from 'react'
import { t } from './i18n.ts'
import type { PanelSnapshot } from '../../src/snapshot.ts'
import { dataFlowStages, diagnosticsRows, markovView, stageLabelOf } from './panel-model.ts'

/**
 * v0.10 新增的三张洞察卡：马尔可夫矩阵、数据流、系统诊断。
 *
 * 为什么独立成文件而不是继续塞进 PanelCards：PanelCards 已经 700+ 行，
 * 「每个卡片家族一个文件」的分界比「所有卡片一个文件」更好定位；
 * 这三张卡都是**纯展示**（无动作回调），放在一起正好是一组。
 *
 * 诚实边界：markov.samples === 0 时显示「不可判定」空态（不画空矩阵）；
 * 诊断行的链接字段为 null 时渲染纯文本（绝不放死链）。
 */

/* ---------- 转移矩阵 ---------- */

export function MarkovBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const view = markovView(snapshot)
  if (!view.available) {
    return <p className="rg-empty">{t('markov.empty')}</p>
  }
  return (
    <>
      <p className="rg-card-note" title={view.summary}>
        {t('markov.samples', { count: view.samples })} · {t(view.converged ? 'markov.converged' : 'markov.notConverged')} · {view.summary}
      </p>
      <ul className="rg-markov" aria-label={t('markov.title')}>
        {view.rows.map((row) => (
          <li key={row.stage} className="rg-markov-row" title={row.label}>
            <span className="rg-markov-stage">{stageLabelOf(row.stage as never, row.stage)}</span>
            {row.barPercent !== null ? (
              <span className="rg-bar" aria-hidden>
                <span className="rg-bar-fill" style={{ width: `${row.barPercent}%` }} />
              </span>
            ) : (
              <span className="rg-markov-nodata">{t('metrics.undefined')}</span>
            )}
            <span className="rg-markov-value">{row.selfLoop !== null ? `${Math.round(row.selfLoop * 100)}%` : '—'}</span>
          </li>
        ))}
      </ul>
      {view.stationary.length > 0 && (
        <div className="rg-markov-stationary">
          <h4 className="rg-subhead">{t('markov.stationary')}</h4>
          <div className="rg-chip-row" role="list">
            {view.stationary.slice(0, 4).map((entry) => (
              <span key={entry.stage} className="rg-chip" role="listitem" title={`${entry.stage} ${entry.percent}%`}>
                {stageLabelOf(entry.stage as never, entry.stage)} {entry.percent}%
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/* ---------- 数据流 ---------- */

export function DataFlowBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const stages = dataFlowStages(snapshot)
  return (
    <ol className="rg-dataflow" aria-label={t('dataflow.title')}>
      {stages.map((stage, index) => (
        <li key={stage.key} className="rg-dataflow-step">
          <span className="rg-dataflow-index" aria-hidden>
            {index + 1}
          </span>
          <div className="rg-dataflow-main">
            <span className="rg-dataflow-label">{stage.label}</span>
            <span className="rg-dataflow-detail" title={stage.detail}>
              {stage.detail}
            </span>
          </div>
          <span className="rg-dataflow-count">{stage.count === null ? '∞' : stage.count}</span>
        </li>
      ))}
    </ol>
  )
}

/* ---------- 系统诊断 ---------- */

export function DiagnosticsBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  const rows = diagnosticsRows(snapshot)
  const issuesUrl = snapshot.diagnostics.issuesUrl
  return (
    <>
      <dl className="rg-dl rg-dl-compact">
        {rows.map((row) => (
          <div key={row.key} className="rg-dl-pair">
            <dt>{row.label}</dt>
            <dd>
              {row.href !== null ? (
                <a className="rg-link" href={row.href} target="_blank" rel="noreferrer" title={row.href}>
                  {row.value}
                </a>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      {issuesUrl !== null && (
        <a className="rg-button rg-button-small rg-issues-button" href={issuesUrl} target="_blank" rel="noreferrer" title={t('diagnostics.issuesHint')}>
          {t('diagnostics.issues')} ↗
        </a>
      )}
    </>
  )
}
