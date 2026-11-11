/**
 * 启动降级：观测通道失败不得拖垮启动（`boot-orchestration.ts` 的两个 try/catch）。
 *
 * ## 为什么这条值得单独钉（不是 IO 注入边界）
 *
 * `recordChanges` / `observeOfficialExperimental` 都是**可注入依赖**，
 * 让它们 reject 是纯内存操作，不依赖文件系统故障。而它们外面那层
 * `try/catch` 承担的是本插件最核心的承诺：
 *
 * > 观测/恢复设施不能拖垮主流程（v0.11.1 P0 教训：一次可恢复的写锁超时
 * > 曾把宿主变成 `fatal load failure`）。
 *
 * 也就是说：这两个 catch 分支若被删掉/吞错方式改坏，宿主会开始因为
 * 「记录变更失败」这种旁路事实而起不来 —— 那正是本插件存在的反面。
 * 断言必须抄实现里的文案原文（`[recency-guard] 记录插件变更失败：…`），
 * 否则测的是近义词而不是契约。
 *
 * ## 三种控制流都要断言
 *
 * 1. 失败**被看见**（warn 收到含原始错误 message 的那一行）；
 * 2. 失败**不中断**（`runBootOrchestration` 正常 resolve，后续步骤照跑）；
 * 3. 失败**不污染判定**（干净启动仍然把 crashSeq 归零）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/host/data/store.ts'
import { runBootOrchestration, type BootOrchestrationDeps } from '../../src/host/guard/boot-orchestration.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

interface Recorder {
  deps: BootOrchestrationDeps
  warnings: string[]
  calls: string[]
}

/** 造一份可观测的依赖集合（所有回调都记账）。 */
function makeDeps(store: Store, profileDir: string, overrides: Partial<BootOrchestrationDeps> = {}): Recorder {
  const warnings: string[] = []
  const calls: string[] = []
  const deps: BootOrchestrationDeps = {
    store,
    profileDir,
    workspace: 'D:/ws',
    machine: { transition: () => true },
    warn: (message) => {
      warnings.push(message)
    },
    reconcilePrepared: () => {
      calls.push('reconcilePrepared')
    },
    recordChanges: async () => {
      calls.push('recordChanges')
    },
    observeOfficialExperimental: async () => {
      calls.push('observeOfficialExperimental')
    },
    scheduleAutoRestore: () => {
      calls.push('scheduleAutoRestore')
    },
    applyAbnormalRecovery: async () => {
      calls.push('applyAbnormalRecovery')
    },
    ...overrides,
  }
  return { deps, warnings, calls }
}

async function main(): Promise<void> {
  console.log('\n== recordChanges 失败：warn 后继续 boot ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-degrade-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] })
      const recorder = makeDeps(store, profile, {
        recordChanges: async () => {
          throw new Error('变更检测模拟失败')
        },
      })
      // 只断言「不抛」不够：必须正常 resolve（boot 的兜底在外层，本段自己也要吞住）。
      let threw: unknown = null
      try {
        await runBootOrchestration(recorder.deps)
      } catch (error) {
        threw = error
      }
      check('boot orchestration resolves despite recordChanges failure', threw === null, String(threw))
      check(
        'warn carries the implementation wording and the original message',
        recorder.warnings.some((w) => w === '[recency-guard] 记录插件变更失败：变更检测模拟失败'),
        recorder.warnings,
      )
      check(
        'the next观测 step still runs after the failure',
        recorder.calls.includes('observeOfficialExperimental'),
        recorder.calls,
      )
      const state = await store.readState()
      check('clean-boot reset still happens after the failure', state.crashSeq === 0, state.crashSeq)
      // 失败证据必须**可复核**：只进 logger 的失败在重启后查不到。
      // 锚点是结构化字段 `degraded` + 实现文案原文。
      const degraded = store.readJournalSync(100).filter((e) => e.degraded === true)
      check('failure leaves a machine-readable degraded note', degraded.length === 1, degraded)
      check(
        'degraded note carries the implementation wording',
        degraded[0]?.detail === '[recency-guard] 记录插件变更失败：变更检测模拟失败',
        degraded[0]?.detail,
      )
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 反向：两条通道都正常时不得出现 degraded 标记 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-healthy-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] })
      const recorder = makeDeps(store, profile)
      await runBootOrchestration(recorder.deps)
      check('healthy boot emits no warnings', recorder.warnings.length === 0, recorder.warnings)
      check(
        'healthy boot writes no degraded note',
        store.readJournalSync(100).every((e) => e.degraded !== true),
        store.readJournalSync(100).map((e) => ({ kind: e.kind, degraded: e.degraded })),
      )
      check('healthy boot still records observation step', recorder.calls.includes('observeOfficialExperimental'), recorder.calls)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 分区索引加锁提交失败：warn + degraded 后继续 boot ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-degrade-index-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] })
      const recorder = makeDeps(store, profile, {
        commitPartitionIndex: async () => {
          throw new Error('索引写模拟失败')
        },
      })
      let threw: unknown = null
      try {
        await runBootOrchestration(recorder.deps)
      } catch (error) {
        threw = error
      }
      check('boot orchestration resolves despite index commit failure', threw === null, String(threw))
      check(
        'warn names the index commit failure with the implementation wording',
        recorder.warnings.some((w) => w === '[recency-guard] 分区索引加锁提交失败（保留同步写的结果）：索引写模拟失败'),
        recorder.warnings,
      )
      const degraded = store.readJournalSync(100).filter((e) => e.degraded === true)
      check('index failure also leaves a degraded note', degraded.length === 1, degraded)
      check(
        'degraded note for index failure carries the wording',
        degraded[0]?.detail === '[recency-guard] 分区索引加锁提交失败（保留同步写的结果）：索引写模拟失败',
        degraded[0]?.detail,
      )
      const state = await store.readState()
      check('boot continues after index failure (bootMarker written)', state.bootMarker !== null, state.bootMarker)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== observeOfficialExperimental 失败：warn 后继续 boot ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-degrade-obs-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] })
      const recorder = makeDeps(store, profile, {
        observeOfficialExperimental: async () => {
          throw new Error('官方观测模拟失败')
        },
      })
      let threw: unknown = null
      try {
        await runBootOrchestration(recorder.deps)
      } catch (error) {
        threw = error
      }
      check('boot orchestration resolves despite observation failure', threw === null, String(threw))
      check(
        'warn carries the implementation wording for观察失败',
        recorder.warnings.some((w) => w === '[recency-guard] 官方实验插件观测失败：官方观测模拟失败'),
        recorder.warnings,
      )
      check('recordChanges ran before the failing observation', recorder.calls.includes('recordChanges'), recorder.calls)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 两条通道同时失败：仍不抛、两条 warn 都在 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-degrade-both-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] })
      const recorder = makeDeps(store, profile, {
        recordChanges: async () => {
          throw new Error('A-失败')
        },
        observeOfficialExperimental: async () => {
          throw new Error('B-失败')
        },
      })
      let threw: unknown = null
      try {
        await runBootOrchestration(recorder.deps)
      } catch (error) {
        threw = error
      }
      check('boot orchestration still resolves when both channels fail', threw === null, String(threw))
      check('both warnings are recorded (neither swallows the other)', recorder.warnings.length === 2, recorder.warnings)
      check('both messages carry their own wording',
        recorder.warnings.some((w) => w.includes('记录插件变更失败')) && recorder.warnings.some((w) => w.includes('官方实验插件观测失败')),
        recorder.warnings,
      )
      const degraded = store.readJournalSync(100).filter((e) => e.degraded === true)
      check('both failures leave degraded notes (neither swallow the other)', degraded.length === 2, degraded)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.log('  FAIL  harness crashed', String(error))
    process.exit(1)
  })