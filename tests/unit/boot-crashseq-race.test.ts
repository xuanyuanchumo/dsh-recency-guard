/**
 * 启动期的 crashSeq 竞争（T14-08 真机缺陷修复的回归）。
 *
 * ## 症状（真实故障注入观测到的那一半）
 *
 * `missing-dep-required` 偶发失败，另一条症状是 `state.crashSeq=0`，
 * 而退出处理器明明已经写过 `crashSeq=1`。根因是 boot 末尾的「干净启动归零」
 * 无条件写 0：boot 是异步的，它的 `updateState` 可能在崩溃之后才拿到执行权
 * （进程退出时挂起的锁等待仍可能落地），于是把刚写下的崩溃计数抹掉。
 *
 * 后果不是「少记一次」，而是**崩溃循环失去升级依据**：每轮都被当成干净启动，
 * 永远停在「关 0 个」——正是本插件要防的那个场景。
 *
 * 修法：归零改成 CAS（只在与本轮启动时读到的一致时归零）。本文件钉住：
 * 1. 崩溃在 boot 期间落地 ⇒ 计数不被归零；
 * 2. 真正的干净启动（无新崩溃）⇒ 计数仍照常归零（不要为了修竞态把功能关掉）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/host/data/store.ts'
import { runBootOrchestration, type BootOrchestrationDeps } from '../../src/host/guard/boot-orchestration.ts'

/** 写一个哨兵文件（store 没有暴露这个写入口，测试直接按文件协议造现场）。 */
function writeStateSyncFixture(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
}

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造最小 orchestration 依赖（其余回调全是 no-op）。 */
function deps(store: Store, profileDir: string, overrides: Partial<BootOrchestrationDeps> = {}): BootOrchestrationDeps {
  return {
    store,
    profileDir,
    workspace: 'D:/ws',
    machine: { transition: () => true },
    warn: () => undefined,
    reconcilePrepared: () => undefined,
    recordChanges: async () => undefined,
    observeOfficialExperimental: async () => undefined,
    scheduleAutoRestore: () => undefined,
    applyAbnormalRecovery: async () => undefined,
    ...overrides,
  }
}

async function main(): Promise<void> {
  console.log('\n== 崩溃在 boot 期间落地 ⇒ 计数不被归零 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-race-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      // 干净起点：crashSeq=0、无哨兵、无残留 bootMarker。
      await store.writeState({ bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] })
      const base = deps(store, profile)
      await runBootOrchestration({
        ...base,
        // 模拟「recordChanges 期间插件把宿主撞死」：退出处理器此刻写下了 crashSeq=1。
        recordChanges: async () => {
          await store.updateState((s) => ({ ...s, crashSeq: 1 }))
        },
      })
      const state = await store.readState()
      check('crashSeq written during boot survives the clean-boot reset', state.crashSeq === 1, state.crashSeq)
      check('boot marker is still cleared on this boot', state.bootMarker !== null, state.bootMarker)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 真正的干净启动 ⇒ 计数照常归零 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-clean-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: null, crashSeq: 2, autoDisabled: [], stabilized: false, restored: [] })
      const base = deps(store, profile)
      await runBootOrchestration({ ...base })
      const state = await store.readState()
      check('clean boot resets the counter to zero', state.crashSeq === 0, state.crashSeq)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 有哨兵的恢复轮：计数保持（不清零） ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-boot-sentinel-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState({ bootMarker: { startedAt: 't', pid: 999999 }, crashSeq: 1, autoDisabled: [{ name: 'suspect-x', disabledAt: 't', reason: 'auto-recency', crashSeq: 1 }], stabilized: false, restored: [] })
      mkdirSync(store.partitionPath, { recursive: true })
      writeStateSyncFixture(join(store.partitionPath, 'crashed'), JSON.stringify({ at: '2026-11-11T00:00:00.000Z', exitCode: 1, pid: 999999 }))
      const base = deps(store)
      await runBootOrchestration({ ...base, profileDir: profile })
      const state = await store.readState()
      check('recovery boot keeps crashSeq at 1', state.crashSeq === 1, state.crashSeq)
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