/**
 * 变更频率因子（v0.13 方向①）的回归。
 *
 * ## 要解决的缺口（研究文档 09 §2.1）
 *
 * 只按「最近一次变更距今多久」（一维新近性）排序，无法区分：
 * - 一小时前**热更新五次** —— 反复改动 ⇒ 引入缺陷的机会更多
 * - 一小时前**只安装一次** —— 一次性动作 ⇒ 只有一次机会
 *
 * 两者 `lastChangeAt` 相同、`recency` 相同，在决策面上完全同分。
 *
 * ## 关键设计：调制项而非第四个加法因子
 *
 * 三因子权重 0.5/0.3/0.2 之和恰为 1。再加一项要么破坏归一化，要么重分配
 * 权重（既有断言集体失效、旧决策不可比）。所以做成 recency 的**乘数**：
 * `recency × (1 + α·density)`，语义是「频率放大/缩小新近性的可信度」。
 *
 * ## 诚实边界（本测试的重点）
 *
 * `changeCount` 缺失 ⇒ 乘数恒为 1 ⇒ 结论与 v0.12 **逐位相同**。
 * 这不是「补 0」，是「没这个维度的信息就不改变结论」。
 */
import {
  CHANGE_FREQUENCY,
  changeDensityMultiplier,
  riskFactors,
  riskScore,
  type RiskInput,
} from '../../src/host/core/lifecycle.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
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
  console.log('\n== 调制乘数的边界 ==')
  check('undefined ⇒ 1（无信息不改变结论）', changeDensityMultiplier(undefined) === 1)
  check('0 ⇒ 1', changeDensityMultiplier(0) === 1)
  check('1 ⇒ 1（只装过一次不算"反复折腾"）', changeDensityMultiplier(1) === 1)
  check('2 ⇒ 1 + α·(2/5)', Math.abs(changeDensityMultiplier(2) - (1 + CHANGE_FREQUENCY.alpha * (2 / CHANGE_FREQUENCY.cap))) < 1e-12, changeDensityMultiplier(2))
  check('cap(5) ⇒ 1 + α', Math.abs(changeDensityMultiplier(5) - (1 + CHANGE_FREQUENCY.alpha)) < 1e-12, changeDensityMultiplier(5))
  check('超过 cap 不再增长（封顶）', changeDensityMultiplier(50) === changeDensityMultiplier(5))
  check('非有限值 ⇒ 1（不产生 NaN/Infinity）', changeDensityMultiplier(Number.NaN) === 1 && changeDensityMultiplier(Number.POSITIVE_INFINITY) === 1)
  check('乘数单调不减', changeDensityMultiplier(3) >= changeDensityMultiplier(2))

  console.log('\n== 向后兼容：缺 changeCount ⇒ 与旧公式逐位一致 ==')
  {
    const base = input()
    const withoutField = riskScore(base, NOW)
    const explicitZero = riskScore(input({ changeCount: 0 }), NOW)
    const explicitOne = riskScore(input({ changeCount: 1 }), NOW)
    check('缺字段 == changeCount:0', withoutField === explicitZero, { withoutField, explicitZero })
    check('缺字段 == changeCount:1（单次安装不变）', withoutField === explicitOne, { withoutField, explicitOne })
    // 对照 v0.12 的原始公式。riskScore 内部有 round4（4 位小数取整），
    // 所以容差取 1e-4 而不是 1e-9 —— 断言的是「公式一致」，不是「无取整」。
    const legacy =
      0.5 * Math.pow(0.5, (NOW - Date.parse(base.lastChangeAt)) / 3_600_000 / 72) + 0.3 * 0 + 0.2 * 0
    check('与 v0.12 原始公式一致（容差 1e-4，含 round4）', Math.abs(withoutField - legacy) < 1e-4, { withoutField, legacy })
  }

  console.log('\n== 频率提升风险：热更新五次 > 只装一次 ==')
  {
    const once = riskScore(input({ changeCount: 1 }), NOW)
    const five = riskScore(input({ changeCount: 5 }), NOW)
    check('热更新五次的风险更高', five > once, { once, five })
    // 增幅上界：recency 项的增量 = 0.5（权重）× baseRecency × α
    const baseRecency = Math.pow(0.5, 1 / 72) // 1 小时前
    const maxDelta = 0.5 * baseRecency * CHANGE_FREQUENCY.alpha
    check('增幅不超过 α 倍新近性权重（不会把一个月没动的顶上来）', five - once <= maxDelta + 1e-4, { diff: five - once, maxDelta })
  }

  console.log('\n== 调制只作用于 recency，不影响其他两因子 ==')
  {
    const a = riskFactors(input({ changeCount: 1, experimental: true, suspectHits: 2, observations: 4 }), NOW)
    const b = riskFactors(input({ changeCount: 5, experimental: true, suspectHits: 2, observations: 4 }), NOW)
    check('experimental 因子不受频率影响', a.experimental === b.experimental, { a: a.experimental, b: b.experimental })
    check('crashFrequency 因子不受频率影响', a.crashFrequency === b.crashFrequency, { a: a.crashFrequency, b: b.crashFrequency })
    check('recency 因子被放大', b.recency > a.recency, { a: a.recency, b: b.recency })
  }

  console.log('\n== 频率不能压过时间局部性（设计约束） ==')
  {
    // 一个月前但热更新 5 次 vs 1 小时前只装一次
    const oldFrequent = riskScore(input({ lastChangeAt: '2026-10-10T00:00:00.000Z', changeCount: 5 }), NOW)
    const freshOnce = riskScore(input({ lastChangeAt: '2026-11-09T23:00:00.000Z', changeCount: 1 }), NOW)
    check('一个月前的高频插件仍低于一小时前的单次插件', oldFrequent < freshOnce, { oldFrequent, freshOnce })
  }

  console.log('\n== 结果始终落在 [0,1] ==')
  {
    const extreme = riskScore(
      input({ lastChangeAt: '2026-11-10T00:00:00.000Z', experimental: true, suspectHits: 99, observations: 1, changeCount: 999 }),
      NOW,
    )
    check('极端输入被夹到 [0,1]', extreme >= 0 && extreme <= 1, extreme)
  }

  console.log('\n== 确定性 ==')
  {
    const one = riskScore(input({ changeCount: 3 }), NOW)
    const two = riskScore(input({ changeCount: 3 }), NOW)
    check('同输入同 now ⇒ 同结果', one === two)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
