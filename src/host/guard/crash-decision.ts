import type { CrashHistoryEntry, ConfidenceVerdict, HazardLike } from './recovery-policy.ts'
import { assessConfidence } from './recovery-policy.ts'
import { errorFindings, type ConflictFinding } from './conflict-metadata.ts'
import { planQuarantine, type CandidatePlugin, type QuarantinePlan } from './quarantine-plan.ts'
import { pickSuspects, type RecencyEntry } from '../risk/recency.ts'

/**
 * 崩溃路径的决策**组装**（T14-03，从 index.ts 提取以控复杂度）。
 *
 * ## 为什么单独成文件
 *
 * 这段是「把四路输入（排名 / 崩溃历史 / 声明 finding / 依赖图）折成一份
 * 决策 + 一份白盒判定」的纯计算，分支密集（确定性 vs 概率性、命中 vs 未命中、
 * 有解 vs 残余），而 `index.ts` 是组合根 —— 复杂度预算按文件计分，
 * 组合根不该为决策内部的分支付费。
 *
 * ## 三条不变式（提取时逐条保留，不因搬家而漂移）
 *
 * 1. **未命中声明 ⇒ 目标 = `pickSuspects` 的 recency 前缀**（旧行为逐位不变）。
 *    命中 ⇒ 目标 = 贪心隔离计划的结果（已排除受保护、已含依赖联动、已封顶）。
 * 2. **确定性证据必须可解释**：`deterministicEvidence` 同时带 findings（为什么）
 *    与 targets（关谁）；只带其中一个就退回黑盒。
 * 3. **残余必须带出去**：`unresolved` 是计划器治不了的那部分（受保护/无候选），
 *    随决策一起落盘，不上屏就等于静默。
 *
 * 本模块**不写盘**：写 journal / state / decision 三条路径仍由 index 编排
 * （崩溃路径的写必须同步，且顺序有意义 —— 先留证，再改名单）。
 */
export interface CrashDecisionInput {
  /** 本轮崩溃序号（1 基）。 */
  seq: number
  maxAutoDisable: number
  confirmRounds: number
  /** 决策排序后的嫌疑名单（rankForDecision 的输出）。 */
  ranked: readonly RecencyEntry[]
  /** 隔离候选（含 kind/priority/依赖边；由 ranked 派生）。 */
  candidates: readonly CandidatePlugin[]
  /** 当前仍成立的声明式 finding。 */
  findings: readonly ConflictFinding[]
  /** 崩溃历史（已按环境变化决定是否清空）。 */
  history: readonly CrashHistoryEntry[]
  /** 环境是否变了（变了 ⇒ 历史计数清零）。 */
  envChanged: boolean
  hazardDirection?: HazardLike
}

/** 决策组装的产物。 */
export interface CrashDecisionResult {
  verdict: ConfidenceVerdict
  /** 本轮要关闭的插件（RecencyEntry 形态，供备份/日志使用）。 */
  targets: RecencyEntry[]
  plan: QuarantinePlan
  /** 命中声明时才有：为什么这是确定性证据。 */
  deterministicEvidence?: { findings: ConflictFinding[]; targets: string[] }
  /** 决策文件要写的 disable 名单。 */
  disable: string[]
  /** 决策文件要写的残余。 */
  unresolved: ConflictFinding[]
}

/**
 * 组装本轮崩溃决策（纯函数）。
 *
 * 顺序刻意固定：先算计划（依赖图 + 排序）→ 再算判定（确定性优先）→
 * 再算目标（计划优先、旧行为兜底）。顺序一变，「命中但计划为空的残余」
 * 就会被误判成「没命中」，从而错误地退回 recency 关闭。
 */
/** 判定快照的形状（与 `GuardState.lastRecoveryVerdict` 同形，避免两处定义漂移）。 */
export interface RecoveryVerdictPatch {
  at: string
  crashSeq: number
  evidence: ConfidenceVerdict['evidence']
  rounds: number
  required: number
  act: boolean
  label: string
  headSuspect: string | null
  deterministic?: { findings: ConflictFinding[]; targets: string[] }
  /** v0.18 T16-12：级联刹车标志（确定性证据轮不回滚）。 */
  rollback?: boolean
}

/**
 * 构造判定快照（观察轮与行动轮**共用**，只差「关不关」）。
 *
 * 为什么必须共用：两处各写一份时，一处加了 `deterministic`、另一处忘了，
 * 面板就会在「观察中」与「已行动」两种状态下显示不同形状的白盒事实 ——
 * 用户会以为系统行为变了，而实际只是投影漏了一个字段。
 */
export function verdictPatch(
  seq: number,
  verdict: ConfidenceVerdict,
  targets: readonly RecencyEntry[],
  deterministicEvidence?: { findings: ConflictFinding[]; targets: string[] },
  at = new Date().toISOString(),
): RecoveryVerdictPatch {
  return {
    at,
    crashSeq: seq,
    evidence: verdict.evidence,
    rounds: verdict.rounds,
    required: verdict.required,
    act: verdict.act,
    label: verdict.label,
    headSuspect: targets[0]?.bundle ?? null,
    ...(deterministicEvidence === undefined ? {} : { deterministic: deterministicEvidence }),
    // 级联刹车标志随判定一起落盘（v0.18 T16-12）：面板/工具要能看见
    // 「这一轮为什么不再禁用」。缺省 = 未刹车，与旧 state 兼容。
    ...(verdict.rollback === true ? { rollback: true } : {}),
  }
}

export function composeCrashDecision(input: CrashDecisionInput): CrashDecisionResult {
  const names = input.ranked.map((entry) => entry.bundle)
  const plan = planQuarantine(input.candidates, input.findings, { maxDisable: input.maxAutoDisable })
  const errors = errorFindings(input.findings)
  // 只有「命中 error 且计划真的产出了目标」才算确定性证据：
  // finding 命中但全部受保护时，targets 为空 ⇒ 不行动（残余进 unresolved），
  // 而不是顺手关一个 recency 嫌疑人来「装作解决了」。
  const deterministicEvidence =
    plan.quarantine.length === 0
      ? undefined
      : { findings: errors, targets: [...plan.quarantine] }
  const verdict = assessConfidence(input.envChanged ? [] : input.history, [...input.ranked], {
    confirmRounds: input.confirmRounds,
    crashSeq: input.seq,
    hazardDirection: input.hazardDirection,
    deterministicEvidence,
    // v0.18 T16-12：级联刹车判据需要封顶数（升级步数用满 ⇒ rollback）。
    maxAutoDisable: input.maxAutoDisable,
  })
  const planned = plan.quarantine
    .map((name) => input.ranked.find((entry) => entry.bundle === name))
    .filter((entry): entry is RecencyEntry => entry !== undefined)
  // 未命中声明 ⇒ 旧行为（recency 前缀）。
  const n = Math.min(Math.max(1, input.seq), Math.max(1, input.maxAutoDisable))
  const legacyTargets = names.length === 0 ? [] : pickSuspects([...input.ranked], n)
  const targets = planned.length > 0 ? planned : legacyTargets
  return {
    verdict,
    targets,
    plan,
    ...(deterministicEvidence === undefined ? {} : { deterministicEvidence }),
    disable: verdict.act ? targets.map((entry) => entry.bundle) : [],
    unresolved: plan.unresolved,
  }
}