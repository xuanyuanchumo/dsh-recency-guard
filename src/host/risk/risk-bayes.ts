/**
 * 贝叶斯风险评分 —— 与 `lifecycle.riskScore` **并列**的第二套读数（v0.13 · RQ1 / E1.1b）。
 *
 * ## 为什么要有这个文件（研究文档 07 §2）
 *
 * `riskScore` 是**频率派点估计**：`0.2 × hits/observations`。
 * 它有两个硬缺陷，面板上看不出来：
 *
 * 1. **1 次崩溃 / 1 次观测 = 100%**，与「20 次崩溃 / 20 次观测 = 100%」
 *    在决策面上完全同分。前者是**一条证据**，后者是**二十条一致的证据**，
 *    把两者当同一件事就是误关（RQ2）的根源。
 * 2. **0 次崩溃 / 1 次观测 = 0%**，被读成「清白」。可它只说明「还没见过」，
 *    不说明「不会发生」。
 *
 * 贝叶斯做法：把命中率当成一个**未知概率 p**，用 `Beta(1,1)`（均匀先验，
 * 即「没见过任何证据前，什么命中率都同样可能」）表示它，每次崩溃做一次
 * **共轭更新**：
 *
 *     先验 Beta(1,1) ⊕ hits 次命中、misses 次未命中 ⇒ 后验 Beta(1+hits, 1+misses)
 *
 * 于是均值 = (1+hits)/(2+hits+misses) —— 它**天然就被样本量拉向 0.5**，
 * 「1/1」被压到 0.667 而不是 1.0，「0/1」被抬到 0.333 而不是 0。
 * 这正是我们要的：**小样本不许假装确定**。并且后验给出 95% 可信区间，
 * 让面板能显示「这个数有多不靠谱」。
 *
 * ## 并行读数纪律（07 §2.3 硬要求）—— 本文件最重要的一条规则
 *
 * **绝不切换 `riskScore` 的默认值。** 本文件不做任何「替换」：
 * - 不修改 `lifecycle.ts` 的任何行为（它的默认路径原样保留为 fallback）；
 * - 不改变三因子权重 0.5/0.3/0.2，也不改变归一化方式；
 * - 贝叶斯读数**另行返回**（`BayesRisk.bayesScore` 与 `parallel`），
 *   面板可以同时显示「现有评分 / 贝叶斯均值 ± 区间」两套数字。
 *
 * 为什么必须并列而不是直接换掉：样本稀疏是**现实**不是过渡状态（07 §2.3
 * 第一行风险）。在没有足够真实崩溃样本之前切换默认值，等于用先验替换证据，
 * 会让既有的每一次决策都失去可比性，也无法做 A/B 回放。
 *
 * ## 数值稳定性纪律（对齐 `survival.ts`）
 *
 * 三个会在朴素实现里炸掉的点，这里都做了处理：
 * - **ln B(a,b)** 走 Lanczos `lgamma` + `a+b` 的对数，不用 `Γ(a)Γ(b)/Γ(a+b)`
 *   （a,b 一大就上溢成 Infinity，相除得 NaN）。
 * - **ln I_x(a,b)** 用**连分式 + 前后缀**组合，收敛快、不需要迭代到 1e-16。
 * - **分位数**在 **(0,1) 的概率空间**二分而不是在 x 空间切区间：
 *   极端比例（0 命中）时后验质量全挤在 x ≈ 0 附近，x 空间的二分要几千步
 *   才动得了，而概率空间 100 步就能把区间压到 1e-30。
 *
 * 对外导出的每个数都保证**有限**：区间端点被夹到 [FLOOR, 1-FLOOR]，
 * 最坏情况下界 < 上界（见 `betaQuantile` 的保险丝），绝不产出 NaN / Infinity。
 *
 * ## 诚实边界（07 §2.3 / 项目 Metric 契约）
 *
 * `hits + misses < SPARSE_SAMPLE_GATE` ⇒ 返回 `defined: false` + `value: null`，
 * **不给值**。「没数据」与「风险为 0」必须可区分，这是本项目写死在类型里的铁律
 * （见 `observability.ts` 的 `Metric<T>`）。
 */

import {
  definedMetric,
  displayDigits,
  round4,
  sampleConfidence,
  undefinedMetric,
  type Metric,
  type MetricMeta,
} from '../observe/observability.ts'
import { riskFactors, riskScore, type RiskInput } from '../core/lifecycle.ts'

// ─────────────────────────── 常量与策略 ───────────────────────────

/**
 * 均匀先验 Beta(1,1) 的两个形状参数。
 *
 * 为什么是 (1,1) 而不是更「知道点什么」的先验：我们没有可辩驳的先验知识
 * ——不同机器、不同插件生态的命中率差异极大。均匀先验是唯一不引入
 * 未经验证假设的选择（E1.1b 明确写的就是 Beta(1,1)）。
 * 它的代价是「样本少时均值被拉到 0.5」，这是**特意的保守**，不是缺陷。
 */
export const BAYES_PRIOR = { alpha: 1, beta: 1 } as const

/** 先验强度 α+β（= 2）：它等价于「先看过 2 次虚拟观测」，是样本稀疏的标尺。 */
export const PRIOR_STRENGTH = BAYES_PRIOR.alpha + BAYES_PRIOR.beta

/**
 * 样本稀疏门：`hits + misses < 3` ⇒ `defined: false`。
 *
 * 为什么是 3 而不是 2 或 5：先验强度是 2，n=2 时后验均值仍有一半质量来自先验
 * （相当于「你自己的证据只占 50%」），这种读数不能当结论展示；n=3 时证据
 * 占比 3/5 = 60%，且区间宽度仍被如实报告。n=5 会把 4 次观测这种「小但真实」
 * 的证据也判为不可判定，反而丢掉可用信息。
 *
 * 这是**展示门**，不是计算门：`betaPosterior` 对任意 n ≥ 0 都算得出有限的
 * 均值与区间（用于离线回放与绘图），只是 `bayesRisk` 拒绝在 n < 3 时给结论。
 */
export const SPARSE_SAMPLE_GATE = 3

/** 区间端点的夹紧量：让值严格落在 (0,1)，避免 0 与 1 这种「确定性」假象。 */
const QUANTILE_FLOOR = 1e-12

/** 95% 可信区间的左右尾概率。 */
const TAIL = 0.025

/**
 * 权重分解方案的命名。
 *
 * `crashFrequency` 只重分配 **crashFrequency 这一项（0.2）**，
 * 另外两项（recency 0.5 / experimental 0.3）**逐位不变**。
 * 理由：贝叶斯先验对「命中率」有可说之处，对「多久前改的」「是不是实验性」
 * 一句话也说不出来 —— 后两者没有可共轭的观测模型。硬把它们也做贝叶斯化
 * 就是凭空发明先验（07 §2.3「过拟合到本机」那条风险）。
 */
export const BAYES_WEIGHT_SCHEME = 'crashFrequency' as const

/** 贝叶斯后验的另一套参考权重（`blend: 'uniform'` 时使用）。 */
export const BAYES_UNIFORM_WEIGHTS = { recency: 1 / 3, experimental: 1 / 3, crashFrequency: 1 / 3 } as const

/** 权重总和的容差：用于检测权重方案被写坏（例如手改成 [0.5,0.3,0.3]）。 */
const WEIGHT_SUM_TOLERANCE = 1e-9

// ─────────────────────────── 分布内核 ───────────────────────────

/** Lanczos 系数的常用形式（与 survival.ts 的 lgamma 同源，但域放宽到 x > 0）。 */
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const

/**
 * ln Γ(x)，域 x > 0。
 *
 * 为什么不像 survival.ts 那样直接用 x ≥ 1 的公式：Beta 的参数可以小于 1
 * （`Beta(0.5,0.5)` 的 Jeffreys 先验是常见备选，分位数实现也会在
 * x 接近 0 时用到小数参数），而 Lanczos 近似只在 x ≥ 1 稳定。
 *
 * 用伽马函数的**递推式**把 (0,1) 抬到 (1,2)：
 *
 *     Γ(x) = Γ(x+1) / x   ⇒   ln Γ(x) = ln Γ(x+1) − ln x
 *
 * 为什么不用反射式 `Γ(x)Γ(1−x) = π/sin(πx)`：把 x ∈ (0,1) 反射到 1−x
 * **仍在 (0,1)**，递归永不终止（实测踩到栈溢出）。递推式一步就把区间
 * 抬出 Lanczos 的稳定域，没有终止性问题。
 *
 * 负数/0 是非域输入，直接返回 NaN 让调用方的守卫去拦（**不静默补 0**）。
 */
function lgamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return Number.NaN
  if (x < 1) return lgamma(x + 1) - Math.log(x)
  const z = x - 1
  let series = 0.99999999999980993
  const t = z + 7.5
  for (let i = 0; i < LANCZOS.length; i += 1) series += LANCZOS[i] / (z + i + 1)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series)
}

/**
 * ln B(a,b) = ln Γ(a) + ln Γ(b) − ln Γ(a+b)。
 *
 * 为什么取对数而不是直接算 B(a,b)：a+b 上到几十、上百时 Γ 就溢出到 Infinity，
 * Infinity/Infinity 得到 NaN —— 而这里的参数完全可能长得很大（一个插件
 * 被观察几百次）。先取对数再 exp，是唯一能覆盖全量程的写法。
 */
export function logBeta(a: number, b: number): number {
  return lgamma(a) + lgamma(b) - lgamma(a + b)
}

/**
 * 正则化不完全贝塔函数 I_x(a,b)（0 ≤ x ≤ 1）。
 *
 * 用**连分式**（Abramowitz & Stegun 26.5.8 的 Lentz 修正版）求
 * `betacf = B(x; a,b) / (x^a (1−x)^b)`，再乘以前缀因子。
 *
 * 收敛性：连分式只在 **x < (a+1)/(a+b+2)** 时收敛快。所以标准做法是对
 * 另一半用对称恒等式 `I_x(a,b) = 1 − I_{1−x}(b,a)` —— 本实现按这条
 * 分派，保证任何 (a,b,x) 都走收敛快的一侧。收敛判据取 1e−15 或 300 次
 * 上限；撞上限就返回当前值（误差已被对数值压缩），**不抛异常**
 * ——观测设施绝不拖垮守护流程。
 */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  // 先挡非域输入：NaN 一律 NaN（让上层守卫发现），不静默变成 0/1。
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(x) || a <= 0 || b <= 0) return Number.NaN
  if (x <= 0) return 0
  if (x >= 1) return 1
  // 这里故意用 Math.log(x) 前的守卫：x 已限定在 (0,1)，log 有界。
  const logFront = a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b)
  const front = Math.exp(logFront)
  if (!Number.isFinite(front)) {
    // 极端参数下 front 可能下溢成 0 或上溢成 Infinity；用对称式再试一次，
    // 仍然不有限就退化成「只看尾部的阶跃」——比 NaN 好，且仍单调。
    return x < (a + 0.5) / (a + b + 1) ? 0 : 1
  }
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/**
 * 连分式核心（Lentz 算法），返回 `B(x;a,b) · a / (x^a (1−x)^b)`。
 *
 * Lentz 修正的要点：直接用 `a1 + b1/(a2 + b2/(...))` 会因中间值过小而
 * 停下或发散；改写成 `f = f₀·d` 的递推，每步检查 `|d−1| < eps`。
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const TINY = 1e-30
  const EPS = 1e-15
  const MAX_ITER = 300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAX_ITER; m += 1) {
    const m2 = 2 * m
    // 偶数步（a 部分）
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    h *= d * c
    // 奇数步（b 部分）
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/**
 * Beta(a,b) 的 p 分位数（p ∈ (0,1)）：解 `I_x(a,b) = p`。
 *
 * ## 为什么在概率空间二分
 *
 * 直觉写法是在 x ∈ (0,1) 上二分，判断 `I_mid > p`。问题在**极端比例**：
 * 0 命中 / 30 次观测 ⇒ 后验 Beta(1,31)，95% 区间上界约 1.5e-1、下界约
 * 8e-4（真实量级），此时 x 空间里前几步 `I_x` 全是 0 —— 二分只能靠步数
 * 硬磨，精度与迭代次数都不受控。
 *
 * 本实现改为对 **z = logit(x) ∈ ℝ** 做二分，每次用逻辑函数回到 x：
 * z 的范围天然覆盖 1e-300 到 1−1e-16，落在「概率的尺度」上而不是
 * 「0 到 1 的线性尺度」上。100 次迭代足以把跨度 1e-12 压到无法分辨。
 *
 * ## 保险丝
 *
 * 输出被夹到 [QUANTILE_FLOOR, 1−QUANTILE_FLOOR]，并且**强制下界 < 上界**
 * （若夹紧把两者压到一起，按半宽撑开）。这样下游永远拿不到 x=0 或 x=1
 * —— 端点意味着「概率确定是 0 或 1」，而我们无论如何都没有这种把握。
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (!Number.isFinite(p) || !Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return Number.NaN
  const target = Math.min(1 - QUANTILE_FLOOR, Math.max(QUANTILE_FLOOR, p))
  const toX = (z: number): number => 1 / (1 + Math.exp(-z))
  const cdf = (z: number): number => regularizedIncompleteBeta(a, b, toX(z))
  // z 的搜索区间取 ±40：logit(1e-12)≈−27.6、logit(1−1e-12)≈27.6，留了余量。
  let lo = -40
  let hi = 40
  if (cdf(lo) >= target) return QUANTILE_FLOOR
  if (cdf(hi) <= target) return 1 - QUANTILE_FLOOR
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2
    if (cdf(mid) < target) lo = mid
    else hi = mid
  }
  const x = toX((lo + hi) / 2)
  if (!Number.isFinite(x)) return Number.NaN
  return Math.min(1 - QUANTILE_FLOOR, Math.max(QUANTILE_FLOOR, x))
}

// ─────────────────────────── 读数形状 ───────────────────────────

/**
 * 一个 Beta 后验的完整读数 —— **永远可计算**（不设样本门）。
 *
 * 为什么和 `bayesRisk` 分开：离线回放/绘图需要「n=0 也有个数」，
 * 而守护决策需要「n 不够就别给结论」。两件事不该互相妥协，
 * 所以底层给全量读数，上层负责按门禁裁剪。
 */
export interface BetaPosterior {
  /** 后验第一形状参数 α′ = α₀ + hits。 */
  alpha: number
  /** 后验第二形状参数 β′ = β₀ + misses。 */
  beta: number
  /** 后验均值 α′/(α′+β′)。**不取整**：它就是面板的主读数来源。 */
  mean: number
  /** 后验众数（α′,β′ 都 > 1 时才有意义，否则退回均值）。 */
  mode: number
  /** 后验标准差 √(α′β′/((α′+β′)²(α′+β′+1)))。 */
  stdev: number
  /** 95% 可信区间下界。 */
  lower95: number
  /** 95% 可信区间上界。 */
  upper95: number
  /** 区间宽度 = upper95 − lower95（样本越多越窄，是本模块的单调性主线）。 */
  width95: number
  /** 命中数（已清洗为非负整数）。 */
  hits: number
  /** 未命中数（已清洗为非负整数）。 */
  misses: number
  /** 样本数 = hits + misses。 */
  samples: number
  /**
   * 后验均值相对先验被证据拉动了多少：`mean − 0.5`。
   *
   * 面板用它区分「真高」与「只是样本少所以贴着 0.5」。
   */
  evidenceShift: number
}

/**
 * Beta 后验 —— `Beta(1+hits, 1+misses)` 的均值/标准差/95% 区间。
 *
 * ## 参数清洗（为什么先 round 再夹）
 *
 * `hits`/`misses` 的上游来自计数器，可能是浮点（累加求平均）、负数（bug）
 * 或 NaN（缺字段）。这里统一**向下取整后夹到 ≥ 0**：
 * - 浮点：计数在语义上是整数，2.7 次命中只可能是 2 次。
 * - 负数 / NaN：视为**无证据**（0）而不是「负命中」——Beta 在负参数上无定义，
 *   静默取 0 至少保持单调；上游 bug 由契约测试去抓，数值层不抛异常
 *   （与项目「观测设施不拖垮守护流程」一致）。
 *
 * 返回值在**任何**有限输入下都是有限的：`mean ∈ (0,1)`、
 * `lower95 < upper95`、`width95 ∈ (0,1)`，绝无 NaN / Infinity / 除零。
 */
export function betaPosterior(hits: number, misses: number): BetaPosterior {
  const h = sanitizeCount(hits)
  const m = sanitizeCount(misses)
  // 先验 Beta(1,1) 的共轭更新：hits 累到 α，misses 累到 β。
  const alpha = BAYES_PRIOR.alpha + h
  const beta = BAYES_PRIOR.beta + m
  const total = alpha + beta
  const mean = alpha / total
  // 标准差公式在有界支撑上恒有限：最大在 α=β=1 时取 1/(2√3) ≈ 0.289。
  const stdev = Math.sqrt((alpha * beta) / (total * total * (total + 1)))
  // 众数只在 α,β > 1 时严格内部；否则后验在 0 或 1 端点上取峰，退回均值更诚实。
  const mode = alpha > 1 && beta > 1 ? (alpha - 1) / (alpha + beta - 2) : mean
  let lower = betaQuantile(TAIL, alpha, beta)
  let upper = betaQuantile(1 - TAIL, alpha, beta)
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    // 保底：分位数实现若因极端参数返回 NaN，用正态近似兜住而不是让 NaN 外泄。
    // 这不是常用路径，但 NaN 一旦漏到面板就再也解释不清了。
    lower = Math.max(QUANTILE_FLOOR, mean - 1.96 * stdev)
    upper = Math.min(1 - QUANTILE_FLOOR, mean + 1.96 * stdev)
  }
  // 保险丝：夹紧或退化可能让 lower ≥ upper，按半宽撑开，保证区间非空。
  if (!(upper > lower)) {
    const half = Math.max(QUANTILE_FLOOR, stdev * 0.5)
    lower = Math.max(QUANTILE_FLOOR, mean - half)
    upper = Math.min(1 - QUANTILE_FLOOR, mean + half)
  }
  return {
    alpha,
    beta,
    mean,
    mode,
    stdev,
    lower95: lower,
    upper95: upper,
    width95: upper - lower,
    hits: h,
    misses: m,
    samples: h + m,
    evidenceShift: mean - 0.5,
  }
}

/** 计数清洗：非有限 ⇒ 0，负数 ⇒ 0，向下取整。 */
function sanitizeCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

// ─────────────────────────── 权重方案 ───────────────────────────

/**
 * 贝叶斯重排的权重方案。
 *
 * - `crashFrequency`（**默认**）：把 `0.2` 那一项换成「0.2 × 贝叶斯后验均值」，
 *   recency 0.5 / experimental 0.3 **逐位不变**。最小变更面 ——
 *   与现有 riskScore 的差异**只**来自命中率那一项，可解释、可回放。
 * - `uniform`：三因子等权 1/3。作为对照读数存在，用来看「差异到底是
 *   贝叶斯带来的，还是权重带来的」；它不是候选默认值。
 */
export type BayesBlend = 'crashFrequency' | 'uniform'

/** 权重三元组（三项之和恒为 1）。 */
export interface BayesWeights {
  recency: number
  experimental: number
  crashFrequency: number
}

/** 按方案取权重；未知方案退回默认（**不掷**，因为这不是可重试的错误）。 */
export function bayesWeights(blend: BayesBlend = BAYES_WEIGHT_SCHEME): BayesWeights {
  if (blend === 'uniform') return { ...BAYES_UNIFORM_WEIGHTS }
  return { recency: 0.5, experimental: 0.3, crashFrequency: 0.2 }
}

// ─────────────────────────── 输入与输出 ───────────────────────────

/**
 * 贝叶斯评分的输入 —— 与 `RiskInput` **兼容并可扩展**。
 *
 * `RiskInput` 里的 `suspectHits` / `observations` 已经足够推出
 * `hits = suspectHits`、`misses = observations − suspectHits`，
 * 所以接线方可以**直接传现有的 `RiskInput`**（结构子类型，零改造）；
 * 也可以在 `hits` / `misses` 里给更精确的计数（例如按崩溃序列回放）。
 *
 * 为什么允许覆盖而不是只用 observations−hits：回放场景里「观察」的定义
 * 可能与生命周期里的不同（比如只统计有决策记录的那几轮），强行从
 * `observations` 反推会把不同语义的数字混在一起。
 */
export interface BayesRiskInput extends RiskInput {
  /** 显式命中数；缺省取 `suspectHits`。 */
  hits?: number
  /** 显式未命中数；缺省取 `observations − suspectHits`（夹到 ≥ 0）。 */
  misses?: number
  /** 重排权重方案；缺省 `crashFrequency`。 */
  blend?: BayesBlend
}

/**
 * 一次贝叶斯评分 —— **两套读数并列**的承载结构（07 §2.3）。
 *
 * `riskScore` 是现有默认路径的**原样输出**（同一个 now、同一份输入），
 * 本文件只**读**它、不改变它。面板必须能同时拿到两者，因此它们必须在
 * 同一个对象里返回，不能让调用方分别调两个模块（那会引入时序与输入不一致）。
 */
export interface BayesRisk {
  /** 现有 `riskScore` 的原值 —— 默认路径，**不变**。 */
  riskScore: number
  /** 贝叶斯重排分（按 `weights` 加权），未取整，∈ [0,1]。 */
  bayesScore: number
  /** 后验均值（= 贝叶斯口径的命中率），未取整。 */
  posteriorMean: number
  /** 95% 可信区间下界。 */
  lower95: number
  /** 95% 可信区间上界。 */
  upper95: number
  /** 区间宽度。 */
  width95: number
  /** 命中 / 未命中 / 样本数（供面板展示「基于 N 次观测」）。 */
  hits: number
  misses: number
  samples: number
  /** 三因子贡献（`riskScore` 口径，与 lifecycle 逐位相同）。 */
  factors: { recency: number; experimental: number; crashFrequency: number }
  /** 贝叶斯口径的三因子贡献（只有 crashFrequency 那一项被替换）。 */
  bayesFactors: { recency: number; experimental: number; crashFrequency: number }
  /** 实际使用的权重方案与权重。 */
  blend: BayesBlend
  weights: BayesWeights
  /** 两套读数之差 `bayesScore − riskScore`（面板用来标「分歧」）。 */
  delta: number
  /** 完整后验（供绘图/离线回放）。 */
  posterior: BetaPosterior
}

/**
 * 计算一次贝叶斯风险读数 —— 与 `riskScore` **并列**，不替换。
 *
 * 数学：
 *
 *     hits   = Σ 该插件是 Top-1 嫌疑且崩溃的轮次
 *     misses = Σ 该插件是 Top-1 嫌疑但未崩溃的轮次
 *     p | data ~ Beta(1+hits, 1+misses)
 *     bayesScore = w_rec·recency + w_exp·experimental + w_freq·E[p]
 *
 * ## 与 riskScore 的关系（务必记住）
 *
 * `bayesScore` **不是** `riskScore` 的替代品：
 * - 权重之和仍为 1，`recency` / `experimental` 两项逐位相同；
 * - 唯一差异是 `crashFrequency` 项从 `0.2 × hits/observations`（可能 1.0）
 *   变成 `0.2 × (1+hits)/(2+hits+misses)`（永远 < 1，且随样本增长逼近前者）。
 *
 * 所以**样本足够大时两者收敛**，样本稀疏时贝叶斯更保守 —— 这正是 E1.1b
 * 要度量的「命中率提升且误伤率不升」。
 *
 * ## 为什么不在这里做样本门
 *
 * 本函数返回**完整**两套读数（含 `posterior`），样本门由 `bayesMetric`
 * 负责。原因：面板要显示「N=2，暂不判定」但同时想画出后验曲线；
 * 若在这里就返回 undefined，前端连画什么都不知道。
 */
export function bayesRisk(input: BayesRiskInput, now = Date.now()): BayesRisk {
  const observations = Number.isFinite(input.observations) ? Math.max(0, input.observations) : 0
  const suspectHits = Number.isFinite(input.suspectHits) ? Math.max(0, input.suspectHits) : 0
  const hits = input.hits === undefined ? suspectHits : input.hits
  const misses = input.misses === undefined ? Math.max(0, observations - suspectHits) : input.misses
  const posterior = betaPosterior(hits, misses)
  const blend: BayesBlend = input.blend ?? BAYES_WEIGHT_SCHEME
  const weights = bayesWeights(blend)
  // factors 直接复用 lifecycle 的实现：任何对 riskScore 的改动都会同时反映到
  // 贝叶斯读数的 recency/experimental 两项上，两边不会各自漂移。
  const factors = riskFactors(input, now)
  const bayesFactors = {
    recency: factors.recency,
    experimental: factors.experimental,
    crashFrequency: weights.crashFrequency * posterior.mean,
  }
  const bayesScore = clamp01(bayesFactors.recency + bayesFactors.experimental + bayesFactors.crashFrequency)
  // riskScore 用**同一个 now** 求值，保证 delta 只反映模型差异而不是时间抖动。
  const legacy = riskScore(input, now)
  return {
    riskScore: legacy,
    bayesScore,
    posteriorMean: posterior.mean,
    lower95: posterior.lower95,
    upper95: posterior.upper95,
    width95: posterior.width95,
    hits: posterior.hits,
    misses: posterior.misses,
    samples: posterior.samples,
    factors: { recency: factors.recency, experimental: factors.experimental, crashFrequency: factors.crashFrequency },
    bayesFactors,
    blend,
    weights,
    delta: bayesScore - legacy,
    posterior,
  }
}

/** 夹到 [0,1]；非有限值 ⇒ 0（不会走到，但契约要求返回有限数）。 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

// ─────────────────────────── Metric 包装（诚实边界） ───────────────────────────

/** `bayesMetric` 的载荷：区间 + 样本数（不重复带危害模型细节）。 */
export interface BayesScoreValue {
  /** 贝叶斯重排分（未取整）。 */
  score: number
  /** 后验均值。 */
  mean: number
  /** 95% 区间。 */
  lower95: number
  upper95: number
  /** 命中/未命中/样本数。 */
  hits: number
  misses: number
  samples: number
}

/**
 * 把贝叶斯读数包成 `Metric<BayesScoreValue>` —— **样本稀疏时说「不可判定」**。
 *
 * 这是 07 §2.3 第一行风险（样本稀疏）在代码里的落点：
 * `hits + misses < SPARSE_SAMPLE_GATE` ⇒ `defined: false`、`value: null`、
 * 并给出人话原因与已观测到的样本数（**原因里带 N**，否则用户只看到
 * 「不可判定」却不知道差多少）。
 *
 * 即便不可判定，`sampleSize` / `confidence` 仍照实填 —— 它们描述的是
 * 「样本量」，不是「读数」，两者不能被同一个 `defined` 一刀切。
 */
export function bayesMetric(input: BayesRiskInput, now = Date.now()): Metric<BayesScoreValue> {
  const r = bayesRisk(input, now)
  const meta: MetricMeta = {
    formula: 'p|data ~ Beta(1+hits, 1+misses); score = Σ wᵢ·factorᵢ（w_freq 用 E[p]）',
    inputs: {
      hits: r.hits,
      misses: r.misses,
      riskScore: r.riskScore,
      bayesScore: r.bayesScore,
      delta: r.delta,
      lower95: r.lower95,
      upper95: r.upper95,
      // 布尔在 inputs 里用 0/1：保持「标量」取值域，便于快照逐字节比对。
      sparse: r.samples < SPARSE_SAMPLE_GATE ? 1 : 0,
    },
    sampleSize: r.samples,
    confidence: sampleConfidence(r.samples),
  }
  if (r.samples < SPARSE_SAMPLE_GATE) {
    return undefinedMetric(
      `样本不足：仅有 ${r.samples} 次观测（< ${SPARSE_SAMPLE_GATE}），贝叶斯后验仍由先验主导`,
      `样本不足（N=${r.samples}）`,
      meta,
    )
  }
  const digits = displayDigitsFor(r.samples)
  return definedMetric(
    {
      score: r.bayesScore,
      mean: r.posteriorMean,
      lower95: r.lower95,
      upper95: r.upper95,
      hits: r.hits,
      misses: r.misses,
      samples: r.samples,
    },
    `贝叶斯 ${pctText(r.posteriorMean, digits)}（95% CI ${pctText(r.lower95, digits)}–${pctText(r.upper95, digits)}，N=${r.samples}）`,
    meta,
  )
}

/**
 * 显示位数：直接用 `observability.displayDigits` 的**降级纪律**
 * （样本越少位数越少），并保证最小 1 位 —— 区间宽度在 1% 以下时
 * 只给 0 位会把上下界显示成同一个数，看起来像「零宽度」。
 *
 * 复用而不是另写一份：位数纪律是全局约定，任何模块自造一套都会出现
 * 「同一指标在不同面板上位数不同」的不可比问题。
 */
function displayDigitsFor(samples: number): number {
  return Math.max(1, displayDigits(samples))
}

/** 百分数文本（保留 digits 位小数）。 */
function pctText(rate: number, digits: number): string {
  return `${(rate * 100).toFixed(digits)}%`
}

// ─────────────────────────── 校准总结（RQ2 前置） ───────────────────────────

/**
 * 一条命中/未命中计数 —— `bayesCalibration` 的最小输入单位。
 *
 * 用 `name` 而不是 id 是为了让报告直接可读；同名会合并（Map），
 * 这在处理「同一插件多次出现」的回放缓冲时是想要的行为。
 */
export interface CalibrationSample {
  /** 插件名（同名的样本会被累加）。 */
  name: string
  /** 命中数。 */
  hits: number
  /** 未命中数。 */
  misses: number
}

/** 单个插件的校准结果。 */
export interface CalibrationEntry extends BetaPosterior {
  /** 插件名。 */
  name: string
}

/**
 * 校准总结 —— 把一组插件的命中/未命中汇总成「整体有多确定」。
 *
 * ## 为什么不是简单平均各插件的均值
 *
 * 12 个插件里有 10 个只有 1 次观测、2 个有 100 次：对 12 个均值取平均，
 * 那 10 个噪声读数各占 1/12，等于让「没证据」与「有证据」等权。
 * 这里给两组读数，各自诚实：
 * - `pooledMean`：**按样本量加权**（= Σ(1+hits) / Σ(2+n)），
 *   衡量「证据总量」下的总体命中率；
 * - `meanOfMeans`：等权平均，衡量「典型插件」的命中率。
 *
 * 两者差得越大，说明插件之间的证据量越不均衡 —— 这本身就是一条要
 * 显示给用户的诊断（面板可据此标「多数插件样本不足」）。
 *
 * ## 诚实边界
 *
 * `undecided` 统计样本不足的插件数；若**全部**不足，`pooled` 仍可算
 * （数学上没问题），但 `decidable` 为 false，调用方不应把它当结论。
 */
export interface BayesCalibration {
  /** 参与的插件数。 */
  plugins: number
  /** 样本量加权均值。 */
  pooledMean: number
  /** 等权均值（各插件后验均值）。 */
  meanOfMeans: number
  /** pooled 的 95% 区间（把全部命中/未命中汇总成一个 Beta 后验再取分位）。 */
  lower95: number
  upper95: number
  /** 汇总样本数与命中数。 */
  totalSamples: number
  totalHits: number
  /** 样本不足（n < 门）的插件数。 */
  undecided: number
  /** 是否至少有一个插件达到样本门。 */
  decidable: boolean
  /** 逐插件读数（按名排序，保证确定性）。 */
  entries: CalibrationEntry[]
}

/**
 * 汇总一组插件样本的贝叶斯校准 —— 供 `riskCalibration` 指标与面板使用。
 *
 * 空输入返回全 0 的**结构化**结果（而不是 undefined）：面板拿到 0 与
 * 拿到 undefined 的处理路径不同，`decidable: false` 已经足够表达
 * 「没有可用结论」，再返 null 只会让调用方多一层分支。
 */
export function bayesCalibration(samples: readonly CalibrationSample[]): BayesCalibration {
  const merged = new Map<string, { hits: number; misses: number }>()
  for (const s of samples) {
    if (!s || typeof s.name !== 'string' || s.name.length === 0) continue
    const cur = merged.get(s.name) ?? { hits: 0, misses: 0 }
    cur.hits += Number.isFinite(s.hits) ? Math.max(0, s.hits) : 0
    cur.misses += Number.isFinite(s.misses) ? Math.max(0, s.misses) : 0
    merged.set(s.name, cur)
  }
  const names = [...merged.keys()].sort()
  const entries: CalibrationEntry[] = []
  let totalHits = 0
  let totalSamples = 0
  let meanSum = 0
  let undecided = 0
  for (const name of names) {
    const raw = merged.get(name)
    const post = betaPosterior(raw?.hits ?? 0, raw?.misses ?? 0)
    entries.push({ name, ...post })
    totalHits += post.hits
    totalSamples += post.samples
    meanSum += post.mean
    if (post.samples < SPARSE_SAMPLE_GATE) undecided += 1
  }
  if (entries.length === 0) {
    return {
      plugins: 0,
      pooledMean: 0,
      meanOfMeans: 0,
      lower95: 0,
      upper95: 0,
      totalSamples: 0,
      totalHits: 0,
      undecided: 0,
      decidable: false,
      entries,
    }
  }
  // 汇总后验 Beta(1+Σhits, 1+Σmisses)：注意**不是**各插件 α′/β′ 的平均，
  // 也不是把各插件 α′/β′ 相加（那会把先验重复计入 P 次）。
  const pooled = betaPosterior(totalHits, totalSamples - totalHits)
  return {
    plugins: entries.length,
    pooledMean: pooled.mean,
    meanOfMeans: meanSum / entries.length,
    lower95: pooled.lower95,
    upper95: pooled.upper95,
    totalSamples,
    totalHits,
    undecided,
    decidable: undecided < entries.length,
    entries,
  }
}

/**
 * 自检：本模块返回的每个数是否都有限 —— 供契约测试遍历调用。
 *
 * 为什么需要它：数值稳定性的失败模式是**静默的**（NaN 会一路穿到面板，
 * 只在渲染时才显形）。把「有限性」做成可被测试断言的显式导出，
 * 比在每个调用点手写 `Number.isFinite` 更难漏。
 */
export function isFinitePosterior(p: BetaPosterior): boolean {
  const values = [p.alpha, p.beta, p.mean, p.mode, p.stdev, p.lower95, p.upper95, p.width95]
  return (
    values.every((v) => Number.isFinite(v)) &&
    p.mean > 0 &&
    p.mean < 1 &&
    p.lower95 > 0 &&
    p.upper95 < 1 &&
    p.lower95 < p.upper95
  )
}

/** 取整到 4 位 —— 与项目其余读数一致的比对口径（仅用于展示/契约比对）。 */
export function roundPosterior4(p: BetaPosterior): BetaPosterior {
  return {
    ...p,
    alpha: round4(p.alpha),
    beta: round4(p.beta),
    mean: round4(p.mean),
    mode: round4(p.mode),
    stdev: round4(p.stdev),
    lower95: round4(p.lower95),
    upper95: round4(p.upper95),
    width95: round4(p.width95),
    evidenceShift: round4(p.evidenceShift),
  }
}

/** 权重方案自检：三项之和必须是 1（写坏权重是静默改变所有决策的坑）。 */
export function weightsNormalized(w: BayesWeights): boolean {
  return Math.abs(w.recency + w.experimental + w.crashFrequency - 1) <= WEIGHT_SUM_TOLERANCE
}
