/**
 * 贝叶斯风险评分（v0.13 · RQ1 / E1.1b）的单测。
 *
 * ## 这个测试要钉住的是什么
 *
 * 不是「函数能跑」，而是三条**纪律**：
 *
 * 1. **Beta(1,1) 先验的数值是确定的**。先验不是随手写的默认值，它决定
 *    「样本少时读数长什么样」。0.5 均值 + [0.025, 0.975] 区间是均匀分布的
 *    解析结论，任何改动都会被这几条断言抓住。
 * 2. **共轭更新方向单调**。命中变多 ⇒ 均值单调上升；未命中变多 ⇒ 单调下降；
 *    n → ∞ ⇒ 收敛到经验命中率。方向错了就是模型错了，不是「精度问题」。
 * 3. **极端输入不产 NaN**。0 命中 / 全命中 / 巨大样本 / 负数 / NaN 计数
 *    都必须返回有限值且区间非空 —— 这是面板不崩的前提。
 *
 * ## 还有一条最容易写错的纪律
 *
 * **`riskScore` 的默认路径不许被本模块影响。** 所以这里用 `lifecycle.riskScore`
 * 与 `bayesRisk(...).riskScore` 做**逐位相等**断言：贝叶斯读数可以随便保守，
 * 但它必须把现有评分原样带出来。这条断言是「并行读数」而非「替换」的可执行证据。
 */
import { riskFactors, riskScore, type RiskInput } from '../../src/host/core/lifecycle.ts'
import {
  BAYES_PRIOR,
  PRIOR_STRENGTH,
  SPARSE_SAMPLE_GATE,
  BAYES_UNIFORM_WEIGHTS,
  bayesCalibration,
  bayesMetric,
  bayesRisk,
  bayesWeights,
  betaPosterior,
  betaQuantile,
  isFinitePosterior,
  logBeta,
  regularizedIncompleteBeta,
  roundPosterior4,
  weightsNormalized,
} from '../../src/host/risk/risk-bayes.ts'

let failures = 0
let assertions = 0

function check(name: string, cond: boolean, detail?: unknown) {
  assertions += 1
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 近似相等（相对容差，用于超大/超小的区间端点）。 */
function near(a: number, b: number, tol = 1e-9): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (a === b) return true
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-300)
  return Math.abs(a - b) / scale < tol
}

const NOW = Date.parse('2026-11-10T00:00:00.000Z')

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    lastChangeAt: '2026-11-09T23:00:00.000Z', // 1 小时前
    experimental: false,
    suspectHits: 0,
    observations: 1,
    ...overrides,
  }
}

function main() {
  // ───────────────────────── 先验与基本形状 ─────────────────────────

  console.log('\n== Beta(1,1) 先验（解析值，不是"看着差不多"） ==')
  {
    check('先验常量是 (1,1)', BAYES_PRIOR.alpha === 1 && BAYES_PRIOR.beta === 1)
    check('先验强度 = 2（等价于两次虚拟观测）', PRIOR_STRENGTH === 2)
    const prior = betaPosterior(0, 0)
    check('先验均值 = 0.5', near(prior.mean, 0.5, 1e-12), prior.mean)
    // 均匀分布 Beta(1,1) 的 2.5% / 97.5% 分位解析值就是 0.025 / 0.975。
    check('先验 95% 下界 = 0.025（均匀分布的解析分位）', near(prior.lower95, 0.025, 1e-8), prior.lower95)
    check('先验 95% 上界 = 0.975', near(prior.upper95, 0.975, 1e-8), prior.upper95)
    check('先验区间宽度 = 0.95', near(prior.width95, 0.95, 1e-8), prior.width95)
    // Beta(1,1) 方差 = 1/12 ⇒ sd = 1/(2√3) ≈ 0.2887。
    check('先验标准差 = 1/(2√3)', near(prior.stdev, 1 / (2 * Math.sqrt(3)), 1e-12), prior.stdev)
    check('先验样本数 = 0', prior.samples === 0)
    check('先验证据位移 = 0（没有证据就没有偏移）', near(prior.evidenceShift, 0, 1e-12))
    check('先验读数有限且区间非空', isFinitePosterior(prior))
  }

  console.log('\n== 共轭更新：后验参数逐个对得上 ==')
  {
    const p = betaPosterior(3, 5)
    check('α′ = 1 + hits = 4', near(p.alpha, 4, 1e-12), p.alpha)
    check('β′ = 1 + misses = 6', near(p.beta, 6, 1e-12), p.beta)
    check('均值 = (1+hits)/(2+hits+misses) = 4/10 = 0.4', near(p.mean, 0.4, 1e-12), p.mean)
    check('样本数 = hits+misses = 8', p.samples === 8)
    check('hits/misses 原样带出', p.hits === 3 && p.misses === 5)
    const one_one = betaPosterior(1, 0)
    // 1/1：频率派给 100%，贝叶斯给 2/3 —— 这就是要消灭的"一条证据等于确定"。
    check('1 命中 0 未命中 ⇒ 0.6667 而非 1.0', near(one_one.mean, 2 / 3, 1e-12), one_one.mean)
    const zero_one = betaPosterior(0, 1)
    check('0 命中 1 未命中 ⇒ 0.3333 而非 0', near(zero_one.mean, 1 / 3, 1e-12), zero_one.mean)
  }

  console.log('\n== 共轭更新的单调性（方向错了就是模型错了） ==')
  {
    const rising = [0, 1, 2, 5, 20].map((h) => betaPosterior(h, 4).mean)
    check(
      '命中增加 ⇒ 均值严格单调上升',
      rising.every((v, i) => i === 0 || v > rising[i - 1]),
      rising,
    )
    const falling = [0, 1, 2, 5, 20].map((m) => betaPosterior(4, m).mean)
    check(
      '未命中增加 ⇒ 均值严格单调下降',
      falling.every((v, i) => i === 0 || v < falling[i - 1]),
      falling,
    )
    // 同比例放大：均值向经验命中率靠拢（先验被证据稀释）。
    // 注意**方向取决于经验命中率相对先验 0.5 的位置**：0.25 < 0.5 ⇒ 递减靠拢；
    // 0.75 > 0.5 ⇒ 递增靠拢。两边都测，才能证明"靠拢"而不是"某种单向漂移"。
    const below = [betaPosterior(1, 3).mean, betaPosterior(10, 30).mean, betaPosterior(100, 300).mean]
    check(
      '经验命中率 0.25（低于先验）⇒ 均值单调递减靠拢',
      below.every((v, i) => i === 0 || v < below[i - 1]),
      below,
    )
    const above = [betaPosterior(3, 1).mean, betaPosterior(30, 10).mean, betaPosterior(300, 100).mean]
    check(
      '经验命中率 0.75（高于先验）⇒ 均值单调递增靠拢',
      above.every((v, i) => i === 0 || v > above[i - 1]),
      above,
    )
    // 绝对容差：near() 是相对判据，对 0.25 量级的值 1e-4 相对容差只有 2.5e-5 绝对值。
    check(
      'n=400 且命中率 0.25 ⇒ 均值 0.2512（先验残余仍可见）',
      Math.abs(below[2] - 0.2512) < 1e-3,
      below[2],
    )
    check(
      '个大样本收敛到经验命中率（|mean − 0.25| < 0.001）',
      Math.abs(betaPosterior(500, 1500).mean - 0.25) < 1e-3,
      betaPosterior(500, 1500).mean,
    )
    // 单调性的另一面：先验强度不变时，证据越多越"敢下结论"。
    check(
      '命中单调不降（含等号边界不会反向）',
      betaPosterior(7, 7).mean > betaPosterior(6, 7).mean && betaPosterior(0, 0).mean < betaPosterior(1, 0).mean,
    )
  }

  console.log('\n== 可信区间随样本增大而收窄 ==')
  {
    // 固定比例 0.5，只放大样本：区间宽度必须严格递减。
    const widths = [0, 2, 10, 50, 200, 2000].map((n) => betaPosterior(n / 2, n / 2).width95)
    check(
      '同比例下宽度严格递减',
      widths.every((v, i) => i === 0 || v < widths[i - 1]),
      widths,
    )
    check('先验宽度 0.95 是上限（没有任何观测能比它更宽）', widths[0] <= 0.9500001, widths[0])
    check('n=2000 时宽度 < 0.05（样本充足才敢收窄）', widths[5] < 0.05, widths[5])
    // 另一条路径：极端比例也不能因为"贴边"就把宽度压到 0。
    check('0 命中 30 次的区间仍然非空且有限', isFinitePosterior(betaPosterior(0, 30)))
    check('全命中 30 次的区间仍然非空且有限', isFinitePosterior(betaPosterior(30, 0)))
    const extreme = betaPosterior(0, 30)
    check('极端比例的宽度 > 0（不许伪造确定性）', extreme.width95 > 0, extreme.width95)
    check('0 命中时上界仍显著 > 下界（右偏但不退化）', extreme.upper95 - extreme.lower95 > 0.01, extreme.width95)
  }

  console.log('\n== 极端比例不产 NaN / Infinity / 除零 ==')
  {
    const cases: Array<[number, number, string]> = [
      [0, 0, '零样本'],
      [0, 1, '零命中小样本'],
      [1, 0, '全命中单样本'],
      [0, 100_000, '零命中超大样本'],
      [100_000, 0, '全命中超大样本'],
      [1, 100_000, '极小比例'],
      [100_000, 1, '极大比例'],
      [1e6, 1e6, '百万级样本'],
      [-5, 3, '负命中（脏输入）'],
      [3, -5, '负未命中（脏输入）'],
      [Number.NaN, 2, 'NaN 命中'],
      [2, Number.NaN, 'NaN 未命中'],
      [Number.POSITIVE_INFINITY, 3, 'Infinity 命中'],
      [1.7, 2.9, '浮点计数'],
    ]
    for (const [h, m, why] of cases) {
      const p = betaPosterior(h, m)
      check(`${why}：所有读数有限`, isFinitePosterior(p), { h, m, mean: p.mean, lo: p.lower95, hi: p.upper95 })
    }
    // 脏输入的具体语义：负数/NaN 视为"无证据"，浮点向下取整。
    const dirty = betaPosterior(-5, Number.NaN)
    check('负数 + NaN ⇒ 退化为先验（无证据）', dirty.samples === 0 && near(dirty.mean, 0.5, 1e-12), dirty)
    const floaty = betaPosterior(1.7, 2.9)
    check('浮点计数向下取整（1.7 ⇒ 1，2.9 ⇒ 2）', floaty.hits === 1 && floaty.misses === 2, floaty)
    check('极大量级仍落在 (0,1) 内', betaPosterior(1e6, 0).mean < 1 && betaPosterior(0, 1e6).mean > 0)
  }

  console.log('\n== 分布内核与解析值对照 ==')
  {
    // I_x(a,b) 的解析特例：Beta(1,1) ⇒ I_x = x；Beta(1,2) ⇒ I_x = 1−(1−x)²。
    check('I_0.5(1,1) = 0.5（均匀分布解析值）', near(regularizedIncompleteBeta(1, 1, 0.5), 0.5, 1e-12))
    check('I_0.25(1,1) = 0.25', near(regularizedIncompleteBeta(1, 1, 0.25), 0.25, 1e-12))
    check('I_0.3(1,2) = 1−0.7² = 0.51', near(regularizedIncompleteBeta(1, 2, 0.3), 0.51, 1e-12))
    check('I_0.3(2,3) ≈ 0.3483（连分式对照）', near(regularizedIncompleteBeta(2, 3, 0.3), 0.3483, 1e-6))
    check('x=0 ⇒ 0', regularizedIncompleteBeta(2, 3, 0) === 0)
    check('x=1 ⇒ 1', regularizedIncompleteBeta(2, 3, 1) === 1)
    check('越界 x<0 ⇒ 0（不抛异常）', regularizedIncompleteBeta(2, 3, -1) === 0)
    check('越界 x>1 ⇒ 1（不抛异常）', regularizedIncompleteBeta(2, 3, 2) === 1)
    check('非域参数 ⇒ NaN（让上层守卫发现，不静默补值）', Number.isNaN(regularizedIncompleteBeta(0, 3, 0.5)))
    check('对称恒等式 I_x(a,b) = 1 − I_{1−x}(b,a)', near(regularizedIncompleteBeta(3, 7, 0.4), 1 - regularizedIncompleteBeta(7, 3, 0.6), 1e-12))
    // ln B(1,1) = ln Γ(1)+ln Γ(1)−ln Γ(2) = 0。理论值恰为 0，但 Lanczos 的
    // 相对误差 ~1e-15 会在减法后剩一个绝对量级 1e-15 的残差 —— 用绝对容差，
    // 不能用 near() 的相对判据（b=0 时相对判据分母退化）。
    check('ln B(1,1) = 0（绝对容差 1e-12）', Math.abs(logBeta(1, 1)) < 1e-12, logBeta(1, 1))
    check('ln B(2,3) = ln(1/12)', near(logBeta(2, 3), Math.log(1 / 12), 1e-12), logBeta(2, 3))
    // 回归：lnΓ 在 (0,1) 上曾用反射式 Γ(x)Γ(1−x)=π/sin(πx) 实现，
    // 而 1−x 仍在 (0,1) ⇒ 无限递归 ⇒ RangeError。递推式修复后这里必须能算。
    // 花括号包住是为了让「栈溢出」变成一条 FAIL 而不是整个文件崩掉。
    try {
      const half = logBeta(0.5, 0.5)
      // 解析值 B(1/2,1/2) = π ⇒ ln B = ln π。
      check('ln B(1/2,1/2) = ln π（小数参数不再栈溢出）', near(half, Math.log(Math.PI), 1e-12), half)
      check('I_0.5(1/2,1/2) = 0.5（对称性）', near(regularizedIncompleteBeta(0.5, 0.5, 0.5), 0.5, 1e-10))
    } catch (error) {
      check('小数参数不抛异常（lnΓ 递推式）', false, String(error))
    }
    // 分位数与 CDF 互为反函数（含极端比例，验证概率空间二分的量程）。
    for (const [a, b] of [[1, 1], [2, 3], [1, 31], [31, 1], [500, 500]] as Array<[number, number]>) {
      const q = betaQuantile(0.4, a, b)
      check(`分位数反演一致 Beta(${a},${b})`, near(regularizedIncompleteBeta(a, b, q), 0.4, 1e-6), { a, b, q })
    }
    check('Beta(1,2) 解析分位 q=1−√(1−p)', near(betaQuantile(0.025, 1, 2), 1 - Math.sqrt(0.975), 1e-8), betaQuantile(0.025, 1, 2))
    check('分位数被夹在 (0,1) 内（不给"确定 0/1"的假象）', betaQuantile(1e-12, 1, 1) > 0 && betaQuantile(1 - 1e-12, 1, 1) < 1)
  }

  console.log('\n== 样本稀疏 ⇒ defined:false（项目铁律） ==')
  {
    check('样本门是 3', SPARSE_SAMPLE_GATE === 3)
    for (const [h, m] of [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0]] as Array<[number, number]>) {
      const metric = bayesMetric(input({ suspectHits: h, observations: h + m }), NOW)
      check(
        `n=${h + m}（< 门）⇒ defined:false 且 value:null`,
        metric.defined === false && metric.value === null,
        { h, m, defined: metric.defined },
      )
      check(`n=${h + m} 的 reason 里带出样本数`, /样本不足/.test(metric.reason ?? ''), metric.reason)
      // 不可判定不等于「样本量未知」：sampleSize / confidence 照实填。
      check(`n=${h + m} 仍如实报告 sampleSize`, metric.sampleSize === h + m, metric.sampleSize)
    }
    const atGate = bayesMetric(input({ suspectHits: 1, observations: 3 }), NOW)
    check('n=3（正好到门）⇒ defined:true', atGate.defined === true && atGate.value !== null, atGate.defined)
    check('defined:true 时样本数与输入一致', atGate.value?.samples === 3, atGate.value?.samples)
    check('label 是颜色之外的第二通道（含 N）', /N=3/.test(atGate.label), atGate.label)
    const sparse = bayesMetric(input({ suspectHits: 0, observations: 0 }), NOW)
    check('零样本 ⇒ confidence = 0', sparse.confidence === 0, sparse.confidence)
    check('零样本 ⇒ 不可判定而不是"风险 0"', sparse.value === null && sparse.defined === false)
  }

  // ───────────────────── 并行读数纪律（关键） ─────────────────────

  console.log('\n== 并行读数：riskScore 默认路径未被改变 ==')
  {
    const cases: RiskInput[] = [
      input(),
      input({ suspectHits: 1, observations: 1 }),
      input({ experimental: true, suspectHits: 3, observations: 7 }),
      input({ lastChangeAt: '2026-10-10T00:00:00.000Z', changeCount: 5 }),
      input({ lastChangeAt: '2026-11-10T00:00:00.000Z', experimental: true, suspectHits: 99, observations: 1, changeCount: 999 }),
      input({ lastChangeAt: 'not-a-date' }),
    ]
    for (const c of cases) {
      const viaBayes = bayesRisk(c, NOW).riskScore
      const direct = riskScore(c, NOW)
      check(
        `riskScore 逐位相等（experimental=${c.experimental}, hits=${c.suspectHits}/${c.observations}）`,
        viaBayes === direct,
        { viaBayes, direct },
      )
    }
    // 固定基线值：这两条钉住"没人偷偷改过 lifecycle 的公式或取整顺序"。
    check('基线 riskScore（1 小时前、无历史)= 0.4952', riskScore(input(), NOW) === 0.4952, riskScore(input(), NOW))
    check(
      '基线 riskScore（1 小时前、experimental、1 次命中）= 0.9952',
      riskScore(input({ experimental: true, suspectHits: 1, observations: 1 }), NOW) === 0.9952,
      riskScore(input({ experimental: true, suspectHits: 1, observations: 1 }), NOW),
    )
    // 只替换 crashFrequency 一项：另两项必须与 lifecycle 的因子分解逐位相同。
    const r = bayesRisk(input({ experimental: true, suspectHits: 2, observations: 5, changeCount: 3 }), NOW)
    const f = riskFactors(input({ experimental: true, suspectHits: 2, observations: 5, changeCount: 3 }), NOW)
    check('recency 因子与 lifecycle 逐位相同', r.bayesFactors.recency === f.recency, { a: r.bayesFactors.recency, b: f.recency })
    check('experimental 因子与 lifecycle 逐位相同', r.bayesFactors.experimental === f.experimental)
    check('factors 原样带出（可审计）', r.factors.crashFrequency === f.crashFrequency && r.factors.recency === f.recency)
    check('只有 crashFrequency 项被贝叶斯均值替换', r.bayesFactors.crashFrequency === 0.2 * r.posteriorMean)
    check('权重之和为 1（写坏权重是静默改结论）', weightsNormalized(bayesWeights()))
    check('默认权重方案是 crashFrequency', r.blend === 'crashFrequency')
    check('默认权重 = 0.5/0.3/0.2（与 lifecycle 一致）', bayesWeights().recency === 0.5 && bayesWeights().experimental === 0.3 && bayesWeights().crashFrequency === 0.2)
    check('uniform 方案三项各 1/3', weightsNormalized(bayesWeights('uniform')) && near(BAYES_UNIFORM_WEIGHTS.recency, 1 / 3, 1e-12))
    check('分数落在 [0,1]', r.bayesScore >= 0 && r.bayesScore <= 1, r.bayesScore)
    check('delta = bayesScore − riskScore', near(r.delta, r.bayesScore - r.riskScore, 1e-12))
  }

  console.log('\n== 两套读数在什么方向分歧（面板要解释的差异） ==')
  {
    // 小样本 1/1：频率派 100%、贝叶斯 2/3 ⇒ 贝叶斯更**保守**（分更低）。
    const small = bayesRisk(input({ suspectHits: 1, observations: 1 }), NOW)
    check('1/1 时贝叶斯低于频率派（保守）', small.bayesScore < small.riskScore, { b: small.bayesScore, r: small.riskScore })
    check('1/1 时 delta < 0', small.delta < 0, small.delta)
    // 0 命中：频率派 0、贝叶斯 > 0 ⇒ 贝叶斯更**谨慎**（分更高，不假装清白）。
    const clean = bayesRisk(input({ suspectHits: 0, observations: 1 }), NOW)
    check('0/1 时贝叶斯高于频率派（不假装清白）', clean.bayesScore > clean.riskScore, { b: clean.bayesScore, r: clean.riskScore })
    check('0/1 时 delta > 0', clean.delta > 0, clean.delta)
    // 样本充足且命中率极端时两者收敛：0.2 × E[p] → 0.2 × rate。
    const converged = bayesRisk(input({ suspectHits: 200, observations: 1000 }), NOW)
    check('大样本时两套读数收敛（|delta| < 0.002）', Math.abs(converged.delta) < 2e-3, converged.delta)
    // 200/1000 的先验残余是 2/(2+1000) ≈ 0.2% 的绝对偏移，所以判据用**相对**偏离。
    check('大样本时后验均值逼近经验命中率 0.2（相对偏差 < 1%）', Math.abs(converged.posteriorMean - 0.2) / 0.2 < 0.01, converged.posteriorMean)
  }

  console.log('\n== 显式 hits/misses 覆盖与默认推导 ==')
  {
    const derived = bayesRisk(input({ suspectHits: 3, observations: 10 }), NOW)
    check('缺省从 observations − suspectHits 推导 misses = 7', derived.misses === 7, derived.misses)
    check('缺省从 suspectHits 推导 hits = 3', derived.hits === 3)
    const explicit = bayesRisk({ ...input({ suspectHits: 3, observations: 10 }), hits: 1, misses: 1 }, NOW)
    check('显式 hits/misses 优先（回放场景的另一种"观测"定义）', explicit.hits === 1 && explicit.misses === 1)
    const negative = bayesRisk(input({ suspectHits: 9, observations: 2 }), NOW)
    check('suspectHits > observations ⇒ misses 夹到 0（不产负计数）', negative.misses === 0, negative.misses)
    const nanObs = bayesRisk(input({ observations: Number.NaN, suspectHits: 1 }), NOW)
    check('NaN observations ⇒ misses = 0（脏输入不产 NaN）', nanObs.misses === 0 && isFinitePosterior(nanObs.posterior))
  }

  console.log('\n== 校准总结（RQ2 前置于此） ==')
  {
    const cal = bayesCalibration([
      { name: 'a', hits: 5, misses: 5 },
      { name: 'b', hits: 20, misses: 0 },
      { name: 'c', hits: 0, misses: 1 },
    ])
    check('插件数 = 3', cal.plugins === 3, cal.plugins)
    check('逐插件条目按名排序（确定性）', cal.entries.map((e) => e.name).join('') === 'abc')
    check('条目本身是合法后验', cal.entries.every(isFinitePosterior))
    check('undecided 统计样本不足的插件数 = 1（c 只有 1 次）', cal.undecided === 1, cal.undecided)
    check('至少一个达门 ⇒ decidable', cal.decidable === true)
    check('pooled 均值 = (1+25)/(2+31) ≈ 0.7879', near(cal.pooledMean, 26 / 33, 1e-12), cal.pooledMean)
    check('等权均值 ≠ pooled（样本量不均衡时的诊断信号）', Math.abs(cal.meanOfMeans - cal.pooledMean) > 1e-3, {
      pooled: cal.pooledMean,
      meanOfMeans: cal.meanOfMeans,
    })
    check('totalSamples = 31', cal.totalSamples === 31, cal.totalSamples)
    check('totalHits = 25', cal.totalHits === 25)
    check(
      'pooled 区间有限且非空（0 < 下界 < 上界 < 1）',
      cal.lower95 > 0 && cal.lower95 < cal.upper95 && cal.upper95 < 1,
      [cal.lower95, cal.upper95],
    )
    const dup = bayesCalibration([
      { name: 'x', hits: 1, misses: 1 },
      { name: 'x', hits: 2, misses: 0 },
    ])
    check('同名样本被累加（回放缓冲的预期行为）', dup.plugins === 1 && dup.entries[0].hits === 3 && dup.entries[0].misses === 1, dup.entries[0])
    const empty = bayesCalibration([])
    check('空输入 ⇒ 结构化零值且 decidable:false（不是 undefined）', empty.plugins === 0 && empty.decidable === false && empty.pooledMean === 0)
    check('空输入不产 NaN', Number.isFinite(empty.lower95) && Number.isFinite(empty.upper95))
    const allSparse = bayesCalibration([{ name: 'p', hits: 1, misses: 0 }])
    check('全部样本不足 ⇒ decidable:false（不给总体结论）', allSparse.decidable === false, allSparse.decidable)
    const dirty = bayesCalibration([{ name: 'q', hits: Number.NaN, misses: -3 }])
    check('脏计数 ⇒ 按无证据处理，不产 NaN', isFinitePosterior(dirty.entries[0]), dirty.entries[0])
  }

  console.log('\n== 确定性、取整与契约辅助 ==')
  {
    const a = bayesRisk(input({ suspectHits: 2, observations: 6 }), NOW)
    const b = bayesRisk(input({ suspectHits: 2, observations: 6 }), NOW)
    check('同输入同 now ⇒ 逐位相同（可回放）', JSON.stringify(a) === JSON.stringify(b))
    const rounded = roundPosterior4(betaPosterior(3, 7))
    check('round4 只保留 4 位小数', /^\d+(\.\d{1,4})?$/.test(String(rounded.mean)), rounded.mean)
    check('round4 后仍是有限值', isFinitePosterior(rounded))
    check('isFinitePosterior 能拒绝 NaN 后验', isFinitePosterior({ ...betaPosterior(1, 1), mean: Number.NaN }) === false)
    // 反向保护：区间倒挂必须被识别成非法（否则"区间"就是装饰）。
    check(
      'isFinitePosterior 能拒绝倒挂区间',
      isFinitePosterior({ ...betaPosterior(1, 1), lower95: 0.9, upper95: 0.1 }) === false,
    )
    const m1 = bayesMetric(input({ suspectHits: 4, observations: 10 }), NOW)
    const m2 = bayesMetric(input({ suspectHits: 4, observations: 10 }), NOW)
    check('Metric 包装同样确定', JSON.stringify(m1) === JSON.stringify(m2))
    check('Metric 带了定义式（白盒契约）', typeof m1.formula === 'string' && m1.formula.length > 0)
    check('Metric inputs 是标量域（布尔用 0/1）', Object.values(m1.inputs ?? {}).every((v) => v === null || ['number', 'string'].includes(typeof v)))
  }

  console.log(`\n断言总数：${assertions}`)
  console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
