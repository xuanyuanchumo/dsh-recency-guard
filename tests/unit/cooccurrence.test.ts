/**
 * 共现信号的采集与验证（v0.13 方向④）的回归。
 *
 * ## 这个模块为什么只做「验证」不做「加权」
 *
 * 研究文档 09 §2.4 判定方向④的**数据基础不存在**（项目没有插件间依赖图），
 * 且共现 ≠ 因果 —— 直接加权会增加误伤，与「宁可漏拦，不可过度拦截」相反。
 * 所以本模块的产出是「能不能加权的**门**」，而不是「加权值」。
 *
 * ## 本测试钉住的重点
 *
 * 1. **诚实边界**：样本不足 ⇒ `undefined`，绝不说成「没有差异」
 *    （那会给「共现无用」提供伪证据）
 * 2. **门是保守的**：达不到门槛一律 `allowed:false` 并给出具体原因
 * 3. **样本上限**：只保留最近 N 条（近期相关性，不让三年前的活跃影响今天）
 */
import {
  appendSample,
  emptyCooccurrenceStore,
  mayWeightByCooccurrence,
  verifyCooccurrence,
  type CooccurrenceSample,
} from '../../src/cooccurrence.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function sample(active: boolean, disabled: boolean, index: number): CooccurrenceSample {
  return {
    at: `2026-11-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    officialActive: active ? ['@deepseek-ai/dsh-experimental-x'] : [],
    suspects: ['third-party-plugin'],
    disabled: disabled ? ['third-party-plugin'] : [],
  }
}

function main() {
  console.log('\n== 空存储：诚实「尚无样本」 ==')
  {
    const store = emptyCooccurrenceStore()
    const verdict = verifyCooccurrence(store)
    check('样本数 0', verdict.samples === 0)
    check('两侧命中率都不可判定', verdict.activeHitRate.value === null && verdict.inactiveHitRate.value === null)
    check('差值不可判定', verdict.hitRateDelta.value === null)
    check('label 说明尚无样本', verdict.label.includes('尚无共现样本'), verdict.label)
    check('门拒绝加权', mayWeightByCooccurrence(verdict).allowed === false)
  }

  console.log('\n== 样本不足：不可判定（不能说成「无差异」）==')
  {
    let store = emptyCooccurrenceStore()
    // 只有 2 条活跃样本 + 1 条不活跃
    store = appendSample(store, sample(true, true, 0))
    store = appendSample(store, sample(true, true, 1))
    store = appendSample(store, sample(false, false, 2))
    const verdict = verifyCooccurrence(store)
    check('活跃样本 2', verdict.activeSamples === 2)
    check('不活跃样本 1', verdict.inactiveSamples === 1)
    check('差值不可判定（样本不足）', verdict.hitRateDelta.value === null, verdict.hitRateDelta)
    check('不可判定原因点明样本数', verdict.hitRateDelta.reason?.includes('至少需') === true, verdict.hitRateDelta.reason)
    check('门拒绝加权', mayWeightByCooccurrence(verdict).allowed === false)
  }

  console.log('\n== 样本充足 + 有明显差异 ⇒ 可能有预测力（但仍不自动加权）==')
  {
    let store = emptyCooccurrenceStore()
    let i = 0
    // 活跃侧：6 条全命中
    for (; i < 6; i += 1) store = appendSample(store, sample(true, true, i))
    // 不活跃侧：6 条全未命中
    for (; i < 12; i += 1) store = appendSample(store, sample(false, false, i))
    const verdict = verifyCooccurrence(store)
    check('活跃命中率 1', verdict.activeHitRate.value === 1, verdict.activeHitRate.value)
    check('不活跃命中率 0', verdict.inactiveHitRate.value === 0, verdict.inactiveHitRate.value)
    check('差值 1.0 可判定', verdict.hitRateDelta.value === 1, verdict.hitRateDelta)
    check('label 说「可能」而非「确定」', verdict.label.includes('可能'), verdict.label)
    const gate = mayWeightByCooccurrence(verdict)
    // 每侧仅 6 条 < MIN*2=10 ⇒ 仍不允许
    check('每侧样本未达 10 ⇒ 门仍拒绝', gate.allowed === false, gate)
    check('门给出具体原因', gate.reason.length > 0)
  }

  console.log('\n== 差异不显著 ⇒ 明确「不应加权」 ==')
  {
    let store = emptyCooccurrenceStore()
    let i = 0
    for (; i < 10; i += 1) store = appendSample(store, sample(true, i % 2 === 0, i))
    for (; i < 20; i += 1) store = appendSample(store, sample(false, i % 2 === 0, i))
    const verdict = verifyCooccurrence(store)
    check('两侧命中率相同（0.5）', verdict.activeHitRate.value === 0.5 && verdict.inactiveHitRate.value === 0.5, {
      a: verdict.activeHitRate.value,
      b: verdict.inactiveHitRate.value,
    })
    check('差值 0', verdict.hitRateDelta.value === 0)
    check('label 明确「不应加权」', verdict.label.includes('不应加权'), verdict.label)
    check('门拒绝', mayWeightByCooccurrence(verdict).allowed === false)
  }

  console.log('\n== 样本上限：只保留最近 N 条 ==')
  {
    let store = emptyCooccurrenceStore()
    for (let i = 0; i < 10; i += 1) store = appendSample(store, sample(true, true, i), 5)
    check('上限 5 生效', store.samples.length === 5, store.samples.length)
    check('保留的是最近的（末条 at 对得上）', store.samples[store.samples.length - 1]?.at === '2026-11-10T00:00:00.000Z', store.samples[store.samples.length - 1])
  }

  console.log('\n== 纯函数：append 不修改原存储 ==')
  {
    const store = emptyCooccurrenceStore()
    const next = appendSample(store, sample(true, true, 0))
    check('原存储不变', store.samples.length === 0)
    check('新存储有 1 条', next.samples.length === 1)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
