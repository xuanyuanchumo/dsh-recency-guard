/**
 * 预防性健康指标（RQ3「信号更早」）—— v0.13 cycle-12 从 observability.ts
 * 拆出：「一个数学模型一个文件」的复杂度纪律（同 control-band.ts / survival.ts
 * / markov.ts 的既定惯例，见 observability.ts 末段的拆分说明）。
 *
 * ## 定位
 *
 * 07 §4 的 E3.1 / E3.2：目标是**在崩溃之前**就有读数（插件加载耗时是否变慢、
 * 配置是否正在被频繁改动），而不是等崩溃发生后再归因。
 *
 * ## 不夸大的三条硬纪律（07 §4.3，写进函数契约而非口号）
 *
 * 1. **只预警，不行动**。本文件全部是纯函数：不读盘、不写盘、不取时间、不碰
 *    生命周期状态机，也不调用任何决策/关闭逻辑 —— 除返回值外零副作用。
 *    是否真的动手，由 RQ1/RQ2 的取证流程另行决定。预警是 `Metric`，确认是
 *    状态机的 `deciding`，两者在类型层面就是不同的东西，不得互相冒充。
 * 2. **样本不足不预警**。样本不够时返回 `defined:false` + `value:null`，
 *    既不给 0 也不给「看起来正常」的读数：把「没有数据」渲染成绿灯，正是
 *    本项目最忌讳的假绿。
 * 3. **参数要有来历**。每个常数都在注释里写明出处（控制图标准教材 /
 *    NIST-SEMATECH 手册 / Page 1954 的 ARL 表），不拍脑袋。
 *
 * ## 接线说明
 *
 * 这两个读数是**并行读数**：本文件只负责算、不负责接。`MetricsSnapshot`
 * 要收纳它们，得先有「加载耗时」与「变更时刻」两类采集面（07 §4.4 把预警
 * 维度放在 lifecycle/alerting 一侧），那属于另一处改动 —— 私自扩容快照会让
 * 契约测试与面板同时失效。
 *
 * 依赖面：只依赖 observability 的读数原语（Metric / MetricMeta / 两个构造器 /
 * sampleConfidence / round4 / median / medianAbsoluteDeviation / quantile /
 * ewmaLevel），不反向依赖任何上层模块。
 */
import {
  definedMetric,
  ewmaLevel,
  median,
  medianAbsoluteDeviation,
  quantile,
  round4,
  sampleConfidence,
  undefinedMetric,
  type Metric,
  type MetricMeta,
} from './observability.js'

/**
 * EWMA 的 α：α = 1 − 2^(−1/H)，H < 1 时夹到 1（与 observability.ewmaAlpha 同口径）。
 *
 * 为什么要在这里重写一行而不是从 observability 导入：那一个是**私有**函数，
 * 且被 `ewma` / `ewmaLevel` / `ewmaKernel` 共用（不是本文件专属）。为了复用它
 * 而把 observability 的导出面撑大，等于为一次内部调用改动共享热点文件的契约 ——
 * 代价高于一行公式的重复。
 *
 * 防漂移：两边口径若被改坏，`loadTimeEwma` 的 `bandFactor` 会变，而单测里
 * 已把 H=3 时的 bandFactor = 0.3391 钉死（0.3391 正是由本式算出），
 * 所以「悄悄改了一边」立刻会被断言抓住。
 */
function ewmaAlpha(halfLife: number): number {
  return 1 - Math.pow(2, -1 / Math.max(1, halfLife))
}

// ═════════════════ RQ3 · 预防性健康指标（只预警，不行动）═════════════════
//
// 下面两个模型是 07 §4（RQ3「信号更早」）的落地：目标是**在崩溃之前**就有
// 读数（E3.1 加载耗时 / E3.2 配置变更频率），而不是等崩溃发生后再归因。
// §4.3「不夸大」三条纪律在这里是**契约**而非口号：
//
// 1. **只预警，不行动**。两函数都是纯函数：不读盘、不写盘、不取时间、不碰
//    生命周期状态机，也不调用任何决策/关闭逻辑 —— 除返回值外零副作用。
//    是否真的动手，由 RQ1/RQ2 的取证流程另行决定。预警是 `Metric`，确认是
//    状态机的 `deciding`，两者在类型层面就是不同的东西，不得互相冒充。
// 2. **样本不足不预警**。样本不够时返回 `defined:false` + `value:null`，
//    既不给 0 也不给「看起来正常」的读数：把「没有数据」渲染成绿灯，正是
//    本项目最忌讳的假绿。
// 3. **参数要有来历**。每个常数都在注释里写明出处（控制图标准教材 /
//    NIST-SEMATECH 手册 / 项目既有约定），不拍脑袋。
//
// 接线说明：这两个读数是**并行读数**，本文件只负责算、不负责接。
// `MetricsSnapshot` 要收纳它们，得先有「加载耗时」与「变更时刻」两类采集面
// （07 §4.4 把预警维度放在 lifecycle/alerting 一侧），那属于另一处改动，
// 不在本次追加导出范围内 —— 私自扩容快照会让契约测试与面板同时失效。

/** MAD → 正态 σ 的一致性常数 1/Φ⁻¹(0.75) = 1.4826（NIST/SEMATECH e-Handbook §1.3.5.6）。 */
const MAD_TO_SIGMA = 1.4826

/** IQR → 正态 σ 的一致性常数 1/1.349（= 1/(2·0.6745)；同 NIST §1.3.5.6）。 */
const IQR_TO_SIGMA = 1.349

/** 平均绝对偏差 Mn → 正态 σ 的一致性常数 1.2533（= √(π/2)；同 NIST §1.3.5.6）。 */
const MAD_FROM_MEAN_ABS = 1.2533

/** 移动极差 MR̄ → σ 的常数 d₂(2) = 1.128（n=2 的无偏极差常数，同 control-band.ts）。 */
const MOVING_RANGE_D2 = 1.128

/**
 * 尺度估计器身份 —— 白盒的一部分：面板必须能回答「这条带的 σ̂ 是哪来的」。
 *
 * 为什么要区分：本文件的带完全由 σ̂ 决定，而当样本集中在同一档时各估计器
 * 会给出不同答案（中位数/MAD 在 ≥50% 样本同值时会退化成 0）。把用了谁写进
 * 读数里，读者才不会把「MAD 退化后改用 IQR」误读成「过程忽然变稳」。
 */
export type SigmaEstimator = 'mad' | 'iqr' | 'meanAbsDev' | 'movingRange' | 'none'

/** 尺度估计结果（σ̂ 与它的来历一起返回，不单独给一个数）。 */
interface ScaleEstimate {
  /** 稳健标准差 σ̂（与样本同单位）；全同值样本为 0。 */
  sigma: number
  /** 该 σ̂ 用的是哪个估计器。 */
  estimator: SigmaEstimator
}

/** MAD → σ 的稳健估计（均值水平型带用）。 */
function levelScale(values: readonly number[]): ScaleEstimate {
  const sigma = MAD_TO_SIGMA * medianAbsoluteDeviation(values)
  return sigma > 0 ? { sigma, estimator: 'mad' } : iqrScale(values)
}

/** MAD 退化（≥50% 样本同值）后的第一后备：σ̂ = IQR / 1.349。 */
function iqrScale(values: readonly number[]): ScaleEstimate {
  const iqr = quantile(values, 0.75) - quantile(values, 0.25)
  if (iqr > 0) return { sigma: iqr / IQR_TO_SIGMA, estimator: 'iqr' }
  return meanAbsDevScale(values)
}

/** IQR 也退化（≥75% 样本同值）后的最后后备：σ̂ = 1.2533·Mn。 */
function meanAbsDevScale(values: readonly number[]): ScaleEstimate {
  const mid = median(values)
  const meanAbsDev = values.reduce((sum, v) => sum + Math.abs(v - mid), 0) / values.length
  // Mn = 0 当且仅当全部样本与中位数相等，即**全部同值** —— 此时根本没有尺度，
  // 返回 0 是事实（由调用方决定「零宽带不预警」），不是估计失败。
  return meanAbsDev > 0 ? { sigma: MAD_FROM_MEAN_ABS * meanAbsDev, estimator: 'meanAbsDev' } : { sigma: 0, estimator: 'none' }
}

/**
 * 移动极差尺度 σ̂ = MR̄ / 1.128（**差分**型估计，CUSUM 标准化用）。
 *
 * 为什么 CUSUM 不用 MAD（本文件另一处的选择）：CUSUM 要标准化的是「相邻间隔
 * 相对基线的偏移」，而 σ̂ 若取自**整段**样本的离散度，就会被「正要检测的那次
 * 漂移」自己污染 —— 实测 60s → 1s 的 60 倍阶跃在 IQR 尺度下只算出 S = 3.4，
 * 低于 h = 5，检测器对自己要抓的形状**结构性失明**。
 *
 * 差分型估计（相邻间隔差的均值 / d₂(2)）量的是**局部抖动**而非整体离散：
 * 水平整体平移不改变差分，所以漂移不会抬高自己的噪声底。1.128 = d₂(2) 是
 * n=2 的无偏极差常数，与 `control-band.ts` 的 MR 图同一口径（本项目的既有先例）。
 * 代价：对**单次**离群敏感（一次异常间隔会抬高 MR̄）—— 有意的保守方向。
 */
function movingRangeScale(values: readonly number[]): ScaleEstimate {
  if (values.length < 2) return { sigma: 0, estimator: 'none' }
  let sum = 0
  for (let i = 1; i < values.length; i += 1) sum += Math.abs(values[i] - values[i - 1])
  const sigma = sum / (values.length - 1) / MOVING_RANGE_D2
  return sigma > 0 ? { sigma, estimator: 'movingRange' } : { sigma: 0, estimator: 'none' }
}

/**
 * 控制限倍数 L = 3（休哈特 3σ 惯例）。
 *
 * 来历：正态过程下单点越界概率 0.27%（双侧），是「误报成本 vs 漏报成本」的
 * 经典平衡点；本文件拆出的 `control-band.ts` 已经用 ±3σ，这里保持同一口径，
 * 否则面板上两条带会给出互相矛盾的「失控」判定。
 */
const LOAD_BAND_SIGMA_LIMIT = 3

/**
 * 加载耗时 EWMA 控制带的**最小样本量**。
 *
 * 取 5 = ⌈1/λ⌉（默认半衰期 3 ⇒ λ = 1−2^(−1/3) = 0.2063 ⇒ 1/λ = 4.85）。
 * 为什么是 1/λ：EWMA 的记忆长度就是 1/λ 个样本，样本数不足一个记忆长度时
 * 的读数主要在复述暖机期的历史，「当前水平」还没有从种子效应里走出来。
 * 这是语义下限；实际门槛取 `max(5, ⌈1/λ⌉)`，半衰期调大时门槛同步抬高。
 */
const LOAD_BAND_MIN_SAMPLES = 5

/** 加载耗时 EWMA 控制带的读数（白盒：中心线 / 控制限 / σ̂ / 带宽因子都随结果返回）。 */
export interface LoadTimeBand {
  /** 去暖机偏置的 EWMA 水平（毫秒）—— 「当前」的加载耗时。 */
  levelMs: number
  /** 中心线 = 历史加载耗时的中位数（毫秒，对单次慢启动稳健）。 */
  baselineMs: number
  /** 上控制限 UCL（毫秒）；`levelMs > upperMs` ⇒ 加载变慢预警。 */
  upperMs: number
  /** 下控制限 LCL（毫秒，夹到 ≥ 0）：白盒对照用，**不参与预警**（变快不是风险）。 */
  lowerMs: number
  /** 稳健标准差 σ̂（毫秒）。 */
  sigmaMs: number
  /** σ̂ 用的是哪个估计器（MAD 在 ≥50% 样本同值时退化为 0，会自动降级）。 */
  sigmaEstimator: SigmaEstimator
  /** EWMA 统计量的稳态标准差因子 √(λ/(2−λ))。 */
  bandFactor: number
  /** 当前水平相对基线的比值 = levelMs / baselineMs。 */
  ratio: number
  /** 是否预警。**只预警不行动**：调用方自行决定要不要进取证流程。 */
  alert: boolean
}

/**
 * 插件加载耗时的 EWMA 控制带 —— 回答「这次启动是不是明显变慢了」。
 *
 * 数学模型（Montgomery《Introduction to Statistical Quality Control》§9.1.2
 * 的 EWMA 控制图，标准化形式）：
 *
 *   L_t = λ·x_t + (1−λ)·L_{t−1}，λ = 1 − 2^(−1/H)（H = 半衰期，项目既有口径）
 *   μ̂   = med(x)                    ← 中心线，用中位数而非均值
 *   σ̂   = 1.4826 · MAD(x)           ← 稳健尺度
 *   UCL/LCL = μ̂ ± L·σ̂·√(λ/(2−λ))，L = 3
 *
 * 为什么带宽要乘 √(λ/(2−λ))：控制限约束的是 **EWMA 统计量**的波动，不是单个
 * 观测的波动。EWMA 自身方差是 Var(L) = σ²·λ/(2−λ)，直接拿 σ̂ 当带宽会得到一个
 * 宽出 1/√(λ/(2−λ)) ≈ 3 倍的假带 —— 那样任何漂移都永远报不出来（结构性失明，
 * 正是本项目在 CUSUM 基准上踩过的同一类坑：用错尺度 ⇒ 检测器形同虚设）。
 *
 * 为什么用中位数 + MAD 而不是均值 + 移动极差：控制图的基准一旦被「那一次特别慢
 * 的启动」污染，就会把后续所有正常启动都放进带内。MAD 的崩溃点是 50%，单次离群
 * 抬不动 σ̂（这恰好补上了 `control-band.ts` 里 MR̄ 被突变污染的已知特性）。
 * 代价是对**单次尖峰不敏感** —— 这是有意的：尖峰由 `crashPressure` / CUSUM 负责，
 * 本带只抓**持续变慢**，两类信号分工不同。
 *
 * 失效条件（全部 `defined:false`，绝不给 0）：
 * - 样本数 < max(5, ⌈1/λ⌉)：控制带还立在暖机期里；
 * - 中位加载耗时 = 0：带宽与比值都失去尺度（不是「加载很快」）；
 * - 非有限/负值样本一律剔除，剔除后不足门槛同样降级。
 *
 * σ̂ = 0（每次都逐毫秒相同）是**真值**而非不可判定，但零宽带没有区分度：
 * 此时一律不预警并把理由写进 label，而不是让 1ms 抖动报成失控。
 *
 * 复杂度 O(n log n)（中位数与 MAD 各一次排序）。**零副作用**。
 */
export function loadTimeEwma(
  loadTimesMs: readonly number[],
  halfLife = 3,
  sigmaLimit = LOAD_BAND_SIGMA_LIMIT,
): Metric<LoadTimeBand> {
  const samples = loadTimesMs.filter((value) => Number.isFinite(value) && value >= 0)
  const lambda = ewmaAlpha(halfLife)
  const bandFactor = Math.sqrt(lambda / (2 - lambda))
  const formula =
    'L_t = λ·x_t + (1−λ)·L_{t−1}（按 1−(1−λ)^n 去暖机偏置）；μ̂ = med(x)；σ̂ = 1.4826·MAD(x)；UCL/LCL = μ̂ ± L·σ̂·√(λ/(2−λ))'
  const meta = (inputs: Record<string, number | string | null>, n: number): MetricMeta => ({
    formula,
    inputs,
    sampleSize: n,
    confidence: sampleConfidence(n),
  })
  // 门槛与 EWMA 记忆长度绑定：半衰期调大 ⇒ 需要更多样本才配立带（见常量注释）。
  const minSamples = Number.isFinite(lambda) && lambda > 0 ? Math.max(LOAD_BAND_MIN_SAMPLES, Math.ceil(1 / lambda)) : Number.POSITIVE_INFINITY
  if (samples.length < minSamples) {
    return undefinedMetric(
      `至少需要 ${Number.isFinite(minSamples) ? minSamples : '∞'} 次加载样本（≈ 一个 EWMA 记忆长度 1/λ）才能立控制带，当前 ${samples.length} 次`,
      '不可判定',
      meta({ samples: samples.length, halfLife, lambda: round4(lambda) }, samples.length),
    )
  }
  const baseline = median(samples)
  if (!(baseline > 0)) {
    return undefinedMetric('中位加载耗时为 0，带宽与比值都失去尺度（不等于「加载很快」）', '不可判定', meta({ samples: samples.length, baselineMs: 0, halfLife }, samples.length))
  }
  const scale = levelScale(samples)
  const sigma = scale.sigma
  const level = ewmaLevel(samples, halfLife)
  const band = sigmaLimit * sigma * bandFactor
  const upper = baseline + band
  const lower = Math.max(0, baseline - band)
  const ratio = round4(level / baseline)
  // σ̂ = 0 时带宽为 0，任何亚毫秒抖动都会「越界」——零宽带没有区分度，
  // 一律不预警（宁可漏报，也不做 07 §4.3 明令禁止的「宁可错杀」）。
  const alert = sigma > 0 && level > upper
  const value: LoadTimeBand = {
    levelMs: Math.round(level),
    baselineMs: Math.round(baseline),
    upperMs: Math.round(upper),
    lowerMs: Math.round(lower),
    sigmaMs: round4(sigma),
    sigmaEstimator: scale.estimator,
    bandFactor: round4(bandFactor),
    ratio,
    alert,
  }
  const label =
    sigma <= 0
      ? `加载耗时完全规则（σ̂=0，${samples.length} 次）：零宽带无区分度，不预警`
      : alert
        ? `加载变慢预警：EWMA ${value.levelMs}ms 越过 UCL ${value.upperMs}ms（基线 ${value.baselineMs}ms、σ̂ ${value.sigmaMs}ms〔${scale.estimator}〕、${samples.length} 次样本）`
        : `加载耗时受控：EWMA ${value.levelMs}ms 在 [${value.lowerMs}, ${value.upperMs}]ms 带内（基线 ${value.baselineMs}ms、${samples.length} 次样本）`
  return definedMetric(value, label, meta({ samples: samples.length, halfLife, lambda: round4(lambda), baselineMs: value.baselineMs, sigmaMs: value.sigmaMs, upperMs: value.upperMs, estimator: scale.estimator, ratio, alerted: alert ? 1 : 0 }, samples.length))
}

/**
 * CUSUM 的参考值 k = 0.5（标准化单位）。
 *
 * 来历：表格型 CUSUM 的最优参考值是待检测漂移幅度的一半，k = δ ÷ 2
 * （Page 1954；Montgomery §9.1.1）。取 δ = 1σ（「变更频率加快一个标准差」
 * 是运营上可感知的最小实质漂移）⇒ k = 0.5。k 取 0.25 或 1.0 只在 δ* 改口径
 * 时才对，与「1σ」这个目标配套的就是 0.5。
 */
const CONFIG_CUSUM_REFERENCE = 0.5

/**
 * 判定界 h = 5（标准化单位）。
 *
 * 来历：Montgomery 的 ARL 表（§9.1.1 表 9.3/9.4）在 k = 0.5 时，h = 4 ⇒
 * 受控平均运行长度 ARL₀ ≈ 168，h = 5 ⇒ ARL₀ ≈ 465。选 h = 5 而不是 4：
 * 本函数的 σ̂ 来自小样本 MAD（n = 5 时相对标准误仍约 52%），阈值必须吸收
 * σ̂ 自身的不确定性；宁可用「465 个间隔才误报一次」的保守界，也不做 07 §4.3
 * 禁止的「宁可错杀」。样本更多时不必调低 h —— 灵敏度会随 σ̂ 变准而自然提高。
 */
const CONFIG_CUSUM_THRESHOLD = 5

/**
 * 配置变更 CUSUM 的最小间隔样本数 = 5。
 *
 * 低于 5 个间隔（即不足 6 次变更）时，MAD 连一个稳定的次序统计量都算不上：
 * σ̂ 的相对标准误约 1.166/√n，n = 5 已达 52%，标准化增量 z_i 的噪声会直接
 * 盖过要检测的 1σ 漂移 —— 那时候「预警」报表的是自己的估计误差，不是现实。
 * 与其让面板亮一盏由噪声点亮的灯，不如如实报不可判定（07 §4.3 第二条）。
 */
const CONFIG_CUSUM_MIN_INTERVALS = 5

/** 配置变更频率 CUSUM 的读数（白盒：统计量、基线、σ̂、k/h 全随结果返回）。 */
export interface ConfigChangeCusum {
  /** 当前 CUSUM 统计量 S_n（标准化单位，≥ 0）。 */
  statistic: number
  /** 判定界 h（标准化单位）。 */
  threshold: number
  /** 参考值 k（标准化单位）。 */
  reference: number
  /** 基线间隔 μ̂ = med(g)（毫秒）。 */
  baselineMs: number
  /** 稳健尺度 σ̂ = MR̄/1.128（毫秒；差分型，见 `movingRangeScale`）。 */
  sigmaMs: number
  /** σ̂ 用的是哪个估计器（本函数恒为 movingRange，字段留作白盒对照）。 */
  sigmaEstimator: SigmaEstimator
  /** 参与计算的间隔数（= 有效变更数 − 1）。 */
  intervals: number
  /** 首次越过 h 的间隔序号（0 基）；未越界为 null。 */
  breachIndex: number | null
  /** 是否预警。**只预警不行动**：动作仍走 RQ1/RQ2 取证。 */
  alert: boolean
}

/**
 * 配置变更频率的 CUSUM 累积和 —— 回答「配置是不是正在被频繁改动」。
 *
 * 为什么「变更变密」算风险前兆（07 H3.2）：每次 `plugin-manager/changed`
 * 都意味着一次插件面变动，变动越密集，落到未验证组合上的概率越高。它比等
 * 崩溃更早，因为**改动是我们自己做的、可观测的**。
 *
 * 数学模型（表格型 CUSUM 的标准化形式，Page 1954 / Montgomery §9.1.1）：
 *
 *   g_i = t_i − t_{i−1}                    ← 相邻变更间隔（毫秒，只取 > 0）
 *   z_i = (μ̂ − g_i) / σ̂                    ← 间隔变短 ⇒ z 为正（变密方向）
 *   S_i = max(0, S_{i−1} + z_i − k)，k = 0.5
 *   预警 ⇔ max_i S_i > h，h = 5
 *
 * 为什么用**标准化**形式而不复用 `cusumChangePoint`：那个函数回答的是「崩溃
 * 密度从第几次崩溃起上行」，基准取 P75 且阈值是相对量（A = 1.5·q），尺度随
 * 数据漂移 —— 适合定位变点，但跨工作区/跨时间**不可比**。本函数把增量除以
 * σ̂ 再比 h，于是「S = 3.2」在两个工作区含义相同（都是 3.2 个标准差的累积
 * 证据），符合 07 §7.2「指标要可判读」的要求。两个模型分工不同，不是重复。
 *
 * 为什么基准用中位数、尺度却用**移动极差**：变更间隔的真实分布是右偏的
 * （长时间不动 + 偶尔连改），均值会被一次「隔了一个月才改」拉爆，所以基线取
 * 中位数。但尺度必须避开「被要检测的漂移自己污染」——整段样本的 MAD/IQR 会把
 * 一次 60 倍阶跃摊进离散度里（实测 S 只到 3.4 < h = 5，检测器对目标形状
 * 结构性失明）；相邻间隔的移动极差量的是局部抖动，水平平移不改变它。
 * 详见 `movingRangeScale`。
 *
 * 失效条件（全部 `defined:false`）：
 * - 有效间隔数 < 5（见 `CONFIG_CUSUM_MIN_INTERVALS`）；
 * - 中位间隔 = 0（多数变更挤在同一时刻 ⇒ 无「频率」可言）；
 * - σ̂ = 0（间隔完全规则，标准化增量没有尺度，除零）—— 与 `intervalSurvival`
 *   对「全等间隔」的处置一致。
 *
 * 与 `cusumChangePoint` 的又一差别：**未检出漂移时返回 `defined:true`
 * + `alert:false`**，而不是 `undefined`。因为本模型的「值」是统计量 S，
 * 而未越界时 S 仍然是一个有意义的读数（面板要能看到它正在逼近 h）；那边
 * 的「值」是变点本身，找不到变点才真的没有值。
 *
 * 复杂度 O(n log n)（排序 + 中位数）。**零副作用**。
 */
export function configChangeCusum(
  changeTimesMs: readonly number[],
  reference = CONFIG_CUSUM_REFERENCE,
  threshold = CONFIG_CUSUM_THRESHOLD,
): Metric<ConfigChangeCusum> {
  const times = changeTimesMs.filter((t) => Number.isFinite(t)).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1]
    // 同刻变更（宿主防抖窗口里合并的 install → enable 连发）不携带「频率」
    // 信息：把它当间隔会同时压低 σ̂、抬高 z，凭空造出一次「变更变密」的假警。
    // 直接丢弃而非记 0 —— 记 0 仍是往样本里塞了一个假观测。
    if (gap > 0) gaps.push(gap)
  }
  const formula = 'S_i = max(0, S_{i−1} + z_i − k)，z_i = (μ̂ − g_i)/σ̂，μ̂ = med(g)，σ̂ = MR̄/1.128，k = 0.5，h = 5'
  const meta = (inputs: Record<string, number | string | null>, n: number): MetricMeta => ({
    formula,
    inputs,
    sampleSize: n,
    confidence: sampleConfidence(n),
  })
  if (gaps.length < CONFIG_CUSUM_MIN_INTERVALS) {
    return undefinedMetric(
      `至少需要 ${CONFIG_CUSUM_MIN_INTERVALS} 个变更间隔（${CONFIG_CUSUM_MIN_INTERVALS + 1} 次变更）才能判定频率漂移，当前 ${gaps.length} 个`,
      '不可判定',
      meta({ changes: times.length, gaps: gaps.length, reference, threshold }, gaps.length),
    )
  }
  const baseline = median(gaps)
  if (!(baseline > 0)) {
    return undefinedMetric('中位变更间隔为 0（多数变更挤在同一时刻），没有「频率」可判', '不可判定', meta({ changes: times.length, gaps: gaps.length, baselineMs: 0 }, gaps.length))
  }
  const scale = movingRangeScale(gaps)
  const sigma = scale.sigma
  if (!(sigma > 0)) {
    return undefinedMetric('变更间隔完全规则（σ̂=0），标准化增量的尺度无定义', '不可判定', meta({ changes: times.length, gaps: gaps.length, baselineMs: Math.round(baseline), sigmaMs: 0 }, gaps.length))
  }
  let statistic = 0
  let breachIndex: number | null = null
  for (let i = 0; i < gaps.length; i += 1) {
    // 上侧 CUSUM：只抓「间隔变短」（变更变密）。间隔变长时增量为负，
    // S 被 max(0, ·) 钳住 —— 变稀不是风险，不该累积证据。
    const z = (baseline - gaps[i]) / sigma
    statistic = Math.max(0, statistic + z - reference)
    if (breachIndex === null && statistic > threshold) breachIndex = i
  }
  const alert = breachIndex !== null
  const value: ConfigChangeCusum = {
    statistic: round4(statistic),
    threshold,
    reference,
    baselineMs: Math.round(baseline),
    sigmaMs: round4(sigma),
    sigmaEstimator: scale.estimator,
    intervals: gaps.length,
    breachIndex,
    alert,
  }
  const label = alert
    ? `配置变更变密预警：CUSUM S=${value.statistic} 越过 h=${threshold}（第 ${(breachIndex ?? 0) + 1} 个间隔起，基线 ${(baseline / 1000).toFixed(1)}s、σ̂ ${(sigma / 1000).toFixed(1)}s〔${scale.estimator}〕、${gaps.length} 个间隔）`
    : `配置变更频率未见上行：S=${value.statistic} ≤ h=${threshold}（基线 ${(baseline / 1000).toFixed(1)}s、σ̂ ${(sigma / 1000).toFixed(1)}s、${gaps.length} 个间隔）`
  return definedMetric(value, label, meta({ changes: times.length, gaps: gaps.length, baselineMs: value.baselineMs, sigmaMs: value.sigmaMs, statistic: value.statistic, threshold, reference, breachIndex, alerted: alert ? 1 : 0 }, gaps.length))
}
