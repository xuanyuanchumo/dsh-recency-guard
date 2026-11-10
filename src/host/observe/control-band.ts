/**
 * 崩溃间隔的休哈特控制带（单值-移动极差 MR 法）—— v0.10 cycle-5 从
 * observability.ts 拆出：「一个数学模型一个文件」的复杂度纪律（见
 * survival.ts 头注）。
 *
 * 质量控制的定位：CUSUM 回答「持续漂移从哪开始」，回归斜率回答「整体
 * 方向」，控制带回答「**哪一次**间隔越过了偶然波动的边界」—— 区分
 * 偶然原因（common cause）与特殊原因（special cause）是它的本职。
 */
import { definedMetric, sampleConfidence, undefinedMetric, type Metric } from '../core/metric.ts'

/** 控制带读数（休哈特单值-移动极差法）。 */
export interface ControlBand {
  /** 中心线（全部间隔的均值，毫秒）。 */
  center: number
  /** 上控制限 UCL（毫秒；超过 = 崩溃**变稀**得异常，或数据有误）。 */
  upper: number
  /** 下控制限 LCL（毫秒；低于 = 崩溃**变密**得异常，正是守护要抓的）。 */
  lower: number
  /** 落在下控制限之外的间隔序号（0 基，指向第 i 个间隔）。 */
  breaches: number[]
  /** 人读结论（含「受控/失控」判定与方向）。 */
  label: string
}

/**
 * 崩溃间隔的休哈特控制带（单值-移动极差 MR 法）。O(n)。
 *
 * 单值图用相邻间隔的极差 MR̄ 估计 σ̂ = MR̄/1.128（1.128 = d₂(2)，n=2 的
 * 无偏常数），UCL/LCL = x̄ ± 3σ̂。
 *
 * 诚实边界：间隔 < 2 ⇒ 无 MR 可算 ⇒ 不可判定。σ̂ ≤ 0（全部间隔相等）
 * ⇒ 带宽为 0 是**真值**（完美周期过程），不是不可判定。
 */
export function controlBand(crashTimes: readonly number[]): Metric<ControlBand> {
  const formula = 'x̄ ± 3·(MR̄/1.128)，MR = |相邻间隔差|（休哈特单值-MR 图，d₂(2)=1.128）'
  const gaps: number[] = []
  for (let i = 1; i < crashTimes.length; i += 1) {
    const gap = (crashTimes[i] ?? 0) - (crashTimes[i - 1] ?? 0)
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap)
  }
  if (gaps.length < 2) {
    return undefinedMetric('间隔样本 < 2，无移动极差可估 σ', '不可判定', { formula, inputs: { gaps: gaps.length }, sampleSize: gaps.length })
  }
  const center = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const movingRanges: number[] = []
  for (let i = 1; i < gaps.length; i += 1) {
    const mr = Math.abs((gaps[i] ?? 0) - (gaps[i - 1] ?? 0))
    if (Number.isFinite(mr)) movingRanges.push(mr)
  }
  const mrBar = movingRanges.reduce((a, b) => a + b, 0) / Math.max(1, movingRanges.length)
  const sigma = mrBar / 1.128
  const upper = center + 3 * sigma
  const lower = Math.max(0, center - 3 * sigma)
  const breaches = gaps.map((gap, index) => (gap < lower ? index : -1)).filter((index) => index >= 0)
  const label =
    breaches.length === 0
      ? `过程受控：${gaps.length} 个间隔均在 [${formatMs(lower)}, ${formatMs(upper)}] 带内`
      : `过程失控（变密）：第 ${breaches.map((b) => b + 1).join(', ')} 个间隔低于 LCL ${formatMs(lower)}`
  return definedMetric({ center, upper, lower, breaches, label }, label, {
    formula,
    inputs: { gaps: gaps.length, center, sigma, mrBar },
    sampleSize: gaps.length,
    confidence: sampleConfidence(gaps.length),
  })
}

/** 毫秒时长的紧凑显示（控制带 label 用）。 */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '?'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}min`
  return `${(minutes / 60).toFixed(1)}h`
}
