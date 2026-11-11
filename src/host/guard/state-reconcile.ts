import type { GuardState, PrebootDecision } from '../data/store.ts'

/**
 * 崩溃状态与决策文件的对账（T14-08 真机缺陷修复）。
 *
 * ## 为什么需要它（实测复现，不是推断）
 *
 * 故障注入用例 `apply-throw-required` 偶发失败，症状是：**决策文件里
 * `disable` 有坏插件、journal 里有 `crash-detected.suspects`，但 `state.json`
 * 的 `crashSeq=0` 且 `autoDisabled=[]`**。
 *
 * 根因是崩溃路径与启动路径的**写竞态**：崩溃处理器是同步写（不能 await），
 * 它写完 decision 再写 state；而同一进程启动期最后一个 `updateState`
 * （「干净启动清零计数」）可能正挂在文件锁里等写回。锁只能串行化**遵守锁的
 * 写者**，锁不住退出处理器的同步写 ⇒ 后者落地后被那个挂起的旧快照覆盖。
 *
 * ## 修法：以决策文件为真相，下一次启动补账
 *
 * 决策文件是「下次启动该拦谁」的唯一输入，而 state 只是它的投影。
 * 只要哨兵在场（= 上一轮确实崩溃过）且决策里有一份非空 `disable`，
 * 而 state 没记下这些插件 —— 那是**投影丢了**，不是「没关过」。
 * 补账是幂等的：已经一致时返回 null，绝不重复添加。
 *
 * ## 边界（不猜）
 *
 * - 没有哨兵 ⇒ 不补（上一轮可能干净退出，决策是恢复流程发布的）；
 * - `reason !== 'crash-recovery'` ⇒ 不补（恢复流程发布的 disable 不是崩溃证据）；
 * - `disable` 为空 ⇒ 不补（观察轮本来就不关人）。
 */
export interface StateReconcileResult {
  /** 需要写回的状态字段（null = 无需补账）。 */
  patch: Pick<GuardState, 'crashSeq' | 'autoDisabled'> | null
  /** 人读原因（写进 journal，崩溃因果链缺口的可审计记录）。 */
  detail: string
}

/**
 * 对账：哨兵在场时，state 必须记得决策文件里每一个被关的插件。
 *
 * @param state 启动时读到的状态
 * @param decision 当前决策文件（null = 没有/损坏）
 * @param sentinelPresent 上一轮的崩溃哨兵是否存在
 * @param now 归档/记录时刻（可注入，保证可复现）
 */
export function reconcileCrashedState(
  state: GuardState,
  decision: PrebootDecision | null,
  sentinelPresent: boolean,
  now = new Date().toISOString(),
): StateReconcileResult {
  if (!sentinelPresent) return { patch: null, detail: '' }
  if (decision === null) return { patch: null, detail: '' }
  if (decision.reason !== 'crash-recovery') return { patch: null, detail: '' }
  const disable = Array.isArray(decision.disable) ? decision.disable : []
  if (disable.length === 0) return { patch: null, detail: '' }

  const known = new Set(state.autoDisabled.map((d) => d.name))
  const missing = disable.filter((name) => !known.has(name))
  const crashSeqLost = state.crashSeq < 1
  if (missing.length === 0 && !crashSeqLost) return { patch: null, detail: '' }

  const crashSeq = Math.max(state.crashSeq, decision.crashSeq ?? 1, 1)
  const added = missing.map((name) => ({
    name,
    disabledAt: now,
    reason: 'auto-recency' as const,
    crashSeq,
  }))
  return {
    patch: { crashSeq, autoDisabled: [...state.autoDisabled, ...added] },
    detail:
      `状态对账：决策文件里有 ${disable.length} 个待拦截插件` +
      `${missing.length > 0 ? `，其中 ${missing.join(', ')} 未记入 autoDisabled` : ''}` +
      `${crashSeqLost ? '，且 crashSeq 丢失（被并发写覆盖）' : ''} —— 已按决策文件补回。`,
  }
}