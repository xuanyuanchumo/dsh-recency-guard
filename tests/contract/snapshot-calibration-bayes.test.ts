/**
 * 快照契约测试 —— M1 误伤校准 + M2 贝叶斯并行读数是否**真的进入观测面**。
 *
 * 为什么需要这个文件（而不是把它塞进 core.test.ts）
 * -------------------------------------------------
 * 研究文档 05 §5.2 记过一条真实教训：**类型漂移是「写了不消费」的恶果**。
 * 本轮（cycle-12）的 M1/M2 都是「在 src/ 里造了一个新模块」，最危险的
 * 失败模式不是模块算错，而是**模块算对了但没人接线** —— 单元测试全绿，
 * 面板上却什么都看不到。所以这里测的不是算法，而是**接线本身**：
 * 给定输入后，快照里必须真的出现那两个字段，且它们与源模块的读数一致。
 */
import { buildPanelSnapshot, type SnapshotInput } from '../../src/snapshot.js'
import { bayesRisk } from '../../src/risk-bayes.js'
import { falsePositiveSamples, falsePositiveRate, calibratedConfirmRounds } from '../../src/risk-calibration.js'
import { riskScore } from '../../src/lifecycle.js'
import { emptyPartitionIndex } from '../../src/isolation.js'
import type { JournalRecord } from '../../src/store.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造一条最小但**类型完整**的快照输入。 */
function makeInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    profile: 'test-profile',
    projectKey: 'abc123def456abcd',
    stage: 'monitoring',
    transitions: [],
    stabilityScore: 0.9,
    observations: [],
    riskInputs: [],
    decisionSuspects: [],
    cooccurrence: {
      samples: 0,
      activeSamples: 0,
      inactiveSamples: 0,
      activeHitRate: null,
      inactiveHitRate: null,
      hitRateDelta: null,
      label: '无样本',
      mayWeight: { allowed: false, reason: '样本不足' },
    },
    journal: [],
    confirmRoundsBase: 2,
    restored: [],
    autoDisabled: [],
    partitions: emptyPartitionIndex(),
    recentEvents: [],
    registeredExposedAs: [],
    backupPolicy: {
      versionedBackups: true,
      retain: 5,
      customRoot: false,
      root: '/tmp/backups',
      configEditorAvailable: true,
    },
    diagnostics: {
      pluginVersion: '0.14.0-test',
      hostVersion: '0.2.2-rc.1',
      repositoryUrl: 'https://example.com/repo',
      issuesUrl: 'https://example.com/issues',
    },
    revisionFacts: {
      crashSeq: 0,
      autoDisabled: [],
      restored: [],
      stabilized: false,
      decisionDisable: [],
      journalTail: '',
    },
    ...overrides,
  }
}

/** 造一条 journal 事件（只填判定需要的字段）。 */
function journalRow(kind: string, bundle: string, seq: number, detail?: string): JournalRecord {
  return {
    t: new Date(Date.UTC(2026, 5, 1, 0, 0, seq)).toISOString(),
    kind,
    bundle,
    ...(detail === undefined ? {} : { detail }),
  }
}

const NOW = Date.parse('2026-06-01T12:00:00.000Z')

console.log('\n== M1 误伤校准进入快照（接线门）==')
{
  const snapshot = buildPanelSnapshot(makeInput(), NOW)
  check('快照带 calibration 字段', snapshot.calibration !== undefined)
  check('calibration.rate 是 Metric 形态', typeof snapshot.calibration.rate.defined === 'boolean')
  check('无样本时误伤率不可判定', snapshot.calibration.rate.defined === false)
  check('无样本时 value 是 null（不是 0）', snapshot.calibration.rate.value === null, snapshot.calibration.rate.value)
  check('calibration.decision 基线来自输入', snapshot.calibration.decision.base === 2, snapshot.calibration.decision.base)
  check('无证据时阈值维持基线', snapshot.calibration.decision.required === 2, snapshot.calibration.decision.required)
  check('calibration 带人话解释', snapshot.calibration.explanation.length > 0, snapshot.calibration.explanation)
}

console.log('\n== M1 快照读数与源模块同源（不是各算一遍）==')
{
  // 5 次**自动关闭**（detail=auto-recency 才被认作自动关闭），
  // 其中 3 次随后被用户 enable ⇒ 误伤率 60%。
  // 为什么是 5 而不是 4：CALIBRATION_MIN_SAMPLES = 5，4 次时读数按设计
  // 判「样本不足」（那不是缺陷，恰恰是 07 §3.3 要的诚实边界）。
  const journal: JournalRecord[] = [
    journalRow('disable', 'dsh-a', 0, 'auto-recency'),
    journalRow('disable', 'dsh-b', 1, 'auto-recency'),
    journalRow('disable', 'dsh-c', 2, 'auto-recency'),
    journalRow('disable', 'dsh-d', 3, 'auto-recency'),
    journalRow('disable', 'dsh-e', 4, 'auto-recency'),
    journalRow('enable', 'dsh-a', 5),
    journalRow('enable', 'dsh-b', 6),
    journalRow('enable', 'dsh-c', 7),
  ]
  const input = makeInput({ journal, confirmRoundsBase: 2 })
  const snapshot = buildPanelSnapshot(input, NOW)

  // 同源断言：快照里的读数必须与直接调用源模块的结果**逐字段相等**。
  // 若有人将来在快照里另写一份算法，这条会立刻红。
  const directStats = falsePositiveSamples(journal)
  const directRate = falsePositiveRate(directStats)
  const directDecision = calibratedConfirmRounds(2, directStats)

  check('误伤率与源模块一致（defined）', snapshot.calibration.rate.defined === directRate.defined)
  check(
    '误伤率与源模块一致（数值）',
    JSON.stringify(snapshot.calibration.rate.value) === JSON.stringify(directRate.value),
    { snapshot: snapshot.calibration.rate.value, direct: directRate.value },
  )
  check('阈值决策与源模块一致（required）', snapshot.calibration.decision.required === directDecision.required, {
    snapshot: snapshot.calibration.decision.required,
    direct: directDecision.required,
  })
  check('阈值决策与源模块一致（kind）', snapshot.calibration.decision.kind === directDecision.kind)
  check('有证据时误伤率可判定', snapshot.calibration.rate.defined === true)
}

console.log('\n== M1 区分「用户主动」与「系统自动」（07 §3.3 的核心纪律）==')
{
  // 同样 5 次自动关闭；A 组随后是**用户主动 enable**（无 restore 跟随），
  // B 组是**系统自动恢复**（enable 之后紧跟 restore，模块据此改判来源）。
  const userJournal: JournalRecord[] = [
    journalRow('disable', 'dsh-a', 0, 'auto-recency'),
    journalRow('disable', 'dsh-b', 1, 'auto-recency'),
    journalRow('disable', 'dsh-c', 2, 'auto-recency'),
    journalRow('disable', 'dsh-d', 3, 'auto-recency'),
    journalRow('disable', 'dsh-e', 4, 'auto-recency'),
    journalRow('enable', 'dsh-a', 5),
    journalRow('enable', 'dsh-b', 6),
    journalRow('enable', 'dsh-c', 7),
  ]
  const systemJournal: JournalRecord[] = [
    journalRow('disable', 'dsh-a', 0, 'auto-recency'),
    journalRow('disable', 'dsh-b', 1, 'auto-recency'),
    journalRow('disable', 'dsh-c', 2, 'auto-recency'),
    journalRow('disable', 'dsh-d', 3, 'auto-recency'),
    journalRow('disable', 'dsh-e', 4, 'auto-recency'),
    // restore 必须紧跟 enable 才构成「系统恢复」段 —— 这是模块判定来源的信号，
    // 也是本测试要钉死的那条纪律。
    journalRow('enable', 'dsh-a', 5),
    journalRow('restore', 'dsh-a', 6),
    journalRow('enable', 'dsh-b', 7),
    journalRow('restore', 'dsh-b', 8),
    journalRow('enable', 'dsh-c', 9),
    journalRow('restore', 'dsh-c', 10),
  ]
  const userSnap = buildPanelSnapshot(makeInput({ journal: userJournal }), NOW)
  const systemSnap = buildPanelSnapshot(makeInput({ journal: systemJournal }), NOW)

  check('用户主动放行 ⇒ 误伤率可判定', userSnap.calibration.rate.defined === true)
  check('用户主动放行 ⇒ 误伤率明显更高', (userSnap.calibration.rate.value?.rate ?? 0) > 0.5, userSnap.calibration.rate.value)
  // 系统自动恢复**不是误伤证据**：不计入分子 ⇒ 误伤率 0（有数据，真是 0）。
  check('系统自动恢复 ⇒ 不计入误伤', (systemSnap.calibration.rate.value?.falsePositives ?? -1) === 0, systemSnap.calibration.rate.value)
  check(
    '两者读数必须不同（若相同说明来源区分失效）',
    JSON.stringify(userSnap.calibration.rate.value) !== JSON.stringify(systemSnap.calibration.rate.value),
  )
}

console.log('\n== M2 贝叶斯并行读数进入快照 ==')
{
  const riskInputs = [
    { bundle: 'dsh-new', experimental: true, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 3, observations: 3 },
    { bundle: 'dsh-old', experimental: false, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 0, observations: 3 },
  ]
  const snapshot = buildPanelSnapshot(makeInput({ riskInputs }), NOW)
  check('快照带 bayes 字段', Array.isArray(snapshot.bayes))
  check('bayes 与 riskInputs 同长度', snapshot.bayes.length === riskInputs.length, snapshot.bayes.length)
  check(
    'bayes 顺序与 riskInputs 一致',
    snapshot.bayes.every((row, i) => row.bundle === riskInputs[i]?.bundle),
    snapshot.bayes.map((r) => r.bundle),
  )
  check('每行都带 defined / label', snapshot.bayes.every((r) => typeof r.defined === 'boolean' && r.label.length > 0))
  check('每行都带 bundle', snapshot.bayes.every((r) => r.bundle.length > 0))
}

console.log('\n== M2 并行读数纪律：两套读数并列，默认值不被替换 ==')
{
  const riskInputs = [
    { bundle: 'dsh-hot', experimental: true, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 2, observations: 2 },
    { bundle: 'dsh-cold', experimental: false, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 0, observations: 2 },
  ]
  const snapshot = buildPanelSnapshot(makeInput({ riskInputs }), NOW)

  // 关键断言（07 §2.3）：risks[] 用的仍是**默认 riskScore**，不是贝叶斯分。
  check(
    'risks 仍消费默认 riskScore（未被贝叶斯替换）',
    snapshot.risks.every((row) => {
      const input = riskInputs.find((r) => r.bundle === row.bundle)
      if (input === undefined) return false
      return Math.abs(row.risk - riskScore(input, NOW)) < 1e-9
    }),
    snapshot.risks.map((r) => ({ bundle: r.bundle, risk: r.risk })),
  )

  // 同源断言：bayes 行的值必须与直接调用 bayesRisk 一致。
  check(
    'bayes 读数与源模块一致',
    snapshot.bayes.every((row) => {
      const input = riskInputs.find((r) => r.bundle === row.bundle)
      if (input === undefined) return false
      const direct = bayesRisk(input, NOW)
      if (row.value === null) return direct.hits + direct.misses < 3
      return Math.abs((row.value?.score ?? 0) - direct.bayesScore) < 1e-9
    }),
    snapshot.bayes,
  )
}

console.log('\n== M2 样本稀疏诚实边界进入快照 ==')
{
  // 1 次观测 → 低于样本门 3 ⇒ defined:false。
  const sparse = [{ bundle: 'dsh-sparse', experimental: false, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 1, observations: 1 }]
  const snapshot = buildPanelSnapshot(makeInput({ riskInputs: sparse }), NOW)
  check('样本稀疏时 bayes 不可判定', snapshot.bayes[0]?.defined === false, snapshot.bayes[0])
  check('样本稀疏时 value 是 null（不是 0）', snapshot.bayes[0]?.value === null, snapshot.bayes[0]?.value)
  check('样本稀疏时 reason 说明差多少', (snapshot.bayes[0]?.reason ?? '').length > 0, snapshot.bayes[0]?.reason)
}

console.log('\n== 快照确定性（同一输入逐字节相同）==')
{
  const input = makeInput({
    riskInputs: [{ bundle: 'dsh-x', experimental: true, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 1, observations: 2 }],
    journal: [journalRow('disable', 'dsh-x', 0, 'auto-recency')],
  })
  // 排除 diagnostics.snapshotMs：它是**快照自身的耗时**（`Date.now() - now`），
  // 天然每次都不同。确定性契约针对的是「由输入决定的事实」，
  // 而自观测开销不是事实 —— 把它算进比对会让这条断言永远红，
  // 从而掩盖真正的非确定性（那才是要抓的）。同一排除已在 v0.12 的
  // 快照契约惯例里确立。
  const strip = (value: unknown): string => {
    const clone = JSON.parse(JSON.stringify(value)) as { diagnostics?: { snapshotMs?: number } }
    if (clone.diagnostics) clone.diagnostics.snapshotMs = 0
    return JSON.stringify(clone)
  }
  const a = strip(buildPanelSnapshot(input, NOW))
  const b = strip(buildPanelSnapshot(input, NOW))
  check('两次构造逐字节相同（排除自观测耗时）', a === b)
  check('calibration 段确定', JSON.stringify(buildPanelSnapshot(input, NOW).calibration) === JSON.stringify(buildPanelSnapshot(input, NOW).calibration))
  check('bayes 段确定', JSON.stringify(buildPanelSnapshot(input, NOW).bayes) === JSON.stringify(buildPanelSnapshot(input, NOW).bayes))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
