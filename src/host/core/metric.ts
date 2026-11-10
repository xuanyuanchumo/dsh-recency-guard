/**
 * 度量契约与数值原语（v0.15 拆环）。
 *
 * 这里只放「模型都要用、且不依赖任何模型」的东西：
 * Metric 契约（不可判定必须 `defined:false` + `null`）、两个构造器、
 * 样本充分度/显示位数、4 位取整、方差、崩溃序列投影。
 *
 * ## 为什么必须独立（eval Q5 的真实违例）
 *
 * 它们原本与具体模型同住在 `observability.ts`，于是
 * `observability → survival → observability` 成立 —— 模型要用契约和原语，
 * 只能从「汇总读数」模块反向取。依赖方向错了，环就出现了。
 *
 * 现在方向单向：模型 → 原语；原语不依赖任何模型，也不依赖观测数据形状。
 */

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

/** 构造一个不可判定的读数（`value` 恒为 null，杜绝「无数据当零」）。 */
export function undefinedMetric<T>(reason: string, label = '不可判定', meta?: MetricMeta): Metric<T> {
  return { value: null, defined: false, label, reason, ...(meta ?? {}) }
}

/** 构造一个可判定的读数。 */

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

/** 总体方差（除以 n，与既有 CV 定义保持一致）。 */
export function variance(values: readonly number[], mean: number): number {
  let acc = 0
  for (const v of values) acc += (v - mean) ** 2
  return acc / values.length
}

/** 间隔离散度的 EWMA 趋势。 */

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
