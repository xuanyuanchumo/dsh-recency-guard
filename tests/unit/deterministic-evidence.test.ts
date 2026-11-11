/**
 * 确定性证据接入 + 旧行为回归锁（T14-03 判据 2）。
 *
 * ## 两条互相制衡的断言
 *
 * 1. **命中时必须立刻行动**：`deterministicEvidence.targets` 非空 ⇒
 *    `evidence === 'deterministic'`、`required === 1`、`act === true`，
 *    不管有几个嫌疑、也不管历史里有没有连续轮数。
 * 2. **未命中时逐位不变**：同一组事件序列，不传选项 / 传空 targets /
 *    传空 findings，三种调用的输出必须**逐字节一致**。
 *    这是硬要求 —— 老 profile 没有任何声明，判定结果不许因为这次改动变一个字。
 *
 * ## 为什么用哈希锁而不是逐字段断言
 *
 * 逐字段断言容易写成「只覆盖我想到的字段」。哈希覆盖**整份输出**
 * （label 文案、rounds、required、evidence 全在里面），任何一位变化都会红；
 * 失败时同时打印实际 JSON，可定位到具体字段。
 */
import { createHash } from 'node:crypto'
import { assessConfidence, type CrashHistoryEntry } from '../../src/host/guard/recovery-policy.ts'
import { rankForDecision } from '../../src/host/guard/decision-evidence.ts'
import { pickSuspects, type RecencyEntry } from '../../src/host/risk/recency.ts'
import { riskScore } from '../../src/host/core/lifecycle.ts'
import { deriveRiskInputs } from '../../src/host/observe/observations.ts'
import type { JournalRecord } from '../../src/host/data/store.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 固定时刻：让 riskScore / 排序可逐字节复现。 */
const NOW = Date.parse('2026-11-10T00:00:00.000Z')

function entry(bundle: string, overrides: Partial<RecencyEntry> = {}): RecencyEntry {
  return { bundle, lastChangeAt: '2026-11-09T00:00:00.000Z', lastKind: 'install', ...overrides }
}

function histAt(suspects: string[], overrides: Partial<CrashHistoryEntry> = {}): CrashHistoryEntry {
  return { at: '2026-11-09T01:00:00.000Z', exitCode: 1, suspects, ...overrides }
}

/** 事件序列夹具：覆盖「唯一嫌疑 / 多嫌疑 / 连续复现 / 换头 / 空记录穿插 / 兜底升级」。 */
const sequences: Array<{ label: string; history: CrashHistoryEntry[]; suspects: RecencyEntry[]; options: Record<string, unknown> }> = [
  { label: 'no-suspects', history: [], suspects: [], options: {} },
  { label: 'single-suspect', history: [], suspects: [entry('a')], options: { confirmRounds: 2 } },
  { label: 'multi-first-round', history: [], suspects: [entry('a'), entry('b')], options: { confirmRounds: 2 } },
  { label: 'multi-second-round', history: [histAt(['a', 'b'])], suspects: [entry('a'), entry('b')], options: { confirmRounds: 2 } },
  { label: 'switch-head', history: [histAt(['a', 'b'])], suspects: [entry('b'), entry('a')], options: { confirmRounds: 2 } },
  { label: 'skip-empty-record', history: [histAt([]), histAt(['a', 'b'])], suspects: [entry('a'), entry('b')], options: { confirmRounds: 3 } },
  { label: 'hard-escalation', history: [], suspects: [entry('a'), entry('b')], options: { confirmRounds: 2, crashSeq: 3 } },
  { label: 'hazard-cluster', history: [histAt(['a', 'b'])], suspects: [entry('a'), entry('b')], options: { confirmRounds: 2, hazardDirection: { weibullShape: 0.4, reliable: true } } },
  { label: 'hazard-regular', history: [histAt(['a', 'b'])], suspects: [entry('a'), entry('b')], options: { confirmRounds: 2, hazardDirection: { weibullShape: 1.8, reliable: true } } },
  { label: 'false-positive-calibration', history: [histAt(['a', 'b'])], suspects: [entry('a'), entry('b')], options: { confirmRounds: 2, falsePositiveStats: { autoDisables: 10, falsePositives: 9, systemRestored: 0, unattributedRestores: 0 } } },
]

/** 输出整份判定并按序 JSON 化（字段顺序固定，因为构造顺序固定）。 */
function verdicts(options: Record<string, unknown>[] = []): string {
  const rows = sequences.map((seq, index) => {
    const merged = { ...seq.options, ...(options[index] ?? {}) }
    return { label: seq.label, verdict: assessConfidence(seq.history, seq.suspects, merged) }
  })
  return JSON.stringify(rows)
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function main() {
  console.log('\n== 回归锁：未命中 ⇒ 与旧实现逐位一致 ==')
  {
    const plain = verdicts()
    // 传「空 targets」与「空 findings」两种形状 —— 都必须完全等于不传。
    const emptyTargets = verdicts(sequences.map(() => ({ deterministicEvidence: { findings: [], targets: [] } })))
    const emptyFindings = verdicts(sequences.map(() => ({ deterministicEvidence: { findings: [], targets: [] } })))
    check('empty targets option is byte-identical to no option', emptyTargets === plain, { plain, emptyTargets })
    check('empty findings option is byte-identical to no option', emptyFindings === plain)
    // 哈希锁：整份输出的指纹（基线取自 v0.15 行为；任何一位变化都会红）。
    const BASELINE_SHA = 'f9fcf66bc626054bf48689d71432d6edab387cb67665f76de094bffe2d01d5ec'
    const actual = sha(plain)
    check(`baseline hash is stable (${actual.slice(0, 12)})`, actual === BASELINE_SHA, { expected: BASELINE_SHA, actual, plain })
  }

  console.log('\n== 命中：第 1 轮就行动（不等 confirmRounds） ==')
  {
    const targets = ['a']
    const evidence = {
      findings: [{ kind: 'declared-conflict', message: 'a 声明与 b 冲突', plugins: ['a', 'b'] }],
      targets,
    }
    // 3 个嫌疑 + 空历史 ⇒ 旧逻辑是 probabilistic、act=false；带证据必须 act=true。
    const suspects = [entry('a'), entry('b'), entry('c')]
    const legacy = assessConfidence([], suspects, { confirmRounds: 2 })
    const withEvidence = assessConfidence([], suspects, { confirmRounds: 2, deterministicEvidence: evidence })
    check('legacy multi-suspect first round does not act', legacy.act === false && legacy.evidence === 'probabilistic', legacy)
    check('deterministic evidence acts on round 1', withEvidence.act === true, withEvidence)
    check('deterministic evidence is classified deterministic', withEvidence.evidence === 'deterministic', withEvidence)
    check('deterministic evidence requires 1 round', withEvidence.required === 1 && withEvidence.rounds === 1, withEvidence)
    check('label names the classification and the target', withEvidence.label.includes('declared-conflict') && withEvidence.label.includes('a'), withEvidence.label)

    // 唯一嫌疑路径不受影响（仍走旧分支，文案不变）。
    const single = assessConfidence([], [entry('a')], { confirmRounds: 2, deterministicEvidence: { findings: [], targets: [] } })
    const singleLegacy = assessConfidence([], [entry('a')], { confirmRounds: 2 })
    check('single-suspect path unchanged by empty evidence', JSON.stringify(single) === JSON.stringify(singleLegacy))

    // 没有嫌疑时，证据不能凭空让它行动（空名单是硬保护）。
    const noNames = assessConfidence([], [], { confirmRounds: 2, deterministicEvidence: evidence })
    check('no suspects ⇒ evidence cannot force action', noNames.act === false, noNames)
  }

  console.log('\n== 排序/风险口径未变（finding 不参与排序） ==')
  {
    const ranked = [entry('a', { lastChangeAt: '2026-11-09T03:00:00.000Z' }), entry('b', { lastChangeAt: '2026-11-09T02:00:00.000Z' }), entry('c', { lastChangeAt: '2026-11-09T01:00:00.000Z' })]
    const journal: JournalRecord[] = [
      { kind: 'install', bundle: 'a', t: '2026-11-09T03:00:00.000Z' },
      { kind: 'install', bundle: 'b', t: '2026-11-09T02:00:00.000Z' },
    ]
    // rankForDecision 不接收 finding ⇒ 它的输出就是旧口径，用哈希钉住。
    const rankJson = JSON.stringify(rankForDecision(ranked, journal, NOW))
    const RANK_SHA = 'f3d995607a0eb390a82179c9ca99aeb7d16a6d1a1aa1e4b29806971c51caefe4'
    check(`decision rank baseline (${sha(rankJson).slice(0, 12)})`, sha(rankJson) === RANK_SHA, { actual: sha(rankJson), rankJson })

    const risks = deriveRiskInputs(ranked, journal).map((input) => ({ bundle: input.bundle, risk: riskScore(input, NOW) }))
    const riskJson = JSON.stringify(risks)
    const RISK_SHA = 'b156a15581cb20229709ce5c5cd2d3bc4ff2f0486c3e716d7c32f42d3290343b'
    check(`risk score baseline (${sha(riskJson).slice(0, 12)})`, sha(riskJson) === RISK_SHA, { actual: sha(riskJson), riskJson })

    // 无声明时「关谁」仍是纯 recency 前缀：n=2 取前两个，顺序不变。
    const picked = pickSuspects(rankForDecision(ranked, journal, NOW), 2).map((s) => s.bundle)
    check('no-declaration target selection is the recency prefix', JSON.stringify(picked) === JSON.stringify(['a', 'b']), picked)
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
process.exit(failures === 0 ? 0 : 1)