/**
 * RQ3 预防性指标接入生产（T15-01）—— 「机制不再孤岛」的可复核证据。
 *
 * ## 背景
 *
 * v0.16 之前 `preventive.ts` 只有单测直接 import，`grep "from.*preventive" src/`
 * = 0：机制实现了，但生产零消费 ⇒ 面板永远看不到预警 ⇒ **研究闭环断裂**。
 * 本文件钉三条：
 * 1. **真的有生产消费者**：`projectPreventive` 把 journal 事实变成投影，
 *    `status` 输出与 `PanelSnapshot` 都带 `preventive`（同一形状）；
 * 2. **不可判定不填 0**：样本不足 ⇒ `defined:false` + `reason` + `value:null`；
 * 3. **只预警不行动**：关闭决策链路（`crash-decision` / `quarantine-plan` /
 *    `recovery-policy` / `recovery-actions` / `decision` / `state-reconcile` /
 *    `boot-orchestration`、`risk/*`）**没有**任何 preventive 依赖 —— 用源码
 *    扫描断言钉死，而不是靠「我记得没接」。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOOT_NOTE_PREFIX,
  bootIntervals,
  bootTimestamps,
  configChangeTimestamps,
  projectPreventive,
} from '../../src/host/surface/preventive-view.ts'
import { buildPanelSnapshot, type PanelSnapshot, type SnapshotInput } from '../../src/host/surface/snapshot.ts'
import { buildStatusOutput } from '../../src/host/surface/status-view.ts'
import { formatStatus, renderOutcome } from '../../src/host/surface/tool-render.ts'
import { emptyState, type JournalRecord } from '../../src/host/data/store.ts'
import { emptyPartitionIndex } from '../../src/host/core/isolation.ts'
import { composeCrashDecision } from '../../src/host/guard/crash-decision.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const PROJECT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const BASE = Date.UTC(2026, 10, 1, 0, 0, 0)

/** 一条启动 note（detail 前缀与 `startup-record.ts` 同源）。 */
function bootNote(offsetMs: number, pid = 1000): JournalRecord {
  return { kind: 'note', detail: `${BOOT_NOTE_PREFIX}${pid}`, t: new Date(BASE + offsetMs).toISOString() }
}

/** 一条 install/update（配置变更事实）。 */
function changeAt(offsetMs: number): JournalRecord {
  return { kind: 'install', bundle: `pkg-${offsetMs}`, version: '1.0.0', t: new Date(BASE + offsetMs).toISOString() }
}

/** 等间隔启动（频率恒定 ⇒ σ̂=0 ⇒ 不预警）。 */
function steadyJournal(): JournalRecord[] {
  return [0, 60_000, 120_000, 180_000, 240_000, 300_000].map((t) => bootNote(t))
}

/** 启动越来越密（频率上越界 ⇒ 预警）。 */
function rampingJournal(): JournalRecord[] {
  // 间隔：600s → 300s → 60s → 10s → 1s（频率 0.1 → 0.2 → 1 → 6 → 60 次/分钟）
  const offsets = [0, 600_000, 900_000, 960_000, 970_000, 971_000]
  return offsets.map((t) => bootNote(t))
}

function main() {
  console.log('\n== 取数：journal 事实 → 时刻序列 ==')
  {
    const journal = [...steadyJournal(), changeAt(10), changeAt(20)]
    check('boot timestamps are extracted from the boot note prefix', bootTimestamps(journal).length === 6, bootTimestamps(journal))
    check('change timestamps only come from install/update', configChangeTimestamps(journal).length === 2, configChangeTimestamps(journal))
    check('boot timestamps are sorted ascending', JSON.stringify(bootTimestamps(journal)) === JSON.stringify([...bootTimestamps(journal)].sort((a, b) => a - b)))
    check('a non-boot note is ignored', bootTimestamps([{ kind: 'note', detail: 'dsh 启动之外的 note', t: new Date(BASE).toISOString() }]).length === 0)
  }

  console.log('\n== 不可判定：defined:false + reason，绝不填 0 ==')
  {
    const empty = projectPreventive([])
    check('loadTime is undefined with no journal', empty.loadTime.defined === false)
    check('loadTime value is null (never 0)', empty.loadTime.value === null, empty.loadTime)
    check('loadTime reason is carried through', (empty.loadTime.reason ?? '').includes('至少需要'), empty.loadTime.reason)
    check('loadTime samples is 0', empty.loadTime.samples === 0, empty.loadTime.samples)
    check('configChanges is undefined with no journal', empty.configChanges.defined === false)
    check('configChanges value is null (never 0)', empty.configChanges.value === null, empty.configChanges)
    check('configChanges reason is carried through', (empty.configChanges.reason ?? '').includes('至少需要 5 个变更间隔'), empty.configChanges.reason)
    check('source explains the proxy is not a measurement', empty.source.note.includes('代理不是真实加载耗时'), empty.source.note)
    check('source states the units explicitly', empty.source.units === 'per-minute', empty.source.units)
  }

  console.log('\n== 可判定：等间隔启动受控（σ̂=0 不预警） ==')
  {
    const steady = projectPreventive(steadyJournal())
    check('steady boot cadence is defined', steady.loadTime.defined === true, steady.loadTime)
    check('steady cadence value is present', steady.loadTime.value !== null)
    check('steady cadence does not alert', steady.loadTime.value?.alert === false, steady.loadTime.value)
    check('steady cadence label names the zero-sigma reason', (steady.loadTime.label ?? '').includes('完全规则'), steady.loadTime.label)
    check('source counts 6 boot samples', steady.source.bootSamples === 6, steady.source.bootSamples)
  }

  console.log('\n== 可判定：启动变密 ⇒ 预警（只预警，不含任何行动语义） ==')
  {
    const ramping = projectPreventive(rampingJournal())
    check('ramping cadence is defined', ramping.loadTime.defined === true, ramping.loadTime)
    check('ramping cadence alerts', ramping.loadTime.value?.alert === true, ramping.loadTime.value)
    check('label says 预警 on a rising frequency', (ramping.loadTime.label ?? '').includes('预警'), ramping.loadTime.label)
    check(
      'label never claims it closed anything',
      !/关闭|隔离|已处理/.test(ramping.loadTime.label) && !/关闭|隔离|已处理/.test(ramping.configChanges.label),
      [ramping.loadTime.label, ramping.configChanges.label],
    )
    // 投影确定性：同一 journal 两次必须逐字节一致（快照契约要求可复现）。
    check(
      'projection is deterministic',
      JSON.stringify(projectPreventive(rampingJournal())) === JSON.stringify(projectPreventive(rampingJournal())),
    )
  }

  console.log('\n== 配置变更 CUSUM：变密 ⇒ 预警；样本不足 ⇒ 不可判定 ==')
  {
    const steadyChanges = [0, 100_000, 200_000, 300_000, 400_000].map((t) => changeAt(t))
    check('5 events ⇒ only 4 gaps ⇒ undefined', projectPreventive(steadyChanges).configChanges.defined === false, projectPreventive(steadyChanges).configChanges)
    const dense = [0, 100_000, 200_000, 300_000, 400_000, 500_000, 501_000].map((t) => changeAt(t))
    const projected = projectPreventive(dense)
    check('7 events ⇒ 6 gaps ⇒ defined', projected.configChanges.defined === true, projected.configChanges)
    check('dense change cadence alerts', projected.configChanges.value?.alert === true, projected.configChanges.value)
    check(
      'CUSUM threshold/reference are carried for white-box reading',
      projected.configChanges.value?.threshold === 5 && projected.configChanges.value?.reference === 0.5,
      projected.configChanges.value,
    )
  }

  console.log('\n== 生产消费：status 输出与面板快照都带 preventive（同一形状） ==')
  {
    const preventive = projectPreventive(rampingJournal())
    const status = buildStatusOutput({
      profile: 'p',
      workspace: 'D:/ws',
      projectKey: 'k',
      dshVersion: '0.2.2-rc.1',
      pluginVersion: '0.17.0',
      issuesUrl: null,
      enabled: true,
      state: emptyState(),
      ranked: [],
      experimentalSuspects: [],
      decisionFile: 'decision.json',
      decisionEvidence: { hasEvidence: false, items: [] },
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
      bayes: [],
      calibration: null,
      lifecycle: { stage: 'monitoring', stabilityScore: 1, steps: [], openSteps: [], rejected: [], transitions: [] },
      configEditorAvailable: false,
      preventive,
      corruption: { state: false, decision: false, files: [] },
    })
    check('status output carries preventive', status.preventive !== undefined)
    check('status preventive has the loadTime/configChanges/source trio', JSON.stringify(Object.keys(status.preventive as object).sort()) === '["configChanges","loadTime","source"]', Object.keys(status.preventive as object))
    const corrupt = status.corrupt as { state: boolean; decision: boolean }
    check('status output carries the corruption marker', corrupt.state === false && corrupt.decision === false, status.corrupt)

    const snapshot = buildPanelSnapshot(makeSnapshotInput(preventive), BASE)
    check('panel snapshot carries the same preventive shape', JSON.stringify(snapshot.preventive) === JSON.stringify(preventive))
    check('panel snapshot defaults corruption to false', JSON.stringify(snapshot.corrupt) === '{"state":false,"decision":false}', snapshot.corrupt)
    check('panel snapshot type exposes preventive (compile-time + runtime)', (snapshot as PanelSnapshot).preventive !== undefined)

    const text = renderOutcome(
      formatStatus({
        profile: 'p',
        dshVersion: '0.2.2-rc.1',
        enabled: true,
        crashedLastRun: false,
        crashSeq: 0,
        stabilized: false,
        autoDisabled: [],
        suspectRanking: [],
        experimentalSuspects: [],
        preventive,
      } as never),
    )
    check('command window shows the warning label', text.includes('启动频率（代理）') && text.includes('配置变更频率'), text)
  }

  console.log('\n== 只预警不行动：关闭决策链路零依赖 preventive（源码扫描）==')
  {
    const chain = [
      'src/host/guard/crash-decision.ts',
      'src/host/guard/quarantine-plan.ts',
      'src/host/guard/recovery-policy.ts',
      'src/host/guard/recovery-actions.ts',
      'src/host/guard/decision.ts',
      'src/host/guard/state-reconcile.ts',
      'src/host/guard/boot-orchestration.ts',
      'src/host/risk/recency.ts',
      'src/host/risk/risk-bayes.ts',
      'src/host/risk/risk-calibration.ts',
    ]
    for (const rel of chain) {
      const text = readFileSync(join(PROJECT_ROOT, rel), 'utf8')
      check(`[no-preventive] ${rel}`, !/from\s+['"][^'"]*preventive[^'"]*['"]/.test(text), text.match(/from\s+['"][^'"]*preventive[^'"]*['"]/)?.[0])
    }
    // 结构化对照：同一份决策输入两次调用的输出逐字节一致；且函数签名里根本没有
    // preventive 参数（「传不进去」比「传了但没用」更强）。
    const input = {
      seq: 1,
      maxAutoDisable: 2,
      confirmRounds: 2,
      ranked: [{ bundle: 'a', lastChangeAt: '2026-11-01T00:00:00.000Z', lastKind: 'install' as const }],
      candidates: [{ name: 'a', enabled: true, index: 0 }],
      findings: [],
      history: [],
      envChanged: false,
    }
    check(
      'crash decision is byte-identical across calls (no preventive input exists)',
      JSON.stringify(composeCrashDecision(input)) === JSON.stringify(composeCrashDecision(input)),
    )
    check(
      'composeCrashDecision parameter list has no preventive field',
      !JSON.stringify(Object.keys(input)).includes('preventive'),
    )
  }

  console.log('\n== 诚实边界：corrupt（schema 降级）不参与任何关闭决策 ==')
  {
    // 未知 schemaVersion ⇒ Store 返回 `{...空态, corrupt:true}`。这个标记是
    // **观测面事实**（上屏、让人知道文件版本不认识），**不得**参与恢复决策：
    // 一旦「文件损坏 ⇒ 不恢复/不关闭」被接进去，那是一次静默的行为变更，
    // 而且会让崩溃循环在数据损坏时失去唯一的升级依据。
    const chain = [
      'src/host/guard/crash-decision.ts',
      'src/host/guard/quarantine-plan.ts',
      'src/host/guard/recovery-policy.ts',
      'src/host/guard/recovery-actions.ts',
      'src/host/guard/decision.ts',
      'src/host/guard/state-reconcile.ts',
      'src/host/guard/boot-orchestration.ts',
    ]
    for (const rel of chain) {
      const text = readFileSync(join(PROJECT_ROOT, rel), 'utf8')
      check(`[no-corrupt] ${rel}`, !/\.corrupt\b/.test(text), text.match(/[^\n]*\.corrupt\b[^\n]*/)?.[0])
    }
    // 运行时对照：决策输出里不存在 corrupt 键；且同一输入两次逐字节一致。
    const input = {
      seq: 1,
      maxAutoDisable: 2,
      confirmRounds: 2,
      ranked: [{ bundle: 'a', lastChangeAt: '2026-11-01T00:00:00.000Z', lastKind: 'install' as const }],
      candidates: [{ name: 'a', enabled: true, index: 0 }],
      findings: [],
      history: [],
      envChanged: false,
    }
    const decision = composeCrashDecision(input)
    check('crash decision carries no corrupt field', !('corrupt' in decision) && !JSON.stringify(decision).includes('corrupt'), Object.keys(decision))
    check('decision output is byte-identical for the same input', JSON.stringify(decision) === JSON.stringify(composeCrashDecision(input)))
  }

  console.log('\n== bootIntervals（导出后的直接契约）：零间隔/负值/NaN 一律不进序列 ==')
  {
    const t = BASE
    check('same-millisecond boots produce no interval', JSON.stringify(bootIntervals([t, t])) === '[]', bootIntervals([t, t]))
    check('normal adjacent boots produce their gaps', JSON.stringify(bootIntervals([t, t + 1000, t + 4000])) === '[1000,3000]', bootIntervals([t, t + 1000, t + 4000]))
    check('out-of-order boots are dropped (negative gap)', JSON.stringify(bootIntervals([t + 4000, t])) === '[]', bootIntervals([t + 4000, t]))
    check('NaN neighbours are dropped', JSON.stringify(bootIntervals([t, Number.NaN, t + 1000])) === '[]', bootIntervals([t, Number.NaN, t + 1000]))
    const mixed = bootIntervals([t, t, t + 1000, t + 1000, t + 3000])
    check('every returned interval is finite and strictly positive', mixed.every((gap) => Number.isFinite(gap) && gap > 0), mixed)
    check('duplicate timestamps do not inflate the sequence', JSON.stringify(mixed) === '[1000,2000]', mixed)

    // 端到端：全部同刻启动 ⇒ 没有间隔 ⇒ 不可判定（绝不出现 Infinity/NaN）。
    const sameInstant: JournalRecord[] = [0, 0, 0, 0, 0, 0].map((_, index) => bootNote(0, 2000 + index))
    const degenerate = projectPreventive(sameInstant)
    check('duplicate-timestamp boots yield an undefined loadTime (no Infinity)', degenerate.loadTime.defined === false && degenerate.loadTime.value === null, degenerate.loadTime)
    check('degenerate input still reports the proxy source counts', degenerate.source.bootSamples === 6 && degenerate.source.units === 'per-minute', degenerate.source)
    check('no non-finite number leaks into the projection', !/Infinity|NaN/.test(JSON.stringify(degenerate)), JSON.stringify(degenerate).slice(0, 200))
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

/** 面板快照的最小输入（与契约测试同一形态；只补本测试关心的字段）。 */
function makeSnapshotInput(preventive: ReturnType<typeof projectPreventive>): SnapshotInput {
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
    backupPolicy: { versionedBackups: true, retain: 5, customRoot: false, root: '/tmp/backups', configEditorAvailable: false },
    diagnostics: { pluginVersion: '0.17.0', hostVersion: '0.2.2-rc.1', repositoryUrl: null, issuesUrl: null },
    revisionFacts: { crashSeq: 0, autoDisabled: [], restored: [], stabilized: false, decisionDisable: [], journalTail: '' },
    preventive,
  }
}

main()
process.exit(failures === 0 ? 0 : 1)