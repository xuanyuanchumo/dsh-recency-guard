import { renderOutcome, formatStatus, formatHistory, formatRecover, formatRestore, formatReenable, formatBackups, formatArchive, formatArchives, formatReload, type ToolOutcome } from './tool-render.ts'
import type { Store, JournalEvent } from '../data/store.ts'
import { auditEnvelope } from '../core/change-guard.ts'

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
  /** 请求宿主热重载本插件（v0.20.0；同步编排，返回三态结果）。 */
  reloadSelf(force: boolean, reason: string): unknown
  store: Pick<Store, 'readJournal' | 'listBackups' | 'listVersionedBackupBundles' | 'append'>
}

/** handler 统一签名：args 已由调用方按 action 收窄。 */
type Handler = (deps: ToolDispatchDeps, args: { bundle?: string; limit?: number; reason?: string; force?: boolean }) => Promise<ToolOutcome>

/** 会改变宿主状态的 action（v0.12 审计面）。
 *
 * 为什么只审计这几个：L4 全自主模式下人类只在**事后**看审计线，
 * 所以要被记录的是「改了什么」，不是「读了什么」。把 status/history
 * 也记进去会淹没信号（面板每 5s 轮询一次 = 频繁写日志），
 * 而真正的崩溃因果链反而被冲掉。
 */
const MUTATING_ACTIONS = new Set(['recover', 'restore', 'reenable', 'archive', 'reload'])

/** 只读 action（不写 journal）。 */
export function isMutatingAction(action: string): boolean {
  return MUTATING_ACTIONS.has(action)
}

/**
 * 调用类错误的**机器可读词表**（v0.20.0，取经 dsh-ops bash-runtime-failure）：
 * code + remedy。code 供模型/脚本按枚举分支；remedy 是「下一步怎么办」——
 * 一条只有文案没有补救的错误让人无从行动（「报错 ≠ 可行动」）。
 * 这些是**调用契约**错误（usage error），不是业务失败：宿主把它们当异常上抛。
 */
const TOOL_USAGE_ERRORS = {
  unknownAction: {
    code: 'RG_UNKNOWN_ACTION',
    remedy: '查看工具描述的 action 枚举，改用受支持的 action 重试。',
  },
  missingBundle: {
    code: 'RG_MISSING_BUNDLE',
    remedy: '带上目标插件的包名（bundle 参数）重试；包名可在 status 输出的 suspectRanking 里查。',
  },
} as const

/** 拼一条「[code] 文案 —— 补救：remedy」形态的错误（code 保持在最前，可被前缀匹配）。 */
function usageError(kind: keyof typeof TOOL_USAGE_ERRORS, detail: string): Error {
  const spec = TOOL_USAGE_ERRORS[kind]
  return new Error(`[${spec.code}] ${detail} 补救：${spec.remedy}`)
}

/**
 * 审计行的 journal kind 选择：复用既有的 `note`，而不是新开 `'audit'`。
 *
 * 为什么：journal 的 kind 是一张**跨层词汇表**（store 的 JournalKind、
 * observations 的 FlowAction、eventFlow 的渲染映射、面板的着色分组都要
 * 跟着改）。新开一个 kind 而漏掉任一处，审计行就在事件流里**消失** ——
 * 那条线比「少一个语义标签」危险得多。复用 note 保证它已经在所有
 * 消费链路上；审计语义靠 detail 前缀 + 结构化 `audit` 字段表达。
 * 真要独立成 kind，应当作为一次完整的词汇表演进单独做。
 */
function auditJournalEvent(action: string, args: { bundle?: string; reason?: string; force?: boolean }): JournalEvent {
  const envelope = auditEnvelope('tool', action, args.reason ?? args.bundle)
  return {
    kind: 'note',
    detail: `审计 · ${envelope.actor}/${envelope.action} · ${envelope.justification}`,
    // 结构化字段供后续按 actor/action 过滤（detail 是人读的，data 是机器读的）。
    audit: { ...envelope, bundle: args.bundle ?? null },
  }
}

/** action → handler 表。键的集合必须与工具 schema 的 enum 一致（契约测试核对）。 */
export const TOOL_ACTIONS: Record<string, Handler> = {
  status: async (deps) => formatStatus((await deps.status()) as never),
  history: async (deps, args) => formatHistory((await deps.store.readJournal(args.limit ?? 40)) as never),
  recover: async (deps) => formatRecover((await deps.recoverNow()) as { disabled: string[]; note: string }),
  restore: async (deps) => formatRestore((await deps.restore()) as { reenabled: string[]; keptDisabled: string[]; note: string }),
  reenable: async (deps, args) => {
    if (!args.bundle) throw usageError('missingBundle', 'reenable 需要 bundle 参数（插件包名）。')
    return formatReenable((await deps.reenable(args.bundle)) as {
      bundle: string
      reenabled: boolean
      hasConfigBackup: boolean
    })
  },
  backups: async (deps) => formatBackups(await deps.store.listBackups(), await deps.store.listVersionedBackupBundles()),
  archive: async (deps, args) => formatArchive((await deps.archiveReset(args.reason?.trim() || '工具触发归档重置')) as never),
  archives: async (deps) => formatArchives((await deps.archives()) as never),
  reload: async (deps, args) => formatReload(deps.reloadSelf(args.force === true, args.reason?.trim() || '工具请求热重载') as never),
}

/**
 * 分派入口：未知 action 抛错（工具层语义：调用错误不是业务失败）。
 *
 * 写动作先落一条**审计行再执行**（v0.12）：顺序是有意的 —— 崩溃发生在
 * 执行中间时，「谁以什么理由发起了这件事」已经在盘上。反过来（先执行
 * 后记录）会让最需要审计的那次失败恰好没有审计。
 *
 * @returns 规范 ToolOutcome；渲染由 output.render 投影（命令窗口显示文本）。
 */
export async function dispatchToolAction(
  deps: ToolDispatchDeps,
  action: string,
  args: { bundle?: string; limit?: number; reason?: string; force?: boolean },
): Promise<ToolOutcome> {
  const handler = TOOL_ACTIONS[action]
  if (handler === undefined) throw usageError('unknownAction', `未知操作：${String(action)}`)
  if (isMutatingAction(action)) {
    // 审计行写失败**不阻塞**动作：它是可观测性设施，不该有否决守护动作的权力
    // （CLAUDE.md：观测设施不拖垮守护流程）。
    try {
      await deps.store.append(auditJournalEvent(action, args))
    } catch {
      /* 降级：无审计行，但动作照做 */
    }
  }
  return handler(deps, args)
}

/** render 的统一桥（index.ts 的 output.render 引用它，保持单一生源）。 */
export function renderToolOutcome(value: unknown): string {
  return renderOutcome(value as ToolOutcome)
}
