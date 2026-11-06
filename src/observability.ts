/**
 * 可观测性 —— 量化指标、白盒透明化与数据结构/算法。
 *
 * ## 三条诚实边界（写死在类型里）
 * 1. **无数据 ⇒ 不给分**（`value: null` + `defined: false`），绝不给 0：
 *    「没有崩溃记录」不等于「崩溃率为 0」。
 * 2. **分母为 0 ⇒ 比率不可判定**（不是 0）。
 * 3. **颜色/评分不是唯一通道**：每个读数都带可读文本（`label`），
 *    灰度打印、屏幕阅读器与截图核对都不依赖颜色。
 *
 * ## 白盒契约
 * 每个派生量都返回 `formula`（定义式）、`inputs`（输入摘要）、
 * `sampleSize`（样本量）、`confidence`（样本充分度指数），
 * 或在不可判定时返回 `defined: false` + `reason`（此时 `value === null`）。
 *
 * `confidence` 是**样本充分度降级指数** conf(n) = 1 − 1/√n，**不是覆盖概率**：
 * 它的唯一用途是让前端在样本少时标「低置信」，当 p 值使用是误读。
 *
 * 位数纪律：派生量的**显示位数**按样本量降级（见 `displayDigits`），
 * 内部值统一 4 位小数只为可逐字节比对 —— 位数不得超出样本能支撑的分辨率。
 *
 * ## 模型清单（定义式 / 假设 / 失效条件 / 复杂度）
 *
 * | 模型 | 定义式 | 假设 | 失效条件 | 复杂度 |
 * |---|---|---|---|---|
 * | `crashRate` | 崩溃次数 / 观测启动次数 | 每次启动是独立观测 | 观测数 0 ⇒ 不可判定 | O(n) |
 * | `crashPressure` | EWMA(0/1 启动信号)，α = 1−2^(−1/H) | 时间局部性：越近越重 | 无观测 ⇒ 不可判定 | O(n) |
 * | `crashIntervalStats` | 间隔序列的中位/均值/CV/MAD/IQR | 间隔可加、同一时基 | 崩溃数 < 2 ⇒ 不可判定；全 0 间隔 ⇒ CV 不可判定 | O(n log n) |
 * | `cusumChangePoint` | S_i = max(0, S_{i−1} + (k·q − g_i))，q = P75(g) | 间隔独立同分布、变点后均值下移 | 崩溃数 < 2、q = 0（同刻崩溃）⇒ 不可判定 | O(n log n) |
 * | `intervalSurvival` | 指数 λ̂ = 1/ḡ；Weibull 形状由轮廓似然解 g(k)=0 | 无删失（每次间隔完整观测）、间隔 i.i.d. | 间隔数 < 3、含 0 间隔、全等间隔 ⇒ 不可判定 | O(k·iters)，iters 固定 100 |
 * | `intervalTrend` | ratio = EWMA_H(g)/median(g)（去暖机偏置） | 近期水平可用指数遗忘估计 | 间隔数 < 2、中位间隔 0 ⇒ 不可判定 | O(n) |
 * | `hazardIndex` | 队列内百分位 (#低于我的 / (n−1)) | 队列是同一总体的一次抽样 | 队列为空 ⇒ 不可判定 | O(n log n) |
 * | `crashTrend`（lifecycle） | 间隔序列对序号的最小二乘斜率 | 间隔线性变化 | 间隔数 < 2 ⇒ slope 记 0（此处用 `trendMetric` 包装为不可判定） | O(n) |
 *
 * 数据结构与算法的选型（都要说明复杂度，否则下一个维护者会「优化」错方向）：
 * - **分位数**：精确排序 + 线性插值 O(n log n)。不用 P² 算法：P² 是为
 *   「流式、n 很大、内存受限」设计的近似算法，本模块 n 通常 ≤ 50，
 *   精确值更可审计（契约测试要逐字节比对）。
 * - **环形缓冲** `RingBuffer`：push O(1) 摊销、只保留最近 W 条，O(W) 内存。
 *   用于「只关心最近 W 个间隔」的窗口统计。
 * - **Top-K 嫌疑排序**：`rankHazards` 用**全量排序** O(n log n)，不用
 *   n log k 的堆 —— 面板要逐行显示**完整**排名，堆只给出前 k 个，
 *   还得再排一次；n ≤ 100 时全量排序更快且保序稳定。
 *   插件规模真的上千时，再换成「大小为 k 的最小堆」，届时复杂度是 O(n log k)。
 */

import { crashTrend, riskScore, type RiskInput, type TrendResult } from './lifecycle.js'

/**
 * 白盒元信息 —— 每个派生量都必须能回答「你从什么、按什么式子算出来的」。
 */
export interface MetricMeta {
  /** 定义式（数学写法，可直接展示）。 */
  formula: string
  /** 输入摘要（只放标量，不放数组 —— 快照契约要保持窄）。 */
  inputs?: Record<string, number | string | null>
  /** 样本量。 */
  sampleSize?: number
  /** 样本充分度指数 ∈ [0,1]（不是覆盖概率）。 */
  confidence?: number
}

/**
 * 一个可空的量化读数。
 *
 * `value` 与 `defined` 必须一致：`defined: false` ⇒ `value === null`。
 * 这条不变式由 `undefinedMetric` / `definedMetric` 两个构造器独占保证，
 * 上层不得手写字面量 —— 手写就会出现「有 reason 但有值」的伪状态。
 */
export interface Metric<T> {
  /** 数值；不可判定时为 null。 */
  value: T | null
  /** 是否可判定。 */
  defined: boolean
  /** 人类可读形态（颜色之外的第二通道）。 */
  label: string
  /** 不可判定的原因。 */
  reason?: string
  /** 定义式。 */
  formula?: string
  /** 输入摘要。 */
  inputs?: Record<string, number | string | null>
  /** 样本量。 */
  sampleSize?: number
  /** 样本充分度指数 ∈ [0,1]。 */
  confidence?: number
}

/** 构造一个不可判定的读数（`value` 恒为 null，杜绝「无数据当零」）。 */
export function undefinedMetric<T>(reason: string, label = '不可判定', meta?: MetricMeta): Metric<T> {
  return { value: null, defined: false, label, reason, ...(meta ?? {}) }
}

/** 构造一个可判定的读数。 */
export function definedMetric<T>(value: T, label: string, meta?: MetricMeta): Metric<T> {
  return { value, defined: true, label, ...(meta ?? {}) }
}

/**
 * 样本充分度降级指数：conf(n) = 1 − 1/√n（n ≥ 1），n ≤ 0 ⇒ 0。
 *
 * 单调递增、上界 1、n=1 时为 0 —— 单样本不能支撑任何统计断言。
 * **它不是置信区间的覆盖概率**：真覆盖率需要分布假设与区间估计，
 * 这里只是「样本够不够」的一维单调代理，用来驱动前端的低置信标记。
 */
export function sampleConfidence(sampleSize: number): number {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) return 0
  return round4(1 - 1 / Math.sqrt(sampleSize))
}

/**
 * 样本量能支撑的**显示**有效位数（不是统计保证，只是防伪精度的预算）。
 *
 * digits ≈ log10(n) + 0.5，夹在 [1,4]：3 个样本只能报 1 位有效数字，
 * 100 个样本才配 2~3 位。内部值仍保留 4 位小数以便比对。
 */
export function displayDigits(sampleSize: number): number {
  if (!Number.isFinite(sampleSize) || sampleSize < 1) return 1
  return Math.max(1, Math.min(4, Math.round(Math.log10(sampleSize) + 0.5)))
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
export function crashRate(observations: readonly Observation[]): Metric<number> {
  if (observations.length === 0) {
    return undefinedMetric('没有启动观测记录', '不可判定', { formula: 'crashes / starts', sampleSize: 0 })
  }
  const crashed = observations.filter((o) => o.crashed).length
  const rate = crashed / observations.length
  return definedMetric(round4(rate), `${crashed}/${observations.length} 次启动崩溃（${pct(rate)}）`, {
    formula: 'crashes / starts',
    inputs: { starts: observations.length, crashes: crashed },
    sampleSize: observations.length,
    confidence: sampleConfidence(observations.length),
  })
}

/** 平均恢复耗时（毫秒）。 */
export function meanRecoveryTime(observations: readonly Observation[]): Metric<number> {
  const samples = observations.map((o) => o.recoveryMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (samples.length === 0) {
    return undefinedMetric('没有成功的恢复样本', '不可判定', {
      formula: 'mean(recoveryMs)',
      inputs: { observationCount: observations.length },
      sampleSize: 0,
    })
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return definedMetric(Math.round(mean), `平均 ${(mean / 1000).toFixed(2)} 秒（${samples.length} 个样本）`, {
    formula: 'mean(recoveryMs)',
    inputs: { recoverySamples: samples.length, minMs: Math.min(...samples), maxMs: Math.max(...samples) },
    sampleSize: samples.length,
    confidence: sampleConfidence(samples.length),
  })
}

/** 崩溃检出率。 */
export function detectionRate(observations: readonly Observation[]): Metric<number> {
  const crashes = observations.filter((o) => o.crashed)
  if (crashes.length === 0) {
    return undefinedMetric('没有崩溃样本', '不可判定', {
      formula: 'detected / crashes',
      inputs: { starts: observations.length },
      sampleSize: 0,
    })
  }
  const detected = crashes.filter((o) => o.detected === true).length
  const rate = detected / crashes.length
  return definedMetric(round4(rate), `检出 ${detected}/${crashes.length} 次崩溃`, {
    formula: 'detected / crashes',
    inputs: { crashes: crashes.length, detected },
    sampleSize: crashes.length,
    confidence: sampleConfidence(crashes.length),
  })
}

/**
 * 隔离纯度 —— 衡量分区之间有没有串扰。
 *
 * 定义：未发生串扰的分区 / 全部分区。
 * 一个分区「串扰」= 它的恢复决策影响了其它分区的启动结果。
 * 数据来源：每个分区启动后检查「本分区的决策是否被别处消费」。
 */
export function isolationPurity(
  partitions: ReadonlyArray<{ key: string; contaminated: boolean }>,
): Metric<number> {
  if (partitions.length === 0) {
    return undefinedMetric('没有分区记录', '不可判定', { formula: 'clean / partitions', sampleSize: 0 })
  }
  const clean = partitions.filter((p) => !p.contaminated).length
  const rate = clean / partitions.length
  return definedMetric(round4(rate), `${clean}/${partitions.length} 个分区无串扰（${pct(rate)}）`, {
    formula: 'clean / partitions',
    inputs: { partitions: partitions.length, clean },
    sampleSize: partitions.length,
    confidence: sampleConfidence(partitions.length),
  })
}

// ─────────────────────────── 序列基础设施 ───────────────────────────

/**
 * 崩溃序列 —— **所有**间隔/变点/趋势模型的唯一输入形态。
 *
 * 为什么强制在这里做一次排序：CLAUDE.md 的铁律是「回归相邻崩溃间隔」，
 * 而间隔的定义依赖时刻的**正序**。若各处自行排序，就会出现
 * 「时间倒序输入 ⇒ 间隔为负 ⇒ 方向丢失」这一类静默错误。
 * 这里统一过滤非有限值并升序排列，标签跟着时刻一起重排（否则
 * `labels[i+1]` 会指向错误的崩溃）。
 */
export interface CrashSeries {
  /** 升序时刻（毫秒）。 */
  times: number[]
  /** 与 times 对齐的标签（可为 null）。 */
  labels: Array<string | null>
  /** 相邻间隔 g_i = t_{i+1} − t_i（毫秒，非负）。 */
  gaps: number[]
}

/** 构建崩溃序列（正序 + 标签对齐）。O(n log n)。 */
export function crashSeries(crashTimes: readonly number[], labels: readonly string[] = []): CrashSeries {
  const pairs = crashTimes
    .map((t, index) => ({ t, label: labels[index] ?? null }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  const times = pairs.map((p) => p.t)
  const gaps: number[] = []
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1])
  return { times, labels: pairs.map((p) => p.label), gaps }
}

/**
 * 环形缓冲 —— 有界内存的「最近 W 条」容器。
 *
 * push 摊销 O(1)、内存 O(W)、快照 O(W)；相比 `arr.push` + `arr.shift()`
 * 少一次整体搬移（V8 的 shift 是 O(n)）。容量非法时**夹到 1**而不是抛异常：
 * 观测设施不该因为一个配置错误拖垮守护流程（同生命周期状态机的纪律）。
 */
export class RingBuffer<T> {
  readonly capacity: number
  private readonly slots: Array<T | undefined>
  private next = 0
  private filled = 0

  constructor(capacity: number) {
    const size = Number.isFinite(capacity) ? Math.floor(capacity) : 1
    this.capacity = Math.max(1, size)
    this.slots = new Array<T | undefined>(this.capacity)
  }

  /** 当前元素数。 */
  get size(): number {
    return this.filled
  }

  /** 写入一个元素，超出容量时覆盖最旧的一个。O(1)。 */
  push(value: T): void {
    this.slots[this.next] = value
    this.next = (this.next + 1) % this.capacity
    if (this.filled < this.capacity) this.filled += 1
  }

  /** 按写入顺序（旧 → 新）导出快照。O(size)。 */
  toArray(): T[] {
    const start = this.filled < this.capacity ? 0 : this.next
    const out: T[] = []
    for (let i = 0; i < this.filled; i += 1) out.push(this.slots[(start + i) % this.capacity] as T)
    return out
  }
}

/** 取序列尾部最多 `limit` 条（`limit <= 0` 或超过长度时返回全部）。O(n)，额外内存 O(limit)。 */
export function tailWindow<T>(values: readonly T[], limit: number): T[] {
  if (!Number.isFinite(limit) || limit <= 0 || limit >= values.length) return [...values]
  const ring = new RingBuffer<T>(limit)
  for (const value of values) ring.push(value)
  return ring.toArray()
}

/** 中位数。O(n log n)。空集返回 0（**调用方必须自行判空**：0 不是「中位数为零」）。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  return quantile(values, 0.5)
}

/**
 * 中位数绝对偏差 MAD = median(|x_i − median(x)|)。
 *
 * 为什么除了 CV 还要 MAD：CV 的分子是标准差（对极端离群敏感），
 * 「一次隔了三个月的崩溃」会把 CV 抬高一个量级，而 MAD 对它不敏感。
 * 两者并排给出，读者能一眼看出「离群点驱动的离散」还是「整体离散」。
 */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0
  const mid = median(values)
  return median(values.map((v) => Math.abs(v - mid)))
}

/**
 * 线性插值分位数（与 NumPy 的默认 linear 插值一致）。O(n log n)。
 *
 * 为什么不用「取第 ⌈p·n⌉ 个」的整数索引：小样本（2~10 个间隔）下整数
 * 索引会跳变，相邻样本的 p75 可能差一倍；插值让阈值随样本平滑变化。
 * 参数名虽为 sortedValues，实现仍防御性重排一次 —— 调用方传乱序也不会静默出错。
 */
export function quantile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const sorted = [...sortedValues].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p))
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (pos - lower) * (sorted[upper] - sorted[lower])
}

/**
 * 指数加权移动平均（EWMA）—— 把离散事件流平滑成可比较的速率序列。O(n)。
 *
 * 模型：s_t = α·x_t + (1−α)·s_{t−1}，α = 1 − 2^(−1/H)，H 为**半衰期（样本数）**。
 *
 * 为什么不用简单移动平均：SMA 需要固定窗口且对窗口边缘不连续，而
 * 「最近几次的崩溃密度」在时间上本就是指数遗忘的 —— 用半衰期表达
 * 「多久算近期」比「看最近 N 条」更贴近语义。
 *
 * 零状态种子：s₀ = α·x₀（等价于「观测窗之前全是 0」）。若直接 s = x₀，
 * 最老样本会拿到权重 1.0 —— 比任何近期样本都重，「近期更重」的语义被
 * 种子反转（cycle-4 实测：[1,0,0] 0.7579 > [0,0,1] 0.1294）。
 *
 * 失效条件：**空序列返回 0**，这是函数契约（不是指标）：调用方必须判空
 * 后再解释，指标层（`crashPressure`）在无样本时返回 `defined:false`。
 * 另外零种子带来**暖机偏置**（前 n 条的加权和只有 1−(1−α)^n），
 * 需要无偏水平估计时用 `ewmaLevel`。
 */
export function ewma(values: readonly number[], halfLife = 3): number {
  if (values.length === 0) return 0
  return round4(ewmaKernel(values, halfLife))
}

/**
 * 去暖机偏置的 EWMA 水平估计。O(n)。
 *
 *   s_n / (1 − (1−α)^n)
 *
 * 为什么必须去偏：对**常数**序列，零种子 EWMA 的比值恒为
 * 1 − 0.5^(n/H)，n=3、H=3 时只有 0.5 —— 直接拿它和基准比会凭空
 * 报出「间隔缩短一半」的假变密。除以暖机因子后，常数序列严格还原常数。
 *
 * 失效条件：n = 0 ⇒ 返回 0（同 `ewma` 的契约）；n = 1 ⇒ 返回 x₀（正确：
 * 单点水平就是它自己）。
 */
export function ewmaLevel(values: readonly number[], halfLife = 3): number {
  if (values.length === 0) return 0
  const alpha = ewmaAlpha(halfLife)
  const warmup = 1 - Math.pow(1 - alpha, values.length)
  if (warmup <= 0) return 0
  return round4(ewmaKernel(values, halfLife) / warmup)
}

/** EWMA 的 α：α = 1 − 2^(−1/H)；H < 1 时夹到 1（避免 α > 0.5 的非法语义）。 */
function ewmaAlpha(halfLife: number): number {
  return 1 - Math.pow(2, -1 / Math.max(1, halfLife))
}

/** 未取整的 EWMA 内核（`ewmaLevel` 需要它做除法，先取整会引入伪精度损失）。 */
function ewmaKernel(values: readonly number[], halfLife: number): number {
  const alpha = ewmaAlpha(halfLife)
  let s = alpha * values[0]
  for (let i = 1; i < values.length; i += 1) s = alpha * values[i] + (1 - alpha) * s
  return s
}

// ─────────────────────────── 间隔统计 ───────────────────────────

/** 间隔序列的鲁棒统计。 */
export interface IntervalStats {
  /** 中位间隔（毫秒，鲁棒中心）。 */
  medianMs: number
  /** 平均间隔（毫秒）。 */
  meanMs: number
  /** 变异系数 = 标准差/均值；样本 < 2 或均值为 0 时为 null（分母为 0 不是 0）。 */
  cv: number | null
  /** cv 不可判定时的原因。 */
  cvReason?: string
  /** 中位数绝对偏差（毫秒，抗离群离散度）。 */
  madMs: number
  /** 四分位距（毫秒）。 */
  iqrMs: number
  minMs: number
  maxMs: number
}

/**
 * 崩溃间隔的统计 —— 回答「崩溃是不是在变密」。
 *
 * 定义式：g_i = t_{i+1} − t_i；中心用中位数（抗离群），离散度同时给
 * CV = σ/μ（对离群敏感）与 MAD（抗离群），并附 IQR 便于画箱线。
 *
 * 失效条件：崩溃数 < 2（没有间隔）⇒ 不可判定；间隔数 < 2 ⇒ CV 无意义（null）；
 * 均值 = 0（全部崩溃同刻）⇒ CV 分母为 0 ⇒ null。
 *
 * 复杂度：排序主导 O(n log n)。
 */
export function crashIntervalStats(crashTimes: readonly number[]): Metric<IntervalStats> {
  const { times, gaps } = crashSeries(crashTimes)
  if (times.length < 2) {
    return undefinedMetric('至少需要两次崩溃才能计算间隔', '不可判定', {
      formula: 'g_i = t_{i+1} − t_i',
      inputs: { crashes: times.length, gaps: 0 },
      sampleSize: times.length,
    })
  }
  const medianGap = median(gaps)
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  // 离散度需要「≥2 个间隔」才有自由度：单间隔的样本标准差恒为 0，那不是
  // 「完全规则」，而是**没有信息** —— 必须给 null，绝不能给 0（铁律）。
  const dispersion = gaps.length < 2 || mean === 0 ? null : round4(Math.sqrt(variance(gaps, mean)) / mean)
  const stats: IntervalStats = {
    medianMs: Math.round(medianGap),
    meanMs: Math.round(mean),
    cv: dispersion,
    madMs: Math.round(medianAbsoluteDeviation(gaps)),
    iqrMs: Math.round(quantile(gaps, 0.75) - quantile(gaps, 0.25)),
    minMs: Math.round(Math.min(...gaps)),
    maxMs: Math.round(Math.max(...gaps)),
  }
  if (gaps.length < 2) stats.cvReason = '间隔样本 < 2，离散度无自由度'
  else if (dispersion === null) stats.cvReason = '全部间隔为 0（均值 0 ⇒ 分母为 0），离散度不可判定'

  const digits = displayDigits(gaps.length)
  return definedMetric(
    stats,
    `中位间隔 ${(medianGap / 1000).toFixed(digits)} 秒，变异系数 ${stats.cv ?? '—'}（${gaps.length} 个间隔）`,
    {
      formula: 'median(g), CV = σ_g/μ_g, MAD = median|g − median(g)|',
      inputs: {
        gaps: gaps.length,
        minMs: stats.minMs,
        maxMs: stats.maxMs,
        madMs: stats.madMs,
        iqrMs: stats.iqrMs,
        cvReason: stats.cvReason ?? null,
      },
      sampleSize: gaps.length,
      confidence: sampleConfidence(gaps.length),
    },
  )
}

/** 总体方差（除以 n，与既有 CV 定义保持一致）。 */
function variance(values: readonly number[], mean: number): number {
  let acc = 0
  for (const v of values) acc += (v - mean) ** 2
  return acc / values.length
}

/** 间隔离散度的 EWMA 趋势。 */
export interface IntervalTrend {
  /** 去暖机偏置的近期间隔水平（毫秒）。 */
  recentMs: number
  /** 全序列中位间隔（毫秒，基准）。 */
  baselineMs: number
  /** recent / baseline；<1 ⇒ 间隔变短 ⇒ 崩溃变密。 */
  ratio: number
  /** 方向判定（对数对称阈值：ratio ≤ 0.75 变密、≥ 1.333 变稀）。 */
  direction: 'denser' | 'steady' | 'sparser'
  /** 参与计算的间隔数（窗口裁剪后）。 */
  window: number
}

/** 变密判定的下阈 0.75 = exp(−0.288)，变稀上阈 1.333 = exp(+0.288)：对数空间对称。 */
const TREND_DENSER_RATIO = 0.75
const TREND_SPARSER_RATIO = 4 / 3

/**
 * 间隔趋势（EWMA 视角）—— 回答「最近的崩溃是不是比历史更密」。
 *
 * 定义式：recent = EWMA_H(g) / (1 − (1−α)^n)；baseline = median(g)；
 * ratio = recent / baseline；ratio ≤ 0.75 ⇒ 变密，≥ 1.333 ⇒ 变稀。
 *
 * 与 CUSUM 的分工：CUSUM 检测**持续漂移**（累积证据、有阈值告警），
 * 本模型只给**当前水平**与历史基准的比值（瞬时视图，不告警）。
 * 与 crashTrend 的分工：crashTrend 回归间隔对**序号**的斜率（全局线性趋势），
 * 本模型是指数遗忘的**近期水平**（局部/即时）。
 *
 * 假设与失效条件：
 * - 间隔 i.i.d. 且时基一致；间隔数 < 2 ⇒ 不可判定。
 * - 基准 = 0（全部崩溃同刻）⇒ 比值分母为 0 ⇒ 不可判定，绝不填 0。
 * - **必须用去偏 EWMA**：零种子在短序列上会凭空报「变密」（见 `ewmaLevel`）。
 *
 * 复杂度 O(n)；`window > 0` 时用环形缓冲只保留最近 W 个间隔，额外内存 O(W)。
 */
export function intervalTrend(crashTimes: readonly number[], halfLife = 3, window = 0): Metric<IntervalTrend> {
  const { gaps } = crashSeries(crashTimes)
  const used = tailWindow(gaps, window)
  if (used.length < 2) {
    return undefinedMetric('至少需要 2 个崩溃间隔才能判定走向', '不可判定', {
      formula: 'ratio = EWMA_H(g)/median(g)',
      inputs: { gaps: gaps.length, window: used.length, halfLife },
      sampleSize: used.length,
    })
  }
  const baseline = median(used)
  if (!(baseline > 0)) {
    return undefinedMetric('基准间隔为 0（全部崩溃发生在同一时刻），比值不可判定', '不可判定', {
      formula: 'ratio = EWMA_H(g)/median(g)',
      inputs: { gaps: used.length, halfLife, baselineMs: 0 },
      sampleSize: used.length,
    })
  }
  const recent = ewmaLevel(used, halfLife)
  const ratio = recent / baseline
  const direction: IntervalTrend['direction'] =
    ratio <= TREND_DENSER_RATIO ? 'denser' : ratio >= TREND_SPARSER_RATIO ? 'sparser' : 'steady'
  const value: IntervalTrend = { recentMs: Math.round(recent), baselineMs: Math.round(baseline), ratio: round4(ratio), direction, window: used.length }
  const verb = direction === 'denser' ? '变密' : direction === 'sparser' ? '变稀' : '平稳'
  return definedMetric(
    value,
    `近期间隔 ${(recent / 1000).toFixed(displayDigits(used.length))} 秒 / 基准 ${(baseline / 1000).toFixed(displayDigits(used.length))} 秒 = ${value.ratio}（${verb}）`,
    {
      formula: 'ratio = EWMA_H(g) / median(g)，EWMA 已按 1−(1−α)^n 去暖机偏置',
      inputs: { gaps: used.length, totalGaps: gaps.length, halfLife, ratio: value.ratio, direction },
      sampleSize: used.length,
      confidence: sampleConfidence(used.length),
    },
  )
}

// ─────────────────────────── 生存 / 危险率 ───────────────────────────

/** 危险率方向。 */
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

// ─────────────────────────── CUSUM 变点 ───────────────────────────

/** CUSUM 变点结果（白盒：统计量、基准、阈值都随结果一起返回）。 */
export interface ChangePoint {
  /** 变点落在第几次崩溃（1-based）。 */
  index: number
  /** 变点崩溃的时刻标签（无标签时为 null）。 */
  at: string | null
  /** 触发时的 CUSUM 统计量 S。 */
  statistic: number
  /** 基准间隔 q = P75(g)（毫秒）。 */
  baselineMs: number
  /** 告警阈 A = alarmFactor · q（毫秒）。 */
  thresholdMs: number
  /** 触发处的间隔 g_i（毫秒）。 */
  gapMs: number
}

/**
 * CUSUM 变点检测 —— 回答「崩溃密度是从哪一次开始上行的」。
 *
 * 数学模型
 * --------
 * 输入是**相邻崩溃间隔** g_i（毫秒）——CLAUDE.md 铁律：回归时间戳或累计
 * 计数都不携带方向（斜率恒 1 / 方向丢失是实测踩过的坑），只有间隔能表达
 * 「变密/变稀」。以 **P75 分位** q 为「正常水平」，容差系数 k = 0.75：
 *
 *   S_i = max(0, S_{i−1} + (k·q − g_i))，告警阈 A = a·q（a = 1.5）
 *
 * 为什么基准不用中位数：中位数的定义保证约一半样本低于它 ——
 * 「间隔低于 0.75×中位数」的样本太少，S 几乎不可能累计到阈值，
 * 检测器对真实的密度变化**结构性失明**（cycle-3 实测）。P75 之下只有
 * 25% 的样本，只有**持续显著变密**才能把 S 推过告警阈 —— 这正是
 * CUSUM 对「漂移」而非「尖峰」敏感的语义（尖峰用 EWMA/中位数已足够）。
 *
 * 假设：间隔独立同分布，变点之后均值下移（崩溃变密）。间隔越短 ⇒
 * 增量越大 ⇒ 恰好在「变密」处告警；间隔稳定或变稀时增量恒为负，S 被钳在 0。
 *
 * 失效条件（全部 `defined:false`）：
 * - 崩溃数 < 2（没有间隔）；
 * - 基准 q = 0（≥75% 的间隔为 0，即多次崩溃挤在同一时刻）⇒ 统计量无尺度可比；
 * - 未出现持续变密（这是「未检出」，不是「密度为零」）。
 *
 * 为什么不用二分/回归找变点：间隔序列通常只有 2~10 个样本，单次 O(n log n)
 * 扫描足够，且阈值语义（0.75q / 1.5q）可以直接解释给用户。
 */
export function cusumChangePoint(
  crashTimes: readonly number[],
  labels: readonly string[] = [],
  toleranceFactor = 0.75,
  alarmFactor = 1.5,
): Metric<ChangePoint> {
  const { labels: sortedLabels, gaps } = crashSeries(crashTimes, labels)
  const formula = 'S_i = max(0, S_{i−1} + (k·q − g_i))，q = P75(g)，A = a·q'
  const meta = (inputs: Record<string, number | string | null>): MetricMeta => ({
    formula,
    inputs,
    sampleSize: gaps.length,
    confidence: sampleConfidence(gaps.length),
  })
  if (gaps.length < 1) {
    return undefinedMetric('至少需要两次崩溃才能检测密度变化', '不可判定', meta({ crashes: gaps.length + 1, gaps: gaps.length }))
  }
  const baseline = quantile(gaps, 0.75)
  if (!(baseline > 0)) {
    return undefinedMetric('基准间隔为 0（多数崩溃挤在同一时刻），CUSUM 统计量无尺度可比', '不可判定', meta({ gaps: gaps.length, baselineMs: 0 }))
  }
  const threshold = baseline * alarmFactor
  let s = 0
  for (let i = 0; i < gaps.length; i += 1) {
    s = Math.max(0, s + (baseline * toleranceFactor - gaps[i]))
    if (s > threshold) {
      // 变点 = 变密后的第一次崩溃：gaps[i] 连接第 i+1 与第 i+2 次（1-based），
      // 密度上行体现在第 i+2 次崩溃上。
      const value: ChangePoint = {
        index: i + 2,
        at: sortedLabels[i + 1] ?? null,
        statistic: round4(s),
        baselineMs: Math.round(baseline),
        thresholdMs: Math.round(threshold),
        gapMs: Math.round(gaps[i]),
      }
      return definedMetric(
        value,
        `崩溃密度自第 ${value.index} 次崩溃起上行（间隔 ${(gaps[i] / 1000).toFixed(1)}s < 基准 ${(baseline / 1000).toFixed(1)}s，S=${(value.statistic / 1000).toFixed(1)}s > A=${(threshold / 1000).toFixed(1)}s）`,
        meta({
          gaps: gaps.length,
          baselineMs: value.baselineMs,
          thresholdMs: value.thresholdMs,
          statistic: value.statistic,
          toleranceFactor,
          alarmFactor,
        }),
      )
    }
  }
  return undefinedMetric('未检测到密度上行（崩溃间隔稳定或变稀）', '未检出', meta({ gaps: gaps.length, baselineMs: Math.round(baseline), thresholdMs: Math.round(threshold) }))
}

// ─────────────────────────── 崩溃压力 ───────────────────────────

/**
 * 崩溃压力 —— EWMA 平滑的「近期崩溃密度」∈ [0,1]。O(n)。
 *
 * 数学模型：把启动序列编码成 0/1 信号（1 = 崩溃），对信号做 EWMA
 * （半衰期默认 5 次启动）：s_t = α·x_t + (1−α)·s_{t−1}。
 *
 * 为什么不是 crashRate（整体比率）：crashRate 对「很久以前崩过一次」与
 * 「刚刚连崩两次」给出同一个数 —— 时间局部性丢失。EWMA 用指数遗忘表达
 * 「多久算近期」，半衰期 5 次启动 ≈ 用户感知的「最近一段时间的状态」。
 *
 * 诚实边界：无观测样本时不可判定（null），而非给 0（「没数据」≠「没压力」）。
 * 全平稳序列的 0 是**真值**（有数据且每次都没崩），两者语义不同。
 * 已知偏差：零种子使早期读数**偏低**（保守），需要无偏水平时用 `ewmaLevel`。
 */
export function crashPressure(observations: readonly Observation[], halfLife = 5): Metric<number> {
  if (observations.length === 0) {
    return undefinedMetric('没有启动观测记录', '不可判定', {
      formula: 's_t = α·x_t + (1−α)·s_{t−1}，α = 1 − 2^(−1/H)',
      inputs: { starts: 0, halfLife },
      sampleSize: 0,
    })
  }
  const signal: number[] = observations.map((o) => (o.crashed ? 1 : 0))
  const pressure = ewma(signal, halfLife)
  const crashed = signal.reduce((a, b) => a + b, 0)
  return definedMetric(pressure, `近期崩溃压力 ${pressure.toFixed(2)}（半衰期 ${halfLife} 次启动）`, {
    formula: 's_t = α·x_t + (1−α)·s_{t−1}，α = 1 − 2^(−1/H)，x ∈ {0,1}',
    inputs: { starts: observations.length, crashes: crashed, halfLife },
    sampleSize: observations.length,
    confidence: sampleConfidence(observations.length),
  })
}

// ─────────────────────────── 嫌疑危险度标度 ───────────────────────────

/** 嫌疑插件的可比危险度等级（文字通道，与 hazardIndex 对应）。 */
export type HazardTier = 'high' | 'medium' | 'low' | 'none'

/** 一行嫌疑排名。 */
export interface RankedRisk {
  bundle: string
  /**
   * 原始加权风险分 ∈ [0,1]。
   *
   * **它不是概率**：权重（0.5/0.3/0.2）是人工先验，不是似然；分数之间
   * 只在**序**上有意义。跨插件比较请用 `hazardIndex`。
   */
  risk: number
  /** 队列内百分位 ∈ [0,1]：把不可比的原始分换算成可比的相对位置。 */
  hazardIndex: number
  /** 等级（high/medium/low/none）。 */
  tier: HazardTier
  label: string
  experimental: boolean
  lastChangeAt: string
}

/**
 * 嫌疑插件的风险排名 + **可比危险度标度**。O(n log n)。
 *
 * 为什么需要 hazardIndex（避免量纲混淆）
 * ------------------------------------
 * `risk` = 0.5·recency + 0.3·experimental + 0.2·frequency 是一个**加权分**：
 * 三项都归一化到 [0,1]，所以和也在 [0,1]，但它不是概率、没有校准。
 * 直接说「这个插件 0.83，很危险」会把读者引向「83% 会崩」的误读。
 * hazardIndex 把原始分映射为**队列内百分位** rank = (#严格低于我的) / (n−1)：
 * - 它只依赖**相对次序**，因此对权重的整体缩放不敏感（这是「可比标度」的关键）；
 * - 0 表示队列里最低，1 表示最高；它是相对的，不是绝对的 ——
 *   队列里只有一个插件时它是 1，但没有比较意义（此时 confidence = 0）。
 *
 * 数据结构：全量排序数组而非大小为 k 的堆 —— 面板要逐行显示**完整**排名，
 * 堆只给前 k 个还得再排一次。n ≤ 100 时全量排序（O(n log n)）更快且稳定；
 * 插件规模上千时应换成最小堆（O(n log k)）。
 *
 * 失效条件：空队列 ⇒ `defined:false`（不是空分数列表）。
 */
export function rankHazards(
  inputs: ReadonlyArray<{
    bundle: string
    experimental: boolean
    lastChangeAt: string
    suspectHits: number
    observations: number
  }>,
  now = Date.now(),
): Metric<RankedRisk[]> {
  const formula = 'risk = 0.5·2^(−age/72h) + 0.3·experimental + 0.2·hits/observations；hazardIndex = (#低于我的)/(n−1)'
  if (inputs.length === 0) {
    return undefinedMetric('没有嫌疑插件可排名', '不可判定', { formula, inputs: { bundles: 0 }, sampleSize: 0 })
  }
  const scored = inputs.map((input) => {
    const riskInput: RiskInput = {
      lastChangeAt: input.lastChangeAt,
      experimental: input.experimental,
      suspectHits: input.suspectHits,
      observations: input.observations,
    }
    return { input, risk: riskScore(riskInput, now) }
  })
  // 降序；同分按名称字典序 —— 稳定且可比对（契约测试要求逐字节一致）。
  scored.sort((a, b) => b.risk - a.risk || a.input.bundle.localeCompare(b.input.bundle))

  const n = scored.length
  const ranked: RankedRisk[] = scored.map((entry, rank) => {
    // 百分位用「排名」而不是「分数」：分数分布未知，排名分布必定均匀。
    const hazardIndex = n === 1 ? 1 : round4((n - 1 - rank) / (n - 1))
    const tier: HazardTier = entry.risk <= 0 ? 'none' : hazardIndex >= 0.75 ? 'high' : hazardIndex >= 0.4 ? 'medium' : 'low'
    return {
      bundle: entry.input.bundle,
      risk: entry.risk,
      hazardIndex,
      tier,
      label: `${entry.input.bundle} 风险 ${entry.risk.toFixed(2)}（${describeRisk(entry.risk)}，相对危险度 ${hazardIndex.toFixed(2)}）`,
      experimental: entry.input.experimental,
      lastChangeAt: entry.input.lastChangeAt,
    }
  })
  return definedMetric(ranked, `嫌疑排名 ${ranked.length} 项（相对危险度按队列百分位）`, {
    formula,
    inputs: { bundles: ranked.length, confidenceNote: 'n=1 时百分位无比较意义' },
    sampleSize: ranked.length,
    confidence: ranked.length > 1 ? sampleConfidence(ranked.length - 1) : 0,
  })
}

/**
 * 风险降序排名（兼容包装）。
 *
 * 保留数组返回形态：既有消费方（快照/面板/测试）按数组使用。
 * 需要白盒元信息时用 `rankHazards`。
 */
export function rankRisks(
  inputs: ReadonlyArray<{
    bundle: string
    experimental: boolean
    lastChangeAt: string
    suspectHits: number
    observations: number
  }>,
  now = Date.now(),
): RankedRisk[] {
  return rankHazards(inputs, now).value ?? []
}

/** 风险等级的文字描述（颜色之外的通道）。 */
export function describeRisk(risk: number): string {
  if (risk >= 0.7) return '高'
  if (risk >= 0.4) return '中'
  if (risk > 0) return '低'
  return '无'
}

// ─────────────────────────── 快照 ───────────────────────────

/** 全部量化指标的一个快照。 */
export interface MetricsSnapshot {
  crashRate: Metric<number>
  meanRecoveryTime: Metric<number>
  detectionRate: Metric<number>
  isolationPurity: Metric<number>
  /** 崩溃间隔统计（中位/均值/CV/MAD/IQR；崩溃数 < 2 时不可判定）。 */
  intervals: Metric<IntervalStats>
  /** CUSUM 变点检测（崩溃密度何时开始上行；无上行时不可判定）。 */
  changePoint: Metric<ChangePoint>
  /**
   * 崩溃压力（EWMA 平滑的近期崩溃速率 ∈ [0,1]；无观测样本时不可判定）。
   *
   * cycle-4 补：`ewma` 半衰期模型此前已实现并有单测，但从未进快照 ——
   * 「生产了没人消费」的过度生产缺口由契约分析暴露后补上这条消费链。
   */
  crashPressure: Metric<number>
  /** 间隔的生存/危险率视角（指数 + Weibull；间隔 < 3 时不可判定）。 */
  survival: Metric<SurvivalFit>
  /** 间隔离散度的 EWMA 趋势（去暖机偏置；间隔 < 2 时不可判定）。 */
  intervalTrend: Metric<IntervalTrend>
  /**
   * 原始趋势结果（兼容字段，由 lifecycle.crashTrend 提供）。
   *
   * 注意：样本不足时它以 `slope: 0 / verdict: 'stable'` 表示 —— 那是
   * 「无数据」而不是「平稳」。需要诚实边界时读 `trendMetric`。
   */
  trend: TrendResult
  /** 上一条的诚实包装：间隔样本 < 2 ⇒ `defined:false`（不把无数据当平稳）。 */
  trendMetric: Metric<TrendResult>
  stabilityScore: number
}

/**
 * 计算全部指标。
 *
 * `crashTimes` 统一由 `crashSeries` 归一（升序 + 标签对齐），
 * 因此 CUSUM 的变点能落到「哪一次崩溃」而不仅是数组下标，
 * 且时间倒序输入不会静默产生负间隔。
 */
export function computeMetrics(
  observations: Observation[],
  stabilityScore: number,
  partitions: Array<{ key: string; contaminated: boolean }>,
  now = Date.now(),
): MetricsSnapshot {
  const crashed = observations.filter((o) => o.crashed)
  const crashTimes = crashed.map((o) => Date.parse(o.at)).filter(Number.isFinite)
  const crashLabels = crashed.map((o) => o.at)
  const trend = crashTrend(crashTimes, now)
  return {
    crashRate: crashRate(observations),
    meanRecoveryTime: meanRecoveryTime(observations),
    detectionRate: detectionRate(observations),
    isolationPurity: isolationPurity(partitions),
    intervals: crashIntervalStats(crashTimes),
    changePoint: cusumChangePoint(crashTimes, crashLabels),
    crashPressure: crashPressure(observations),
    survival: intervalSurvival(crashTimes),
    intervalTrend: intervalTrend(crashTimes),
    trend,
    trendMetric: trendMetric(trend),
    stabilityScore,
  }
}

/**
 * 把 `crashTrend` 的原始结果包成诚实读数。
 *
 * `crashTrend.samples` 是**间隔数**（崩溃数 − 1）。间隔数 < 2 时回归的
 * 自变量只有一个点，斜率的 0 是「没有信息」，不是「趋势平稳」——
 * 这里必须转成 `defined:false`，否则面板会把「数据不足」渲染成绿字平稳。
 */
export function trendMetric(trend: TrendResult): Metric<TrendResult> {
  const formula = 'b = Σ(x−x̄)(y−ȳ)/Σ(x−x̄)²，x = 间隔序号，y = 间隔长度（小时）'
  if (trend.samples < 2) {
    return undefinedMetric('间隔样本 < 2，回归斜率无自由度（不是「趋势平稳」）', '不可判定', {
      formula,
      inputs: { gaps: trend.samples, verdict: trend.verdict },
      sampleSize: trend.samples,
    })
  }
  const verdictLabel = trend.verdict === 'worsening' ? '变密（恶化）' : trend.verdict === 'improving' ? '变稀（改善）' : '平稳'
  return definedMetric(trend, `${verdictLabel}：斜率 ${trend.rawSlope} 小时/次（${trend.samples} 个间隔）`, {
    formula,
    inputs: { gaps: trend.samples, rawSlope: trend.rawSlope, threshold: trend.threshold, verdict: trend.verdict },
    sampleSize: trend.samples,
    confidence: sampleConfidence(trend.samples),
  })
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}
