import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 失效写锁的清理（T14-05，从 store.ts 纯提取）。
 *
 * ## 为什么单独成文件
 *
 * 这段与「数据存取」不是一回事：它只关心**锁卫生**（崩溃遗留的锁、
 * 记录不完整的锁、被活进程持有的锁），判据密集（空/非 PID/已死/太新/EPERM），
 * 而 store.ts 的复杂度预算已经贴近上限。搬出来之后两头都更清楚：
 * store 只做读写，锁卫生只有一条入口。
 *
 * ## 真机事故（为什么这些判据一条都不能少）
 *
 * 宿主崩溃恰好发生在锁文件创建与写入 PID 之间，留下 0 字节 state.json.lock。
 * atomic-write 的接管要求锁内有可读 PID，记录不完整的锁会被一直等待 →
 * updateState 超时 → boot 重抛 → 宿主 fatal load failure（DSH 起不来，连续 5 次）。
 * 另外 `process.kill(0, 0)` 在 POSIX 上成功（= 当前进程组），所以 pid=0
 * 的锁**不是**「活进程持有」——它必须被当不完整记录清掉。
 */
/**
 * 陈旧写锁的最小年龄（毫秒）。
 *
 * 比它年轻的锁一律不清理：锁文件由 `writeFile(..., {flag:'wx'})` 创建后
 * 立刻写入 PID，两者之间存在一个**极短的零字节窗口** —— 此时清理会把
 * 正在创建的锁删掉，两个写者就会同时持锁。5 秒的窗口远大于该间隙，
 * 又远小于「崩溃遗留」的时间尺度（实测遗留锁已数小时）。
 */
const STALE_LOCK_MIN_AGE_MS = 5_000

/** 陈旧锁清理结果（可观测：清了什么、留了什么、为什么）。 */
export interface StaleLockReport {
  /** 被清理的锁文件名。 */
  removed: string[]
  /** 保留的锁文件名（可能仍被活进程持有，或太新）。 */
  kept: string[]
}

/** 进程是否存活（EPERM = 存在但无权探测，按存活处理）。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 清理**失效的写锁**（v0.11.1 紧急修复）。
 *
 * 背景（真机实锤）：宿主崩溃恰好发生在锁文件创建与写入 PID 之间，留下
 * 一个 **0 字节的 `state.json.lock`**。`@deepseek-ai/dsh-atomic-write` 的
 * 接管逻辑只在锁里**有可读 PID 且进程已死**时才删除；记录不完整的锁
 * 会被一直等待，2 秒后超时抛错 —— 而该错误发生在 `boot()` 里，直接成了
 * 宿主 `fatal load failure`（DSH 起不来）。守护设施绝不能把主流程拖死。
 *
 * 清理判据（任一成立且超过年龄阈值）：
 * - 锁内容为空 / 不是正整数 PID（不完整记录，永远无法被接管）；
 * - PID 对应的进程不存在（等价于库的接管语义，提前做掉少等 2 秒）；
 * - 其余保留（可能真被活进程持有 —— 那种情况必须等，不能抢）。
 */
export function cleanStaleLocks(dir: string, now = Date.now()): StaleLockReport {
  const report: StaleLockReport = { removed: [], kept: [] }
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return report
  }
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs < STALE_LOCK_MIN_AGE_MS) {
        report.kept.push(name)
        continue
      }
      let text = ''
      try {
        text = readFileSync(path, 'utf8').trim()
      } catch {
        report.kept.push(name)
        continue
      }
      const pid = Number(text)
      const incomplete = text === '' || !Number.isInteger(pid) || pid <= 0
      if (!incomplete && processAlive(pid)) {
        report.kept.push(name)
        continue
      }
      rmSync(path, { force: true })
      report.removed.push(name)
    } catch {
      report.kept.push(name)
    }
  }
  return report
}

/** 判断一个错误是否是写锁超时（用于「清理后重试一次」的定向处理）。 */
export function isLockTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes('timed out waiting for the writer lock')
}
