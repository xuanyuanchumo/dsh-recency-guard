import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { readSelfPackage, readHostVersion, safeJson, safeVersion } from './self-describe.js'
// The runtime version is a detail, not a hard dependency: the import is
// resolved lazily so a missing optional peer can never stop the plugin from
// loading.
import { Store, bundleMtimes, bundleMtimesSync, bundleVersionsSync, declaredDependenciesSync } from './store.js'
import {
  suspectBundles,
  rankByRecency,
  pickSuspects,
  diffVersions,
  isOfficial,
  isExperimentalName,
  describeError,
} from './recency.js'
import type { BundleLike, RecencyEntry } from './recency.js'
import type { JournalEvent } from './store.js'
import type { GuardState } from './store.js'
import { computeRevision, type RevisionFacts } from './change-guard.js'
import { DECISION_RELATIVE_PATH, writePointer } from './decision.js'
import { installGuardedRows, GUARD_PACKAGE_NAME } from './guarded-rows.js'
import { deriveObservations, deriveRiskInputs } from './observations.js'
import { installExitSentinel, readSentinel, clearSentinel, pidAlive } from './sentinel.js'
import { observeOfficialExperimental } from './official-observe.js'
import { watchPluginChanges } from './event-watch.js'
import { assessConfidence, environmentChanged, reconcilePrepared, classifyAbnormalExit, abnormalExitDecision, type CrashHistoryEntry } from './recovery-policy.js'
import { StageMachine, type LifecycleStepName } from './lifecycle.js'
import { buildCapabilityGraph, verifyCapabilityContract } from './capability-specs.js'
import { currentRegistrationSurface, verifySurfaceAlignment } from './capability-specs.js'
import { buildPanelSnapshot, buildGraphDataFor, type PanelSnapshot } from './snapshot.js'
import { buildPartitionSnapshot } from './partition-snapshot.js'
import {
  isolationView,
  partitionArtifacts,
  projectKey,
  readPartitionIndex,
  registerPartition,
  writePartitionIndex,
} from './isolation.js'
import { archiveAndReset, listArchives, readArchiveManifest } from './archive.js'
import { wireRoutes } from './routes-plugin.js'
import { registerGuardTool } from './tool-registration.js'
import type { Observation } from './observability.js'
export const name = 'dsh-recency-guard'

export interface Config {
  /** Master switch. When false the guard only records; it never disables. */
  enabled: boolean
  /** Whether experimental-named bundles count as recovery suspects. */
  includeExperimental: boolean
  /** Max suspect bundles to disable on a single recovery pass. */
  maxAutoDisable: number
  /** Auto re-enable the needed (non-suspect) bundles after the profile boots clean. */
  autoRestore: boolean
  /**
   * 概率性证据的行动阈值：头号嫌疑连续 N 轮复现才动手（v0.9 置信分级）。
   * 唯一嫌疑不受此限制（确定性证据，第 1 轮即行动）。
   */
  confirmRounds: number
  /**
   * 插件更新时是否写「带版本的时间线备份」（v0.8 备份增强）。
   *
   * 默认开：备份是 best-effort，写失败只降级不报错；关闭则回到只保留
   * 「最近一份」的旧行为。
   */
  versionedBackups: boolean
  /** 每个插件保留几份时间线备份（超出删最旧）。 */
  backupRetain: number
  /**
   * 备份的自定义目录。
   *
   * 空 = 用默认位置（`<profile>/.recency-guard/projects/<分区>/backups`，
   * 随分区隔离）；填绝对路径 = 备份集中到用户指定的目录（分区隔离由
   * 子目录名保证：`<root>/<partitionKey>`）。环境变量
   * `RECENCY_GUARD_BACKUP_ROOT` 优先于本配置 —— 运维脚本比面板配置
   * 更接近机器真相。
   */
  backupRoot: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('崩溃后自动按“最近更新”关闭嫌疑插件。'),
  includeExperimental: Schema.boolean().default(true).description('把 experimental/beta 命名的组合包也算作嫌疑。'),
  maxAutoDisable: Schema.number().default(2).description('单次恢复最多自动关闭的嫌疑插件数（崩溃次数递增，封顶此值）。'),
  autoRestore: Schema.boolean().default(true).description('稳定启动后自动重新启用非嫌疑插件，恢复需要的配置。'),
  confirmRounds: Schema.number().default(2).description('概率性证据的行动阈值：同一头号嫌疑连续 N 轮崩溃才自动关闭（唯一嫌疑不受限）。'),
  versionedBackups: Schema.boolean().default(true).description('插件更新时写带版本的时间线备份（可回溯更新前后的配置）。'),
  backupRetain: Schema.number().default(5).description('每个插件保留的时间线备份份数（超出删最旧）。'),
  backupRoot: Schema.string().default('').description('备份自定义目录（留空用 profile 内默认位置，随分区隔离）。'),
})

/** The subset of `ctx.pluginManager` this plugin uses. */
interface PluginManagerLike {
  listBundles(): Promise<BundleLike[]>
  listPlugins(): Promise<PluginRow[]>
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<unknown>
}

/** One row of `ctx.pluginManager.listPlugins()`. */
interface PluginRow {
  entryId: string
  moduleName: string
  enabled: boolean
  /** Present when the row can be addressed through the profile patch. */
  patchId?: string
  /** Present when the row cannot be changed (management / unaddressable). */
  readOnlyReason?: string
}

/** The subset of `ctx.configEditor` this plugin uses. */
interface ConfigEditorLike {
  configuration(): Array<{
    entry: { id?: string; name?: string }
    inherited: Record<string, unknown>
    override: Record<string, unknown>
  }>
}

/**
 * 硬依赖的宿主服务。
 *
 * `configEditor` **不在**这里：它只在「关闭前备份配置」这一条 best-effort
 * 路径上用到（package.json 里它是 optional peer），把它列成硬依赖会让没有
 * config-editor 的 profile 整条 fiber pending —— 守护、工具、状态机一起失效。
 * 这与 `webServer` 是同一类缺陷（dsh-anic cycle-74 P0），只是它是可选服务，
 * 因此用 `ctx.inject(['configEditor'], cb)` 挂子 fiber：它缺席只影响备份。
 */
export const inject = ['tools', 'pluginManager', 'profileContext']

export function apply(ctx: Context, config: Config) {
  // The plugin-manager and config-editor services are declared by the harness
  // through `inject`; the base cordis Context type does not know them.
  const services = ctx as unknown as {
    pluginManager: PluginManagerLike
    profileContext: { name: string; dir: string; patchPath: string; cwd?: string }
  }
  const pm = services.pluginManager
  const profile = services.profileContext
  // 分区的锚点是**项目目录**，不是 profile 目录 ——
  // 同一个 profile 可以在多个项目里工作，用 profile 目录做键会让它们
  // 共用一份日志与状态，互相污染。
  //
  // profileContext 里的项目事实是 `cwd`（launcher 记录的进程工作目录）。
  const workspace = services.profileContext.cwd ?? profile.dir
  // 备份根优先级：环境变量（运维脚本）> 面板配置 > profile 内默认。
  const backupRoot =
    process.env.RECENCY_GUARD_BACKUP_ROOT || (typeof config.backupRoot === 'string' ? config.backupRoot : '')
  const store = new Store(profile.dir, projectKey(workspace), backupRoot)
  const guard = new Guard(
    ctx,
    store,
    pm,
    // configEditor 是**可选**服务，且没写进 inject —— 直接读 `services.configEditor`
    // 会让 Cordis 的追踪代理抛 "cannot get property ... without inject"，
    // 而那个异常发生在 `apply` 里就等于整个插件没激活（沙箱 sb-rg-c5 实测）。
    // 用 tryReadService：缺席就传 undefined，由子 fiber 后续接上。
    tryReadService(ctx, 'configEditor') as ConfigEditorLike | undefined,
    config,
    profile.dir,
    profile.patchPath,
    profile.name,
    projectKey(workspace),
    workspace,
  )
  guard.beginStep('loader')

  // configEditor 走**选择性注入**：缺席时只有这个子 fiber 是 pending，
  // 主插件照常工作（备份降级为「无备份」，不是「插件不加载」）。
  attachOptionalService(ctx, 'configEditor', (source) => guard.attachConfigEditor(source))
  if (tryReadService(ctx, 'configEditor') !== undefined) {
    // 服务已在场上（同步可读）：立即接上，别等子 fiber 的第一轮调度。
    guard.attachConfigEditor(ctx)
  }

  // The pre-boot guard needs no registration: the guarded patch rows read the
  // decision file directly through their `disabled` expression.

  // Register this workspace's partition so multiple projects using the same
  // profile stay isolated: the partition index is the only shared structure,
  // and it holds *references*, not state. Each partition's journal / state /
  // decision live in their own directory.
  const partitionIndex = readPartitionIndex(profile.dir)
  const { partition, index: nextIndex } = registerPartition(partitionIndex, workspace)
  writePartitionIndex(profile.dir, nextIndex)

  // The route surface is a SEPARATE cordis sub-plugin: webServer only exists
  // in the desktop bundle, and listing it as a hard dependency of this plugin
  // would leave the whole fiber pending in headless — taking the tools and
  // the state machine down with it (dsh-anic cycle-74 P0).
  //
  // 登记的是**注册表里的名称**（`ROUTE_SURFACE` / `TOOL_SURFACE`），不是
  // 手写常量：注册面是从真实注册代码消费的那张表投影出来的，清单与它比对
  // 才有意义（自己核对自己永远为真）。
  const surface = currentRegistrationSurface()
  guard.noteRegistered(surface.toolName)
  for (const route of surface.routes) guard.noteRegistered(route.exposedName)

  ctx.effect(
    () => {
      const dispose = wireRoutes(ctx, {
        profileDir: profile.dir,
        workspace: partition.workspace,
        profileName: profile.name,
        projectKey: partition.key,
        snapshot: () => guard.panelSnapshot(),
        snapshotPartition: (key) => guard.partitionSnapshot(key),
        graph: () => guard.graphData(),
        archive: (reason) => guard.archiveReset(reason),
        archives: () => guard.archives(),
        reenable: (bundle) => guard.reenable(bundle),
        restore: () => guard.restore(),
        recover: () => guard.recoverNow(),
        isolation: async () => guard.isolationView(),
        lifecycle: async () => guard.lifecycleView(),
        // 动作路由的乐观并发基准（v0.12）：只算那枚哈希，不重跑快照投影。
        currentRevision: () => guard.currentRevision(),
        // 路由**真的**注册成功时回报（含 webServer 缺席时的沉默 —— 那也是事实）。
        onRegister: (name) => guard.noteRegistered(name),
        // 路由面是独立子 fiber，拿不到 ctx.logger —— 由父插件桥一条错误通道，
        // 否则注册失败只进 console（宿主日志视图看不见 = 等于没报）。
        logError: (message) => ctx.logger.warn(message),
      })
      // The disposer must be a function (not undefined): cordis treats an
      // undefined return as "no effect", which is fine — but the TYPE has to
      // be uniform, hence the no-op fallback.
      return typeof dispose === 'function' ? dispose : () => {}
    },
    'recency-guard: route surface',
  )

  ctx.effect(
    () => {
      // Boot is fire-and-forget: the plugin must not block the host's startup.
      void guard.boot()
      // 事件驱动加速器（v0.8.1）：宿主的 pluginManager 在每次变更操作
      // （GUI/工具路径的 install/update/enable/disable，含失败）后 emit
      // `plugin-manager/changed`（runtime/dsh-plugin-manager/lib/index.js:2398）。
      // 收到事件就重跑一次变更检测 —— 插件装完/升完**不用等下一次重启**
      // 就进时间线与嫌疑面。
      //
      // 已知盲区（子代理对宿主源码的实证）：CLI `dsh plugin add` 与手工
      // 编辑 patch 不经过 manager，不发此事件 —— 那些路径仍由「每次启动
      // 的同步 diff」兜底。事件是加速器，不是唯一真相。
      //
      // 失败防御：宿主事件面不可用时（旧版/裁剪版宿主）静默降级为纯启动
      // 检测 —— tryReadService 同款纪律，可选能力缺席不拖垮守护。
      const disposeEvents = guard.watchPluginChanges()
      // The disposer MUST return the promise: cordis awaits an async disposer,
      // so the crash marker is cleared before the process exits.
      return () => {
        disposeEvents()
        return guard.shutdown()
      }
    },
    'recency-guard: boot + change-events + clean-shutdown marker',
  )

  // The startup record must be written SYNCHRONOUSLY: the very crash this
  // plugin guards against can happen during this same boot, and the process
  // dies before any awaited write completes. A journal entry that only lands
  // after an await would be lost with the crash it documents.
  guard.recordStartupSync()

  // 启动后做一次能力契约自检：清单 ↔ 实际注册面双向比对。
  // 不一致只记日志（契约缺口要被看见并修，不该拖垮守护流程）。
  ctx.effect(
    () => {
      guard.verifyContract(injectedServiceNames(ctx))
      // 自检没有需要释放的资源；返回 no-op disposer 以满足 cordis 的 Effect 形状。
      return () => {}
    },
    'recency-guard: capability contract self-check',
  )

  // A crash (an unhandled rejection or an uncaught exception) makes the host
  // dispose its fibers BEFORE exiting with code 1 — so the disposer above runs
  // on a crash too, and a disposer alone cannot tell the two apart. The exit
  // code can: a clean shutdown ends with code 0, a crash with code 1.
  //
  // The listener must live at the PROCESS level, not on this fiber: cordis runs
  // disposers in reverse order, so a fiber-level `process.on('exit')` would be
  // removed before the process exits and the signal would be lost.
  //
  // The crash handler publishes the recovery decision, so the NEXT boot's
  // guarded rows keep the suspect plugin from loading at all.
  installExitSentinel(store.partitionPath, (exitCode) => {
    if (config.enabled) guard.publishDecisionOnCrash(exitCode)
  })

  // 工具注册整体在 tool-registration.ts：那里一次接完「名字/action 枚举 +
  // 文本投影 + 三个展示投影」，漏接任何一条都在这个小文件里肉眼可见。
  registerGuardTool(ctx.tools, {
    status: () => guard.status(),
    recoverNow: () => guard.recoverNow(),
    restore: () => guard.restore(),
    reenable: (bundle) => guard.reenable(bundle),
    archiveReset: (reason) => guard.archiveReset(reason),
    archives: () => guard.archives(),
    store,
  })

  // Loader 四件套走完：这一轮的「加载」步骤到此闭合（含耗时）。
  guard.endStep('loader', true, 'Loader 四件套就绪（name/inject/Config/apply）')
}

/**
 * 读一个宿主服务 **而不让它把插件拖死**。
 *
 * 为什么不能直接 `ctx.foo`：Cordis 的可追踪代理在**没有 inject 声明**时读未知
 * 服务会抛 `cannot get property "foo" without inject`。这个异常出现在 `apply`
 * 里就等于「整个插件没激活」—— 沙箱实测（sb-rg-c5）正是这样：
 *
 *     dsh: warning: 1 entry did not activate
 *     recency-guard (dsh-recency-guard): Error: cannot get property "configEditor" without inject
 *
 * 一个**可选**依赖不该有这种权力。所以读它必须包在 try 里：读不到就是「不在场」。
 */
function tryReadService(ctx: Context, name: string): unknown {
  try {
    return (ctx as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/**
 * 读出现场真实存在的宿主服务名 —— 契约自检的 inject 面输入。
 *
 * 为什么不用 `inject` 常量：常量只说明「声明了什么」，而契约要核对的是
 * 「实际能拿到什么」。以 `ctx` 上可读到的服务为准，声明与现实的差距才会
 * 现形（漏 inject 的能力会在自检里报 host-service-not-injected）。
 */
function injectedServiceNames(ctx: Context): string[] {
  const names = ['tools', 'pluginManager', 'profileContext', 'webServer', 'configEditor']
  return names.filter((name) => typeof tryReadService(ctx, name) !== 'undefined')
}

/**
 * 挂一个**可选**宿主服务（官方 `ctx.inject(deps, cb)` 简写形式）。
 *
 * 为什么需要它：可选服务写进 `inject` 数组会让整条 fiber 等它，缺席即插件
 * 全废；用子 fiber 则「服务不在场」只影响依赖它的那一条能力（这里是配置备份）。
 * 宿主没有 `ctx.inject`（stub / 旧代）时静默回落：能力降级，插件照常加载。
 */
function attachOptionalService(ctx: Context, service: string, attach: (source: unknown) => void): void {
  const injectFn = (ctx as unknown as { inject?: (deps: string[], cb: (child: unknown) => void) => unknown }).inject
  if (typeof injectFn !== 'function') return
  try {
    injectFn.call(ctx, [service], (child: unknown) => {
      attach(child)
    })
  } catch {
    /* 回落：可选服务缺席不是错误 */
  }
}

class Guard {
  /**
   * The profile directory, captured at startup.
   *
   * The crash handler runs from the `process.on('exit')` listener, long after
   * the plugin's fiber was disposed — at that point the cordis context is
   * INACTIVE and reading `ctx.profileContext` throws. Everything the crash
   * handler needs must therefore be captured while the context is alive.
   */
  private readonly profileDir: string

  /** The profile's patch file, where the guarded rows are written. */
  private readonly patchPath: string

  /** The profile's name, reported by the status action. */
  private readonly profileName: string

  /**
   * 生命周期状态机 —— 让「守护现在处于什么状态」只有一个答案。
   *
   * 此前这个状态由多个布尔量拼出（crashed / recovering / stabilized），
   * 于是「既崩溃又稳定」这类不可能组合在真实运行中确实会发生。
   * 状态机让非法组合**无法表示**，并把合法迁移显式写死。
   */
  private readonly machine = new StageMachine('idle')

  /** 当前工作区的分区键（多项目隔离的锚点）。 */
  private readonly projectKey: string

  /** 当前项目（工作区）的规范化路径。 */
  private readonly workspace: string

  /** 插件自描述包（版本 + 反馈链接，R12/R18）：读不到时字段为 null，诚实降级。 */
  private readonly selfPackage = readSelfPackage()


  /**
   * 配置编辑服务 —— **可选**。
   *
   * 它只服务「关闭前备份配置」这一条 best-effort 路径；服务缺席时备份能力
   * 降级为「没有备份」，而不是整条 fiber 挂起（`ctx.inject` 子 fiber 的结果）。
   */
  private configEditor?: ConfigEditorLike

  constructor(
    private readonly ctx: Context,
    private readonly store: Store,
    private readonly pm: PluginManagerLike,
    configEditor: ConfigEditorLike | undefined,
    private readonly config: Config,
    profileDir: string,
    patchPath: string,
    profileName: string,
    projectKey: string,
    workspace: string,
  ) {
    this.profileDir = profileDir
    this.patchPath = patchPath
    this.profileName = profileName
    this.projectKey = projectKey
    this.workspace = workspace
    this.attachConfigEditor(configEditor)
  }

  /**
   * 接上一个配置编辑服务来源（`ctx` 或 `ctx.inject` 给的子 context）。
   *
   * 形状校验必须在**接入时**做：拿不到 `configuration()` 的来源等于没有服务，
   * 早失败比在崩溃路径上才发现「备份函数不存在」便宜得多。
   */
  attachConfigEditor(source: unknown): boolean {
    const candidate = (source as { configEditor?: unknown } | undefined)?.configEditor
    if (candidate && typeof (candidate as ConfigEditorLike).configuration === 'function') {
      this.configEditor = candidate as ConfigEditorLike
      return true
    }
    return false
  }

  /** 配置编辑服务是否可用（诚实报告，不假装有）。 */
  get configEditorAvailable(): boolean {
    return this.configEditor !== undefined
  }

  // ---------- 生命周期步骤（进入 / 退出 / 耗时 / 失败原因）----------

  /** 进入一个生命周期步骤。 */
  beginStep(name: LifecycleStepName): void {
    this.machine.beginStep(name)
  }

  /** 退出一个生命周期步骤。 */
  endStep(name: LifecycleStepName, ok = true, reason?: string): void {
    this.machine.endStep(name, ok, reason)
  }

  /** 一步到位的步骤记录（同步路径用）。 */
  recordStep(name: LifecycleStepName, ok: boolean, reason?: string, durationMs = 0): void {
    this.machine.recordStep(name, ok, reason, durationMs)
  }

  /**
   * 生命周期视图 —— 面板与路由消费的「步骤流 + 迁移史 + 被拒迁移」。
   *
   * 三样东西放在一起才是可诊断的：只看当前阶段回答不了「为什么没恢复」，
   * 只看迁移史看不出「哪一步卡了多久」。
   */
  lifecycleView(): {
    stage: string
    stabilityScore: number
    transitions: readonly unknown[]
    steps: readonly unknown[]
    openSteps: readonly string[]
    rejected: readonly unknown[]
  } {
    return {
      stage: this.machine.stage,
      stabilityScore: this.machine.stabilityScore(),
      transitions: this.machine.transitions,
      steps: this.machine.steps,
      openSteps: this.machine.openSteps(),
      rejected: this.machine.rejectedTransitions,
    }
  }

  /**
   * 隔离视图 —— 当前分区 + 本 profile 下其它工作区的**引用**（不含它们的状态）。
   *
   * `others` 只给出键/标签/工作区路径：面板据此回答「还有谁在用这个 profile」，
   * 但绝不把对方的状态读进来 —— 隔离在数据结构上就成立，不靠调用方自觉。
   * 同时给出对方分区的产物路径清单，作为「互不可见」可断言的对照面。
   */
  isolationView(): {
    profile: string
    workspace: string
    projectKey: string
    current: unknown
    others: Array<Record<string, unknown>>
    isolated: boolean
    exclusive: boolean
    artifacts: string[]
    foreignArtifacts: Array<{ key: string; label: string; paths: string[] }>
  } {
    const view = isolationView(this.profileDir, this.workspace)
    return {
      profile: this.profileName,
      workspace: this.workspace,
      projectKey: this.projectKey,
      current: view.current,
      others: view.others.map((p) => ({
        key: p.key,
        label: p.label,
        workspace: p.workspace,
        lastSeenAt: p.lastSeenAt,
      })),
      isolated: view.isolated,
      exclusive: view.exclusive,
      artifacts: partitionArtifacts(this.profileDir, this.projectKey),
      foreignArtifacts: view.others.map((p) => ({
        key: p.key,
        label: p.label,
        paths: partitionArtifacts(this.profileDir, p.key),
      })),
    }
  }

  // ---------- bundle facts ----------

  /** Installed bundle -> version map, used for update detection. */
  private async versionMap(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const b of await this.pm.listBundles()) {
      if (b.installed !== false && b.version) out[b.name] = b.version
    }
    return out
  }
  /** Record install/update/remove events by diffing against the last snapshot. */
  private async recordChanges(): Promise<void> {
    const prev = await this.store.readSnapshot()
    const current = await this.versionMap()
    const { install, update } = diffVersions(prev, current)
    const events: JournalEvent[] = []
    for (const i of install) events.push({ kind: 'install', bundle: i.name, version: i.version })
    for (const u of update) events.push({ kind: 'update', bundle: u.name, version: u.to, prevVersion: u.from })
    for (const [name, ver] of Object.entries(prev)) {
      if (current[name] === undefined) events.push({ kind: 'remove', bundle: name, version: ver })
    }
    await this.store.append(events)
    await this.store.writeSnapshot(current)
    await this.backupUpdatedConfigs(update)
  }

  /**
   * 更新发生时抓「更新前」配置快照进时间线备份（v0.8）。
   *
   * 放在 append 之后：先保证事件链完整，备份是锦上添花（best-effort，
   * 失败不影响变更记录 —— 那才是崩溃归因的主证据）。
   * 单独成方法：把「遍历 + try/catch + 判空」的分支从 recordChanges
   * 挪出去，让变更记录的主干保持一眼可读。
   */
  private async backupUpdatedConfigs(update: ReadonlyArray<{ name: string; from: string }>): Promise<void> {
    if (update.length === 0 || !this.config.versionedBackups) return
    for (const u of update) {
      try {
        const snap = this.snapshotConfig(u.name)
        if (snap !== undefined) {
          await this.store.writeVersionedBackup(u.name, u.from, snap, { retain: this.config.backupRetain })
        }
      } catch (err) {
        this.ctx.logger.warn(`[recency-guard] 写 ${u.name} 的时间线备份失败：${describeError(err)}`)
      }
    }
  }

  /** 官方实验插件观测 —— 实现见 official-observe.ts（index.ts 只做编排）。 */
  private async observeOfficialExperimental(): Promise<void> {
    const bundles = await this.pm.listBundles()
    await observeOfficialExperimental(bundles, this.store, {
      versionedBackups: this.config.versionedBackups,
      backupRetain: this.config.backupRetain,
    }, (message) => this.ctx.logger?.warn?.(message))
  }

  /**
   * 从 journal 抽崩溃历史（置信分级的输入）。
   *
   * 每条 crash-detected 事件的 suspects 字段就是当时的嫌疑名单快照；
   * runtime 版本取事件时刻附近的 note（简化：用当前版本 —— 宿主升级
   * 必然伴随重启，note 里 pid 变化 + 版本字段足以断代）。
   */
  private readCrashHistory(): CrashHistoryEntry[] {
    const events = this.store.readJournalSync(1000)
    const runtime = safeVersion()
    const out: CrashHistoryEntry[] = []
    for (const e of events) {
      if (e.kind !== 'crash-detected') continue
      const suspects = Array.isArray(e.suspects) ? e.suspects.filter((s): s is string => typeof s === 'string') : []
      // v0.11.1 紧急修复：启动时的崩溃检测记录（`上次运行以退出码 N 结束`）
      // 没有嫌疑名单 —— 它不是一次**决策**。此前把它也收进历史，连续计数
      // 每轮都被这条空记录打断：桌面端 crashSeq 涨到 3 仍停在 1/2 轮，
      // 崩溃循环永远无法升级为自动关闭（真机实锤）。
      if (suspects.length === 0) continue
      out.push({
        at: e.t,
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : -1,
        suspects,
        runtimeVersion: runtime,
      })
    }
    return out
  }

  /** Journal-derived recency map: most recent install-or-update per bundle. */
  private async journalRecency(): Promise<Map<string, { at: string; kind: 'install' | 'update'; version?: string }>> {
    const events = await this.store.readJournal(1000)
    const map = new Map<string, { at: string; kind: 'install' | 'update'; version?: string }>()
    for (const e of events) {
      if ((e.kind === 'install' || e.kind === 'update') && e.bundle) {
        map.set(e.bundle, { at: e.t, kind: e.kind, version: e.version })
      }
    }
    return map
  }

  /**
   * Install the guarded rows for the profile's third-party plugins.
   *
   * The pre-boot protection only works if every plugin that could crash has a
   * patch row whose `disabled` expression consults the decision file. Those
   * rows live in the profile's own patch file, which is the layer the plugin
   * manager persists to and the layer the user edits.
   *
   * The rows are written ONCE, when the plugin is installed; the decision file
   * then decides per boot which of them actually stay off. The row therefore
   * carries no state of its own.
   *
   * A row is only added for a plugin that is (a) not official, (b) not this
   * guard, and (c) addressable through the profile patch — the plugin manager
   * reports the latter as a `patchId`.
   */
  /**
   * Install the guarded rows for the profile's third-party plugins.
   *
   * The pre-boot protection only works if every plugin that could crash has a
   * patch row whose `disabled` expression consults the decision file. Those
   * rows live in the profile's own patch file, which is the layer the plugin
   * manager persists to and the layer the user edits.
   *
   * The installation is SYNCHRONOUS: the rows have to exist before any plugin
   * can crash, and the crash this plugin guards against can happen during this
   * very boot. The row ids come from the installed bundles' own patch files,
   * which are readable without awaiting anything.
   *
   * The rows carry no state of their own: the decision file alone decides, per
   * boot, which of them actually stay off.
   */
  async rankedSuspects(): Promise<RecencyEntry[]> {
    const bundles = await this.pm.listBundles()
    let suspects = suspectBundles(bundles)
    if (!this.config.includeExperimental) {
      suspects = suspects.filter((b) => !isExperimentalName(b.name))
    }
    const journal = await this.journalRecency()
    const mtimes = await bundleMtimes(this.profileDir)
    return rankByRecency(suspects, journal, mtimes)
  }

  /**
   * The suspect ranking computed SYNCHRONOUSLY.
   *
   * It reads the profile's declared dependencies instead of the plugin
   * manager's live inventory, because the recovery decision must be published
   * from the process-level exit handler, where only synchronous APIs exist.
   *
   * The guard itself is never a suspect: disabling it would remove the very
   * mechanism that recovers the profile.
   */
  rankedSuspectsSync(): RecencyEntry[] {
    const declared = declaredDependenciesSync(this.profileDir)
    const versions = bundleVersionsSync(this.profileDir)
    const journal = this.journalRecencySync()
    const mtimes = bundleMtimesSync(this.profileDir)

    const suspects: BundleLike[] = declared
      .filter((name) => !isOfficial(name) && name !== GUARD_PACKAGE_NAME)
      .map((name) => ({ name, installed: true, enabled: true, version: versions[name] }))
    const filtered = this.config.includeExperimental
      ? suspects
      : suspects.filter((b) => !isExperimentalName(b.name))

    return rankByRecency(filtered, journal, mtimes)
  }

  /** Journal-derived recency map, read synchronously. */
  private journalRecencySync(): Map<string, { at: string; kind: 'install' | 'update'; version?: string }> {
    const map = new Map<string, { at: string; kind: 'install' | 'update'; version?: string }>()
    for (const e of this.store.readJournalSync(1000)) {
      if ((e.kind === 'install' || e.kind === 'update') && e.bundle) {
        map.set(e.bundle, { at: e.t, kind: e.kind, version: e.version })
      }
    }
    return map
  }

  /**
   * The rows of the suspect bundles, so a bundle can be disabled at the plugin
   * level (which is addressable through the profile patch) as well as at the
   * bundle level.
   */
  private async suspectRows(targets: RecencyEntry[]): Promise<PluginRow[]> {
    const wanted = new Set(targets.map((t) => t.bundle))
    const rows = await this.pm.listPlugins()
    return rows.filter((r) => wanted.has(r.moduleName) && r.enabled && r.readOnlyReason === undefined)
  }

  // ---------- lifecycle ----------

  /**
   * The synchronous startup record.
   *
   * It runs before any await, so it completes even if a suspect plugin throws
   * during this same boot. It writes:
   *  - the install/update facts read from the profile's package.json
   *  - the crash sentinel of the previous run, so a crash is never lost
   */
  recordStartupSync(): void {
    try {
      this.store.appendSync({ kind: 'note', detail: `dsh 启动 pid=${process.pid}` })
      // Install the guarded rows BEFORE anything can crash, so the next boot
      // can keep a suspect plugin from loading at all. Synchronous by design.
      const installed = installGuardedRows(this.profileDir, this.patchPath)
      // 步骤留痕走**同步**：这里是崩溃路径的入口，await 之后进程可能已经死了。
      this.recordStep(
        'install-guarded-rows',
        installed.blocked === undefined,
        installed.blocked ?? `新增 ${installed.added.length} 行 / 跳过 ${installed.skipped.length} 行`,
      )
      if (installed.added.length > 0) {
        this.store.appendSync({
          kind: 'note',
          detail: `已安装守护行：${installed.added.map((r) => `${r.rowId} (${r.bundleName})`).join(', ')}`,
        })
      }
      const sentinel = readSentinel(this.store.partitionPath)
      if (sentinel) {
        this.store.appendSync({
          kind: 'crash-detected',
          detail: `上次运行以退出码 ${sentinel.exitCode} 结束`,
          exitCode: sentinel.exitCode,
          at: sentinel.at,
        })
      }
      // Record install/update facts synchronously, so the recency ranking has
      // real data even when this boot dies before an async write completes.
      const current = bundleVersionsSync(this.profileDir)
      const previous = this.store.readSnapshotSync()
      const { install, update } = diffVersions(previous, current)
      for (const i of install) this.store.appendSync({ kind: 'install', bundle: i.name, version: i.version })
      for (const u of update) {
        this.store.appendSync({ kind: 'update', bundle: u.name, version: u.to, prevVersion: u.from })
      }
      this.store.writeSnapshotSync(current)
      this.recordStep(
        'startup-record',
        true,
        `崩溃哨兵 ${sentinel ? `退出码 ${sentinel.exitCode}` : '无'}；安装 ${install.length} / 更新 ${update.length}`,
      )
    } catch (error) {
      /* best effort: the journal must never break the host's startup */
      this.recordStep('startup-record', false, describeError(error))
    }
  }

  /**
   * Publish the recovery decision at CRASH time.
   *
   * This runs inside the process-level exit handler, so it must be fully
   * synchronous. It is the decisive step of the whole design: the next boot's
   * guarded patch rows read the decision file in their `disabled` expression,
   * which the Loader evaluates BEFORE importing the suspect plugin's module —
   * so the suspect never loads and the crash cannot repeat.
   *
   * Publishing at crash time (rather than at the next boot) removes the race:
   * the Loader creates rows concurrently, so a decision written while the guard
   * was loading could arrive after the suspect's row had already been
   * evaluated.
   */
  publishDecisionOnCrash(exitCode: number): void {
    try {
      this.machine.transition('deciding', `退出码 ${exitCode} 触发恢复决策`)
      const state = this.store.readStateSync()
      const seq = state.crashSeq + 1
      const ranked = this.rankedSuspectsSync()
      const n = Math.min(Math.max(1, seq), Math.max(1, this.config.maxAutoDisable))
      const targets = pickSuspects(ranked, n)
      // 置信分级（v0.9.0）：唯一嫌疑是确定性证据，第 1 轮即行动；
      // 多嫌疑是概率性证据，连续 confirmRounds 轮同头号嫌疑才动手。
      // 环境变化（runtime/头号插件版本）⇒ 历史计数清零。
      const history = this.readCrashHistory()
      const envChanged = environmentChanged(history[history.length - 1], safeVersion(), ranked)
      // crashSeq 进判定（v0.11.1）：连续崩溃达到 3 次即兜底升级为行动 ——
      // 崩溃循环本身是确定性事实，不能让计数失效把宿主钉死在循环里。
      const verdict = assessConfidence(envChanged ? [] : history, ranked, {
        confirmRounds: this.config.confirmRounds,
        crashSeq: seq,
      })
      this.store.appendSync({
        kind: 'note',
        detail: `恢复判定：${verdict.label}`,
      })
      this.store.appendSync({
        kind: 'crash-detected',
        detail: `第 ${seq} 次崩溃（退出码 ${exitCode}）`,
        exitCode,
        suspects: targets.map((t) => t.bundle),
      })
      // 两阶段（v0.9.0）：act=false 只写 prepared（嫌疑保留、disable 为空），
      // 守护行拿到空名单 = 全放行 —— 偶发崩溃不该有人被关。
      // act=true 直接 quarantined（动手了），补 prepared 历史到 journal。
      this.store.writeDecisionSync({
        capturedAt: new Date().toISOString(),
        suspects: ranked.map((s) => ({
          bundle: s.bundle,
          version: s.version,
          lastChangeAt: s.lastChangeAt,
        })),
        disable: verdict.act ? targets.map((t) => t.bundle) : [],
        reason: 'crash-recovery',
        phase: verdict.act ? 'quarantined' : 'prepared',
        crashSeq: seq,
      })
      if (!verdict.act) {
        // 观察轮：不关任何插件，但崩溃证据链完整保留 —— 这是下次判定的输入。
        // verdict 落进 state：status 工具与面板由此显示「观察中 N/M 轮」
        // （崩溃路径是同步的，state 用 writeStateSync 已有机制带走）。
        this.store.writeStateSync({
          ...this.store.readStateSync(),
          lastRecoveryVerdict: {
            at: new Date().toISOString(),
            crashSeq: seq,
            evidence: verdict.evidence,
            rounds: verdict.rounds,
            required: verdict.required,
            act: verdict.act,
            label: verdict.label,
            headSuspect: targets[0]?.bundle ?? null,
          },
        })
        this.recordStep('crash-decision', true, `第 ${seq} 次崩溃 → 观察轮（未关闭插件）：${verdict.label}`)
        return
      }
      // act=true 也要带 verdict：工具显示「为什么关了它」。
      this.store.writeStateSync({
        ...this.store.readStateSync(),
        lastRecoveryVerdict: {
          at: new Date().toISOString(),
          crashSeq: seq,
          evidence: verdict.evidence,
          rounds: verdict.rounds,
          required: verdict.required,
          act: verdict.act,
          label: verdict.label,
          headSuspect: targets[0]?.bundle ?? null,
        },
      })
      // 指针必须与决策**同时**落地：守护行的表达式在下次启动时
      // 只读 profile 目录下的指针。
      writePointer(this.profileDir, this.projectKey, this.store.partitionPath)
      this.store.writeStateSync({
        ...state,
        crashSeq: seq,
        stabilized: false,
        autoDisabled: targets.map((t) => ({
          name: t.bundle,
          version: t.version,
          disabledAt: new Date().toISOString(),
          reason: 'auto-recency' as const,
          crashSeq: seq,
        })),
      })
      // 崩溃路径是**同步**的：进入/退出由一条闭合区间表达（这里没时间做两段式，
      // 进程随时会死，留一条永远闭合不了的区间反而是假数据）。
      this.recordStep('crash-decision', true, `第 ${seq} 次崩溃 → 关闭 ${targets.map((t) => t.bundle).join(', ') || '无'}`)
    } catch (error) {
      // 崩溃路径失败必须留痕（步骤 + stderr 双通道）：决策没发出去意味着
      // 下次启动还会重演同一次崩溃，这是最需要被看见的失败。
      this.recordStep('crash-decision', false, describeError(error))
      // The crash is already recorded by the sentinel; report why the decision
      // could not be published, because a silent failure here means the crash
      // will repeat on the next boot.
      try {
        process.stderr.write(
          `dsh-recency-guard: publishing the recovery decision failed: ${String(error)}\n${(error as Error)?.stack ?? ''}\n`,
        )
      } catch {
        /* stderr is gone; nothing more to do */
      }
    }
  }

  /**
   * Boot: detect a previous crash, and if the profile crashed last run,
   * auto-disable the most-recently-updated suspect(s).
   *
   * The crash signal is the process-level sentinel file, written when the
   * previous run exited with a non-zero code. A fiber disposer cannot be used
   * for this: the host disposes fibers on a crash too.
   */
  async boot(): Promise<void> {
    this.beginStep('boot')
    try {
      await this.bootInner()
      this.endStep('boot', true, '启动流程完成')
    } catch (error) {
      // v0.11.1 紧急修复：boot **绝不向外抛**（此前 rethrow 直接把宿主拖进
      // `dsh: fatal load failure`，实测：崩溃遗留的 0 字节 state.json.lock
      // 让 updateState 等满 3s 超时，异常冒到 loader 即宿主退出码 1）。
      //
      // 本插件的全部价值都建立在「观测/恢复设施不能拖垮主流程」之上：
      // 守护自己起不来时正确姿势是**降级留痕**（步骤记失败 + 警告日志），
      // 让宿主照常启动；下一个启动周期可以继续尝试恢复。
      this.endStep('boot', false, describeError(error))
      try {
        this.ctx.logger?.warn?.(`[recency-guard] 守护启动降级（宿主继续启动）：${describeError(error)}`)
      } catch {
        /* 日志通道失败也不能抛出 */
      }
    }
  }

  /** Boot 的实现体（外层负责步骤计时与失败原因留痕）。 */
  private async bootInner(): Promise<void> {
    await this.store.init()
    const state = await this.store.readState()
    const sentinel = readSentinel(this.store.partitionPath)
    if (sentinel) clearSentinel(this.store.partitionPath)
    // The sentinel says the PREVIOUS run crashed: this boot is the recovery
    // boot, and the decision it published must not be touched.
    const crashedLastRun = sentinel !== null

    // ---------- 第二条检测通道：哨兵缺席的异常终止（v0.12.1） ----------
    // 用户旅程实测出的 P0：强杀沙箱后 bootMarker 残留（pid 39576）而
    // crashSeq 仍是 0，面板说「启动时未发现上次崩溃」。
    // 根因是信号源的覆盖面：哨兵写在 `process.on('exit')` 里，而
    // SIGKILL / OOM killer / 断电 / 原生段错误**根本不运行 exit 处理器**。
    // 危险的不是少记一次，而是崩溃循环失去升级依据 —— 插件以原生方式
    // 撞死宿主时，每一轮都只看到残留标记、每一轮都被当成干净启动清零计数，
    // 于是永远停在「关 0 个」，正是本插件要防的那个场景。
    const staleMarker = state.bootMarker
    const exitClass = classifyAbnormalExit({
      sentinelPresent: sentinel !== null,
      staleBootMarker: staleMarker,
      // pid 存活复核：残留标记不携带死因，「另一个实例还开着」不是崩溃。
      stalePidAlive: staleMarker === null ? false : pidAlive(staleMarker.pid),
      // 同一进程内的 boot 重入（热重载/HMR）也要认出来 —— 实测：装完新版后
      // 那个 pid 又写了一条启动记录，若不识别就会被读成「另一个实例在跑」。
      currentPid: process.pid,
    })
    // 上一轮的存活时长（人读用；判据不依赖它 —— 死亡时间无法从磁盘推出）。
    const staleAgeMs = staleMarker === null ? 0 : Date.now() - Date.parse(staleMarker.startedAt)
    const abnormalSeqNext = exitClass === 'abnormal' ? (state.abnormalExitSeq ?? 0) + 1 : 0
    if (exitClass === 'abnormal') {
      // 记成 crash-detected 而不是新 kind：journal 的 kind 是跨层词汇表
      // （store / observations 的 FlowAction / 流动映射 / 面板着色四处），
      // 漏改任一处这条事实就在事件流里静默消失。退出码缺席写在 detail 里。
      this.store.appendSync({
        kind: 'crash-detected',
        detail: `上次运行未留下退出码（哨兵缺席）—— 强杀/OOM/断电/原生崩溃之一；` +
          `启动于 ${staleMarker?.startedAt ?? '?'}（约 ${Math.max(0, Math.round(staleAgeMs / 1000))}s 前），` +
          `pid ${staleMarker?.pid ?? '?'} 已不存在，连续异常终止 ${abnormalSeqNext} 轮`,
        exitCode: null,
        signal: 'unobserved',
      })
    } else if (exitClass === 'concurrent') {
      // 并发实例不是崩溃：如实留痕但计数归零，避免「有人开着另一个 dsh」
      // 被读成「宿主崩了」进而误关插件。
      this.store.appendSync({
        kind: 'note',
        detail: `检测到同 profile 的另一个实例仍在运行（pid ${staleMarker?.pid}）—— 不计为异常终止`,
      })
    } else if (exitClass === 'self-reload') {
      // 同一进程内重跑 boot（热重载 / HMR reconcile）：不是崩溃，也不是并发实例。
      // 这条分支存在的意义是**防假归因** —— 实测：装完新版后同一 pid 又写了
      // 一条启动记录，若归到 concurrent 就会报「检测到另一个实例」，
      // 用户会去查一个根本不存在的第二个进程。
      this.store.appendSync({
        kind: 'note',
        detail: `同一进程内重新加载守护（pid ${process.pid}）—— 不计为异常终止`,
      })
    }

    // 两阶段对账（v0.9.0）：上一轮可能留下 prepared 记录（崩溃打断或正常
    // 退出没走到升级）。按磁盘现状归类：autoDisabled 里有 = 关闭已走到
    // pluginManager ⇒ confirmed；不在 ⇒ reverted（证据链保留）。
    try {
      const decision = this.store.readDecisionSync()
      if (decision?.phase === 'prepared' && decision.disable.length > 0) {
        const stateNow = this.store.readStateSync()
        const disabledNow = new Set(stateNow.autoDisabled.map((d) => d.name))
        const reconciled = reconcilePrepared(
          decision.disable.map((bundle) => ({ bundle, preparedAt: decision.capturedAt, crashSeq: decision.crashSeq ?? 0 })),
          new Map(decision.disable.map((b) => [b, !disabledNow.has(b)] as const)),
        )
        for (const r of reconciled) {
          this.store.appendSync({
            kind: 'note',
            detail: `两阶段对账：${r.bundle} → ${r.outcome === 'confirmed' ? '关闭已生效（confirmed）' : '未生效（reverted，重启后重试或人工 reenable）'}`,
          })
        }
      }
    } catch (err) {
      // 对账失败不拖垮启动：prepared 记录保持原样，下轮再对。
      this.ctx.logger?.warn?.(`[recency-guard] prepared 对账失败：${describeError(err)}`)
    }
    // A crash recovery already published the decision and recorded the
    // disabled bundles at the end of the crashed run.
    const recovering = state.autoDisabled.length > 0

    // 状态机迁移（白盒透明：每次迁移都带原因与时刻）。
    if (crashedLastRun) {
      this.machine.transition('crashed', `上次运行以退出码 ${sentinel?.exitCode ?? '未知'} 结束`)
    } else {
      this.machine.transition('monitoring', '启动时未发现上次崩溃')
    }

    await this.store.updateState((s) => ({
      ...s,
      bootMarker: { startedAt: new Date().toISOString(), pid: process.pid },
      crashedRun: false,
      lastExitCode: undefined,
      // 计数随每轮启动重写：abnormal 累加，clean/concurrent 归零。
      // 不在别处清零 ⇒ 「计数从哪来」只有一条路径可查。
      abnormalExitSeq: abnormalSeqNext,
    }))

    try {
      await this.recordChanges()
    } catch (err) {
      this.ctx.logger.warn(`[recency-guard] 记录插件变更失败：${describeError(err)}`)
    }

    // 官方实验插件观测（只记录不关闭）：与 recordChanges 同级 try/catch ——
    // 观测通道失效不能影响变更记录与恢复主流程。
    try {
      await this.observeOfficialExperimental()
    } catch (err) {
      this.ctx.logger.warn(`[recency-guard] 官方实验插件观测失败：${describeError(err)}`)
    }

    // ---------- 恢复/升级的分支（v0.12.1 重排） ----------
    // 判据顺序是语义问题，不是风格问题：
    //   crashedLastRun（哨兵在）> exitClass==='abnormal'（标记残留且 pid 已死）
    //   > recovering（名单里有被关的插件）> 干净启动。
    // 「上一轮是否活过了启动」只能由**上一轮的退出方式**回答；此前用
    // `!crashedLastRun` 当「活过了」的代理，在哨兵通道下成立（没哨兵=干净退出），
    // 但新增通道之后不再成立：异常终止同样没有哨兵。若沿用旧条件，
    // 「关了嫌疑插件 → 又死了一次（无哨兵）」会被读成「崩溃已过」而把插件
    // 全部恢复 —— 那等于把刚建立的隔离亲手拆掉，正是崩溃循环最需要的反面。
    if (recovering && !crashedLastRun && exitClass === 'clean') {
      // The profile booted with the suspect(s) disabled and SURVIVED the boot,
      // so the crash is over. Restore everything except the prime suspect,
      // which stays off until the user confirms it with the reenable action.
      this.ctx.logger.warn(
        `[recency-guard] 上次崩溃已通过阻止加载 ${state.autoDisabled.map((d) => d.name).join(', ')} 恢复。`,
      )
      if (this.config.autoRestore) {
        // v0.11.2：恢复要经过插件管理器的 HMR 事务，而 boot 阶段 Loader
        // 自己可能正在事务中（实测 enable 返回 `HMR transactions cannot be
        // nested` 且 application=failed）。延后 1.5s 到事务之外执行；
        // 定时器 unref 不拖住宿主退出。失败由 reenable 的诚实结果兜底
        // （不谎报成功、留在 autoDisabled 下轮重试）。
        const timer = setTimeout(() => {
          void this.restore().catch((err) => {
            try {
              this.ctx.logger.warn(`[recency-guard] 自动恢复配置失败：${describeError(err)}`)
            } catch {
              /* 日志通道失败也不能抛出 */
            }
          })
        }, 1500)
        ;(timer as { unref?: () => void }).unref?.()
      }
    } else if (recovering) {
      // 仍在崩溃循环里（哨兵在 / 上一轮异常终止 / 并发实例语义不明）：
      // 决策保持原样，恢复会把嫌疑插件重新放进来、把崩溃直接带回来。
      const why =
        crashedLastRun
          ? '上次崩溃后启动'
          : exitClass === 'abnormal'
            ? `上一轮异常终止（连续 ${abnormalSeqNext} 轮）`
            : exitClass === 'concurrent'
              ? '同 profile 存在另一个运行中的实例'
              : '守护在同一进程内重载'
      this.ctx.logger.warn(`[recency-guard] ${why}，保持嫌疑插件关闭。`)
    } else if (exitClass === 'abnormal') {
      // 没有隔离记录 + 上一轮异常终止 ⇒ 走概率性通道：累计到 confirmRounds
      // 轮才动手（沿用 v0.9 分级，不新造策略）。第一轮只观察不动手，
      // 因为「标记残留」同样可由用户主动杀进程/关机产生。
      const decision = abnormalExitDecision(abnormalSeqNext, this.config.confirmRounds, this.config.maxAutoDisable)
      const ranked = this.rankedSuspectsSync()
      const head = ranked.length === 0 ? null : ranked[0].bundle
      this.store.appendSync({
        kind: 'note',
        detail: decision.act
          ? `异常终止判定：连续 ${decision.rounds}/${decision.required} 轮 ⇒ 行动，本轮关闭 ${decision.targets} 个（头号嫌疑 ${head ?? '无'}）`
          : `异常终止判定：观察中 ${decision.rounds}/${decision.required} 轮（残留标记也可能是人为杀进程，不动手）`,
      })
      await this.store.updateState((s) => ({
        ...s,
        lastRecoveryVerdict: {
          at: new Date().toISOString(),
          crashSeq: abnormalSeqNext,
          evidence: 'probabilistic',
          rounds: decision.rounds,
          required: decision.required,
          act: decision.act,
          label: decision.act
            ? `异常终止累计 ${decision.rounds} 轮 ⇒ 关闭 ${decision.targets} 个`
            : `异常终止观察中（${decision.rounds}/${decision.required} 轮）`,
          headSuspect: head,
        },
      }))
      if (decision.act && head !== null) {
        // 复用既有恢复通道：备份配置 + 关闭 + 发布决策（守护行据此拦截）。
        // 不另写一套关闭逻辑，否则两条通道的隔离语义会各自漂移。
        await this.recover(decision.targets)
      }
    } else {
      await this.store.updateState((s) => ({ ...s, crashSeq: 0 }))
    }
  }

  /**
   * Disable the N most-recently-updated suspect bundles (N = min(crashSeq, maxAutoDisable)).
   * Each target's config is backed up before disabling.
   */
  async recover(crashSeq: number): Promise<RecencyEntry[]> {
    const ranked = await this.rankedSuspects()
    const n = Math.min(Math.max(1, crashSeq), Math.max(1, this.config.maxAutoDisable))
    const targets = pickSuspects(ranked, n)
    const already = new Set((await this.store.readState()).autoDisabled.map((d) => d.name))

    for (const t of targets) {
      if (already.has(t.bundle)) continue
      await this.disableBundle(t.bundle, 'auto-recency', crashSeq)
    }

    // Publish the decision for the pre-boot helper, so the next boot can keep
    // the suspect off even if this process dies again before it can persist.
    await this.publishDecision(ranked, targets.map((t) => t.bundle), 'crash-recovery', crashSeq)
    return targets
  }

  /** Manual recovery entry point (tool). Runs one pass with crashSeq = 1. */
  async recoverNow(): Promise<unknown> {
    const targets = await this.recover(1)
    return {
      disabled: targets.map((t) => t.bundle),
      note: '已关闭最近更新的嫌疑插件。重启 dsh 后若仍崩溃，将自动关闭最近更新的 2 个。',
    }
  }

  /** Publish the pre-boot decision file the guarded patch rows consult. */
  private async publishDecision(
    suspects: RecencyEntry[],
    disable: string[],
    reason: 'none' | 'crash-recovery',
    crashSeq?: number,
  ): Promise<void> {
    this.store.writeDecisionSync({
      capturedAt: new Date().toISOString(),
      suspects: suspects.map((s) => ({
        bundle: s.bundle,
        version: s.version,
        lastChangeAt: s.lastChangeAt,
      })),
      disable,
      reason,
      ...(crashSeq === undefined ? {} : { crashSeq }),
    })
    // 同步写指针：守护行的表达式只认 profile 目录下的指针，
    // 由它再找到**本分区**的决策文件（分区键表达式算不出来）。
    writePointer(this.profileDir, this.projectKey, this.store.partitionPath)
  }

  /** Disable a single bundle, backing up its config first, and journal it. */
  async disableBundle(bundle: string, reason: 'auto-recency' | 'manual', crashSeq: number): Promise<void> {
    // Snapshot config before disabling so a later re-enable can restore it.
    try {
      const snap = this.snapshotConfig(bundle)
      if (snap !== undefined) await this.store.writeBackup(bundle, snap)
    } catch (err) {
      this.ctx.logger.warn(`[recency-guard] 备份 ${bundle} 配置失败：${describeError(err)}`)
    }

    // Disable every addressable plugin row the bundle contributes. The bundle
    // layer itself is deselected too, so a fresh boot does not re-add the row.
    const rows = await this.suspectRows([{ bundle, lastChangeAt: '', lastKind: 'install' }])
    const results: unknown[] = []
    for (const row of rows) {
      try {
        results.push(await this.pm.setPluginEnabled(row.entryId, false))
      } catch (err) {
        this.ctx.logger.warn(`[recency-guard] 关闭插件 ${row.moduleName} 失败：${describeError(err)}`)
      }
    }
    try {
      results.push(await this.pm.setBundleEnabled(bundle, false))
    } catch (err) {
      this.ctx.logger.warn(`[recency-guard] 关闭组合包 ${bundle} 失败：${describeError(err)}`)
    }

    await this.store.append({ kind: 'disable', bundle, detail: reason, result: safeJson(results) })
    await this.store.updateState((s) => {
      if (s.autoDisabled.some((d) => d.name === bundle)) return s
      return {
        ...s,
        autoDisabled: [
          ...s.autoDisabled.filter((d) => d.name !== bundle),
          {
            name: bundle,
            disabledAt: new Date().toISOString(),
            reason,
            crashSeq: reason === 'auto-recency' ? crashSeq : 0,
          },
        ],
      }
    })
    this.ctx.logger.warn(`[recency-guard] 已关闭嫌疑插件 ${bundle}（${reason}）。重启后生效。`)
  }

  /** Snapshot a bundle's merged config (inherited + override) from the config editor. */
  private snapshotConfig(bundle: string): unknown {
    // 服务缺席（可选依赖）⇒ 没有备份，而不是抛异常：备份是 best-effort，
    // 关闭嫌疑插件的业务动作不该因为拿不到配置就中断。
    if (!this.configEditor) return undefined
    const rows = this.configEditor.configuration()
    const match = rows.filter((r) => r.entry?.name === bundle)
    if (match.length === 0) return undefined
    return match.map((r) => ({ entry: r.entry, inherited: r.inherited, override: r.override }))
  }

  /**
   * Re-enable bundles that were auto-disabled, EXCEPT the top suspect (the most
   * recently updated one, the most likely culprit). Their config is restored
   * from the backup taken before the disable.
   */
  async restore(): Promise<unknown> {
    this.beginStep('restore')
    try {
      const result = await this.restoreInner()
      this.endStep('restore', true, `恢复 ${(result as { reenabled?: string[] })?.reenabled?.length ?? 0} 个`)
      return result
    } catch (error) {
      this.endStep('restore', false, describeError(error))
      throw error
    }
  }

  /** Restore 的实现体（外层负责步骤计时与失败原因留痕）。 */
  private async restoreInner(): Promise<unknown> {
    const state = await this.store.readState()
    const auto = state.autoDisabled
    this.machine.transition('stabilizing', '崩溃后成功启动，准备恢复配置')
    if (auto.length === 0) {
      await this.publishDecision([], [], 'none')
      return { reenabled: [], keptDisabled: [], note: '没有自动关闭记录。' }
    }

    // The bundles the recovery disabled are the ones to keep off. The decision
    // that produced them is the authority here — recomputing the ranking could
    // rank a DIFFERENT bundle on top (the ranking changes as plugins are
    // installed), and re-enabling the actual suspect would bring the crash back.
    const disabled = new Set(auto.map((d) => d.name))
    const reenabled: string[] = []
    const keptDisabled: string[] = []
    const failed: string[] = []

    for (const d of auto) {
      // The most recently disabled bundle is the prime suspect: it stays off
      // until the user confirms it with the reenable action.
      if (d.name === auto[auto.length - 1]?.name) {
        keptDisabled.push(d.name)
        continue
      }
      // v0.11.2 白盒修复：恢复结果必须如实区分「真的启用了」与「管理器拒绝」。
      const result = (await this.reenable(d.name)) as { reenabled?: boolean }
      if (result?.reenabled === true) reenabled.push(d.name)
      else failed.push(d.name)
    }

    await this.store.updateState((s) => ({
      ...s,
      // 失败者留在 autoDisabled（下轮启动重试）；成功者与首要嫌疑移出。
      autoDisabled: s.autoDisabled.filter((d) => keptDisabled.includes(d.name) || failed.includes(d.name)),
      stabilized: true,
      restored: [...s.restored, ...reenabled],
    }))
    this.machine.transition('recovered', `已恢复 ${reenabled.length} 个插件`)
    await this.store.append({
      kind: 'restore',
      detail: `重新启用 ${reenabled.join(', ') || '无'}${failed.length > 0 ? `；未启用（管理器拒绝，保留待重试） ${failed.join(', ')}` : ''}`,
    })
    await this.publishDecision(
      [...disabled].map((bundle) => ({ bundle, lastChangeAt: '', lastKind: 'install' as const })),
      [...keptDisabled, ...failed],
      keptDisabled.length || failed.length ? 'crash-recovery' : 'none',
    )
    return {
      reenabled,
      keptDisabled: [...keptDisabled, ...failed],
      note: keptDisabled.length || failed.length
        ? `已恢复 ${reenabled.length} 个配置；${keptDisabled.length > 0 ? `仅保留嫌疑插件 ${keptDisabled.join(', ')} 关闭` : ''}${failed.length > 0 ? `${keptDisabled.length > 0 ? '；' : ''}${failed.join(', ')} 管理器拒绝恢复，已留在名单待下轮重试` : ''}。确认安全后可用 reenable 手动开启。`
        : '已恢复全部配置。',
    }
  }

  /** Manually re-enable one bundle, noting its backed-up config. */
  async reenable(bundle: string): Promise<unknown> {
    const rows = await this.suspectRows([{ bundle, lastChangeAt: '', lastKind: 'install' }])
    const results: unknown[] = []
    try {
      results.push(await this.pm.setBundleEnabled(bundle, true))
    } catch (err) {
      this.ctx.logger.warn(`[recency-guard] 启用组合包 ${bundle} 失败：${describeError(err)}`)
    }
    for (const row of rows) {
      try {
        results.push(await this.pm.setPluginEnabled(row.entryId, true))
      } catch (err) {
        this.ctx.logger.warn(`[recency-guard] 启用插件 ${row.moduleName} 失败：${describeError(err)}`)
      }
    }
    await this.store.append({ kind: 'enable', bundle, result: safeJson(results) })
    // v0.11.2 白盒修复：**只有真的 applied 才算恢复成功**。
    // 此前无条件返回 reenabled:true 并从 autoDisabled 里删掉 —— 实测
    // 管理器返回 `application: 'failed'`（HMR 嵌套事务）时，state 仍记
    // 「已恢复」，面板/工具显示成功而插件实际关闭：假绿比失败更糟。
    const applied = results.some(
      (r) => typeof r === 'object' && r !== null && (r as { application?: unknown }).application === 'applied',
    )
    if (applied) {
      await this.store.updateState((s) => ({
        ...s,
        autoDisabled: s.autoDisabled.filter((d) => d.name !== bundle),
      }))
    } else {
      this.ctx.logger.warn(`[recency-guard] ${bundle} 未能恢复（管理器未 applied），保留在自动关闭名单待下轮重试`)
    }
    const backup = await this.store.readBackup(bundle)
    return { bundle, reenabled: applied, hasConfigBackup: backup !== null }
  }

  /**
   * Clear the crash marker on teardown.
   *
   * This runs on BOTH a clean exit and a crash, because the host disposes its
   * fibers before exiting with code 1 as well. The crash signal itself lives
   * in the process-level sentinel file, which the exit handler writes; this
   * disposer only keeps the in-state marker tidy.
   *
   * The crash counter is NOT reset here: `shutdown` cannot tell a clean exit
   * from a crash on its own, and the counter must survive until the next boot
   * knows whether the run ended cleanly. The next boot resets it.
   */
  async shutdown(): Promise<void> {
    try {
      await this.store.updateState((s) => ({ ...s, bootMarker: null }))
      this.recordStep('shutdown', true, '退出清理完成')
    } catch (error) {
      /* best-effort: a crashed run simply leaves the marker for the next boot */
      this.recordStep('shutdown', false, describeError(error))
    }
  }

  /** 事件驱动加速器 —— 实现见 event-watch.ts（index.ts 只做编排与降级）。 */
  watchPluginChanges(): () => void {
    return watchPluginChanges(this.ctx, () => this.recordChanges(), (message) => {
      this.recordStep('watch-events', true, message)
    }, (message) => {
      this.recordStep('watch-events', false, message)
    })
  }

  /**
   * 观测记录 —— 从日志推导的启动观测序列。
   *
   * 数据来源：journal 里的 'note'（每次启动）与 'crash-detected'（崩溃）。
   * 一次启动的观测 = 一条 note；其后若出现 crash-detected，则该次启动崩溃。
   */
  private observations(): Observation[] {
    return deriveObservations(this.store.readJournalSync(1000))
  }

  /**
   * 嫌疑插件的风险输入。
   *
   * 历史嫌疑次数来自 journal 里该插件被写入 autoDisabled 的次数，
   * 观测次数是该插件在嫌疑名单里出现过的总次数。
   */
  private riskInputs(): Array<{
    bundle: string
    experimental: boolean
    lastChangeAt: string
    suspectHits: number
    observations: number
  }> {
    return deriveRiskInputs(this.rankedSuspectsSync(), this.store.readJournalSync(1000))
  }

  /**
   * 面板快照 —— 状态、指标、排名、能力矩阵、图谱连通性、分区列表。
   *
   * 纯读：观测面不写任何状态。所有视图渲染同一份快照，
   * 保证界面上的事实互相一致（不会出现「状态是 A 时刻、指标是 B 时刻」）。
   */
  /**
   * revision 事实的**唯一装配处**（v0.12）。
   *
   * 为什么必须是单一函数而不是两处内联：面板快照里的 revision 与动作路由
   * 核对用的 revision 必须是**同一组字段跑同一算法**。两处各自装配时，
   * 将来谁加了一个字段而忘了另一处，结果不是「少核对一项」而是**每次动作都
   * 409**（面板发出去的凭证永远核对不过）—— 把一个可选加强项变成整体失效。
   * 现在两处都只经这里，字段漂移在结构上无法发生（契约层另有比对门）。
   */
  private revisionFactsFrom(state: GuardState, journalTail: string): RevisionFacts {
    return {
      crashSeq: state.crashSeq,
      stabilized: state.stabilized,
      decisionDisable: this.store.readDecisionSync()?.disable ?? [],
      journalTail,
      autoDisabled: state.autoDisabled.map((d) => d.name),
      restored: state.restored,
    }
  }

  /**
   * 当前写状态凭证（v0.12 乐观并发）。
   *
   * 为什么不复用 panelSnapshot：快照要投影指标、风险排名、能力图与马尔可夫
   * 矩阵（几十毫秒），而动作路由**每次 POST** 都要核对一次。这里只读派生
   * revision 必需的三样事实（state / decision / journal 尾），一次同步
   * readState + 一次 readDecisionSync + 一次 journal 末行读，开销小一个量级。
   */
  async currentRevision(): Promise<string> {
    const state = await this.store.readState()
    // 凭证只依赖 journal 的**末行**（写一次就变一次），不需要切片：
    // 取 limit 1 而非复用快照那份 slice(-40)，把「取末行」这个意图写死，
    // 而不是依赖「两份切片的末位恰好相同」这一巧合。
    const tail = this.store.readJournalSync(1)
    return computeRevision(this.revisionFactsFrom(state, tail.length > 0 ? tail[tail.length - 1].t : ''))
  }

  /**
   * 面板快照 —— 状态、指标、排名、能力矩阵、图谱连通性、分区列表。
   *
   * 纯读：观测面不写任何状态。所有视图渲染同一份快照，
   * 保证界面上的事实互相一致（不会出现「状态是 A 时刻、指标是 B 时刻」）。
   */
  async panelSnapshot(): Promise<PanelSnapshot> {
    const state = await this.store.readState()
    // 事件流快照：journal 尾部直接投影（时间升序），面板据此画「流动」。
    const recentEvents = this.store
      .readJournalSync(1000)
      .slice(-40)
      .map((e) => ({ t: e.t, kind: e.kind, bundle: e.bundle, detail: e.detail }))
    return buildPanelSnapshot({
      profile: this.profileName,
      projectKey: this.projectKey,
      stage: this.machine.stage,
      transitions: this.machine.transitions,
      stabilityScore: this.machine.stabilityScore(),
      observations: this.observations(),
      riskInputs: this.riskInputs(),
      restored: state.restored,
      lastRecoveryVerdict: state.lastRecoveryVerdict,
      autoDisabled: state.autoDisabled.map((d) => ({
        name: d.name,
        reason: d.reason,
        crashSeq: d.crashSeq,
        disabledAt: d.disabledAt,
      })),      partitions: readPartitionIndex(this.profileDir),
      backupPolicy: {
        versionedBackups: this.config.versionedBackups,
        retain: this.config.backupRetain,
        // customRoot 的判定：环境变量或配置了自定义根 ⇒ resolveBackupsDir
        // 会把备份指到分区目录之外。用「备份根不在分区内」反推，避免在
        // 这里重复维护一条 backupRoot 解析规则（单一真相在 store）。
        customRoot: !this.store.backupsRoot.startsWith(this.store.partitionPath),
        root: this.store.backupsRoot,
        configEditorAvailable: this.configEditorAvailable,
      },
      registeredExposedAs: [...this.actuallyRegistered],
      recentEvents,
      // revision 的事实基座（v0.12 乐观并发）：全部取自上面已经读过的状态，
      // 只多一次 readDecisionSync —— 决策文件是几十十字节的小 JSON，
      // 而它是「下次启动会不会拦住插件」的真值，不读它就等于用一份
      // 可能过期的名单派生凭证。journal 尾复用 recentEvents（同一份读盘结果）。
      // revision 的事实基座：与 currentRevision() **同一个装配函数**，
      // 所以「面板发出去的凭证」与「宿主核对用的凭证」派生自同一组字段。
      revisionFacts: this.revisionFactsFrom(state, recentEvents.length > 0 ? recentEvents[recentEvents.length - 1].t : ''),
      diagnostics: {
        pluginVersion: this.selfPackage.version,
        hostVersion: readHostVersion(),
        repositoryUrl: this.selfPackage.repositoryUrl,
        issuesUrl: this.selfPackage.issuesUrl,
      },
    })
  }

  /** 图谱数据（能力生产消费关系 + 缺口节点）。 */
  async graphData(): Promise<unknown> {
    return buildGraphDataFor(buildCapabilityGraph())
  }

  /**
   * 跨分区只读快照（v0.11 P0：数据面真正支持 `?partition=` 查询）。
   *
   * 投影实现在 `partition-snapshot.ts`（独立模块：磁盘投影有自己的一条
   * 隔离边界要讲清楚，且 index.ts 复杂度预算 100 不该被它撑破）。
   */
  async partitionSnapshot(key: string): Promise<unknown> {
    return buildPartitionSnapshot(
      {
        profileDir: this.profileDir,
        profileName: this.profileName,
        config: {
          versionedBackups: this.config.versionedBackups,
          backupRetain: this.config.backupRetain,
          configEditorAvailable: this.configEditorAvailable,
        },
        selfPackage: {
          version: this.selfPackage.version,
          repositoryUrl: this.selfPackage.repositoryUrl,
          issuesUrl: this.selfPackage.issuesUrl,
        },
      },
      key,
    )
  }

  /**
   * 实际注册出去的对外名称。
   *
   * 由**注册处**收集（不是手写常量表）：工具名来自注册表 `TOOL_SURFACE`
   * （`ctx.tools.register` 用的就是它），路由名由 `registerRoutes` 在**真的**
   * 注册成功时回调登记。启动时用 `verifyContract` 与能力清单**双向**比对 ——
   * 清单有而没注册（漏登）、注册了而清单没提（虚登）都会被自动发现并记录。
   */
  private readonly actuallyRegistered = new Set<string>()

  /** 登记一个实际注册出去的对外名称（由 apply() 在注册处调用）。 */
  noteRegistered(name: string): void {
    this.actuallyRegistered.add(name)
  }

  /**
   * 启动时的契约自检（**双向**）。
   *
   * 两道门：
   * 1. `verifySurfaceAlignment`：清单 ↔ 注册表（工具名/action、路由、宿主服务依赖）
   *    双向比对 —— 这是**结构**层面的门，不依赖运行时是否真的注册成功；
   * 2. `verifyCapabilityContract`：清单声明的对外名称 ↔ 现场实际注册出来的名称 ——
   *    这是**事实**层面的门（webServer 缺席时路由不注册，这里也不该谎报）。
   *
   * 只记日志不抛异常 —— 契约缺口是要被**看见并修**的，不是要让守护流程挂掉。
   */
  verifyContract(injectedServices: Iterable<string> = []): {
    ok: boolean
    gaps: Array<{ kind: string; subject: string; detail: string }>
    missing: string[]
    extra: string[]
  } {
    const graph = buildCapabilityGraph()
    const alignment = verifySurfaceAlignment(graph, currentRegistrationSurface(), injectedServices)
    const runtime = verifyCapabilityContract(graph, this.actuallyRegistered)
    if (!alignment.ok) {
      this.ctx.logger.warn(
        `[recency-guard] 能力注册面不一致（${alignment.gaps.length} 处）—— ${alignment.gaps
          .slice(0, 8)
          .map((g) => `${g.kind}:${g.subject}`)
          .join(', ')}`,
      )
    }
    if (!runtime.ok) {
      const missing = runtime.missing.length > 0 ? `清单声明但未注册：${runtime.missing.join(', ')}` : ''
      const extra = runtime.extra.length > 0 ? `已注册但清单未声明：${runtime.extra.join(', ')}` : ''
      this.ctx.logger.warn(`[recency-guard] 能力契约不一致 —— ${missing}${missing && extra ? '；' : ''}${extra}`)
    }
    return {
      ok: alignment.ok && runtime.ok,
      gaps: alignment.gaps,
      missing: runtime.missing,
      extra: runtime.extra,
    }
  }

  /**
   * 归档重置 —— 归档当前产物，然后**以最新项目事实重跑**。
   *
   * 归档不删除证据（manifest 记录归档了什么，含搬不动的条目），但**不继承**
   * 旧结论：崩溃计数归零、决策清空、状态机强制复位，随后立刻按当前
   * node_modules / profile 清单重新推导一轮事实。
   *
   * 为什么复位必须强制（`machine.reset` 而不是 `transition`）：上一轮可能停在
   * `crashed`，而白名单里没有 `crashed → idle` 的路 —— 用 `transition` 会静默
   * 失败，界面继续显示「崩溃」，旧结论换个方式继续生效。
   */
  async archiveReset(reason: string): Promise<unknown> {
    this.beginStep('archive')
    try {
      const result = archiveAndReset(this.store.partitionPath, this.workspace, reason)
      this.machine.reset(`归档重置：${reason}`)
      await this.store.append({
        kind: 'note',
        detail: `归档重置（${reason}），归档目录 ${result.archiveDir}${
          result.skipped.length > 0 ? `，留在原地：${result.skipped.join(', ')}` : ''
        }`,
      })
      this.endStep('archive', true, `搬走 ${result.count} 项`)
      // 无等待地继续重跑：归档的语义是「重新开始执行」，不是「归完就停」。
      const basis = await this.rerunWithCurrentFacts(`归档后按最新事实重跑（${reason}）`)
      return {
        ok: true,
        archiveDir: result.archiveDir,
        count: result.count,
        skipped: result.skipped,
        manifest: result.manifest,
        basis,
      }
    } catch (error) {
      this.endStep('archive', false, describeError(error))
      throw error
    }
  }

  /**
   * 以**最新项目事实**重跑一轮基线（自举 / 举他的共同入口）。
   *
   * 重跑只认当前事实：从 profile 的 package.json + node_modules 重新读出
   * 已安装插件与版本，写进新快照，并落一条基线事件。历史产物不参与 ——
   * 它们已经被归档到 `archive/<时间戳>/`（需要对照时**显式**读取清单）。
   */
  async rerunWithCurrentFacts(reason: string): Promise<{
    at: string
    workspace: string
    projectKey: string
    bundles: Array<{ name: string; version?: string }>
    journalEvents: number
    archived: number
  }> {
    this.beginStep('rerun')
    try {
      const current = bundleVersionsSync(this.profileDir)
      const bundles = Object.entries(current)
        .map(([name, version]) => ({ name, version }))
        .sort((a, b) => a.name.localeCompare(b.name))
      // 新快照 = 当前事实；旧快照已随归档搬走（不继承）。
      this.store.writeSnapshotSync(current)
      writePointer(this.profileDir, this.projectKey, this.store.partitionPath)
      this.store.appendSync({
        kind: 'note',
        detail: `新循环基线（${reason}）：${bundles.length} 个已安装插件，工作区 ${this.workspace}`,
      })
      const journalEvents = this.store.readJournalSync(1000).length
      const archived = listArchives(this.store.partitionPath).length
      const basis = {
        at: new Date().toISOString(),
        workspace: this.workspace,
        projectKey: this.projectKey,
        bundles,
        journalEvents,
        archived,
      }
      this.endStep('rerun', true, `基线：${bundles.length} 个插件 · ${archived} 份归档`)
      return basis
    } catch (error) {
      this.endStep('rerun', false, describeError(error))
      throw error
    }
  }

  /** 列出归档（带 manifest 摘要 —— 举他对照时的事实基线）。 */
  async archives(): Promise<unknown> {
    return {
      archives: listArchives(this.store.partitionPath).map((a) => ({
        ...a,
        summary: readArchiveManifest(a.dir)?.summary,
      })),
    }
  }

  async status(): Promise<unknown> {
    const state = await this.store.readState()
    const ranked = await this.rankedSuspects()
    const lifecycle = this.lifecycleView()
    return {
      profile: this.profileName,
      // cycle-4 T03：命令窗口的隔离归因 —— 这次守护是哪个项目的事实。
      workspace: this.workspace,
      projectKey: this.projectKey,
      dshVersion: safeVersion(),
      // 反馈入口（v0.10 R18）：命令窗口的排障现场也能直达 Issues。
      pluginVersion: this.selfPackage.version,
      issuesUrl: this.selfPackage.issuesUrl,
      enabled: this.config.enabled,
      crashedLastRun: state.crashedRun === true,
      lastBootMarker: state.bootMarker,
      lastExitCode: state.lastExitCode,
      crashSeq: state.crashSeq,
      autoDisabled: state.autoDisabled,
      stabilized: state.stabilized,
      restored: state.restored,
      decisionFile: DECISION_RELATIVE_PATH,
      // 恢复判定白盒（v0.9.1）：undefined = 本分区还没有崩溃决策发生过。
      lastRecoveryVerdict: state.lastRecoveryVerdict,
      // v0.8.1：不再在数据层裁剪到 10 个。rankedSuspects 本身就是全量排序
      // （n ≤ 100，全量排序 O(n log n)），slice 只是把「插件多」变成
      // 「看不到」。显示层的截断（带省略计数）是渲染策略，不该伪装成数据。
      suspectRanking: ranked,
      suspectTotal: ranked.length,
      experimentalSuspects: ranked.filter((r) => isExperimentalName(r.bundle)).map((r) => r.bundle),
      // 生命周期步骤流：不只报「现在什么状态」，还报「做过哪些步、哪步失败过」。
      lifecycle: {
        stage: lifecycle.stage,
        stabilityScore: lifecycle.stabilityScore,
        steps: lifecycle.steps.slice(-12),
        openSteps: lifecycle.openSteps,
        rejectedTransitions: lifecycle.rejected.slice(-5),
        lastTransition: lifecycle.transitions[lifecycle.transitions.length - 1] ?? null,
      },
      // 可选服务可用性：诚实报告（false = 备份能力降级，不是错误）。
      configEditorAvailable: this.configEditorAvailable,
    }
  }
}
// 自描述/版本事实族（safeJson/safeVersion/optionalRequire/readSelfPackage/
// readHostVersion）已拆到 self-describe.ts —— 复杂度预算按文件计分，
// 旁路事实不该挤占崩溃恢复主线的预算（cycle-5）。

