/**
 * 分布形态驱动的阈值调整（v0.13 方向②）的回归。
 *
 * ## 为什么是「分布形态」而不是「证据年龄衰减」
 *
 * 候选方向原提议用指数衰减 `w_i = e^(−λΔt_i)` 给旧证据降权。研究文档 09 §2.2
 * 判定该方案有副作用：`confirmRounds` 的语义是「**同一头号嫌疑连续复现**」，
 * 而 `environmentChanged` 已保证环境没变。环境没变时的复现，无论间隔多久都是
 * 该插件的缺陷 —— 加时间衰减会把它判成证据不足 ⇒ **放过真缺陷**，违反
 * 「宿主可用性优先于误伤最小化」这条兜底升级所依据的同一原则。
 *
 * 所以改用崩溃间隔的 Weibull 形状 k（分布形态）：
 * - k < 0.9：危险率递减 ⇒ 崩溃成簇（连锁）⇒ 阈值下调（更积极切断）
 * - k > 1.1：危险率递增 ⇒ 比泊松更规则（固定周期负载）⇒ 阈值上调（更保守）
 * - 其余 / 不可靠 / 撞边界 / 无样本 ⇒ 不变
 *
 * 本测试钉住的是**调整的边界条件**（哪些情况下必须不动），而不是调整本身 ——
 * 因为「不动」是向后兼容与安全性的保证。
 */
import { assessConfidence, hazardAdjustedRounds, type HazardLike } from '../../src/host/guard/recovery-policy.ts'
import type { RecencyEntry } from '../../src/host/risk/recency.ts'
import type { CrashHistoryEntry } from '../../src/host/guard/recovery-policy.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function entry(bundle: string): RecencyEntry {
  return { bundle, lastChangeAt: '2026-11-09T00:00:00.000Z', lastKind: 'install' }
}

function history(...suspects: string[][]): CrashHistoryEntry[] {
  return suspects.map((s, i) => ({ at: `2026-11-0${i + 1}T00:00:00.000Z`, exitCode: 1, suspects: s }))
}

function main() {
  console.log('\n== hazardAdjustedRounds：边界条件（必须不动的情形） ==')
  check('无形态 ⇒ 原样', hazardAdjustedRounds(2, undefined) === 2)
  check('reliable=false（样本<9）⇒ 不调整', hazardAdjustedRounds(2, { weibullShape: 0.5, reliable: false }) === 2)
  check('atBound=true（撞搜索上界）⇒ 不调整', hazardAdjustedRounds(2, { weibullShape: 5, atBound: true }) === 2)
  check('形状缺失 ⇒ 不调整', hazardAdjustedRounds(2, { reliable: true }) === 2)
  check('形状非有限 ⇒ 不调整', hazardAdjustedRounds(2, { weibullShape: Number.NaN, reliable: true }) === 2)
  check('k≈1（泊松）⇒ 不调整', hazardAdjustedRounds(2, { weibullShape: 1.0, reliable: true }) === 2)
  check('k=0.95（仍属恒定带）⇒ 不调整', hazardAdjustedRounds(2, { weibullShape: 0.95, reliable: true }) === 2)

  console.log('\n== hazardAdjustedRounds：调整方向与幅度 ==')
  check('k<0.9（成簇）⇒ 下调 1', hazardAdjustedRounds(2, { weibullShape: 0.5, reliable: true }) === 1)
  check('k>1.1（趋于规则）⇒ 上调 1', hazardAdjustedRounds(2, { weibullShape: 1.5, reliable: true }) === 3)
  check('下调有下限 1（confirmRounds=1 时不再降）', hazardAdjustedRounds(1, { weibullShape: 0.5, reliable: true }) === 1)
  check('幅度只有 ±1（不让间接指标主导判断）', hazardAdjustedRounds(5, { weibullShape: 0.3, reliable: true }) === 4)

  console.log('\n== assessConfidence：确定性证据不受形态影响 ==')
  {
    const single = [entry('only')]
    const withCluster: HazardLike = { weibullShape: 0.3, reliable: true }
    const verdict = assessConfidence([], single, { hazardDirection: withCluster })
    check('唯一嫌疑仍第 1 轮行动', verdict.act === true && verdict.evidence === 'deterministic')
    check('required 仍为 1', verdict.required === 1)
  }

  console.log('\n== assessConfidence：成簇时更积极（阈值 2→1）==')
  {
    const suspects = [entry('head'), entry('second')]
    const hist = history(['head'])
    const plain = assessConfidence(hist, suspects, { confirmRounds: 2 })
    const clustered = assessConfidence(hist, suspects, { confirmRounds: 2, hazardDirection: { weibullShape: 0.4, reliable: true } })
    check('无形态：streak=2 ≥ 2 ⇒ 行动', plain.act === true, plain)
    // 用 streak=1 的场景更能看出差异
    const streak1 = assessConfidence([], suspects, { confirmRounds: 2 })
    const streak1Cluster = assessConfidence([], suspects, { confirmRounds: 2, hazardDirection: { weibullShape: 0.4, reliable: true } })
    check('无形态 streak=1/2 ⇒ 观察', streak1.act === false && streak1.required === 2, streak1)
    check('成簇 streak=1/1 ⇒ 行动（阈值下调生效）', streak1Cluster.act === true && streak1Cluster.required === 1, streak1Cluster)
    check('成簇时 label 说明阈值被调整', streak1Cluster.label.includes('阈值'), streak1Cluster.label)
  }

  console.log('\n== assessConfidence：趋于规则时更保守（阈值 2→3）==')
  {
    const suspects = [entry('head'), entry('second')]
    const hist = history(['head']) // streak = 2
    const plain = assessConfidence(hist, suspects, { confirmRounds: 2 })
    const regular = assessConfidence(hist, suspects, { confirmRounds: 2, hazardDirection: { weibullShape: 1.8, reliable: true } })
    check('无形态 streak=2 ⇒ 行动', plain.act === true)
    check('趋于规则 streak=2/3 ⇒ 观察（阈值上调生效）', regular.act === false && regular.required === 3, regular)
  }

  console.log('\n== 兜底升级不受形态影响（安全网优先） ==')
  {
    const suspects = [entry('head'), entry('second')]
    const regular = assessConfidence([], suspects, {
      confirmRounds: 2,
      crashSeq: 3, // 达兜底阈值
      hazardDirection: { weibullShape: 1.8, reliable: true },
    })
    check('即使阈值被上调到 3，crashSeq≥3 仍强制行动', regular.act === true, regular)
  }

  console.log('\n== 无形态时行为与 v0.12 逐位一致（向后兼容） ==')
  {
    const suspects = [entry('head'), entry('second')]
    const a = assessConfidence(history(['head']), suspects, { confirmRounds: 2 })
    const b = assessConfidence(history(['head']), suspects, { confirmRounds: 2, hazardDirection: undefined })
    check('省略 hazardDirection == 显式 undefined', JSON.stringify(a) === JSON.stringify(b), { a, b })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
