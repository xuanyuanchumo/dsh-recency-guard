/**
 * 误伤反馈闭环（v0.14 / M1 / RQ2，研究文档 07 §3）的回归。
 *
 * 本测试钉四件事，每件都对应 07 §3.3 的一条诚实边界：
 *
 * 1. **样本不足 ⇒ `defined:false` + `value:null`**：绝不把「还没人撤销过」
 *    读成「误伤率 0%」（Metric 契约，见 observability.ts 头注）。
 * 2. **区分证据来源**：「用户主动 reenable」是证据；「系统自动恢复」不是。
 *    这是本任务最容易做错的地方 —— journal 里两者都是 `kind: 'enable'`，
 *    唯一差别是系统恢复那一段**被一条 `restore` 收尾**。
 * 3. **样本充足时阈值收敛**：误伤率被足够样本证伪 ⇒ 回到基线；
 *    误伤率超线 ⇒ 上调，且**只升不降**（永不增加误伤）。
 * 4. **解释文案可读**：面板要能显示「本轮为何提高阈值」，不做黑盒。
 *
 * 另有一节专门钉**向后兼容**：不传 `falsePositiveStats` 时
 * `assessConfidence` 必须与 v0.13.0 逐位一致 —— 这是硬要求，
 * 用「显式 undefined vs 省略」的 JSON 逐字节比对作为机器门。
 */
import {
  CALIBRATION_MIN_SAMPLES,
  FALSE_POSITIVE_SEVERE,
  FALSE_POSITIVE_TARGET,
  MAX_CALIBRATED_ROUNDS,
  calibratedConfirmRounds,
  calibrationExplanation,
  falsePositiveRate,
  falsePositiveSamples,
  wilsonInterval,
  type FalsePositiveStats,
} from '../../src/risk-calibration.js'
import { assessConfidence, type CrashHistoryEntry } from '../../src/recovery-policy.js'
import type { RecencyEntry } from '../../src/recency.js'
import type { JournalRecord } from '../../src/store.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 构造一条 journal 记录（只填本模块关心的字段）。 */
function rec(kind: JournalRecord['kind'], extra: Record<string, unknown> = {}, t = '2026-11-01T00:00:00.000Z'): JournalRecord {
  return { kind, t, ...extra } as JournalRecord
}

/** 自动关闭记录（`disable` + `detail: 'auto-recency'` —— 生产路径就是长这样）。 */
function autoDisable(bundle: string, t: string): JournalRecord {
  return rec('disable', { bundle, detail: 'auto-recency' }, t)
}

/** 用户主动放行（孤立 enable，后面没有 restore 收尾）。 */
function userReenable(bundle: string, t: string): JournalRecord {
  return rec('enable', { bundle }, t)
}

/** 系统自动恢复的一段（连续 enable + 一条 restore 收尾）。 */
function systemRestore(bundles: string[], t: string): JournalRecord[] {
  return [...bundles.map((bundle) => rec('enable', { bundle }, t)), rec('restore', { detail: '重新启用 x' }, t)]
}

function stats(over: Partial<FalsePositiveStats> = {}): FalsePositiveStats {
  return { falsePositives: 0, autoDisables: 0, systemRestored: 0, unattributed: 0, samples: [], ...over }
}

function entry(bundle: string): RecencyEntry {
  return { bundle, lastChangeAt: '2026-11-07T00:00:00.000Z', lastKind: 'update' }
}

function histAt(suspects: string[]): CrashHistoryEntry {
  return { at: '2026-11-07T00:00:00.000Z', exitCode: 1, suspects }
}

function main() {
  // ───────────────────────────────────────────────────────────────
  console.log('\n== wilsonInterval：小样本不许假装确定 ==')
  {
    // 0/10：点估计 0，但上界仍 27.8% —— Wilson 承认样本薄。
    const zeroOf10 = wilsonInterval(0, 10)
    check('0/10 点估计为 0', zeroOf10.point === 0, zeroOf10)
    check('0/10 上界仍显著大于 0（不把无证据当零风险）', zeroOf10.upper > 0.25, zeroOf10)
    check('0/10 下界钳到 0', zeroOf10.lower === 0, zeroOf10)
    // 5/10
    const half = wilsonInterval(5, 10)
    check('5/10 点估计 0.5', half.point === 0.5, half)
    check('5/10 区间包含点估计', half.lower < half.point && half.point < half.upper, half)
    // n=10 的上界必须比 n=30 宽（样本越多越锐）
    check('n=10 上界宽于 n=30（样本量进入判据）', wilsonInterval(0, 10).upper > wilsonInterval(0, 30).upper)
    // 无信息边界：n=0 ⇒ [0,1]，不是 [0,0]
    const empty = wilsonInterval(0, 0)
    check('n=0 ⇒ 退化为 [0,1]（完全无信息，而非零宽）', empty.lower === 0 && empty.upper === 1, empty)
    // 非法输入不产生 NaN/Infinity
    const junk = wilsonInterval(Number.NaN, Number.NaN)
    check('非法输入 ⇒ 有限值', Number.isFinite(junk.point) && Number.isFinite(junk.lower) && Number.isFinite(junk.upper), junk)
    // successes 超过 total 必须被钳（否则 p̂ > 1）
    const over = wilsonInterval(9, 5)
    check('successes > total 被钳制（p̂ ≤ 1）', over.point <= 1 && over.upper <= 1, over)
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n== falsePositiveRate：样本不足 ⇒ defined:false + value:null ==')
  {
    const none = falsePositiveRate(stats())
    check('无自动关闭 ⇒ 不可判定', none.defined === false)
    check('无自动关闭 ⇒ value 为 null（不是 0）', none.value === null)
    check('无自动关闭的 reason 提到分母', (none.reason ?? '').includes('分母'), none.reason)

    // n=4 且 fp=0：仍不可判定 —— 这是最容易被写成「误伤率 0%」的伪读数。
    const few = falsePositiveRate(stats({ autoDisables: 4, falsePositives: 0 }))
    check('n=4 < 5 ⇒ 不可判定（不报 0%）', few.defined === false && few.value === null, few)
    check('n=4 的 label 明示样本不足', few.label.includes('样本不足'), few.label)

    // 阈值边界：正好 n=5 才可判定。
    const gate = falsePositiveRate(stats({ autoDisables: CALIBRATION_MIN_SAMPLES, falsePositives: 0 }))
    check('n=5 = 门槛 ⇒ 可判定', gate.defined === true && gate.value !== null, gate)
    check('n=5, fp=0 ⇒ 误伤率 0', gate.value?.rate === 0, gate.value)

    // 可判定时区间被带上（面板要显示「这个数有多不靠谱」）。
    const withFp = falsePositiveRate(stats({ autoDisables: 20, falsePositives: 3 }))
    check('n=20, fp=3 ⇒ 点估计 0.15', withFp.value?.rate === 0.15, withFp.value)
    check('可判定时带 Wilson 区间', (withFp.value?.lower ?? 1) < 0.15 && (withFp.value?.upper ?? 0) > 0.15, withFp.value)
    check('可判定时 label 含区间与样本量', withFp.label.includes('20') && withFp.label.includes('区间'), withFp.label)
    check('可判定时 confidence 来自 sampleConfidence', (withFp.confidence ?? 0) > 0, withFp)
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n== falsePositiveSamples：用户主动 reenable 计入 ==')
  {
    // 关 A → 用户手动开 A（没有 restore 收尾）⇒ 一次误伤。
    const journal = [
      autoDisable('a', '2026-11-01T00:00:00.000Z'),
      userReenable('a', '2026-11-02T00:00:00.000Z'),
    ]
    const s = falsePositiveSamples(journal)
    check('用户主动放行 ⇒ 误伤 +1', s.falsePositives === 1, s)
    check('自动关闭计入分母', s.autoDisables === 1, s)
    check('系统恢复计数为 0', s.systemRestored === 0, s)
    check('样本带两条时戳（可回放）', s.samples[0]?.autoDisabledAt === '2026-11-01T00:00:00.000Z' && s.samples[0]?.reenabledAt === '2026-11-02T00:00:00.000Z', s.samples[0])
    check('样本记下被误关的 bundle', s.samples[0]?.bundle === 'a', s.samples[0])
  }

  console.log('\n== falsePositiveSamples：系统自动恢复**不**计入（07 §3.3 核心）==')
  {
    // 系统恢复的真实形态：restoreDisabledExceptPrime 逐个 reenableOne（各写一条
    // enable）后写一条 restore。这一段是常规流程，不是误伤证据。
    const journal = [
      autoDisable('a', '2026-11-01T00:00:00.000Z'),
      autoDisable('b', '2026-11-01T00:00:01.000Z'),
      ...systemRestore(['a', 'b'], '2026-11-02T00:00:00.000Z'),
    ]
    const s = falsePositiveSamples(journal)
    check('系统自动恢复 ⇒ 误伤 0（不计入证据）', s.falsePositives === 0, s)
    check('系统自动恢复 ⇒ 单独计数（面板可见，口径透明）', s.systemRestored === 2, s)
    check('系统恢复不产生误伤样本', s.samples.length === 0, s.samples)
    check('分母仍是 2（自动关闭本身照算）', s.autoDisables === 2, s)
    // 归因正确性：系统恢复消费掉了那次关闭，所以后续不会被误配。
    check('无人被记为 unattributed', s.unattributed === 0, s)
  }

  console.log('\n== falsePositiveSamples：同段混排时判来源的边界 ==')
  {
    // enable 段被 restore 收尾 ⇒ 整段是系统恢复（无论中间夹了几条）。
    const allSystem = falsePositiveSamples([
      autoDisable('a', 't1'),
      autoDisable('b', 't2'),
      ...systemRestore(['a', 'b'], 't3'),
    ])
    check('一段 2 条 enable + restore ⇒ 全判系统', allSystem.falsePositives === 0 && allSystem.systemRestored === 2, allSystem)

    // 系统恢复之后再出现独立的 enable ⇒ 那是用户主动（新的一段）。
    const mixed = falsePositiveSamples([
      autoDisable('a', 't1'),
      ...systemRestore(['a'], 't2'),
      autoDisable('a', 't3'),
      userReenable('a', 't4'),
    ])
    check('系统恢复后再用户放行 ⇒ 记 1 次误伤', mixed.falsePositives === 1, mixed)
    check('同一次关闭不会被两次消费（误伤不虚高）', mixed.falsePositives <= mixed.autoDisables, mixed)
    check('系统恢复仍单独计数', mixed.systemRestored === 1, mixed)

    // 用户的 enable 后面**跟了**别的事件再出现 restore：不构成配对 ⇒ 仍是用户证据。
    const separated = falsePositiveSamples([
      autoDisable('a', 't1'),
      userReenable('a', 't2'),
      rec('note', { detail: '无关记录' }, 't3'),
      rec('restore', { detail: 'x' }, 't4'),
    ])
    check('enable 与 restore 之间被别的事件打断 ⇒ 判用户主动', separated.falsePositives === 1, separated)
  }

  console.log('\n== falsePositiveSamples：归因边界（不虚高误伤率）==')
  {
    // 用户 enable 了一个 guard 从没关过的插件 ⇒ 不是误伤证据。
    const unattributed = falsePositiveSamples([userReenable('never-disabled', 't1')])
    check('无对应自动关闭 ⇒ 不计误伤', unattributed.falsePositives === 0, unattributed)
    check('无对应自动关闭 ⇒ 记 unattributed（口径透明）', unattributed.unattributed === 1, unattributed)

    // 用户自己手动关的（detail: 'manual'）不算 guard 的自动关闭：不进分母。
    const manual = falsePositiveSamples([
      rec('disable', { bundle: 'x', detail: 'manual' }, 't1'),
      userReenable('x', 't2'),
    ])
    check('manual 关闭不进分母（不稀释误伤率）', manual.autoDisables === 0, manual)
    check('manual 关闭后的 enable 不计误伤', manual.falsePositives === 0, manual)

    // `kind: 'auto-disable'` 也算自动关闭（两条历史 kind 都要认）。
    const legacy = falsePositiveSamples([
      rec('auto-disable', { bundle: 'y' }, 't1'),
      userReenable('y', 't2'),
    ])
    check('kind=auto-disable 也计入分母', legacy.autoDisables === 1 && legacy.falsePositives === 1, legacy)

    // 空输入 / 非法输入不抛异常。
    const empty = falsePositiveSamples([])
    check('空 journal ⇒ 全零（不抛异常）', empty.autoDisables === 0 && empty.falsePositives === 0, empty)
    const junk = falsePositiveSamples(undefined as unknown as JournalRecord[])
    check('undefined journal ⇒ 全零（不抛异常）', junk.autoDisables === 0, junk)
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n== calibratedConfirmRounds：样本不足的保守方向 ==')
  {
    // 从没自动关过 ⇒ 不动。没有数据不能推出任何调整方向。
    const none = calibratedConfirmRounds(2, stats())
    check('无样本 ⇒ 维持基线 2 轮', none.required === 2 && none.delta === 0, none)
    check('无样本 ⇒ kind=hold-insufficient', none.kind === 'hold-insufficient', none.kind)
    check('无样本 ⇒ rate 不可判定', none.rate.defined === false && none.rate.value === null, none.rate)

    // n<5 且 fp=0 ⇒ 不动（把「样本薄」当「高风险」会白降检出率）。
    const thin = calibratedConfirmRounds(2, stats({ autoDisables: 3, falsePositives: 0 }))
    check('n=3, fp=0 ⇒ 不上调（无数据 ≠ 高风险）', thin.required === 2, thin)

    // n<5 但已有撤销 ⇒ 直接证据，保守 +1（不能因为样本薄就无视用户的撤销）。
    const thinFp = calibratedConfirmRounds(2, stats({ autoDisables: 3, falsePositives: 1 }))
    check('n=3, fp=1 ⇒ 上调 1 轮', thinFp.required === 3 && thinFp.delta === 1, thinFp)
    check('样本不足的上调也算 raise-insufficient 类', thinFp.kind === 'raise-insufficient', thinFp.kind)
    check('样本不足的上调幅度封在 +1（不外推比率）', thinFp.delta === 1, thinFp)
  }

  console.log('\n== calibratedConfirmRounds：样本充足时收敛/上调 ==')
  {
    // 足够样本 + 从未撤销 ⇒ 正面证据，回到基线（收敛）。
    const clean = calibratedConfirmRounds(3, stats({ autoDisables: 20, falsePositives: 0 }))
    check('n=20 全清白 ⇒ 回到基线 3 轮（delta=0）', clean.required === 3 && clean.delta === 0, clean)
    check('收敛类为 hold-rate', clean.kind === 'hold-rate', clean.kind)

    // 误伤率低于目标线 ⇒ 仍回到基线。
    const below = calibratedConfirmRounds(3, stats({ autoDisables: 30, falsePositives: 3 })) // 10%
    check('观测误伤率 10% ≤ 15% ⇒ 维持基线', below.required === 3 && below.delta === 0, below)

    // 误伤率超过目标线（但不到严重线）⇒ +1。
    const over = calibratedConfirmRounds(2, stats({ autoDisables: 20, falsePositives: 5 })) // 25%
    check('观测误伤率 25% > 15% ⇒ 上调 1 轮', over.required === 3 && over.delta === 1, over)
    check('上调类为 raise-rate', over.kind === 'raise-rate', over.kind)

    // 误伤率超过严重线 ⇒ +2。
    const severe = calibratedConfirmRounds(2, stats({ autoDisables: 10, falsePositives: 5 })) // 50%
    check('观测误伤率 50% > 35% ⇒ 上调 2 轮', severe.required === 4 && severe.delta === 2, severe)

    // 目标线边界：恰好 15% 不算超（≤ 判据），20% 才算。
    const atLine = calibratedConfirmRounds(2, stats({ autoDisables: 20, falsePositives: 3 }))
    check('恰好 15% ⇒ 不上调（≤ 目标线）', atLine.delta === 0, atLine)
    // 两条线都是对外常量（面板要显示「超过哪条线」），所以直接钉住它们的值：
    // 改常量必须同时改文档与测试，不能悄悄漂移。
    check(`目标线常量 = 15%（当前 ${FALSE_POSITIVE_TARGET}）`, FALSE_POSITIVE_TARGET === 0.15)
    check(`严重线常量 = 35%（当前 ${FALSE_POSITIVE_SEVERE}）`, FALSE_POSITIVE_SEVERE === 0.35)
    // 边界两侧各取一个样本，证明判据用的是「> 线」而不是「≥ 线」。
    const justOverTarget = calibratedConfirmRounds(2, stats({ autoDisables: 20, falsePositives: 4 })) // 20%
    check('刚过目标线 ⇒ +1（用来确认边界不是 ≥）', justOverTarget.delta === 1, justOverTarget)
    const justOverSevere = calibratedConfirmRounds(2, stats({ autoDisables: 20, falsePositives: 8 })) // 40%
    check('刚过严重线 ⇒ +2', justOverSevere.delta === 2, justOverSevere)

    // 只升不降：极低误伤率也**不会**把基线降下来。
    const neverLower = calibratedConfirmRounds(3, stats({ autoDisables: 100, falsePositives: 0 }))
    check('只升不降：清白样本不会穿透基线', neverLower.required === 3 && neverLower.delta === 0, neverLower)
    check('delta 永不为负', neverLower.delta >= 0, neverLower.delta)
  }

  console.log('\n== calibratedConfirmRounds：上限与钳制 ==')
  {
    // base=4 且严重误伤 ⇒ 已在上限，不再上调，但必须如实说明。
    const capped = calibratedConfirmRounds(MAX_CALIBRATED_ROUNDS, stats({ autoDisables: 10, falsePositives: 9 }))
    check(`base=${MAX_CALIBRATED_ROUNDS} 已到上限 ⇒ required 不变`, capped.required === MAX_CALIBRATED_ROUNDS, capped)
    check('撞上限时解释里说明「已达上限」', capped.explanation.includes('上限'), capped.explanation)

    // base 高于常量上限 ⇒ 上限跟着抬高，绝不把它压回去。
    const above = calibratedConfirmRounds(6, stats({ autoDisables: 10, falsePositives: 9 }))
    check('base=6 > MAX ⇒ 保持 6（不被压回）', above.required === 6 && above.delta === 0, above)

    // 非法 base ⇒ 钳到 1。
    check('base=0 ⇒ 钳到 1', calibratedConfirmRounds(0, stats()).base === 1)
    check('base=NaN ⇒ 钳到 1', calibratedConfirmRounds(Number.NaN, stats()).base === 1)
    check('base=-5 ⇒ 钳到 1', calibratedConfirmRounds(-5, stats()).base === 1)
    // 小数 base ⇒ 取整（阈值必须是整数轮）。
    check('base=2.7 ⇒ 取整为 2', calibratedConfirmRounds(2.7, stats()).base === 2)

    // 负数的 fp/n 不得产生负 delta 或怪异结果。
    const negative = calibratedConfirmRounds(2, stats({ autoDisables: -3, falsePositives: -1 }))
    check('负数样本 ⇒ 不产生负 delta', negative.delta >= 0 && negative.required >= 2, negative)
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n== calibrationExplanation：人话可读（07 §3.3 不做黑盒）==')
  {
    const raised = calibratedConfirmRounds(2, stats({ autoDisables: 10, falsePositives: 5 }))
    const text = calibrationExplanation(raised)
    check('解释写明调整方向（2 → 4）', text.includes('2 → 4'), text)
    check('解释含「误伤率」字样', text.includes('误伤率'), text)
    check('解释给出观测比率（5/10）', text.includes('5/10'), text)
    check('解释说明口径：系统自动恢复不计入', text.includes('系统自动恢复不计入') || text.includes('不计入证据'), text)
    check('解释不是空串', text.length > 30, text.length)

    const held = calibratedConfirmRounds(2, stats({ autoDisables: 20, falsePositives: 0 }))
    const heldText = calibrationExplanation(held)
    check('维持时解释写明「维持基线」', heldText.includes('维持基线'), heldText)

    // 不可判定时必须如实说不可判定，不能编一个数字。
    const noData = calibratedConfirmRounds(2, stats())
    const noDataText = calibrationExplanation(noData)
    check('不可判定时解释明说「不可判定」', noDataText.includes('不可判定'), noDataText)
    check('不可判定时解释不出现伪造的百分比', !/\d+\.\d%/.test(noDataText), noDataText)
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n== assessConfidence 接入：向后兼容（不传 ⇒ 与 v0.13 逐位一致）==')
  {
    const suspects = [entry('head'), entry('second')]
    const history = [histAt(['head'])]
    const legacy = assessConfidence(history, suspects, { confirmRounds: 2 })
    const explicitUndef = assessConfidence(history, suspects, { confirmRounds: 2, falsePositiveStats: undefined })
    check('省略 falsePositiveStats == 显式 undefined', JSON.stringify(legacy) === JSON.stringify(explicitUndef), { legacy, explicitUndef })

    // 唯一嫌疑与空名单两条提前返回路径也必须逐位一致（校准不参与确定性证据）。
    const solo = assessConfidence([], [entry('only')], {})
    const soloWithStats = assessConfidence([], [entry('only')], {
      falsePositiveStats: stats({ autoDisables: 10, falsePositives: 9 }),
    })
    check('唯一嫌疑：带误伤样本也不改变确定性判定', JSON.stringify(solo) === JSON.stringify(soloWithStats), { solo, soloWithStats })

    const emptyCase = assessConfidence([], [], {})
    const emptyWithStats = assessConfidence([], [], { falsePositiveStats: stats({ autoDisables: 10, falsePositives: 9 }) })
    check('空名单：带误伤样本行为一致', JSON.stringify(emptyCase) === JSON.stringify(emptyWithStats), { emptyCase, emptyWithStats })

    // 无样本时，接入点的输出必须与不传完全一致（这是最常见的线上形态）。
    const noData = assessConfidence(history, suspects, { confirmRounds: 2, falsePositiveStats: stats() })
    check('传入空样本 ⇒ 与 v0.13 输出逐位一致', JSON.stringify(noData) === JSON.stringify(legacy), { noData, legacy })
  }

  console.log('\n== assessConfidence 接入：误伤反馈抬阈值 ==')
  {
    const suspects = [entry('head'), entry('second')]
    // streak = 2。基线 2 轮 ⇒ v0.13 会动手；校准到 3 轮后应转为观察。
    const history = [histAt(['head'])]
    const raised = assessConfidence(history, suspects, {
      confirmRounds: 2,
      falsePositiveStats: stats({ autoDisables: 20, falsePositives: 5 }), // 25% ⇒ +1
    })
    check('误伤校准后 required 变为 3', raised.required === 3, raised)
    check('streak=2 < 3 ⇒ 本轮只观察（误伤更少）', raised.act === false, raised)
    check('label 说明阈值被误伤反馈调整', raised.label.includes('误伤反馈'), raised.label)
    check('label 仍带 streak 进度（2/3）', raised.label.includes('2/3'), raised.label)

    // 严重误伤 ⇒ +2 ⇒ 4 轮；streak=3 之前都不动手。
    const severe = assessConfidence([histAt(['head']), histAt(['head'])], suspects, {
      confirmRounds: 2,
      falsePositiveStats: stats({ autoDisables: 10, falsePositives: 5 }), // 50% ⇒ +2
    })
    check('严重误伤 ⇒ required 4', severe.required === 4, severe)
    check('streak=3 < 4 ⇒ 仍观察', severe.act === false, severe)

    // 故障确实持续时，抬阈值只是延后一轮，不是不救。
    const persists = assessConfidence([histAt(['head']), histAt(['head'])], suspects, {
      confirmRounds: 2,
      falsePositiveStats: stats({ autoDisables: 20, falsePositives: 5 }), // +1 ⇒ 3
    })
    check('streak=3 ≥ 3 ⇒ 达阈值动手（不是不救）', persists.act === true, persists)
  }

  console.log('\n== assessConfidence 接入：兜底升级不被误伤校准削弱 ==')
  {
    const suspects = [entry('head'), entry('second')]
    // 校准把阈值抬到 4，但 crashSeq ≥ 3 的兜底必须仍然强制动手。
    const verdict = assessConfidence([], suspects, {
      confirmRounds: 2,
      crashSeq: 3,
      falsePositiveStats: stats({ autoDisables: 10, falsePositives: 5 }), // +2 ⇒ 4
    })
    check('阈值被抬到 4', verdict.required === 4, verdict)
    check('crashSeq≥3 仍强制行动（安全网优先）', verdict.act === true, verdict)
    check('兜底文案说明是安全网', verdict.label.includes('兜底升级'), verdict.label)
  }

  console.log('\n== assessConfidence 接入：与形态调节叠加的顺序 ==')
  {
    const suspects = [entry('head'), entry('second')]
    // 形态：k>1.1 ⇒ 基线上调 1（2→3）；误伤：25% ⇒ 再 +1（3→4）。
    // 顺序是 形态 → 校准，且校准以形态调节后的值为基线。
    const stacked = assessConfidence([histAt(['head'])], suspects, {
      confirmRounds: 2,
      hazardDirection: { weibullShape: 1.8, reliable: true }, // ⇒ 3
      falsePositiveStats: stats({ autoDisables: 20, falsePositives: 5 }), // ⇒ 3 + 1 = 4
    })
    check('形态 + 误伤叠加 ⇒ 4 轮', stacked.required === 4, stacked)
    check('叠加后 label 同时说明两者', stacked.label.includes('分布形态') && stacked.label.includes('误伤反馈'), stacked.label)

    // 只有形态、没有误伤样本 ⇒ 与 v0.13 行为一致（3 轮）。
    const hazardOnly = assessConfidence([histAt(['head'])], suspects, {
      confirmRounds: 2,
      hazardDirection: { weibullShape: 1.8, reliable: true },
    })
    check('仅形态 ⇒ 3 轮（v0.13 行为不变）', hazardOnly.required === 3, hazardOnly)
  }

  // ───────────────────────────────────────────────────────────────
  console.log('\n== 端到端：journal → 样本 → 阈值（真实链路）==')
  {
    // 12 次自动关闭，其中 2 次被用户主动放行、8 次由系统恢复 ⇒ 误伤率 2/12 ≈ 16.7%。
    const journal: JournalRecord[] = []
    for (let i = 0; i < 12; i += 1) journal.push(autoDisable(`p${i}`, `2026-11-01T00:00:0${i}.000Z`))
    journal.push(...systemRestore(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], '2026-11-02T00:00:00.000Z'))
    journal.push(userReenable('p8', '2026-11-03T00:00:00.000Z'))
    journal.push(userReenable('p9', '2026-11-03T00:00:01.000Z'))

    const s = falsePositiveSamples(journal)
    check('端到端：分母 12', s.autoDisables === 12, s)
    check('端到端：误伤 2（系统恢复的 8 次未计入）', s.falsePositives === 2, s)
    check('端到端：系统恢复计数 8', s.systemRestored === 8, s)

    const rate = falsePositiveRate(s)
    check('端到端：误伤率可判定', rate.defined === true, rate)
    // 内部值统一 4 位小数（observability.ts 的位数纪律），所以比对也要按 4 位取整。
    check(
      '端到端：误伤率 ≈ 16.7%（2/12）',
      Math.abs((rate.value?.rate ?? 0) - Math.round((2 / 12) * 10000) / 10000) < 1e-9,
      rate.value,
    )

    const decision = calibratedConfirmRounds(2, s)
    check('端到端：16.7% > 15% ⇒ 上调 1 轮', decision.required === 3 && decision.delta === 1, decision)

    // 对照组：如果朴素做法把「所有 enable」都当误伤，同一份 journal 会得到
    // 10/12 = 83% 的假严重误伤率，把阈值无谓抬到 4 轮。这正是 07 §3.3
    // 「不区分来源就会误判」的机器证明 —— 也是本任务最容易做错的地方。
    const naiveStats = stats({ autoDisables: 12, falsePositives: 10 })
    const naiveDecision = calibratedConfirmRounds(2, naiveStats)
    check('对照：朴素计数（enable 全算误伤）= 83% ⇒ 阈值 4', naiveDecision.required === 4, naiveDecision)
    check('对照：本模块口径更保守（3 轮 < 朴素 4 轮）', decision.required < naiveDecision.required, {
      ours: decision.required,
      naive: naiveDecision.required,
    })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
