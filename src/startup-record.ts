/**
 * 启动期的**同步记录**（v0.13 从 index.ts 抽出以控复杂度）。
 *
 * ## 为什么必须是同步
 *
 * 这段跑在 `apply()` 的最前面，**在任何 await 之前**。理由不是性能而是正确性：
 * 本插件守护的崩溃可能就在同一次启动里发生（等待被加载的坏插件），
 * 一旦 await，进程死掉时这段就没执行完 —— 于是「谁最可疑」的原始证据全丢。
 *
 * 它依次做四件事，每件都是**为下一条路径准备输入**：
 *
 * 1. `installGuardedRows`：把守护行写进 profile patch。必须在任何插件模块被
 *    import **之前**完成，否则坏插件已经加载了，拦截无从谈起。
 * 2. `readSentinel`：上一轮若崩溃，哨兵在场 ⇒ 记一条 `crash-detected`。
 * 3. `diffVersions`：把「当前版本映射」与上次快照对比，得出 install/update 事实。
 *    这是 recency 排名的**权威数据源**（journal 事件），不是 mtime 引导值。
 * 4. `writeSnapshotSync`：把当前版本存为下次对比的基线。
 *
 * ## 为什么单独成模块
 *
 * 它是 index.ts 里 try/catch 分支最密集的一段（5 个条件分支 + 循环 + 步骤留痕），
 * 与 `bootInner()`（异步编排）没有控制依赖 —— 只是「先跑完它，再进入异步流程」。
 * 抽出来后 `recordStartupSync()` 在 index.ts 里只剩一次委托调用。
 */

import { bundleVersionsSync, type Store } from './store.js'
import { diffVersions } from './recency.js'
import { installGuardedRows } from './guarded-rows.js'
import { readSentinel } from './sentinel.js'

/** 启动记录所需的窄依赖（注入而非持有 Guard，便于单测）。 */
export interface StartupRecordDeps {
  profileDir: string
  patchPath: string
  store: Store
  /** 步骤留痕（同步）。 */
  recordStep: (name: 'install-guarded-rows' | 'startup-record', ok: boolean, reason: string) => void
  /** 当前进程 pid（注入便于测试与去噪）。 */
  pid: number
}

/** 启动记录的产物摘要（供调用方写日志/断言）。 */
export interface StartupRecordResult {
  /** 守护行新增/跳过数。 */
  added: number
  skipped: number
  /** 守护行安装是否被阻断（false = 安装失败，已留痕）。 */
  installed: boolean
  /** 上一轮是否留下崩溃哨兵。 */
  crashed: boolean
  /** install / update 事件数。 */
  installs: number
  updates: number
}

/**
 * 执行启动记录（同步，best-effort）。
 *
 * 任何一步失败都只留痕不抛 —— journal 与守护行安装绝不能让宿主启动失败
 * （v0.11.1 的 P0 教训：一个可恢复的写锁超时曾把宿主变成 fatal load failure）。
 */
export function recordStartup(deps: StartupRecordDeps): StartupRecordResult {
  const result: StartupRecordResult = {
    added: 0,
    skipped: 0,
    installed: false,
    crashed: false,
    installs: 0,
    updates: 0,
  }
  try {
    deps.store.appendSync({ kind: 'note', detail: `dsh 启动 pid=${deps.pid}` })

    const installed = installGuardedRows(deps.profileDir, deps.patchPath)
    result.added = installed.added.length
    result.skipped = installed.skipped.length
    result.installed = installed.blocked === undefined
    deps.recordStep(
      'install-guarded-rows',
      result.installed,
      installed.blocked ?? `新增 ${result.added} 行 / 跳过 ${result.skipped} 行`,
    )
    if (installed.added.length > 0) {
      deps.store.appendSync({
        kind: 'note',
        detail: `已安装守护行：${installed.added.map((r) => `${r.rowId} (${r.bundleName})`).join(', ')}`,
      })
    }

    const sentinel = readSentinel(deps.store.partitionPath)
    result.crashed = sentinel !== null
    if (sentinel) {
      deps.store.appendSync({
        kind: 'crash-detected',
        detail: `上次运行以退出码 ${sentinel.exitCode} 结束`,
        exitCode: sentinel.exitCode,
        at: sentinel.at,
      })
    }

    const current = bundleVersionsSync(deps.profileDir)
    const previous = deps.store.readSnapshotSync()
    const { install, update } = diffVersions(previous, current)
    result.installs = install.length
    result.updates = update.length
    for (const i of install) deps.store.appendSync({ kind: 'install', bundle: i.name, version: i.version })
    for (const u of update) {
      deps.store.appendSync({ kind: 'update', bundle: u.name, version: u.to, prevVersion: u.from })
    }
    deps.store.writeSnapshotSync(current)

    deps.recordStep(
      'startup-record',
      true,
      `崩溃哨兵 ${sentinel ? `退出码 ${sentinel.exitCode}` : '无'}；安装 ${result.installs} / 更新 ${result.updates}`,
    )
  } catch (error) {
    // best effort：journal 绝不能让宿主启动失败。
    deps.recordStep('startup-record', false, error instanceof Error ? error.message : String(error))
  }
  return result
}
