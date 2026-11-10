/**
 * 崩溃间隔的生存/危险率分析（指数 + Weibull MLE）—— v0.10 cycle-5 从
 * observability.ts 拆出：复杂度预算按文件计分，「一个数学模型一个文件」
 * 让每个模型的单测与实现同址（本段实现与 tests/unit/observability-math
 * 的 survival 断言一一对应）。
 *
 * 依赖面：只依赖 observability 的读数原语（Metric/MetricMeta/undefined/
 * definedMetric/sampleConfidence/round4/variance/displayDigits/crashSeries）。
 */

import { crashSeries, definedMetric, displayDigits, round4, sampleConfidence, undefinedMetric, variance, type Metric, type MetricMeta } from './observability.js'

// ─────────────────────────── 生存 / 危险率 ───────────────────────────

/** 危险率方向（原 observability 导出面，随模型搬到此处）。 */
export type HazardDirection = 'decreasing' | 'constant' | 'increasing'

/** 崩溃间隔的生存分析结果（指数 + Weibull）。 */
export interface SurvivalFit {
  /** 间隔样本数（= 崩溃数 − 1）。 */
  samples: number
  /** 指数模型失效率 λ̂ = 1/ḡ（单位 1/ms）。**不取整**：λ 常见量级 1e−6，
   * 按「4 位小数」取整会把有效数字压到 2 位以下（位数与量级不匹配的伪精度）。 */
  exponentialRatePerMs: number
  /** 指数模型均值 = 1/λ̂（= 样本均值）。 */
  exponentialMeanMs: number
  /** Weibull 形状 k̂（轮廓似然 MLE）。 */
  weibullShape: number
  /**
   * 形状是否撞到搜索上界（k = 10³）。
   *
   * 含义：间隔近乎完全规则（方差 → 0）时 Weibull 的 MLE 发散到无穷 ——
   * 此时 k̂ 是**边界伪值**而不是估计值，必须显式标注而不是报成「k=1000」。
   */
  weibullShapeAtBound: boolean
  /** Weibull 尺度 λ̂（毫秒）。 */
  weibullScaleMs: number
  /** Weibull 模型均值 = λ̂·Γ(1 + 1/k̂)（毫秒）。 */
  weibullMeanMs: number
  /** 危险率方向（k < 0.9 递减 / 0.9~1.1 恒定 / > 1.1 递增）。 */
  hazardDirection: HazardDirection
  /**
   * 方向判定是否可靠：样本 < 9 时形状估计的标准误足以翻转判定，
   * 此时方向只是提示，不是结论。
   */
  hazardDirectionReliable: boolean
  /** 观测到的变异系数（指数模型的理论 CV 恒为 1，偏离即模型误配）。 */
  cvObserved: number | null
}

/** Weibull 形状的两个判定带（±10%）：与 `hazardDirection` 一一对应。 */
const WEIBULL_CONSTANT_LOW = 0.9
const WEIBULL_CONSTANT_HIGH = 1.1

/** 方向判定可靠所需的最小间隔样本数（se(k̂) ~ k̂/√n，n=9 时相对误约 1/3）。 */
const HAZARD_RELIABLE_SAMPLES = 9

/** Weibull 形状的搜索区间上界；撞到它意味着 MLE 发散（间隔近乎完全规则）。 */
const SHAPE_SEARCH_MAX = 1e3

/**
 * 崩溃间隔的生存分析 —— 回答「崩溃的到达过程像不像泊松，还是成簇爆发」。
 *
 * 模型
 * ----
 * 把相邻崩溃间隔 g_i 当作**独立同分布的非负寿命**（无删失：每次间隔都
 * 完整观测到）。两个拟合：
 *
 * 1. **指数（齐次泊松过程）**：λ̂ = 1/ḡ（MLE，闭式）。危险率 h(t) = λ 恒定
 *    ⇒ 无记忆：下一次崩溃不取决于距上次多久。理论 CV 恒为 1，因此
 *    `cvObserved` 与 1 的偏离就是「指数假设被数据拒绝」的直接证据。
 * 2. **Weibull**：h(t) = (k/λ)(t/λ)^(k−1)。形状 k 用**轮廓似然 MLE**：
 *    对固定 k，λ̂(k) = ((1/n)Σ g_i^k)^(1/k)；
 *    代入得 k 的得分方程
 *      g(k) = Σ w_i·ln g_i / Σ w_i − 1/k − mean(ln g) = 0，w_i = g_i^k，
 *    g(k) 在 k 上严格单调递减，用**对数空间二分**求解（k 跨 6 个数量级，
 *    线性二分前 20 步几乎不动）。
 *
 * 语义（为什么值得算）
 * ------------------
 * 间隔的**趋势**由 `crashTrend`/`intervalTrend`/CUSUM 负责；本模型回答的是
 * **到达过程的形状**：
 * - k < 0.9：危险率递减 ⇒ 间隔过离散 ⇒ 崩溃**成簇**（一次故障引发连锁），
 *   或存在未观测的异质性（某插件只在特定操作下崩）。
 * - k ≈ 1：无记忆（泊松），崩溃在时间上互不相关。
 * - k > 0.9：危险率递增 ⇒ 间隔比泊松更规则（欠离散），多见于固定周期的
 *   定时任务/固定时长的工作负载。
 * 这三者对「该不该继续等下一次启动来观察」是完全不同的结论，因此必须区分。
 *
 * 失效条件（全部返回 `defined:false`，绝不硬凑）
 * - 间隔数 < 3：两参数似然在 n = 2 时没有残差自由度，形状只是两点之比的函数。
 * - 存在 0 间隔（同刻多次崩溃）：ln 0 = −∞，对数似然发散。
 * - 全部间隔相等（方差 0）：g(k) ≡ −1/k < 0 无根，k → ∞，形状不可辨识。
 *
 * 复杂度：O(iters · n)，iters 固定 100；用 log-sum-exp 计算避免 g^k 溢出。
 */
export function intervalSurvival(crashTimes: readonly number[]): Metric<SurvivalFit> {
  const { gaps } = crashSeries(crashTimes)
  const formula = 'λ̂ = 1/ḡ（指数 MLE）；Weibull g(k) = Σ g_i^k ln g_i / Σ g_i^k − 1/k − mean(ln g) = 0'
  const meta = (sampleSize: number, inputs?: Record<string, number | string | null>): MetricMeta => ({
    formula,
    inputs,
    sampleSize,
    confidence: sampleConfidence(sampleSize),
  })
  if (gaps.length < 3) {
    return undefinedMetric(
      `至少需要 3 个崩溃间隔才能拟合两参数 Weibull（当前 ${gaps.length} 个）`,
      '不可判定',
      meta(gaps.length, { gaps: gaps.length }),
    )
  }
  if (gaps.some((g) => !Number.isFinite(g) || g <= 0)) {
    const zeros = gaps.filter((g) => g === 0).length
    return undefinedMetric(
      zeros > 0
        ? `存在 ${zeros} 个零间隔（同一时刻的多次崩溃），Weibull 对数似然在 0 处发散`
        : '存在非有限间隔，生存模型不可用',
      '不可判定',
      meta(gaps.length, { gaps: gaps.length, zeroGaps: zeros }),
    )
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const spread = variance(gaps, mean)
  if (spread === 0) {
    return undefinedMetric('全部崩溃间隔相等（方差 0），Weibull 形状不可辨识', '不可判定', {
      formula,
      inputs: { gaps: gaps.length, meanMs: Math.round(mean), exponentialRatePerMs: 1 / mean },
      sampleSize: gaps.length,
      confidence: sampleConfidence(gaps.length),
    })
  }

  const logs = gaps.map((g) => Math.log(g))
  const shape = weibullShapeMle(logs)
  const shapeAtBound = shape > SHAPE_SEARCH_MAX * 0.999
  const scale = Math.exp((logSumExp(logs.map((l) => shape * l)) - Math.log(gaps.length)) / shape)
  const cvObserved = round4(Math.sqrt(spread) / mean)
  const hazardDirection: HazardDirection =
    shape < WEIBULL_CONSTANT_LOW ? 'decreasing' : shape > WEIBULL_CONSTANT_HIGH ? 'increasing' : 'constant'
  const fit: SurvivalFit = {
    samples: gaps.length,
    exponentialRatePerMs: 1 / mean,
    exponentialMeanMs: Math.round(mean),
    weibullShape: round4(shape),
    weibullShapeAtBound: shapeAtBound,
    weibullScaleMs: Math.round(scale),
    weibullMeanMs: Math.round(scale * Math.exp(lgamma(1 + 1 / shape))),
    hazardDirection,
    hazardDirectionReliable: gaps.length >= HAZARD_RELIABLE_SAMPLES,
    cvObserved,
  }
  // 位数按样本量降级：3 个间隔只报 1 位有效数字，避免「0.8234 的形状」这种伪精度。
  const digits = displayDigits(gaps.length)
  const directionLabel =
    hazardDirection === 'decreasing' ? '递减·成簇' : hazardDirection === 'increasing' ? '递增·比泊松规则' : '恒定·泊松散'
  // 撞上界时标签必须自曝：k=1000 是搜索边界，不是「形状真有一千」。
  const shapeText = shapeAtBound ? `k≥${SHAPE_SEARCH_MAX}（撞搜索上界，间隔近乎完全规则）` : `k=${shape.toFixed(digits)}（危险率${directionLabel}）`
  return definedMetric(
    fit,
    `Weibull ${shapeText}，尺度 ${(scale / 1000).toFixed(digits)} 秒；` +
      `指数 λ=${fit.exponentialRatePerMs.toExponential(2)}/ms（${gaps.length} 个间隔）`,
    {
      formula,
      inputs: {
        gaps: gaps.length,
        meanMs: fit.exponentialMeanMs,
        cvObserved,
        cvExponentialTheory: 1,
        hazardDirection,
        // 布尔在 inputs 里用 0/1：inputs 的取值域保持「标量」，便于快照序列化比对。
        reliable: fit.hazardDirectionReliable ? 1 : 0,
        shapeAtBound: shapeAtBound ? 1 : 0,
        weibullShapeDigits: digits,
      },
      sampleSize: gaps.length,
      confidence: sampleConfidence(gaps.length),
    },
  )
}

/**
 * Weibull 形状 k 的轮廓似然 MLE：解 g(k) = softmax_k(ln g)·ln g − 1/k − mean(ln g) = 0。
 *
 * g 在 k 上严格单调递减（g(0⁺) → ln min − ∞ < 0，g(∞) → ln max − mean(ln g) > 0
 * 当且仅当样本不全相等 —— 调用方已排除全等样本），故可用二分。
 * 在**对数空间**取中点：k 的搜索区间是 [1e−3, 1e3]，线性二分前 20 步几乎不动。
 */
function weibullShapeMle(logs: readonly number[]): number {
  const meanLog = logs.reduce((a, b) => a + b, 0) / logs.length
  const score = (k: number): number => softmaxMean(k, logs) - 1 / k - meanLog
  let lo = 1e-3
  let hi = SHAPE_SEARCH_MAX
  for (let i = 0; i < 100; i += 1) {
    const mid = Math.sqrt(lo * hi)
    if (score(mid) < 0) lo = mid
    else hi = mid
  }
  return Math.sqrt(lo * hi)
}

/** 权重 w_i = exp(k·ln g_i) 归一化后对 ln g_i 的加权平均（数值稳定版）。 */
function softmaxMean(k: number, logs: readonly number[]): number {
  const scaled = logs.map((l) => k * l)
  const max = Math.max(...scaled)
  let weightSum = 0
  let weightedLogSum = 0
  for (let i = 0; i < scaled.length; i += 1) {
    const w = Math.exp(scaled[i] - max)
    weightSum += w
    weightedLogSum += w * logs[i]
  }
  return weightedLogSum / weightSum
}

/** log(Σ exp(v_i))，用最大值平移避免上溢。 */
function logSumExp(values: readonly number[]): number {
  const max = Math.max(...values)
  if (!Number.isFinite(max)) return max
  let sum = 0
  for (const v of values) sum += Math.exp(v - max)
  return max + Math.log(sum)
}

/** Lanczos 近似的 ln Γ(x)，域 x ≥ 1（本模块唯一用途是 Γ(1 + 1/k)，k ≤ 1000 ⇒ x ≥ 1.001）。 */
function lgamma(x: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  const z = x - 1
  let series = 0.99999999999980993
  const t = z + 7.5
  for (let i = 0; i < coefficients.length; i += 1) series += coefficients[i] / (z + i + 1)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series)
}

