/**
 * 决策与观测面的**视图投影**（v0.13，从 index.ts 抽出以控复杂度）。
 *
 * ## 为什么单独成模块
 *
 * 这三段都是「把磁盘上的事实投影成面板/工具可读的形状」：
 * 决策因子证据、共现验证结论、崩溃间隔形态判定。它们与守护流程**没有控制依赖**
 * —— 不改变状态、不做决策，只是读盘 + 投影。
 *
 * index.ts 的复杂度已顶到 126（预算 100），而这三段贡献了十几个分支。
 * 按「职责缝隙」切开后：
 * - index.ts 只留一行委托（读者不必在 1800 行里翻找投影逻辑）；
 * - 每段都能被单测直接驱动（它们是纯函数 + 注入读取器）。
 *
 * ## 共同纪律
 *
 * **全部 best-effort**：任何一步失败都返回「不可判定」的形状而不是抛。
 * 观测设施不能拖垮崩溃路径，也不能让面板因为一条坏数据而整块空白。
 */

import type { RecencyEntry } from '../risk/recency.ts'
import type { DecisionSuspect } from './decision.ts'
import { appendSample, mayWeightByCooccurrence, sampleFromCrash, verifyCooccurrence } from '../observe/cooccurrence.ts'
import { decisionSuspects } from './decision-evidence.ts'
import type { CrashHistoryEntry } from './recovery-policy.ts'
import type { JournalRecord } from '../data/store.ts'
import { intervalSurvival } from '../observe/survival.ts'

/** 崩溃间隔形态的判定输入（与 `recovery-policy.HazardLike` 同形）。 */
export interface HazardShape {
  weibullShape?: number
  reliable?: boolean
  atBound?: boolean
}

/**
 * 从 journal 事件提取崩溃时刻 → 拟合崩溃间隔形态（纯函数）。
 *
 * ## 为什么用「至少 4 个崩溃时刻」而不是 3
 *
 * 4 个时刻 = 3 个间隔，这是两参数 Weibull 有残差自由度的下限。3 个时刻只有
 * 2 个间隔，形状只是「两点之比」的函数 —— `intervalSurvival` 内部也会拒绝，
 * 这里提前挡掉省一次拟合。
 *
 * ## 诚实边界
 *
 * 任何异常（时间戳不可解析、样本不足、拟合不可判定）⇒ `undefined`，
 * 让 `hazardAdjustedRounds` 原样返回 `confirmRounds`（行为与 v0.12 逐位一致）。
 */
export function hazardShapeFromJournal(events: readonly JournalRecord[]): HazardShape | undefined {
  try {
    const crashTimes: number[] = []
    for (const event of events) {
      if (event.kind !== 'crash-detected') continue
      const parsed = Date.parse(event.t)
      if (Number.isFinite(parsed)) crashTimes.push(parsed)
    }
    if (crashTimes.length < 4) return undefined
    const fit = intervalSurvival(crashTimes)
    if (!fit.defined || fit.value === null) return undefined
    return {
      weibullShape: fit.value.weibullShape,
      reliable: fit.value.hazardDirectionReliable,
      atBound: fit.value.weibullShapeAtBound,
    }
  } catch {
    // 观测设施绝不拖垮崩溃路径：算不出形态就退回不调整。
    return undefined
  }
}

/** 决策因子证据的工具/面板投影形状。 */
export interface DecisionEvidenceView {
  hasEvidence: boolean
  items: Array<{
    rank: number
    bundle: string
    risk: number
    factors: { recency: number; experimental: number; crashFrequency: number }
    streak: number
    changeCount: number
    source: string | null
  }>
}

/**
 * 由决策文件的 suspects 投影出证据视图（纯函数）。
 *
 * `hasEvidence=false` 是**诚实边界**：旧版决策文件没记因子，此时不返回一排 0
 * （会被误读成「零风险」），而是显式说明未记录 —— 面板据此显示「旧版本」。
 */
export function projectDecisionEvidence(suspects: readonly DecisionSuspect[]): DecisionEvidenceView {
  let hasEvidence = false
  const items = suspects.map((suspect, index) => {
    const ev = suspect.evidence
    if (ev) hasEvidence = true
    return {
      rank: ev?.rank ?? index + 1,
      bundle: suspect.bundle,
      risk: ev?.risk ?? 0,
      factors: ev?.factors ?? { recency: 0, experimental: 0, crashFrequency: 0 },
      streak: ev?.streak ?? 0,
      changeCount: ev?.changeCount ?? 0,
      source: ev?.source ?? null,
    }
  })
  return { hasEvidence, items }
}

/** 共现验证的投影形状。 */
export interface CooccurrenceView {
  samples: number
  activeSamples: number
  inactiveSamples: number
  activeHitRate: number | null
  inactiveHitRate: number | null
  hitRateDelta: number | null
  label: string
  mayWeight: { allowed: boolean; reason: string }
}

/**
 * 由磁盘上的共现样本投影出验证结论（纯函数）。
 *
 * 只报「能不能加权」，不报加权值 —— 加权需要额外的严格化论证（研究文档 09 §4.3）。
 */
export function projectCooccurrence(samples: readonly unknown[]): CooccurrenceView {
  try {
    const verdict = verifyCooccurrence({ schemaVersion: 1, samples: samples as never[] })
    return {
      samples: verdict.samples,
      activeSamples: verdict.activeSamples,
      inactiveSamples: verdict.inactiveSamples,
      activeHitRate: verdict.activeHitRate.value,
      inactiveHitRate: verdict.inactiveHitRate.value,
      hitRateDelta: verdict.hitRateDelta.value,
      label: verdict.label,
      mayWeight: mayWeightByCooccurrence(verdict),
    }
  } catch {
    // 观测设施失败 ⇒ 显式不可判定，不伪造「无差异」。
    return {
      samples: 0,
      activeSamples: 0,
      inactiveSamples: 0,
      activeHitRate: null,
      inactiveHitRate: null,
      hitRateDelta: null,
      label: '共现样本读取失败，不可判定',
      mayWeight: { allowed: false, reason: '读取失败' },
    }
  }
}

/**
 * 构造一条共现样本（纯函数，便于单测）。
 *
 * 「官方实验插件是否活跃」由调用方从观测快照读好再传入 —— 崩溃路径上不能
 * 做全量扫描，读取与投影分离是刻意的。
 */
export function buildCooccurrenceSample(input: {
  at: string
  officialActive: readonly string[]
  ranked: readonly RecencyEntry[]
  disabled: readonly string[]
}): ReturnType<typeof sampleFromCrash> {
  return sampleFromCrash({
    at: input.at,
    officialActive: input.officialActive,
    suspects: input.ranked.map((r) => r.bundle),
    disabled: input.disabled,
    observations: [],
  })
}

/** 把新样本并入既有存储（纯函数，返回新存储）。 */
export function mergeCooccurrenceSample(
  store: { schemaVersion: 1; samples: unknown[] },
  sample: ReturnType<typeof sampleFromCrash>,
  limit = 200,
): { schemaVersion: 1; samples: unknown[] } {
  return appendSample({ schemaVersion: 1, samples: store.samples as never[] }, sample, limit) as {
    schemaVersion: 1
    samples: unknown[]
  }
}

/**
 * 崩溃路径上的决策 suspects 构造（纯函数）。
 *
 * 为什么需要 `history` 参数：`streak`（连续头号嫌疑轮数）需要崩溃历史才能算。
 */
export function buildDecisionSuspects(
  ranked: readonly RecencyEntry[],
  events: Parameters<typeof decisionSuspects>[1],
  history: readonly CrashHistoryEntry[],
  now?: number,
): DecisionSuspect[] {
  return decisionSuspects(ranked, events, history, now)
}
