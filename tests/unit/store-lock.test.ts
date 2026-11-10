/**
 * 写锁自愈回归（v0.11.1 紧急修复）。
 *
 * 真机事故：宿主崩溃恰好发生在锁文件创建与写入 PID 之间，遗留 0 字节
 * `state.json.lock`。atomic-write 的接管要求锁内有可读 PID，记录不完整
 * 的锁会被一直等待 → updateState 超时 → boot 重抛 → 宿主 fatal load
 * failure（DSH 起不来，连续 5 次）。
 *
 * 本文件钉死两条修复：
 * 1. `cleanStaleLocks` 只清理**失效**锁（空/非 PID/进程已死/超过年龄阈值），
 *    活锁与「刚创建」的锁一律保留（避免抢掉正在持有的写者）。
 * 2. `Store.updateState` 在锁超时后清理并重试一次 —— 陈旧锁不再致命。
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, cleanStaleLocks, isLockTimeout } from '../../src/host/data/store.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 把文件的 mtime 设成 N 秒前（模拟崩溃遗留）。 */
function ageFile(path: string, seconds: number): void {
  const t = new Date(Date.now() - seconds * 1000)
  utimesSync(path, t, t)
}

async function main() {
  console.log('\n== cleanStaleLocks：失效判据 ==')
  {
    const dir = mkdtempSync(join(tmpdir(), 'rg-lock-'))
    try {
      // 1) 0 字节 + 陈旧 ⇒ 清理
      const emptyOld = join(dir, 'state.json.lock')
      writeFileSync(emptyOld, '')
      ageFile(emptyOld, 3600)

      // 2) 活进程 PID + 陈旧 ⇒ 保留（可能是真持有者）
      const liveLock = join(dir, 'decision.json.lock')
      writeFileSync(liveLock, `${process.pid}\n`)
      ageFile(liveLock, 3600)

      // 3) 刚创建的空锁 ⇒ 保留（创建窗口竞态）
      const freshEmpty = join(dir, 'fresh.json.lock')
      writeFileSync(freshEmpty, '')

      // 4) 死 PID + 陈旧 ⇒ 清理（提前接管，少等一次超时）
      const deadLock = join(dir, 'dead.json.lock')
      writeFileSync(deadLock, '999999\n')
      ageFile(deadLock, 3600)

      const report = cleanStaleLocks(dir)
      check('empty stale lock is removed', report.removed.includes('state.json.lock'), report)
      check('live-PID lock is kept', report.kept.includes('decision.json.lock'), report)
      check('fresh empty lock is kept (race safety)', report.kept.includes('fresh.json.lock'), report)
      check('dead-PID lock is removed', report.removed.includes('dead.json.lock'), report)
      check('the stale lock file is gone from disk', !existsSync(emptyOld))
      check('the live lock file stays on disk', existsSync(liveLock))
      check('non-lock files are untouched', !report.removed.some((n) => !n.endsWith('.lock')), report)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n== updateState：陈旧锁自愈 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-profile-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      // 模拟上一次崩溃遗留：0 字节锁 + 陈旧 mtime
      const lock = join(store.partitionPath, 'state.json.lock')
      writeFileSync(lock, '')
      ageFile(lock, 3600)
      const before = await store.readState()
      const after = await store.updateState((s) => ({ ...s, crashSeq: before.crashSeq + 1 }))
      check('updateState succeeds despite the stale lock', after.crashSeq === before.crashSeq + 1, after.crashSeq)
      check('the stale lock is cleared after the update', !existsSync(lock))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== isLockTimeout：定向识别 ==')
  {
    check('recognizes the atomic-write lock timeout message', isLockTimeout(new Error('atomic-write: timed out waiting for the writer lock at /x')))
    check('ignores unrelated errors', !isLockTimeout(new Error('EACCES: permission denied')))
    check('ignores non-errors', !isLockTimeout('timeout'))
  }

  console.log(failures === 0 ? '\nstore-lock 全部通过\n' : `\n${failures} 个断言失败\n`)
  if (failures > 0) process.exit(1)
}

await main()