/**
 * schema 版本判据（T15-03 / TD `state-schema-version` 收口）。
 *
 * ## 三条读取路径（缺一条都会把「损坏」读成「正常」）
 *
 * 1. `schemaVersion: 1` ⇒ 正常读；
 * 2. **缺失** ⇒ 按 v1 宽容读（v0.16 及更早的文件没有该字段 —— 老 profile
 *    必须能读，这是硬兼容要求）；
 * 3. **未知值** ⇒ 返回安全空态（`corrupt:true`）、**不覆盖文件**、
 *    写一条 `degraded:true` 的 journal note。
 *
 * 第 3 条为什么不能「尽力解释」：`crashSeq` / `autoDisabled` / `disable`
 * 的语义可能已变；按旧语义解释会做出错误恢复决策（拦错插件或漏拦），
 * 比「承认看不懂」危险得多。所以本文件同时断言**文件逐字节不变**。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, SCHEMA_VERSION } from '../../src/host/data/store.ts'
import { parseDecisionText, parseStateText, unsupportedVersionDetail } from '../../src/host/data/schema-version.ts'
import { listArchives, readArchiveManifest, resetArtifacts } from '../../src/host/data/archive.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const statePath = (store: Store) => join(store.partitionPath, 'state.json')
const decisionPath = (store: Store) => join(store.partitionPath, 'decision.json')

/** 直接写一次原始文件（模拟「旧版本/被改坏」的落盘形态）。 */
function writeRaw(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

async function main(): Promise<void> {
  console.log('\n== 写端：三个状态文件都带 schemaVersion ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-schema-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: null, crashSeq: 2, autoDisabled: [], stabilized: true, restored: ['x'] })
      const state = JSON.parse(readFileSync(statePath(store), 'utf8')) as { schemaVersion?: number }
      check('writeState stamps schemaVersion', state.schemaVersion === SCHEMA_VERSION, state.schemaVersion)

      store.writeDecisionSync({ capturedAt: 't', suspects: [], disable: ['a'], reason: 'crash-recovery' })
      const decision = JSON.parse(readFileSync(decisionPath(store), 'utf8')) as { schemaVersion?: number; disable?: string[] }
      check('writeDecisionSync stamps schemaVersion', decision.schemaVersion === SCHEMA_VERSION, decision.schemaVersion)
      check('writeDecisionSync keeps the payload', JSON.stringify(decision.disable) === '["a"]', decision.disable)

      store.writeStateSync({ bootMarker: { startedAt: 't', pid: 7 }, crashSeq: 3, autoDisabled: [], stabilized: false, restored: [] })
      check('writeStateSync stamps schemaVersion', (JSON.parse(readFileSync(statePath(store), 'utf8')) as { schemaVersion?: number }).schemaVersion === SCHEMA_VERSION)

      const resetDir = mkdtempSync(join(tmpdir(), 'rg-schema-reset-'))
      try {
        resetArtifacts(resetDir)
        check('resetArtifacts stamps state schemaVersion', (JSON.parse(readFileSync(join(resetDir, 'state.json'), 'utf8')) as { schemaVersion?: number }).schemaVersion === SCHEMA_VERSION)
        check('resetArtifacts stamps decision schemaVersion', (JSON.parse(readFileSync(join(resetDir, 'decision.json'), 'utf8')) as { schemaVersion?: number }).schemaVersion === SCHEMA_VERSION)
      } finally {
        rmSync(resetDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 读端 v=1：正常 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-schema-v1-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      writeRaw(statePath(store), { schemaVersion: 1, bootMarker: null, crashSeq: 4, autoDisabled: [{ name: 'p', disabledAt: 't', reason: 'auto-recency', crashSeq: 4 }], stabilized: false, restored: [] })
      const state = await store.readState()
      check('v=1 state is read as-is', state.crashSeq === 4 && state.autoDisabled[0]?.name === 'p', state)
      check('v=1 state is not marked corrupt', state.corrupt === undefined, state.corrupt)
      check('corruption report stays clean', store.corruptionReport().state === false && store.corruptionReport().decision === false)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 读端缺 v：按 v1 宽容读（老 profile 必须能读）==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-schema-nov-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      // v0.16 及更早的落盘形态：没有 schemaVersion 字段。
      writeRaw(statePath(store), { bootMarker: null, crashSeq: 7, autoDisabled: [], stabilized: true, restored: [] })
      writeRaw(decisionPath(store), { capturedAt: 't', suspects: [], disable: ['legacy'], reason: 'crash-recovery' })
      const state = await store.readState()
      check('legacy state keeps crashSeq', state.crashSeq === 7, state.crashSeq)
      check('legacy state is not marked corrupt', state.corrupt === undefined)
      check('legacy decision is read', JSON.stringify(store.readDecisionSync()?.disable) === '["legacy"]', store.readDecisionSync())
      check('legacy read does not create a degraded note', store.readJournalSync(50).every((e) => e.degraded !== true), store.readJournalSync(50))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 读端 v=999：安全空态 + 留痕 + 文件逐字节不变 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-schema-unknown-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      writeRaw(statePath(store), { schemaVersion: 999, bootMarker: null, crashSeq: 9, autoDisabled: [{ name: 'x', disabledAt: 't', reason: 'auto-recency', crashSeq: 9 }], stabilized: false, restored: [] })
      const before = readFileSync(statePath(store), 'utf8')

      const state = await store.readState()
      check('unknown version returns a safe empty state', state.crashSeq === 0 && state.autoDisabled.length === 0, state)
      check('unknown version is marked corrupt', state.corrupt === true, state.corrupt)
      check('the file is NOT overwritten (byte-identical)', readFileSync(statePath(store), 'utf8') === before)
      const notes = store.readJournalSync(50).filter((e) => e.degraded === true)
      check('a degraded note is written once', notes.length === 1, notes)
      check(
        'the note names the file and the unsupported version',
        typeof notes[0]?.detail === 'string' && notes[0].detail.includes('state.json') && notes[0].detail.includes('schemaVersion=999') && notes[0].detail.includes('文件未被修改'),
        notes[0]?.detail,
      )
      check('corruption report exposes the state file', store.corruptionReport().state === true, store.corruptionReport())

      // 幂等：同一 (文件, 版本) 反复读不得刷屏（快照 5s 一次，一天会写上万条）。
      await store.readState()
      await store.readState()
      check('repeated reads do not duplicate the note', store.readJournalSync(50).filter((e) => e.degraded === true).length === 1, store.readJournalSync(50).filter((e) => e.degraded === true).length)
      check('the file is still byte-identical after repeated reads', readFileSync(statePath(store), 'utf8') === before)

      // decision 同族判据。
      writeRaw(decisionPath(store), { schemaVersion: 999, capturedAt: 't', suspects: [], disable: ['ghost'], reason: 'crash-recovery' })
      const decisionBefore = readFileSync(decisionPath(store), 'utf8')
      check('unknown version decision is not interpreted', store.readDecisionSync() === null)
      check('unknown version decision file is untouched', readFileSync(decisionPath(store), 'utf8') === decisionBefore)
      check('corruption report exposes the decision file', store.corruptionReport().decision === true, store.corruptionReport())
      check(
        'decision corruption is journaled',
        store.readJournalSync(50).some((e) => e.degraded === true && typeof e.detail === 'string' && e.detail.includes('decision.json')),
        store.readJournalSync(50).map((e) => e.detail),
      )
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 归档 manifest：未知版本不解释、不覆盖 ==')
  {
    const partition = mkdtempSync(join(tmpdir(), 'rg-schema-archive-'))
    try {
      const knownDir = join(partition, 'archive', 'known')
      const unknownDir = join(partition, 'archive', 'unknown')
      mkdirSync(knownDir, { recursive: true })
      mkdirSync(unknownDir, { recursive: true })
      writeRaw(join(knownDir, 'manifest.json'), { schemaVersion: 1, archivedAt: '2026-11-01T00:00:00.000Z', reason: 'ok', workspace: 'D:/ws', entries: [], summary: { crashSeq: 0, autoDisabled: [], journalEvents: 0 } })
      writeRaw(join(unknownDir, 'manifest.json'), { schemaVersion: 999, archivedAt: '2026-11-02T00:00:00.000Z', reason: 'future', workspace: 'D:/ws', entries: [], summary: { crashSeq: 0, autoDisabled: [], journalEvents: 0 } })
      const before = readFileSync(join(unknownDir, 'manifest.json'), 'utf8')

      const reported: Array<{ dir: string; version: unknown }> = []
      const archives = listArchives(partition, (dir, version) => reported.push({ dir, version }))
      check('only the supported manifest is listed', archives.length === 1 && archives[0]?.reason === 'ok', archives)
      check('the unsupported manifest is reported (留痕)', reported.length === 1 && reported[0]?.version === 999, reported)
      check('readArchiveManifest returns null for unknown version', readArchiveManifest(unknownDir) === null)
      check('unknown manifest file is untouched', readFileSync(join(unknownDir, 'manifest.json'), 'utf8') === before)
      check('known manifest is still readable', readArchiveManifest(knownDir)?.reason === 'ok')
    } finally {
      rmSync(partition, { recursive: true, force: true })
    }
  }

  console.log('\n== 直接驱动纯判据（保持模块可被变异工具直接覆盖）==')
  {
    // 为什么直接 import 这三个符号：变异工具的归属判据是「测试文件直接 import
    // 该模块」。若只经 Store 间接调用，`schema-version.ts` 的变异体永不进池 ——
    // 指标不覆盖的东西，指标不会告诉你它没覆盖（v0.15 教训）。
    const unsupported = parseStateText(JSON.stringify({ schemaVersion: 42, crashSeq: 5 }))
    check('parseStateText flags an unsupported version', unsupported.corruptVersion === 42, unsupported)
    const supported = parseStateText(JSON.stringify({ schemaVersion: 1, crashSeq: 5 }))
    check('parseStateText accepts v1', supported.corruptVersion === undefined && supported.state?.crashSeq === 5, supported)
    const legacy = parseStateText(JSON.stringify({ crashSeq: 5 }))
    check('parseStateText treats a missing version as v1', legacy.corruptVersion === undefined && legacy.state?.crashSeq === 5, legacy)
    const legacyDefaults = parseStateText('{}')
    check('parseStateText fills the v1 defaults for an empty object', legacyDefaults.state?.autoDisabled.length === 0 && legacyDefaults.state?.restored.length === 0, legacyDefaults.state)

    check('parseDecisionText flags an unsupported version', parseDecisionText(JSON.stringify({ schemaVersion: 7 })).corruptVersion === 7)
    check('parseDecisionText accepts a legacy decision', parseDecisionText(JSON.stringify({ disable: ['x'] })).decision !== null)
    check(
      'unsupportedVersionDetail is the single wording source',
      unsupportedVersionDetail('state.json', 42) === '[recency-guard] state.json 的 schemaVersion=42 不受支持（本实现只认 1）；文件未被修改，按安全空态降级。',
      unsupportedVersionDetail('state.json', 42),
    )
    check('SCHEMA_VERSION is 1', SCHEMA_VERSION === 1)
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.log('  FAIL  harness crashed', String(error))
    process.exit(1)
  })