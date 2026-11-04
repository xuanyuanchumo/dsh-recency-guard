import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
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
import { DECISION_RELATIVE_PATH, writePointer } from './decision.js'
import { installGuardedRows, GUARD_PACKAGE_NAME } from './guarded-rows.js'
import { deriveObservations, deriveRiskInputs } from './observations.js'
import { installExitSentinel, readSentinel, clearSentinel } from './sentinel.js'
import { StageMachine } from './lifecycle.js'
import { buildCapabilityGraph, verifyCapabilityContract } from './capability-specs.js'
import { buildPanelSnapshot, buildGraphDataFor, type PanelSnapshot } from './snapshot.js'
import { projectKey, readPartitionIndex, registerPartition, writePartitionIndex } from './isolation.js'
import { archiveAndReset, listArchives } from './archive.js'
import { wireRoutes } from './routes-plugin.js'
import { ROUTE_PATHS } from './routes.js'
import {
  renderOutcome,
  formatStatus,
  formatHistory,
  formatRecover,
  formatRestore,
  formatReenable,
  formatBackups,
  formatArchive,
  formatArchives,
  type ToolOutcome,
} from './tool-render.js'
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
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('崩溃后自动按“最近更新”关闭嫌疑插件。'),
  includeExperimental: Schema.boolean().default(true).description('把 experimental/beta 命名的组合包也算作嫌疑。'),
  maxAutoDisable: Schema.number().default(2).description('单次恢复最多自动关闭的嫌疑插件数（崩溃次数递增，封顶此值）。'),
  autoRestore: Schema.boolean().default(true).description('稳定启动后自动重新启用非嫌疑插件，恢复需要的配置。'),
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

export const inject = ['tools', 'pluginManager', 'profileContext', 'configEditor']

export function apply(ctx: Context, config: Config) {
  // The plugin-manager and config-editor services are declared by the harness
  // through `inject`; the base cordis Context type does not know them.
  const services = ctx as unknown as {
    pluginManager: PluginManagerLike
    configEditor: ConfigEditorLike
    profileContext: { name: string; dir: string; patchPath: string; cwd?: string }
  }
  const pm = services.pluginManager
  const ce = services.configEditor
  const profile = services.profileContext
  // 分区的锚点是**项目目录**，不是 profile 目录 ——
  // 同一个 profile 可以在多个项目里工作，用 profile 目录做键会让它们
  // 共用一份日志与状态，互相污染。
  //
  // profileContext 里的项目事实是 `cwd`（launcher 记录的进程工作目录）。
  const workspace = services.profileContext.cwd ?? profile.dir
  const store = new Store(profile.dir, projectKey(workspace))
  const guard = new Guard(
    ctx,
    store,
    pm,
    ce,
    config,
    profile.dir,
    profile.patchPath,
    profile.name,
    projectKey(workspace),
    workspace,
  )

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
  // 路由的对外名称同样在**注册处**登记。
  for (const path of Object.values(ROUTE_PATHS)) guard.noteRegistered(path)

  ctx.effect(
    () => {
      const dispose = wireRoutes(ctx, {
        profileDir: profile.dir,
        workspace: partition.workspace,
        profileName: profile.name,
        snapshot: () => guard.panelSnapshot(),
        graph: () => guard.graphData(),
        archive: (reason) => guard.archiveReset(reason),
        archives: () => guard.archives(),
        reenable: (bundle) => guard.reenable(bundle),
        recover: () => guard.recoverNow(),
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
      // The disposer MUST return the promise: cordis awaits an async disposer,
      // so the crash marker is cleared before the process exits.
      return () => guard.shutdown()
    },
    'recency-guard: boot + clean-shutdown marker',
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
      guard.verifyContract()
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

  // 工具的对外名称在**注册处**登记（契约自检的输入）。
  guard.noteRegistered('recency_guard')

  ctx.tools.register(
    defineTool({
      name: 'recency_guard',
      description:
        '插件崩溃恢复守护：记录第三方/实验性插件的安装、更新日期与配置备份；崩溃后按“最近更新”自动关闭嫌疑插件（先关最近 1 个，仍崩溃则关最近 2 个），稳定后自动恢复需要的配置。' +
        'action=status 查看崩溃状态、嫌疑排名与自动关闭列表；action=history 查看安装更新日志；action=recover 立即按最近更新执行一次恢复关闭；' +
        'action=restore 重新启用被自动关闭的非嫌疑插件；action=reenable 手动重新启用某个插件；action=backups 列出配置备份；' +
        'action=archive 归档当前产物并重置（按最新事实重新开始）；action=archives 列出历史归档。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'history', 'recover', 'restore', 'reenable', 'backups', 'archive', 'archives'],
          description: '要执行的操作。',
        },
        bundle: { type: 'string', description: 'reenable 的目标插件名（包名）。' },
        limit: { type: 'number', description: 'history 返回的事件条数，默认 40。' },
        reason: { type: 'string', description: 'archive 的归档原因（可选）。' },
      },
      // 规范输出：模型消费结构化事实；人读文本由 output.render 投影
      // （会话里的命令窗口显示的就是它，而不是满屏转义的 JSON）。
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: renderOutcome(value as ToolOutcome) }],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        switch (args.action) {
          case 'status':
            return formatStatus((await guard.status()) as never)
          case 'history':
            return formatHistory(await store.readJournal(args.limit ?? 40) as never)
          case 'recover':
            return formatRecover((await guard.recoverNow()) as { disabled: string[]; note: string })
          case 'restore':
            return formatRestore((await guard.restore()) as { reenabled: string[]; keptDisabled: string[]; note: string })
          case 'reenable': {
            if (!args.bundle) throw new Error('reenable 需要 bundle 参数（插件包名）。')
            return formatReenable((await guard.reenable(args.bundle)) as {
              bundle: string
              reenabled: boolean
              hasConfigBackup: boolean
            })
          }
          case 'backups':
            return formatBackups(await store.listBackups())
          case 'archive':
            return formatArchive((await guard.archiveReset(args.reason?.trim() || '工具触发归档重置')) as never)
          case 'archives':
            return formatArchives((await guard.archives()) as never)
          default:
            throw new Error(`未知操作：${String(args.action)}`)
        }
      },
    }),
  )
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

  constructor(
    private readonly ctx: Context,
    private readonly store: Store,
    private readonly pm: PluginManagerLike,
    private readonly ce: ConfigEditorLike,
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
    } catch {
      /* best effort: the journal must never break the host's startup */
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

      this.store.appendSync({
        kind: 'crash-detected',
        detail: `第 ${seq} 次崩溃（退出码 ${exitCode}）`,
        exitCode,
        suspects: targets.map((t) => t.bundle),
      })
      this.store.writeDecisionSync({
        capturedAt: new Date().toISOString(),
        suspects: ranked.map((s) => ({
          bundle: s.bundle,
          version: s.version,
          lastChangeAt: s.lastChangeAt,
        })),
        disable: targets.map((t) => t.bundle),
        reason: 'crash-recovery',
        crashSeq: seq,
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
    } catch (error) {
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
    await this.store.init()
    const state = await this.store.readState()
    const sentinel = readSentinel(this.store.partitionPath)
    if (sentinel) clearSentinel(this.store.partitionPath)
    // The sentinel says the PREVIOUS run crashed: this boot is the recovery
    // boot, and the decision it published must not be touched.
    const crashedLastRun = sentinel !== null
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
    }))

    try {
      await this.recordChanges()
    } catch (err) {
      this.ctx.logger.warn(`[recency-guard] 记录插件变更失败：${describeError(err)}`)
    }



    if (recovering && !crashedLastRun) {
      // The profile booted with the suspect(s) disabled and SURVIVED the boot,
      // so the crash is over. Restore everything except the prime suspect,
      // which stays off until the user confirms it with the reenable action.
      this.ctx.logger.warn(
        `[recency-guard] 上次崩溃已通过阻止加载 ${state.autoDisabled.map((d) => d.name).join(', ')} 恢复。`,
      )
      if (this.config.autoRestore) {
        try {
          await this.restore()
        } catch (err) {
          this.ctx.logger.warn(`[recency-guard] 自动恢复配置失败：${describeError(err)}`)
        }
      }
    } else if (recovering) {
      // This boot IS the recovery boot: the previous run crashed, so the
      // decision stays exactly as the crash published it. Restoring here would
      // re-enable the suspect and bring the crash straight back.
      this.ctx.logger.warn('[recency-guard] 上次崩溃后启动，保持嫌疑插件关闭。')
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
    const rows = this.ce.configuration()
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

    for (const d of auto) {
      // The most recently disabled bundle is the prime suspect: it stays off
      // until the user confirms it with the reenable action.
      if (d.name === auto[auto.length - 1]?.name) {
        keptDisabled.push(d.name)
        continue
      }
      await this.reenable(d.name)
      reenabled.push(d.name)
    }

    await this.store.updateState((s) => ({
      ...s,
      autoDisabled: s.autoDisabled.filter((d) => keptDisabled.includes(d.name)),
      stabilized: true,
      restored: [...s.restored, ...reenabled],
    }))
    this.machine.transition('recovered', `已恢复 ${reenabled.length} 个插件`)
    await this.store.append({ kind: 'restore', detail: `重新启用 ${reenabled.join(', ') || '无'}` })
    await this.publishDecision(
      [...disabled].map((bundle) => ({ bundle, lastChangeAt: '', lastKind: 'install' as const })),
      keptDisabled,
      keptDisabled.length ? 'crash-recovery' : 'none',
    )
    return {
      reenabled,
      keptDisabled,
      note: keptDisabled.length
        ? `已恢复需要的配置，仅保留嫌疑插件 ${keptDisabled.join(', ')} 关闭。确认安全后可用 reenable 手动开启。`
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
    await this.store.updateState((s) => ({
      ...s,
      autoDisabled: s.autoDisabled.filter((d) => d.name !== bundle),
    }))
    const backup = await this.store.readBackup(bundle)
    return { bundle, reenabled: true, hasConfigBackup: backup !== null }
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
    } catch {
      /* best-effort: a crashed run simply leaves the marker for the next boot */
    }
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
      autoDisabled: state.autoDisabled.map((d) => ({
        name: d.name,
        reason: d.reason,
        crashSeq: d.crashSeq,
        disabledAt: d.disabledAt,
      })),
      partitions: readPartitionIndex(this.profileDir),
      registeredExposedAs: [...this.actuallyRegistered],
      recentEvents,
    })
  }

  /** 图谱数据（能力生产消费关系 + 缺口节点）。 */
  async graphData(): Promise<unknown> {
    return buildGraphDataFor(buildCapabilityGraph())
  }

  /**
   * 实际注册出去的对外名称。
   *
   * 由**注册处**收集（不是手写常量表）：工具名在 `ctx.tools.register` 处登记，
   * 路由路径在 `registerRoutes` 处登记。启动时用 `verifyCapabilityContract`
   * 与能力清单**双向**比对 —— 清单有而没注册（漏登）、注册了而清单没提（虚登）
   * 都会被自动发现并响亮记录。
   */
  private readonly actuallyRegistered = new Set<string>()

  /** 登记一个实际注册出去的对外名称（由 apply() 在注册处调用）。 */
  noteRegistered(name: string): void {
    this.actuallyRegistered.add(name)
  }

  /**
   * 启动时的契约自检。
   *
   * 只记日志不抛异常 —— 契约缺口是要被**看见并修**的，不是要让守护流程挂掉。
   */
  verifyContract(): { missing: string[]; extra: string[]; ok: boolean } {
    const result = verifyCapabilityContract(buildCapabilityGraph(), this.actuallyRegistered)
    if (!result.ok) {
      const missing = result.missing.length > 0 ? `清单声明但未注册：${result.missing.join(', ')}` : ''
      const extra = result.extra.length > 0 ? `已注册但清单未声明：${result.extra.join(', ')}` : ''
      this.ctx.logger.warn(`[recency-guard] 能力契约不一致 —— ${missing}${missing && extra ? '；' : ''}${extra}`)
    }
    return result
  }

  /**
   * 归档重置 —— 归档当前产物并以最新事实从头开始。
   *
   * 归档不删除证据（manifest 记录归档了什么），但**不继承**旧结论：
   * 崩溃计数归零、决策清空，下一次启动按当前 node_modules 重新推导嫌疑。
   */
  async archiveReset(reason: string): Promise<unknown> {
    const result = archiveAndReset(this.store.partitionPath, this.workspace, reason)
    // 重置后状态机回到空闲 —— 旧结论不再生效。
    this.machine.transition('idle', `归档重置：${reason}`)
    await this.store.append({ kind: 'note', detail: `归档重置（${reason}），归档目录 ${result.archiveDir}` })
    return {
      ok: true,
      archiveDir: result.archiveDir,
      count: result.count,
      manifest: result.manifest,
    }
  }

  /** 列出归档。 */
  async archives(): Promise<unknown> {
    return { archives: listArchives(this.store.partitionPath) }
  }

  async status(): Promise<unknown> {
    const state = await this.store.readState()
    const ranked = await this.rankedSuspects()
    return {
      profile: this.profileName,
      dshVersion: safeVersion(),
      enabled: this.config.enabled,
      crashedLastRun: state.crashedRun === true,
      lastBootMarker: state.bootMarker,
      lastExitCode: state.lastExitCode,
      crashSeq: state.crashSeq,
      autoDisabled: state.autoDisabled,
      stabilized: state.stabilized,
      restored: state.restored,
      decisionFile: DECISION_RELATIVE_PATH,
      suspectRanking: ranked.slice(0, 10),
      experimentalSuspects: ranked.filter((r) => isExperimentalName(r.bundle)).map((r) => r.bundle),
    }
  }
}

function safeJson(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

function safeVersion(): string {
  try {
    // Resolved lazily: the module is only loaded when the version is asked
    // for, so an absent optional peer cannot break the plugin's startup.
    const mod = optionalRequire('@deepseek-ai/dsh-app-boot') as {
      getDshRuntimeVersion?: () => string
    }
    return typeof mod?.getDshRuntimeVersion === 'function' ? mod.getDshRuntimeVersion() : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Load an optional module by name.
 *
 * The runtime version is a detail, not a hard dependency, so this never
 * throws: a missing optional peer simply yields no version.
 */
function optionalRequire(specifier: string): unknown {
  try {
    return createRequire(import.meta.url)(specifier)
  } catch {
    return undefined
  }
}
