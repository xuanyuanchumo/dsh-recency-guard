/**
 * 重载编排域（cycle-18，取经 dsh-anic reloadOrchestrator 三铁律）：
 * 探测 hmr → 判据 → **先落 in-flight** → 触发。
 *
 * ## 被修的缺口（ref-study 差距清单 #1，实测不是推测）
 *
 * 本插件已有 `build-freshness` 判据（v0.19）但**没有重载动作**：改完代码后
 * 宿主仍跑旧 dist，用户只能人工重启宿主。桌面 profile 的 `@deepseek-ai/dsh-hmr`
 * 服务提供 `reconcileProfile`（重载 profile 内磁盘文件已变的插件），本插件
 * 从不消费它 —— 宿主把能力注册了，插件不用，等于没有。
 *
 * ## 三条铁律（每条对应一个真实失败形态，anic cycle-80/81 实证）
 *
 * 1) **in-flight 先落盘再触发**：`reconcileProfile` 会替换本实例，事后没人能写
 *    「请求过重载」。顺序若反过来，真发生重载时史账是空的。
 * 2) **setTimeout 不 await**：本实例即将被替换，await 的续体可能永不执行，
 *    还会把调用方挂住。触发后立刻返回 `scheduled`；结果由新实例 finalize 接手。
 * 3) **hmr 绝不进硬 inject**：headless/SDK profile 没有 hmr，硬 inject 会让整条
 *    fiber pending（anic cycle-74 P0 教训）。只经 `ctx.get('hmr', false)` 可选
 *    探测；缺失即 `unavailable` 且零写入 —— 诚实降级，绝不假装成功。
 *
 * ## 判据（对齐 anic cycle-81 修正）
 *
 * 不是「dist 是否比 src 旧」，而是「**运行实例** revision 是否等于当前 dist
 * revision」。dist 落后源码 ⇒ 拒绝并说「先 build」（重载旧产物等于白做）；
 * 实例已是最新产物 ⇒ 拒绝并说「无需重载」（避免无谓拆装打断会话）；
 * 实例未知 ⇒ **放行**（读不到 ≠ 已同步；多一次无害重载 ≪ 误拒一次真重载）。
 *
 * ## 诚实边界
 *
 * 只保证「请求 + 留痕」：不保证宿主真的完成重载；实例被杀会让 `.then` 侧的
 * 成功/失败条目丢失，但 in-flight 握手条目一定先于触发落盘，因此「曾经请求过」
 * 不会被吞掉。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freshnessVerdict, computeBuildFreshness, findPluginRoot, type BuildFreshness } from './build-freshness.ts'
import { writeFileAtomicSync } from './atomic-sync.ts'
import {
  appendReloadHistory,
  finalizeInFlight,
  readReloadHistory,
  RELOAD_HISTORY_FILE,
  type ReloadHistoryEntry,
} from './reload-history.ts'

export { finalizeInFlight }

/** 本插件自己的产物 revision（模块内存；apply 时由 markRunningRevision 写入）。 */
let runningRevision: string | null = null

/**
 * 记录本实例加载的 dist revision（apply 时调用，唯一写点）。
 *
 * 为什么放内存而不是只放旁路文件：同模块实例内的调用方（工具/路由）零 IO；
 * 旁路文件（writeRunningRevision）解决的是「路由子 fiber 是另一个模块实例」
 * 的可见性问题（anic cycle-81 真机实测）。
 */
export function markRunningRevision(revision: string | null): void {
  runningRevision = revision !== null && revision !== '' ? revision : null
}

/**
 * 把运行实例 revision 写进分区旁路文件（跨模块实例可见）。
 *
 * 为什么需要旁路：路由注册在独立子插件（routes-plugin.ts），它的模块实例
 * 与主 fiber 不一定共享 —— 只靠内存标记，动作路由读到的恒为 null。
 * TTL 过期即弃（重启窗口后的旧记录不可拿去否决重载）。
 */
export function writeRunningRevision(dir: string, revision: string | null): void {
  try {
    writeFileAtomicSync(
      join(dir, RUNNING_REVISION_FILE),
      `${JSON.stringify({ revision, at: new Date().toISOString() }, null, 2)}\n`,
    )
  } catch {
    /* 写失败不阻断 apply：内存值仍有效，读取侧退化为「未知 ⇒ 放行」 */
  }
}

/** 旁路文件名（放分区目录下，与重载史同域）。 */
export const RUNNING_REVISION_FILE = 'running-revision.json'
/** 旁路标记有效期：超过即视为陈旧（停机窗口后的旧记录不可信）。 */
const RUNNING_REVISION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 读运行实例 revision：内存 → 分区旁路（TTL 校验）。
 *
 * 返回 null = **未知**（不是「已同步」）：调用方必须据此放行，而不是拒绝。
 */
export function readRunningRevision(dir?: string): string | null {
  if (runningRevision !== null) return runningRevision
  if (dir === undefined) return null
  try {
    const path = join(dir, RUNNING_REVISION_FILE)
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { revision?: unknown; at?: unknown }
    if (typeof raw.revision !== 'string' || raw.revision === '') return null
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
    if (!Number.isFinite(at) || Date.now() - at > RUNNING_REVISION_TTL_MS) return null
    return raw.revision
  } catch {
    return null
  }
}

/** 仅测试用：清空内存标记（避免用例间串味）。 */
export function resetRunningRevisionForTest(): void {
  runningRevision = null
}

/** 宿主 hmr 服务的最小形状（只声明本模块用到的两个方法）。 */
interface HmrService {
  runExclusive?: (op: () => Promise<unknown>) => Promise<unknown>
  reconcileProfile?: (requiredIds?: readonly string[]) => Promise<unknown>
}

/** reloadSelf 的结果（工具与路由共用同一形状；action 三态是诚实降级的全部形态）。 */
export interface ReloadResult {
  action: 'scheduled' | 'refused' | 'unavailable'
  reason: string
  fromRevision: string | null
  stale: boolean
  /** true = 本实例已把 in-flight 落盘（跨实例握手生效）；其余动作恒 false。 */
  handshake: boolean
  revision?: string | null
  scheduledAt?: string
  /** 史账写盘是否成功（scheduled 时必有）；dropped = FIFO 淘汰的旧条数。 */
  history?: { ok: boolean; dropped?: number }
  /** 新鲜度的一句话结论（命令窗口直接可读）。 */
  verdict?: string
}

/** reloadSelf 的入参。dir = 分区目录（史账与旁路标记的落点）。 */
export interface ReloadSelfOptions {
  dir: string
  /** 插件根（缺省从本模块位置向上找，与 cwd 无关）。 */
  pluginRoot?: string
  reason: string
  /** 请求来源（工具 action / 路由名），落史账。 */
  actor: string
  requiredIds?: string[]
  /**
   * 运行中实例启动时加载的 dist revision。缺省时两级读取（内存 → 分区旁路）。
   * 测试可显式传入以驱动「实例未知/已最新/已过期」三分支。
   */
  observedRevision?: string | null
  /** 测试/演示用：跳过两类拒绝。生产调用方不该传。 */
  force?: boolean
}

/**
 * 解析 hmr 服务（**一次** ctx.get，探测与取句柄同源）。
 *
 * 为什么合成一个函数：分成「先 probe 再 get」会让同一次调用里 ctx.get('hmr')
 * 发生两次 —— 两次之间服务若被卸载，就会出现「探测说可用、取句柄拿到
 * undefined」的 TOCTOU 分叉。
 */
function resolveHmr(ctx: unknown): { available: boolean; reason: string; service: HmrService | null } {
  const get = (ctx as { get?: (key: string, strict?: boolean) => unknown } | null | undefined)?.get
  if (typeof get !== 'function') return { available: false, reason: 'ctx.get is not available', service: null }
  let svc: HmrService | null | undefined
  try {
    svc = get.call(ctx, 'hmr', false) as HmrService | null | undefined
  } catch {
    return { available: false, reason: 'hmr probe threw (ctx.get(hmr) unavailable)', service: null }
  }
  if (svc === null || svc === undefined) {
    return { available: false, reason: 'hmr service not provided (headless/SDK profile)', service: null }
  }
  if (typeof svc.runExclusive !== 'function' || typeof svc.reconcileProfile !== 'function') {
    return { available: false, reason: 'hmr service shape mismatch (runExclusive/reconcileProfile missing)', service: null }
  }
  return { available: true, reason: 'ok', service: svc }
}

/** 可选探测 hmr 服务（**不**写进 inject；headless 恒 unavailable）。 */
export function probeHmr(ctx: unknown): { available: boolean; reason: string } {
  const resolved = resolveHmr(ctx)
  return { available: resolved.available, reason: resolved.reason }
}

/** 产物新鲜度只读摘要（史账的 staleAtRequest 依据 + 工具输出的 verdict）。 */
function freshnessOf(pluginRoot: string | null): { fresh: BuildFreshness; verdict: string } {
  if (pluginRoot === null) {
    const empty: BuildFreshness = {
      stale: null,
      revision: null,
      builtAt: null,
      newestSourceAt: null,
      driftMs: null,
      builtVersion: null,
      reason: '未找到插件根目录',
    }
    return { fresh: empty, verdict: empty.reason ?? '未找到插件根目录' }
  }
  const fresh = computeBuildFreshness(pluginRoot ?? undefined)
  return { fresh, verdict: freshnessVerdict(fresh).text }
}

/**
 * 请求本插件热重载（核心入口）。
 *
 * 顺序**不可交换**：探测 → 判据 → 落 in-flight → 触发。若先触发再写，本实例
 * 被替换后就没有任何进程能写下「请求过重载」—— 史账会显示成「什么都没发生」。
 */
export function reloadSelf(ctx: unknown, opts: ReloadSelfOptions): ReloadResult {
  const hmr = resolveHmr(ctx)
  if (!hmr.available || hmr.service === null) {
    // 零写入：没有服务就没有发生任何事，写一条 'unavailable' 反而是伪造活动痕迹。
    return { action: 'unavailable', reason: hmr.reason, fromRevision: null, stale: false, handshake: false }
  }
  const root = opts.pluginRoot ?? findPluginRoot()
  const { fresh, verdict } = freshnessOf(root)
  const fromRevision = fresh.revision
  const running = opts.observedRevision !== undefined ? opts.observedRevision : readRunningRevision(opts.dir)
  if (fresh.stale === true && opts.force !== true) {
    // dist 落后源码：拒绝并点名「先 build」—— 重载旧产物等于白做。
    // 拒绝也落账（actor/reason 可复核的执行事实）。
    const entry: ReloadHistoryEntry = {
      at: new Date().toISOString(),
      actor: opts.actor,
      reason: opts.reason,
      status: 'refused',
      fromRevision: running,
      toRevision: null,
      staleAtRequest: true,
      warnings: [verdict],
      error: null,
    }
    const appended = appendReloadHistory(opts.dir, entry)
    return {
      action: 'refused',
      reason: `产物已过期（${String(fresh.newestSourceAt ?? '未知源码时刻')} 的源码比产物新）；先 npm run build 再重载`,
      fromRevision: running,
      stale: true,
      handshake: false,
      revision: fromRevision,
      verdict,
      history: { ok: appended.ok, ...(appended.dropped !== undefined ? { dropped: appended.dropped } : {}) },
    }
  }
  const upToDate = running !== null && fromRevision !== null && running === fromRevision
  if (upToDate && opts.force !== true) {
    const entry: ReloadHistoryEntry = {
      at: new Date().toISOString(),
      actor: opts.actor,
      reason: opts.reason,
      status: 'refused',
      fromRevision: running,
      toRevision: null,
      staleAtRequest: false,
      warnings: [],
      error: null,
    }
    const appended = appendReloadHistory(opts.dir, entry)
    return {
      action: 'refused',
      reason: `运行实例已是最新产物（revision ${running}，dist 未变，无需重载）`,
      fromRevision: running,
      stale: false,
      handshake: false,
      revision: fromRevision,
      verdict,
      history: { ok: appended.ok, ...(appended.dropped !== undefined ? { dropped: appended.dropped } : {}) },
    }
  }
  const staleAtRequest = fresh.stale === true || !upToDate
  const entry: ReloadHistoryEntry = {
    at: new Date().toISOString(),
    actor: opts.actor,
    reason: opts.reason,
    status: 'in-flight',
    fromRevision: running,
    toRevision: null,
    staleAtRequest,
    warnings: staleAtRequest ? [verdict] : [],
    error: null,
  }
  const appended = appendReloadHistory(opts.dir, entry)
  if (!appended.ok) {
    // 没有留痕就不触发：拿不到审计证据的重载请求一律拒绝（「没有证据 ≠ 通过」）。
    return {
      action: 'refused',
      reason: `重载史账（${RELOAD_HISTORY_FILE}）不可写；拒绝在无审计证据的情况下重载`,
      fromRevision: running,
      stale: staleAtRequest,
      handshake: false,
      revision: fromRevision,
      verdict,
    }
  }
  const service = hmr.service
  // 铁律②：不 await —— 本实例即将被替换，续体可能永不执行；串行化交给 runExclusive。
  // 成功且实例存活（无可替换项）时自己完成握手；已被替换时由新实例 finalize 接手。
  setTimeout(() => {
    void Promise.resolve()
      .then(() => service.runExclusive?.(async () => service.reconcileProfile?.(opts.requiredIds)))
      .then(() => {
        finalizeInFlight(opts.dir, root === null ? null : computeBuildFreshness(root).revision)
      })
      .catch((error: unknown) => {
        appendReloadHistory(opts.dir, {
          ...entry,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          finalizedAt: new Date().toISOString(),
        })
      })
  }, 0)
  return {
    action: 'scheduled',
    reason: opts.reason,
    fromRevision: running,
    stale: staleAtRequest,
    handshake: true,
    revision: fromRevision,
    scheduledAt: entry.at,
    verdict,
    history: { ok: true, ...(appended.dropped !== undefined ? { dropped: appended.dropped } : {}) },
  }
}

/** 只读摘要（面板/工具用；不暴露 hmr 服务对象、不写盘）。 */
export interface ReloadSummary {
  /** 刻意恒缺省：摘要不泄漏宿主服务对象本身（只读面拿不到可调用句柄）。 */
  hmr?: never
  stale: boolean | null
  revision: string | null
  last: ReloadHistoryEntry | null
  historyCount: number
  historyError: string | null
  /** 本插件根目录解析失败时的原因（null = 正常）。 */
  rootError: string | null
}

/** 汇总当前构建新鲜度 + 最近一次重载（只读，无副作用）。 */
export function reloadSummary(dir: string, pluginRoot?: string): ReloadSummary {
  const root = pluginRoot ?? findPluginRoot()
  const { fresh } = freshnessOf(root)
  const history = readReloadHistory(dir)
  return {
    stale: fresh.stale,
    revision: fresh.revision,
    last: history.entries[history.entries.length - 1] ?? null,
    historyCount: history.entries.length,
    historyError: history.error,
    rootError: root === null ? '未找到插件根目录（package.json 的 name 与本包不匹配）' : null,
  }
}

/** 本插件根目录（源码/产物两种形态都成立；与 cwd 无关）。 */
export function selfPluginRoot(): string | null {
  return findPluginRoot(dirname(fileURLToPath(import.meta.url)))
}
