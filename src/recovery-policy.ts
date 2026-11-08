import type { RecencyEntry } from './recency.js'

/**
 * 恢复决策的置信分级与两阶段状态机（v0.9.0，借鉴 compat-guardian）。
 *
 * ## 为什么需要置信分级
 *
 * v0.8 之前的恢复逻辑是「崩溃即动手」：crashSeq=1 就关最近更新的插件。
 * 但一次崩溃可能是**偶发**（电源闪断、OOM 竞争、用户杀进程），拿它当
 * 证据去关一个无辜插件，代价是用户下次启动少一个功能。
 *
 * 分级规则（借鉴 compat-guardian 的「确定性证据立即处理、不确定性证据
 * 计数确认」）：
 * - **确定性证据**（决策时可以立刻看到的硬事实）⇒ 第一轮即可动手：
 *   嫌疑插件是**唯一**的嫌疑（没有第二个候选能解释这次崩溃）；
 * - **不确定性证据**（最近更新只是相关性）⇒ 需要 `confirmRounds` 轮
 *   重复崩溃才动手，且每轮之间宿主 runtime/插件版本没变（变了说明
   *   环境已经不同，计数器该清零重数）。
 *
 * ## 两阶段提交
 *
 * 关闭动作拆成两阶段：
 * 1. **prepared**：决策文件写好、嫌疑名单落 journal，但 `disable` 名单
 *    标记为 `phase: 'prepared'` —— 此时如果进程死掉，下次启动按磁盘
 *    现状对账（reconcile），不会留下半成品状态；
 * 2. **quarantined**：pluginManager 确认关闭成功后升级。
 *
 * 为什么不做成「写两个文件」：决策文件是守护行表达式的唯一输入，
 * 两阶段都写同一个文件，用 `phase` 字段区分 —— 守护行只认名单本身，
 * phase 是给 reconcile 与面板看的。
 */

/** 一轮崩溃观察的证据分类。 */
export type EvidenceClass = 'deterministic' | 'probabilistic'

/** 恢复决策的阶段。 */
export type DecisionPhase = 'prepared' | 'quarantined' | 'reconciled'

/** 置信分级判定结果。 */
export interface ConfidenceVerdict {
  /** 本轮是否允许动手（false = 只记录不关闭）。 */
  act: boolean
  /** 证据分类。 */
  evidence: EvidenceClass
  /** 已累计的崩溃轮数（含本轮）。 */
  rounds: number
  /** 动手所需的轮数。 */
  required: number
  /** 人读判定（面板/工具直接展示）。 */
  label: string
}

/** 置信分级所需的崩溃历史（reconcile 与计数都靠它）。 */
export interface CrashHistoryEntry {
  /** 崩溃时刻（ISO）。 */
  at: string
  /** 崩溃退出码。 */
  exitCode: number
  /** 崩溃时的嫌疑名单快照（按 ranked 顺序）。 */
  suspects: string[]
  /** 崩溃时的宿主 runtime 版本（变了 ⇒ 计数清零）。 */
  runtimeVersion?: string
  /** 崩溃时嫌疑插件的版本快照（变了 ⇒ 计数清零）。 */
  suspectVersions?: Record<string, string | undefined>
}

/**
 * 置信分级判定 —— 纯函数。
 *
 * @param history 以往崩溃记录（不含本轮），旧 → 新
 * @param currentSuspects 本轮嫌疑名单（ranked 顺序）
 * @param options confirmRounds：概率性证据需要的重复轮数（默认 2）；
 *   crashSeq：本轮的累计崩溃序号（用于兜底升级）；hardEscalateAfter：兜底阈值（默认 3）。
 *
 * 判定表：
 * - 唯一嫌疑（本轮名单长度 1）⇒ deterministic，第 1 轮就动手 ——
 *   「没有别的解释」是硬证据，等第二轮只会让用户多崩一次；
 * - 多嫌疑 ⇒ probabilistic，需要连续 confirmRounds 轮看到**同一**头号
 *   嫌疑才动手（名单换头 = 环境变了 = 重新计数）；
 * - **兜底升级（v0.11.1 紧急修复）**：累计崩溃序号 ≥ hardEscalateAfter 时
 *   强制动手 —— 崩溃循环本身就是「宿主已经起不来」的确定性事实，
 *   概率计数机制一旦失效（实测：启动记录的嫌疑空记录曾把连续数打断），
 *   没有兜底就会永远观察、永远崩溃。宿主可用性优先于误伤最小化。
 */
export function assessConfidence(
  history: readonly CrashHistoryEntry[],
  currentSuspects: readonly RecencyEntry[],
  options: { confirmRounds?: number; crashSeq?: number; hardEscalateAfter?: number } = {},
): ConfidenceVerdict {
  const confirmRounds = Math.max(1, options.confirmRounds ?? 2)
  const names = currentSuspects.map((s) => s.bundle)
  if (names.length === 0) {
    return { act: false, evidence: 'probabilistic', rounds: 0, required: confirmRounds, label: '没有嫌疑插件，无需恢复' }
  }
  if (names.length === 1) {
    return {
      act: true,
      evidence: 'deterministic',
      rounds: 1,
      required: 1,
      label: `唯一嫌疑 ${names[0]}：确定性证据，第 1 轮即行动`,
    }
  }
  // 概率性证据：数「连续同头号嫌疑」的轮数。
  // v0.11.1：**跳过嫌疑为空的记录**（启动时的检测事件）。此前
  // `entry.suspects[0] ?? '' !== head` 会让每条启动记录都打断连续计数 ——
  // 实测桌面端 crashSeq 连涨到 3 却永远停在 1/2 轮，崩溃循环无解。
  const head = names[0]
  let streak = 1
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as CrashHistoryEntry
    if (entry.suspects.length === 0) continue
    if ((entry.suspects[0] ?? '') !== head) break
    streak += 1
  }
  const hardEscalateAfter = Math.max(1, options.hardEscalateAfter ?? 3)
  const escalated = options.crashSeq !== undefined && options.crashSeq >= hardEscalateAfter
  const act = streak >= confirmRounds || escalated
  return {
    act,
    evidence: 'probabilistic',
    rounds: streak,
    required: confirmRounds,
    label: act
      ? streak >= confirmRounds
        ? `头号嫌疑 ${head} 连续 ${streak} 轮复现（≥ ${confirmRounds}）：达到行动阈值`
        : `连续 ${options.crashSeq} 次崩溃仍未恢复：兜底升级为行动（安全网）`
      : `头号嫌疑 ${head} 复现 ${streak}/${confirmRounds} 轮：观察中，本轮只记录不关闭`,
  }
}

/**
 * 环境稳定性检查 —— 判定历史计数是否仍然有效。
 *
 * 任何一项变化 ⇒ 环境已不同，计数应清零（compat-guardian 同款规则）：
 * - 宿主 runtime 版本变化；
 * - 头号嫌疑插件版本变化。
 */
export function environmentChanged(
  lastEntry: CrashHistoryEntry | undefined,
  currentRuntime: string,
  currentSuspects: readonly RecencyEntry[],
): boolean {
  if (lastEntry === undefined) return false
  if (lastEntry.runtimeVersion !== undefined && lastEntry.runtimeVersion !== currentRuntime) return true
  const head = currentSuspects[0]
  if (head === undefined) return false
  const prevVersion = lastEntry.suspectVersions?.[head.bundle]
  return prevVersion !== undefined && prevVersion !== head.version
}

/**
 * 两阶段记录的 reconcile —— 按磁盘现状对账遗留的 prepared 记录。
 *
 * 场景：上一轮在 prepared 后、quarantined 前崩了（或正常退出但没走到
 * 升级）。本次启动读到一条 prepared 记录，需要对账归类：
 * - 插件实际已被禁用（diskState 说 enabled=false）⇒ 升级为 quarantined
 *   （关闭已生效，补记账）；
 * - 插件仍然启用 ⇒ prepared 记录作废，标记 reconciled-failed（关闭没生效，
 *   但崩溃证据链保留 —— 它还是下次决策的输入）。
 *
 * 纯函数：输入磁盘态，输出每个遗留记录的处置。可独立单测。
 */
export function reconcilePrepared(
  prepared: ReadonlyArray<{ bundle: string; preparedAt: string; crashSeq: number }>,
  diskState: ReadonlyMap<string, boolean>,
): Array<{
  bundle: string
  outcome: 'confirmed' | 'reverted'
  preparedAt: string
  crashSeq: number
}> {
  return prepared.map((p) => {
    const enabled = diskState.get(p.bundle)
    // 磁盘上查不到（插件已卸载）与「仍启用」同义：关闭没有生效。
    const confirmed = enabled === false
    return {
      bundle: p.bundle,
      outcome: confirmed ? 'confirmed' : 'reverted',
      preparedAt: p.preparedAt,
      crashSeq: p.crashSeq,
    }
  })
}
