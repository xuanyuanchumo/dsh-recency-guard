import { useState, type ReactElement } from 'react'
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

/** 平稳分布的显示条数上限：**只截渲染层**（见 CLAUDE.md「数据层不做显示截断」）。
 *  view.stationary 是完整事实，这里只是「先给最占优的几档」，并且必须把
 *  省略了多少说出来 —— 静默 slice(0,4) 会让用户以为长期占比只有这 4 个阶段。 */
const STATIONARY_VISIBLE = 4

export function MarkovBody({ snapshot }: { snapshot: PanelSnapshot }): ReactElement {
  // useState 必须在**任何**提前 return 之前调用：Rules of Hooks 不是风格问题 ——
  // 早退时少调一个 hook，下一次渲染的 hook 槽位会整体错位，症状是
  // 「切换数据后状态串到别的卡上」，比报错更难查。
  const [showAllStationary, setShowAllStationary] = useState(false)
  const view = markovView(snapshot)
  const stationaryVisible = showAllStationary ? view.stationary : view.stationary.slice(0, STATIONARY_VISIBLE)
  const stationaryOmitted = view.stationary.length - stationaryVisible.length
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
            {/* 跨阶段去向徽标（v0.11）：`→ 崩溃 40%` 直接可读，高危迁移无法被忽略。 */}
            {row.exits !== null && (
              <span className="rg-markov-exits">
                {row.exits.map((exit) => (
                  <span key={exit.stage} className="rg-chip rg-chip-exit" title={row.label}>
                    → {stageLabelOf(exit.stage as never, exit.stage)} {exit.percent}%
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {view.stationary.length > 0 && (
        <div className="rg-markov-stationary">
          <h4 className="rg-subhead">{t('markov.stationary')}</h4>
          {/* 为什么不静默 slice(0,4)：长期占比的第 5、6 档可能正是「崩溃后
              未恢复」那一档 —— 被藏起来的恰恰是最该看的。省略必须计数、
              必须给展开按钮（CLAUDE.md「数据层不做显示截断」的渲染层半边）。 */}
          <div className="rg-chip-row" role="list">
            {stationaryVisible.map((entry) => (
              <span key={entry.stage} className="rg-chip" role="listitem" title={`${entry.stage} ${entry.percent}%`}>
                {stageLabelOf(entry.stage as never, entry.stage)} {entry.percent}%
              </span>
            ))}
            {stationaryOmitted > 0 && (
              <button
                type="button"
                className="rg-chip rg-chip-more"
                onClick={() => setShowAllStationary(true)}
                aria-label={t('markov.stationaryMore', { count: stationaryOmitted })}
              >
                {t('markov.stationaryMore', { count: stationaryOmitted })}
              </button>
            )}
          </div>
          {/* 展开后仍给出总数：收起按钮本身不携带「一共几个」的信息。 */}
          {showAllStationary && view.stationary.length > STATIONARY_VISIBLE && (
            <button type="button" className="rg-link" onClick={() => setShowAllStationary(false)}>
              {t('markov.stationaryAll', { count: view.stationary.length })}
            </button>
          )}
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
