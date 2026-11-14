/**
 * 重载史账域（cycle-18，取经 dsh-anic reloadHistory.ts）：
 * `.recency-guard/reload-history.json` 的读写与跨实例握手落定。
 *
 * ## 为什么先落 in-flight（本模块存在的核心理由）
 *
 * `hmr.reconcileProfile` 会卸载/替换本插件实例，之后本进程写的任何东西都可能
 * 丢失 —— 事后没有任何进程能补写「我请求过重载」。所以请求方必须**先**写
 * `status:'in-flight'` 条目，重载后的**新实例**在启动时调 `finalizeInFlight`
 * 把它补成 `reloaded`。这不是日志，是**跨实例状态机**：少了 in-flight，
 * 真发生重载时史账会显示成「什么都没发生」—— 最坏的静默失败。
 *
 * ## 与 anic 实现的两处适配（不是照抄）
 *
 * 1. **落点不同**：anic 放工作区 `.cycles/`（它的工作单元是「循环」）；
 *    本插件的持久事实都在 profile 分区目录（`.recency-guard/projects/<key>/`），
 *    重载史与崩溃决策是同一性质的本机事实 —— 分区隔离让它天然不串项目。
 * 2. **产物名不同**：本仓 host 产物是 `dist/index.js`（DSH main 字段指向它），
 *    指纹比对由调用方（build-freshness 域）完成，这里只管史账本身。
 *
 * ## 三条写盘纪律（与 anic 同源）
 *
 * 1. 原子写（tmp + rename，走本仓 writeFileAtomicSync —— 顺带获得 fsync 幸存性）；
 * 2. 有界 FIFO 50：留够最近若干次，又不让文件无限长（dropped 让调用方如实记账）；
 * 3. 损坏文件先改名 `.corrupt` 备份再重建 —— **静默销毁证据不允许**。
 *
 * ## 幂等语义
 *
 * `finalizeInFlight` 只在「最后一条确为 in-flight」时改写，否则返回 null 且
 * **零写入**。于是「正常启动调用一次」不污染历史，「重复调用」不产生第二个结局。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../core/atomic-sync.ts'

/** 重载史文件名（放分区目录下；跨实例共享的握手面）。 */
export const RELOAD_HISTORY_FILE = 'reload-history.json'
/** 有界 FIFO：够看清最近若干次重载，又不让文件无限长。 */
export const RELOAD_HISTORY_LIMIT = 50

/**
 * 一次重载请求的留痕条目（in-flight → reloaded / failed / refused 的跨实例状态机）。
 *
 * `refused` / `unavailable` 也落史账（与 anic 的差异：本插件的守护决策讲究
 * 「执行一定要有操作记录」，被拒绝的请求本身是可复核的执行事实）；
 * 唯独 `unavailable` 在 hmr 服务缺席时**零写入** —— 没有发生任何事就不伪造活动痕迹。
 */
export interface ReloadHistoryEntry {
  at: string
  /** 请求来源（工具 action 名 / 路由名）。 */
  actor: string
  /** 为什么重载（必填；空串按「未说明」落账，不编造理由）。 */
  reason: string
  status: 'in-flight' | 'reloaded' | 'refused' | 'failed'
  /** 请求时运行实例的 revision（null = 未知 —— 未知放行，不阻拦）。 */
  fromRevision: string | null
  /** 完成时观测到的 revision（仅 reloaded 有意义）。 */
  toRevision: string | null
  /** 请求时 dist 是否已过期（true = 请求方被警告过先 build）。 */
  staleAtRequest: boolean
  warnings: string[]
  error: string | null
  finalizedAt?: string
}

/** 历史文件绝对路径。 */
function historyPath(dir: string): string {
  return join(dir, RELOAD_HISTORY_FILE)
}

/** 读重载史。缺失 → 空数组 + 无错误；损坏 → 空数组 + **响亮**错误（绝不抛）。 */
export function readReloadHistory(dir: string): { entries: ReloadHistoryEntry[]; error: string | null } {
  const path = historyPath(dir)
  if (!existsSync(path)) return { entries: [], error: null }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return { entries: [], error: `${RELOAD_HISTORY_FILE} is not a JSON array` }
    return { entries: parsed as ReloadHistoryEntry[], error: null }
  } catch (error) {
    return { entries: [], error: `${RELOAD_HISTORY_FILE} is corrupt: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 原子写整份史账；失败返回 false（不吞异常语义，由调用方决定降级）。 */
function writeHistory(dir: string, entries: ReloadHistoryEntry[]): boolean {
  try {
    writeFileAtomicSync(historyPath(dir), `${JSON.stringify(entries, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * 追加一条重载史（有界 FIFO 50）。
 * 损坏文件先改名 `.corrupt` 备份再重建 —— 覆盖允许，静默销毁证据不允许。
 */
export function appendReloadHistory(dir: string, entry: ReloadHistoryEntry): { ok: boolean; dropped?: number } {
  const read = readReloadHistory(dir)
  if (read.error !== null) {
    try {
      renameSync(historyPath(dir), `${historyPath(dir)}.corrupt`)
    } catch {
      /* 备份失败不阻断追加 */
    }
  }
  const entries = [...read.entries, entry]
  const dropped = Math.max(0, entries.length - RELOAD_HISTORY_LIMIT)
  const kept = dropped > 0 ? entries.slice(dropped) : entries
  const ok = writeHistory(dir, kept)
  return dropped > 0 ? { ok, dropped } : { ok }
}

/**
 * 跨实例握手落定：把最后一条 in-flight 改写成 reloaded。
 *
 * 只有「最后一条是 in-flight」时才写（返回新条目）；否则返回 null 且**零写入** ——
 * 幂等正是它的价值：新实例启动正常调用不污染历史，重复调用不产生第二个结局。
 */
export function finalizeInFlight(dir: string, observedRevision: string | null): ReloadHistoryEntry | null {
  const { entries } = readReloadHistory(dir)
  const last = entries[entries.length - 1]
  if (last === undefined || last.status !== 'in-flight') return null
  const finalized: ReloadHistoryEntry = {
    ...last,
    status: 'reloaded',
    toRevision: observedRevision,
    finalizedAt: new Date().toISOString(),
  }
  const next = [...entries.slice(0, -1), finalized]
  return writeHistory(dir, next) ? finalized : null
}
