/**
 * `guard/startup-record.ts` 直接单测（T15-04）。
 *
 * 为什么补这条：启动记录是「在任何 await 之前」必须跑完的同步路径，它的
 * best-effort 兜底（任何一步失败只留痕不抛）没有任何直接测试 ⇒ try/catch
 * 变异体从未进池。host 的 StartupRecordDeps 本来就是窄注入接口，用桩 store
 * 就能驱动，不需要真机。
 *
 * 覆盖边界（不假装覆盖）：`installGuardedRows` 走真实实现（空 profile ⇒
 * 0 行），但**不**覆盖真实 dsh 的 patch 写入（那在 guarded-rows 自己的测试）；
 * `bundleVersionsSync` 的真实 npm 布局用临时空 profile 代替。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordStartup, type StartupRecordDeps } from '../../src/host/guard/startup-record.js'
import type { JournalEvent, JournalRecord, Store } from '../../src/host/data/store.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

interface FakeStore {
  events: JournalEvent[]
  steps: Array<{ name: string; ok: boolean; reason: string }>
  throwOnAppend: boolean
  snapshot: Record<string, string>
}

function fakeStore(state: FakeStore, partitionPath: string): Store {
  return {
    appendSync: (event: JournalEvent) => {
      if (state.throwOnAppend) throw new Error('append boom')
      state.events.push(event)
    },
    readSnapshotSync: () => state.snapshot,
    writeSnapshotSync: (next: Record<string, string>) => {
      state.snapshot = next
      state.events.push({ kind: 'note', detail: `snapshot ${Object.keys(next).length}` })
    },
    partitionPath,
  } as unknown as Store
}

const root = await mkdtemp(join(tmpdir(), 'rg-startup-record-'))
try {
  console.log('\n== 空 profile：四步都跑、但不制造噪声 ==')
  {
    const profile = join(root, 'profile-a')
    mkdirSync(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }), 'utf8')
    const state: FakeStore = { events: [], steps: [], throwOnAppend: false, snapshot: {} }
    const deps: StartupRecordDeps = {
      profileDir: profile,
      patchPath: join(profile, 'cordis.patch.yml'),
      store: fakeStore(state, join(profile, '.recency-guard', 'projects', 'k')),
      recordStep: (name, ok, reason) => state.steps.push({ name, ok, reason }),
      pid: 4242,
    }
    let threw: unknown
    let result: ReturnType<typeof recordStartup> | undefined
    try {
      result = recordStartup(deps)
    } catch (error) {
      threw = error
    }
    check('空 profile 的启动记录不抛', threw === undefined, threw)
    check('记录启动 pid', state.events.some((e) => e.kind === 'note' && String(e.detail).includes('pid=4242')), state.events)
    check('守护行安装成功（空 profile ⇒ 0 行但 installed:true）', result?.installed === true && result?.added === 0 && result?.skipped === 0, result)
    check('没有新增行时不写「已安装守护行」噪声 note', !state.events.some((e) => String(e.detail).includes('已安装守护行')), state.events)
    check('两个步骤都留痕（install-guarded-rows / startup-record）', state.steps.map((s) => s.name).join(',') === 'install-guarded-rows,startup-record', state.steps)
    check('快照被写回（下次对比的基线）', state.events.some((e) => String(e.detail).startsWith('snapshot ')), state.events)
  }

  console.log('\n== 哨兵在场：记 crash-detected 且报告 crashed ==')
  {
    const profile = join(root, 'profile-b')
    mkdirSync(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }), 'utf8')
    const partition = join(profile, '.recency-guard', 'projects', 'k')
    mkdirSync(partition, { recursive: true })
    // sentinel 文件名即 SENTINEL_NAME（crashed）；直接断言 recordStartup 读它。
    writeFileSync(join(partition, 'crashed'), JSON.stringify({ exitCode: 1, at: '2026-11-11T00:00:00.000Z', pid: 9 }), 'utf8')
    const state: FakeStore = { events: [], steps: [], throwOnAppend: false, snapshot: {} }
    const result = recordStartup({
      profileDir: profile,
      patchPath: join(profile, 'cordis.patch.yml'),
      store: fakeStore(state, partition),
      recordStep: (name, ok, reason) => state.steps.push({ name, ok, reason }),
      pid: 1,
    })
    check('上一轮哨兵 ⇒ crashed:true', result.crashed === true, result)
    const crashEvent = state.events.find((e) => e.kind === 'crash-detected')
    check('写出 crash-detected 且带退出码', crashEvent?.exitCode === 1 && String(crashEvent?.detail).includes('退出码 1'), crashEvent)
  }

  console.log('\n== best effort：任何一步失败都不抛，只把步骤标 false ==')
  {
    const profile = join(root, 'profile-c')
    mkdirSync(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }), 'utf8')
    const state: FakeStore = { events: [], steps: [], throwOnAppend: true, snapshot: {} }
    let threw: unknown
    let result: ReturnType<typeof recordStartup> | undefined
    try {
      result = recordStartup({
        profileDir: profile,
        patchPath: join(profile, 'cordis.patch.yml'),
        store: fakeStore(state, join(profile, '.recency-guard', 'projects', 'k')),
        recordStep: (name, ok, reason) => state.steps.push({ name, ok, reason }),
        pid: 7,
      })
    } catch (error) {
      threw = error
    }
    check('appendSync 抛错时 recordStartup 不抛（宿主启动不能被 journal 拖垮）', threw === undefined, threw)
    check('失败被记成 startup-record:false', state.steps.some((s) => s.name === 'startup-record' && s.ok === false), state.steps)
    check('失败原因进 recordStep（可诊断）', state.steps.some((s) => s.name === 'startup-record' && s.reason.includes('append boom')), state.steps)
    check('返回值仍是合法摘要（不返回 undefined）', result !== undefined && typeof result.installed === 'boolean', result)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)