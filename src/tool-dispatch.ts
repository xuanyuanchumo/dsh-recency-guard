import { renderOutcome, formatStatus, formatHistory, formatRecover, formatRestore, formatReenable, formatBackups, formatArchive, formatArchives, type ToolOutcome } from './tool-render.js'
import type { Store } from './store.js'

/**
 * `recency_guard` 工具的 action 分派（v0.8.1 从 index.ts 抽出）。
 *
 * ## 为什么表驱动而不是 switch
 *
 * 复杂度预算：apply() 里内联 switch 让 index.ts 到 125（预算 100）。
 * 分派本质是「action → handler」的映射，写成表之后：
 * - 新增 action = 加一行表项（Loader 四件套不动）；
 * - 契约测试可以直接从表里数 actions 与 TOOL_SURFACE 对账（比正则扒源码稳）；
 * - 分支消失，index.ts 只剩一次查表 + 一次调用。
 *
 * handler 的入参是 Guard 与 Store 的**窄接口**（结构化类型，不是整个类）：
 * 测试时不用桩整个 Guard，给两个方法就够。
 */
export interface ToolDispatchDeps {
  status(): Promise<unknown>
  // Guard 的方法声明返回 Promise<unknown>（历史签名）；分派表在 handler 内
  // 用窄类型接收，formatXxx 端已有 as never 收窄 —— 这里不再二次断言，
  // 让 unknown 直接流入，避免双层类型谎言。
  recoverNow(): Promise<unknown>
  restore(): Promise<unknown>
  reenable(bundle: string): Promise<unknown>
  archiveReset(reason: string): Promise<unknown>
  archives(): Promise<unknown>
  store: Pick<Store, 'readJournal' | 'listBackups' | 'listVersionedBackupBundles'>
}

/** handler 统一签名：args 已由调用方按 action 收窄。 */
type Handler = (deps: ToolDispatchDeps, args: { bundle?: string; limit?: number; reason?: string }) => Promise<ToolOutcome>

/** action → handler 表。键的集合必须与工具 schema 的 enum 一致（契约测试核对）。 */
export const TOOL_ACTIONS: Record<string, Handler> = {
  status: async (deps) => formatStatus((await deps.status()) as never),
  history: async (deps, args) => formatHistory((await deps.store.readJournal(args.limit ?? 40)) as never),
  recover: async (deps) => formatRecover((await deps.recoverNow()) as { disabled: string[]; note: string }),
  restore: async (deps) => formatRestore((await deps.restore()) as { reenabled: string[]; keptDisabled: string[]; note: string }),
  reenable: async (deps, args) => {
    if (!args.bundle) throw new Error('reenable 需要 bundle 参数（插件包名）。')
    return formatReenable((await deps.reenable(args.bundle)) as {
      bundle: string
      reenabled: boolean
      hasConfigBackup: boolean
    })
  },
  backups: async (deps) => formatBackups(await deps.store.listBackups(), await deps.store.listVersionedBackupBundles()),
  archive: async (deps, args) => formatArchive((await deps.archiveReset(args.reason?.trim() || '工具触发归档重置')) as never),
  archives: async (deps) => formatArchives((await deps.archives()) as never),
}

/**
 * 分派入口：未知 action 抛错（工具层语义：调用错误不是业务失败）。
 *
 * @returns 规范 ToolOutcome；渲染由 output.render 投影（命令窗口显示文本）。
 */
export async function dispatchToolAction(deps: ToolDispatchDeps, action: string, args: { bundle?: string; limit?: number; reason?: string }): Promise<ToolOutcome> {
  const handler = TOOL_ACTIONS[action]
  if (handler === undefined) throw new Error(`未知操作：${String(action)}`)
  return handler(deps, args)
}

/** render 的统一桥（index.ts 的 output.render 引用它，保持单一生源）。 */
export function renderToolOutcome(value: unknown): string {
  return renderOutcome(value as ToolOutcome)
}
