/**
 * 可观测性 —— 量化指标、白盒透明化与数据结构/算法。
 *
 * 三条诚实边界（承 dsh-anic `graphHealth.ts` 的教训，写死在本模块的���型里）：
 *
 * 1. **无数据 ⇒ 不给分**（不是给 0 分）。`null` 与 `0` 是两件事：
 *    「没有崩溃记录」不等于「崩溃率为 0」。
 * 2. **分母为 0 ⇒ 比率不可判定**（不是 0）。
 * 3. **颜色/评分不是唯一通道**：每个量化读数都带**可读的文本形态**，
 *    便于灰度打印、屏幕阅读器与截图核对。
 *
 * 指标集（KPI）
 * -----------
 * | 指标 | 含义 | 不可判定条件 |
 * |---|---|---|
 * | `crashRate` | 崩溃率 = 崩溃次数 / 观测启动次数 | 观测次数为 0 |
 * | `meanRecoveryTime` | 平均恢复耗时（崩溃 → 成功启动） | 无成功恢复样本 |
 * | `detectionRate` | 崩溃检出率 = 被守护发现的崩溃 / 全部崩溃 | 无崩溃样本 |
 * | `stabilityScore` | 稳定性评分（见 lifecycle.ts） | 恒可得 |
 * | `riskScore` | 单插件崩溃风险（见 lifecycle.ts） | 恒可得 |
 * | `crashTrend` | 崩溃趋势斜率 | 崩溃样本 < 2 |
 * | `isolationPurity` | 隔离纯度 = 未串扰的分区 / 全部分区 | 分区数为 0 |
 */

import { crashTrend, riskScore, type RiskInput, type TrendResult } from './lifecycle.js'

/** 一个可空的量化读数。 */
export interface Metric<T> {
  /** 数值；不可判定时为 null。 */
  value: T | null
  /** 是否可判定。 */
  defined: boolean
  /** 人类可读形态（颜色之外的第二通道）。 */
  label: string
  /** 不可判定的原因。 */
  reason?: string
}

/** 构造一个不可判定的读数。 */
export function undefinedMetric<T>(reason: string, label = '不可判定'): Metric<T> {
  return { value: null, defined: false, label, reason }
}

/** 构造一个可判定的读数。 */
export function definedMetric<T>(value: T, label: string): Metric<T> {
  return { value, defined: true, label }
}

/** 观测到的启动事实。 */
export interface Observation {
  /** 启动时刻。 */
  at: string
  /** 该次启动是否崩溃结束。 */
  crashed: boolean
  /** 若崩溃后成功启动，恢复耗时（毫秒）。 */
  recoveryMs?: number
  /** 该次崩溃是否被守护检出。 */
  detected?: boolean
}

/** 崩溃率。 */
export function crashRate(observations: Observation[]): Metric<number> {
  if (observations.length === 0) return undefinedMetric('没有启动观测记录')
  const crashed = observations.filter((o) => o.crashed).length
  const rate = crashed / observations.length
  return definedMetric(round4(rate), `${crashed}/${observations.length} 次启动崩溃（${pct(rate)}）`)
}

/** 平均恢复耗时（毫秒）。 */
export function meanRecoveryTime(observations: Observation[]): Metric<number> {
  const samples = observations.map((o) => o.recoveryMs).filter((v): v is number => typeof v === 'number')
  if (samples.length === 0) return undefinedMetric('没有成功的恢复样本')
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return definedMetric(Math.round(mean), `平均 ${(mean / 1000).toFixed(2)} 秒（${samples.length} 个样本）`)
}

/** 崩溃检出率。 */
export function detectionRate(observations: Observation[]): Metric<number> {
  const crashes = observations.filter((o) => o.crashed)
  if (crashes.length === 0) return undefinedMetric('没有崩溃样本')
  const detected = crashes.filter((o) => o.detected === true).length
  const rate = detected / crashes.length
  return definedMetric(round4(rate), `检出 ${detected}/${crashes.length} 次崩溃`)
}

/**
 * 隔离纯度 —— 衡量分区之间有没有串扰。
 *
 * 定义：未发生串扰的分区 / 全部分区。
 * 一个分区「串扰」= 它的恢复决策影响了其它分区的启动结果。
 * 数据来源：每个分区启动后检查「本分区的决策是否被别处消费」。
 */
export function isolationPurity(partitions: Array<{ key: string; contaminated: boolean }>): Metric<number> {
  if (partitions.length === 0) return undefinedMetric('没有分区记录')
  const clean = partitions.filter((p) => !p.contaminated).length
  const rate = clean / partitions.length
  return definedMetric(round4(rate), `${clean}/${partitions.length} 个分区无串扰（${pct(rate)}）`)
}

/** 全部量化指标的一个快照。 */
export interface MetricsSnapshot {
  crashRate: Metric<number>
  meanRecoveryTime: Metric<number>
  detectionRate: Metric<number>
  isolationPurity: Metric<number>
  stabilityScore: number
  trend: TrendResult
}

/** 计算全部指标。 */
export function computeMetrics(
  observations: Observation[],
  stabilityScore: number,
  partitions: Array<{ key: string; contaminated: boolean }>,
  now = Date.now(),
): MetricsSnapshot {
  const crashTimes = observations.filter((o) => o.crashed).map((o) => Date.parse(o.at)).filter(Number.isFinite)
  return {
    crashRate: crashRate(observations),
    meanRecoveryTime: meanRecoveryTime(observations),
    detectionRate: detectionRate(observations),
    isolationPurity: isolationPurity(partitions),
    stabilityScore,
    trend: crashTrend(crashTimes, now),
  }
}

/**
 * 嫌疑插件的风险排名。
 *
 * 数据结构：**排序数组**而非堆 —— 排名结果要完整展示（面板逐行显示），
 * 数组的 O(n log n) 排序在几十个插件量级下足够，且保序稳定（相同分数按
 * 名称字典序），使面板输出可逐字节比对（便于契约测试）。
 */
export interface RankedRisk {
  bundle: string
  risk: number
  label: string
  experimental: boolean
  lastChangeAt: string
}

/** 对嫌疑插件按风险降序排名。 */
export function rankRisks(
  inputs: Array<{ bundle: string; experimental: boolean; lastChangeAt: string; suspectHits: number; observations: number }>,
  now = Date.now(),
): RankedRisk[] {
  const ranked = inputs.map((input) => {
    const riskInput: RiskInput = {
      lastChangeAt: input.lastChangeAt,
      experimental: input.experimental,
      suspectHits: input.suspectHits,
      observations: input.observations,
    }
    const risk = riskScore(riskInput, now)
    return {
      bundle: input.bundle,
      risk,
      label: `${input.bundle} 风险 ${risk.toFixed(2)}（${describeRisk(risk)}）`,
      experimental: input.experimental,
      lastChangeAt: input.lastChangeAt,
    }
  })
  // 降序；同分按名称字典序 —— 稳定且可比对。
  ranked.sort((a, b) => b.risk - a.risk || a.bundle.localeCompare(b.bundle))
  return ranked
}

/** 风险等级的文字描述（颜色之外的通道）。 */
export function describeRisk(risk: number): string {
  if (risk >= 0.7) return '高'
  if (risk >= 0.4) return '中'
  if (risk > 0) return '低'
  return '无'
}

/**
 * 指数加权移动平均（EWMA）—— 用于把离散事件流平滑成可比较的速率序列。
 *
 * 模型：s_t = α·x_t + (1-α)·s_{t-1}
 * α 由**半衰期**决定：α = 1 - 0.5^(1/H)，H 为半衰期的样本数。
 *
 * 为什么不用简单移动平均：SMA 需要固定窗口且对窗口边缘不连续，
 * 而「最近几次的崩溃密度」这个量在时间上本就是指数遗忘的 —— 用半衰期
 * 表达「多久算近期」比用「看最近 N 条」更贴近语义。
 */
export function ewma(values: number[], halfLife = 3): number {
  if (values.length === 0) return 0
  // α = 1 - 2^(-1/H)：递推 (1-α) 每 H 步把旧值的权重减半。
  //
  // H 的语义：**旧值衰减到一半需要几个样本**。H 越小 ⇒ α 越大 ⇒ 近期权重越高。
  // H=1 ⇒ α=0.5（最近一个值占一半）；H=3 ⇒ α≈0.206。
  const alpha = 1 - Math.pow(2, -1 / Math.max(1, halfLife))
  let s = values[0]
  for (let i = 1; i < values.length; i += 1) s = alpha * values[i] + (1 - alpha) * s
  return round4(s)
}

/**
 * 崩溃间隔的统计 —— 回答「崩溃是不是在变密」。
 *
 * 返回中位数间隔（鲁棒统计量：不受单次异常长间隔影响）与变异系数。
 */
export function crashIntervalStats(crashTimes: number[]): Metric<{ medianMs: number; cv: number }> {
  const sorted = crashTimes.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length < 2) return undefinedMetric('至少需要两次崩溃才能计算间隔')
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i += 1) gaps.push(sorted[i] - sorted[i - 1])
  const medianGap = median(gaps)
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const stdDev = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length)
  const cv = mean === 0 ? 0 : round4(stdDev / mean)
  return definedMetric(
    { medianMs: Math.round(medianGap), cv },
    `中位间隔 ${(medianGap / 1000).toFixed(1)} 秒，变异系数 ${cv}`,
  )
}

/** 中位数。 */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}
