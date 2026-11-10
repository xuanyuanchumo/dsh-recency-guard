/**
 * 官方实验插件的**共现信号**采集与验证（v0.13 方向④，研究文档 09 §2.4）。
 *
 * ## 为什么先采集、不加权
 *
 * 候选方向原提议：「若某非官方插件依赖的底层模块与某官方实验插件共享（或该
 * 实验插件在崩溃窗口中也处于活跃状态），该非官方插件的风险加权应适度上调」。
 *
 * 研究文档 09 §2.4 判定这条**数据基础不存在**且风险方向不对：
 * 1. **依赖数据不存在** —— `official-observe.ts` 只记 `{bundle, version, enabled}`；
 *    `declaredDependenciesSync` 是 profile 声明的依赖列表，**不是插件间运行时依赖图**；
 *    `CapabilityGraph` 是插件**内部**能力关系，不是插件间依赖。
 * 2. **共现 ≠ 因果** —— 官方实验插件崩溃时，非官方插件可能只是「在同一时刻活跃」。
 *    直接加权会**增加误伤**（把无辜插件加权），与「宁可漏拦，不可过度拦截」相反。
 * 3. **不可证伪** —— 没有因子快照就无法验证共现是否真有预测力。先上模型再验证，
 *    违反项目「先验证假设再行动」的迭代纪律。
 *
 * 所以本模块只做**采集与验证**，不动判定：
 * - 采集：每次崩溃时，记录「当时哪些官方实验插件处于启用态」+「哪些非官方嫌疑
 *   插件在场」→ 落盘成共现样本。
 * - 验证：累计到足够样本后，算出「官方实验活跃时非官方插件的命中率」vs
 *   「不活跃时」，给出**可判定的**结论（含 `defined:false` 边界）。
 * - 加权：**留空**。只有验证结论达到统计显著时才谈得上加权，且届时权重上限 0.1
 *   （远低于 recency 的 0.5），并只在「官方实验插件在崩溃窗口内**确实变更过**」
 *   时触发（比「活跃」严格）。
 *
 * ## 复杂度
 *
 * 采集 O(o + s)（o = 官方实验数，s = 嫌疑数）；验证 O(n)（n = 样本数）。
 * 全部纯函数 + 注入存储，可独立单测。
 */

import type { Observation } from './observability.js'
import { definedMetric, round4, sampleConfidence, undefinedMetric, type Metric } from './observability.js'

/** 一条共现样本：一次崩溃时「谁在场」。 */
export interface CooccurrenceSample {
  /** 崩溃时刻（ISO）。 */
  at: string
  /** 崩溃当时处于启用态的官方实验插件名。 */
  officialActive: string[]
  /** 崩溃当时的非官方嫌疑插件名（按嫌疑排序）。 */
  suspects: string[]
  /** 该轮最终被自动关闭的插件名（空 = 观察轮）。 */
  disabled: string[]
}

/** 共现样本的存储形状（带 schema 版本，便于将来演进）。 */
export interface CooccurrenceStore {
  schemaVersion: 1
  samples: CooccurrenceSample[]
}

/**
 * 共现验证结论。
 *
 * 每一栏都可能是 `defined:false` —— 「样本不足」与「没有差异」是两件事，
 * 前者不能说成后者（否则会给「共现无用」提供伪证据）。
 */
export interface CooccurrenceVerdict {
  /** 样本总数。 */
  samples: number
  /** 官方实验活跃时的样本数。 */
  activeSamples: number
  /** 官方实验不活跃时的样本数。 */
  inactiveSamples: number
  /** 活跃时「有插件被关闭」的比例（= 命中率）。 */
  activeHitRate: Metric<number>
  /** 不活跃时的命中率。 */
  inactiveHitRate: Metric<number>
  /**
   * 命中率差值（活跃 − 不活跃）。
   *
   * 这是**唯一**可以用来判断「共现是否有预测力」的量。正且显著 ⇒ 值得考虑加权；
   * 接近 0 或为负 ⇒ 共现信号无价值，**不应加权**。
   */
  hitRateDelta: Metric<number>
  /** 人读结论（面板/工具直接展示）。 */
  label: string
}

/** 判定所需的最小样本数（每侧至少 5 条，低于此不宜谈比率差异）。 */
const MIN_SAMPLES_PER_SIDE = 5

/** 差值显著性的经验阈值：超过 0.2（20 个百分点）才认为"可能有预测力"。 */
const MEANINGFUL_DELTA = 0.2

/** 构造一个空的共现存储。 */
export function emptyCooccurrenceStore(): CooccurrenceStore {
  return { schemaVersion: 1, samples: [] }
}

/**
 * 追加一条共现样本（纯函数，返回新数组）。
 *
 * 上限保护：只保留最近 `limit` 条（默认 200）。共现验证是**近期相关性**，
 * 无限累积会让「三年前的活跃」影响今天的判断，也会让文件无限增长。
 */
export function appendSample(
  store: CooccurrenceStore,
  sample: CooccurrenceSample,
  limit = 200,
): CooccurrenceStore {
  const samples = [...store.samples, sample]
  return {
    schemaVersion: 1,
    samples: samples.length > limit ? samples.slice(samples.length - limit) : samples,
  }
}

/** 命中率读数（带诚实边界）。 */
function hitRateOf(samples: readonly CooccurrenceSample[], active: boolean): Metric<number> {
  const side = samples.filter((s) => (s.officialActive.length > 0) === active)
  if (side.length === 0) {
    return undefinedMetric(active ? '没有官方实验插件活跃的崩溃样本' : '没有官方实验插件不活跃的崩溃样本', '不可判定', {
      formula: active ? 'hits(active) / samples(active)' : 'hits(inactive) / samples(inactive)',
      sampleSize: 0,
    })
  }
  const hits = side.filter((s) => s.disabled.length > 0).length
  return definedMetric(round4(hits / side.length), `${hits}/${side.length} 次崩溃有插件被关闭`, {
    formula: active ? 'hits(active) / samples(active)' : 'hits(inactive) / samples(inactive)',
    inputs: { samples: side.length, hits },
    sampleSize: side.length,
    confidence: sampleConfidence(side.length),
  })
}

/**
 * 验证共现信号是否有预测力（纯函数）。
 *
 * 回答的问题是：**官方实验插件活跃时，非官方插件更容易被判定为嫌疑吗？**
 * - 若显著更高 ⇒ 共现可能携带信息（但仍不等于因果）
 * - 若相近或更低 ⇒ 共现无价值，不应加权
 * - 样本不足 ⇒ 不可判定（不猜）
 */
export function verifyCooccurrence(store: CooccurrenceStore): CooccurrenceVerdict {
  const samples = store.samples
  const activeSamples = samples.filter((s) => s.officialActive.length > 0).length
  const inactiveSamples = samples.length - activeSamples

  const activeHitRate = hitRateOf(samples, true)
  const inactiveHitRate = hitRateOf(samples, false)

  let hitRateDelta: Metric<number>
  if (activeHitRate.value === null || inactiveHitRate.value === null) {
    hitRateDelta = undefinedMetric('任一侧样本为空，差值不可判定', '不可判定', {
      formula: 'hitRate(active) − hitRate(inactive)',
      sampleSize: samples.length,
    })
  } else if (activeSamples < MIN_SAMPLES_PER_SIDE || inactiveSamples < MIN_SAMPLES_PER_SIDE) {
    hitRateDelta = undefinedMetric(
      `每侧至少需 ${MIN_SAMPLES_PER_SIDE} 条样本（当前 ${activeSamples}/${inactiveSamples}）`,
      '不可判定',
      { formula: 'hitRate(active) − hitRate(inactive)', sampleSize: samples.length },
    )
  } else {
    const delta = round4(activeHitRate.value - inactiveHitRate.value)
    hitRateDelta = definedMetric(delta, `差值 ${(delta * 100).toFixed(1)} 个百分点`, {
      formula: 'hitRate(active) − hitRate(inactive)',
      inputs: { active: activeHitRate.value, inactive: inactiveHitRate.value },
      sampleSize: samples.length,
      confidence: sampleConfidence(Math.min(activeSamples, inactiveSamples)),
    })
  }

  const label =
    samples.length === 0
      ? '尚无共现样本，无法验证共现信号'
      : hitRateDelta.value === null
        ? `样本不足（活跃 ${activeSamples} / 不活跃 ${inactiveSamples}）：共现信号暂不可判定`
        : hitRateDelta.value >= MEANINGFUL_DELTA
          ? `共现信号可能有预测力（差值 ${(hitRateDelta.value * 100).toFixed(1)} 点 ≥ ${MEANINGFUL_DELTA * 100}）—— 仍需更多样本与因果论证才能加权`
          : `共现信号无显著预测力（差值 ${(hitRateDelta.value * 100).toFixed(1)} 点）—— **不应加权**`

  return { samples: samples.length, activeSamples, inactiveSamples, activeHitRate, inactiveHitRate, hitRateDelta, label }
}

/**
 * 共现数据能否支撑「加权」这个动作。
 *
 * 这是一个**门**而不是一个建议：只有明确 `true` 才允许在将来的版本里引入加权。
 * 当前实现永远返回 `false`（保守：连验证都还没跑够样本），并给出原因。
 */
export function mayWeightByCooccurrence(verdict: CooccurrenceVerdict): { allowed: boolean; reason: string } {
  if (verdict.samples === 0) return { allowed: false, reason: '尚无共现样本' }
  if (verdict.hitRateDelta.value === null) return { allowed: false, reason: '样本不足，差值不可判定' }
  if (verdict.hitRateDelta.value < MEANINGFUL_DELTA) {
    return { allowed: false, reason: `差值为 ${(verdict.hitRateDelta.value * 100).toFixed(1)} 点，未达 ${MEANINGFUL_DELTA * 100} 点门槛` }
  }
  // 即使差值达标，也要求两侧样本足够（结论要有统计支撑）。
  if (verdict.activeSamples < MIN_SAMPLES_PER_SIDE * 2 || verdict.inactiveSamples < MIN_SAMPLES_PER_SIDE * 2) {
    return { allowed: false, reason: `每侧至少需 ${MIN_SAMPLES_PER_SIDE * 2} 条样本才能支撑加权决策` }
  }
  return {
    allowed: true,
    reason: '共现信号达到门槛 —— 但加权前仍须完成「官方实验插件在窗口内确实变更过」的严格化论证',
  }
}

/** 由观测记录推导「该轮是否被关闭」的判定（供采集端复用）。 */
export function sampleFromCrash(input: {
  at: string
  officialActive: readonly string[]
  suspects: readonly string[]
  disabled: readonly string[]
  observations: readonly Observation[]
}): CooccurrenceSample {
  void input.observations
  return {
    at: input.at,
    officialActive: [...input.officialActive],
    suspects: [...input.suspects],
    disabled: [...input.disabled],
  }
}
