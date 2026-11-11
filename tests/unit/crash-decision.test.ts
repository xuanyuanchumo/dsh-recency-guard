/**
 * 崩溃决策组装（T14-03 判据 2/3/4 的接线层）。
 *
 * `composeCrashDecision` 是「排名 / 历史 / finding / 依赖图 → 决策」的纯函数，
 * 也是崩溃路径与 recovery 计划器**共享语义**的地方。这里钉三条：
 *
 * 1. **未命中声明 ⇒ 目标 = recency 前缀**（与旧行为逐位一致）；
 * 2. **命中 ⇒ 目标是计划结果**，且判定是 deterministic / required=1；
 * 3. **命中但全部受保护 ⇒ 计划为空、残余上屏、判定不为确定性**（不假装解决）。
 * 另测依赖联动：关掉被依赖者时目标里必须连带依赖者。
 */
import { composeCrashDecision, verdictPatch } from '../../src/host/guard/crash-decision.ts'
import type { CandidatePlugin } from '../../src/host/guard/quarantine-plan.ts'
import type { ConflictFinding } from '../../src/host/guard/conflict-metadata.ts'
import type { RecencyEntry } from '../../src/host/risk/recency.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function entry(bundle: string, index: number): RecencyEntry {
  return { bundle, lastChangeAt: `2026-11-0${9 - index}T00:00:00.000Z`, lastKind: 'install' }
}

function candidate(name: string, index: number, opts: Partial<CandidatePlugin> = {}): CandidatePlugin {
  return { name, enabled: true, index, ...opts }
}

function finding(kind: ConflictFinding['kind'], plugins: string[], severity: ConflictFinding['severity'] = 'error'): ConflictFinding {
  return {
    kind,
    severity,
    plugins,
    message: `${kind} on ${plugins.join(',')}`,
    source: { file: '/fake/package.json', line: 4 },
    declaration: '{"stub":true}',
  }
}

/** 默认输入：3 个嫌疑，无声明。 */
function baseInput(overrides: Record<string, unknown> = {}) {
  const ranked = [entry('a', 1), entry('b', 2), entry('c', 3)]
  return {
    seq: 1,
    maxAutoDisable: 2,
    confirmRounds: 2,
    ranked,
    candidates: ranked.map((r, index) => candidate(r.bundle, index)),
    findings: [] as ConflictFinding[],
    history: [],
    envChanged: false,
    ...overrides,
  }
}

function main() {
  console.log('\n== 未命中声明：recency 前缀（旧行为） ==')
  {
    const result = composeCrashDecision(baseInput())
    check('no findings ⇒ plan is empty', result.plan.quarantine.length === 0, result.plan)
    check('no findings ⇒ no deterministic evidence', result.deterministicEvidence === undefined)
    check('no findings ⇒ targets are the recency prefix (n = min(crashSeq, cap))', JSON.stringify(result.targets.map((t) => t.bundle)) === '["a"]', result.targets)
    // 第 2 次崩溃 ⇒ n=2（旧口径：N 由崩溃次数决定，不因多嫌疑而变）。
    const second = composeCrashDecision(baseInput({ seq: 2 }))
    check('second crash ⇒ two targets', JSON.stringify(second.targets.map((t) => t.bundle)) === '["a","b"]', second.targets)
    check('no findings ⇒ unresolved empty', result.unresolved.length === 0)
    // 唯一嫌疑是确定性证据（旧分支），但证据形状里不带 deterministicEvidence。
    const single = composeCrashDecision(baseInput({ ranked: [entry('a', 1)] }))
    check('single suspect still acts on round 1 (legacy deterministic branch)', single.verdict.act === true && single.verdict.evidence === 'deterministic', single.verdict)
    check('single suspect disables that one', JSON.stringify(single.disable) === '["a"]', single.disable)
  }

  console.log('\n== 命中声明：计划接管 + 第 1 轮行动 ==')
  {
    const result = composeCrashDecision(baseInput({ findings: [finding('declared-conflict', ['c', 'a'])] }))
    check('finding hit ⇒ deterministic evidence present', result.deterministicEvidence !== undefined)
    check('finding hit ⇒ evidence targets = plan', JSON.stringify(result.deterministicEvidence?.targets) === JSON.stringify(result.plan.quarantine), result.deterministicEvidence)
    check('finding hit ⇒ verdict is deterministic', result.verdict.evidence === 'deterministic' && result.verdict.required === 1, result.verdict)
    check('finding hit ⇒ acts', result.verdict.act === true, result.verdict)
    // 计划只关一个（冲突双方关掉一个即可）。
    check('finding hit ⇒ minimal set (one bundle)', result.plan.quarantine.length === 1, result.plan.quarantine)
    check('finding hit ⇒ disable matches plan', JSON.stringify(result.disable) === JSON.stringify(result.plan.quarantine), result.disable)
  }

  console.log('\n== 命中但全部受保护：不假装解决 ==')
  {
    const findings = [finding('duplicate-service', ['official-a', 'official-b'])]
    const result = composeCrashDecision(
      baseInput({
        findings,
        candidates: [
          candidate('a', 0),
          candidate('b', 1),
          candidate('official-a', 2, { protected: true }),
          candidate('official-b', 3, { protected: true }),
        ],
      }),
    )
    check('protected-only ⇒ plan is empty', result.plan.quarantine.length === 0, result.plan)
    check('protected-only ⇒ no deterministic evidence (cannot act on it)', result.deterministicEvidence === undefined)
    check('protected-only ⇒ unresolved carries the finding', result.unresolved.length === 1, result.unresolved)
    check('protected-only ⇒ no empty "disable" pretends success', result.disable.length === 0 || result.targets.length > 0, result.disable)
  }

  console.log('\n== 依赖联动：关被依赖者时连带依赖者 ==')
  {
    const findings = [finding('dsh-version', ['leaf'])]
    const result = composeCrashDecision(
      baseInput({
        // 联动闭包是 3 个，配额必须能整组容纳（否则计划器会拒绝半组，见其头注）。
        maxAutoDisable: 5,
        ranked: [entry('top', 0), entry('mid', 1), entry('leaf', 2)],
        candidates: [
          candidate('top', 0, { declared: true, dependencies: ['mid'] }),
          candidate('mid', 1, { declared: true, dependencies: ['leaf'] }),
          candidate('leaf', 2, { declared: true }),
        ],
        findings,
      }),
    )
    check('linkage ⇒ plan covers the chain', JSON.stringify(result.plan.quarantine) === '["leaf","top","mid"]', result.plan.quarantine)
    check('linkage ⇒ disable matches the chain', JSON.stringify(result.disable) === '["leaf","top","mid"]', result.disable)
    check('linkage ⇒ step reports linked plugins', result.plan.steps[0]?.linked.length === 2, result.plan.steps[0])
  }

  console.log('\n== 判定快照：观察轮与行动轮同形 ==')
  {
    const result = composeCrashDecision(baseInput())
    const patch = verdictPatch(7, result.verdict, result.targets, undefined, '2026-11-11T00:00:00.000Z')
    check('patch carries the verdict label', patch.label === result.verdict.label)
    check('patch carries the seq', patch.crashSeq === 7)
    check('patch headSuspect is the first target', patch.headSuspect === 'a', patch)
    check('patch omits deterministic when absent', patch.deterministic === undefined)
    const withEvidence = verdictPatch(7, result.verdict, result.targets, { findings: [], targets: ['a'] }, '2026-11-11T00:00:00.000Z')
    check('patch carries deterministic evidence when present', withEvidence.deterministic?.targets[0] === 'a')
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
process.exit(failures === 0 ? 0 : 1)