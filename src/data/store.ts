import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { DecisionSuspect } from '../guard/decision.js'
import { readCooccurrenceSync, writeCooccurrenceSync, readObservation, readObservationSync, writeObservation } from '../observe/cooccurrence-store.js'

/**
 * Journal / state store for dsh-recency-guard.
 *
 * Everything lives under `<profile>/.recency-guard/`:
 *   journal.jsonl  – append-only event log (install / update / enable / disable / crash / recover)
 *   snapshot.json  – last observed { bundleName -> version } for update detection
 *   state.json     – crash-recovery state (crash counter, auto-disabled set, boot marker)
 *   decision.json  – the bundles the guarded patch rows must keep off for this boot
 *   backups/<bundle>.json – config snapshot taken before a disable
 *   backups/versions/<bundle>/<version>@<ts>.json – versioned config timeline (v0.8)
 */

export const STATE_DIRNAME = '.recency-guard'

/**
 * journal 行数上限（超过后丢弃最旧的行）。
 *
 * 为什么要封顶而不是无限追加：journal 是 append-only 的崩溃证据链，
 * 但「无限增长」在长跑 profile 上会把读盘成本（每次 append 都要整读整写）
 * 与快照投影一起拖垮。1000 行足够覆盖最近若干天的安装/崩溃事件历史；
 * 丢弃是**静默**的，因此读到的样本永远要当成「窗口内样本」而非全量
 * —— 这正是统计层用 `sampleSize` 白盒标注样本量的原因。
 */
export const JOURNAL_MAX_LINES = 1000

export type JournalKind =
  | 'install'
  | 'update'
  | 'remove'
  | 'enable'
  | 'disable'
  | 'crash-detected'
  | 'auto-disable'
  | 'recover'
  | 'restore'
  | 'config-backup'
  | 'official-observe'
  | 'note'

/** An event as written to the journal. `t` is stamped by the store. */
export interface JournalEvent {
  kind: JournalKind
  bundle?: string
  /**
   * 本次事件**确实作用到**的 bundle 名列表（v0.15 / TD-1）。
   *
   * 与 `bundle` 的分工是「批量 vs 单目标」：一条 `enable` 只启用一个插件，
   * 所以用 `bundle`；而一条 `restore` 会重新启用若干个插件，此前只在自由文本
   * `detail` 里写名字，消费方（`risk-calibration.ts` 的来源判定）只能靠
   * 「连续 enable 段是否被一条 restore 收尾」的形态启发式反推那是系统恢复
   * 还是用户主动 —— 这就是本次要还的技术债。
   *
   * 语义边界（写错比不写更糟）：
   * - **只列成功的**：restore 的 `bundles` 只放真正 `applied` 的插件；被管理器
   *   拒绝的留在 `autoDisabled` 待下轮重试，把它们写进来等于宣布一件没发生的事，
   *   来源判定会据此把一次失败的恢复当成「系统已恢复」。
   * - **省略 ≠ 空**：老 journal（v0.14.0 及更早）没有这个字段，消费方必须回退到
   *   启发式；`[]` 则是「这条 restore 真的一个都没恢复」的显式事实。两者都让
   *   当前实现不改判定（见 risk-calibration 的「只升级不降级」），但语义不同，
   *   消费方不许用 `event.bundles ?? []` 抹平差异。
   */
  bundles?: string[]
  version?: string
  prevVersion?: string
  detail?: string
  [k: string]: unknown
}

/** A journal line as read back from disk. */
export interface JournalRecord extends JournalEvent {
  t: string
}

export interface RecoveredBundle {
  name: string
  version?: string
  disabledAt: string
  reason: 'auto-recency' | 'manual'
  crashSeq: number
}

export interface GuardState {
  /**
   * Set while running; cleared on a clean exit. A leftover value means the
   * previous run ended abnormally — i.e. it crashed.
   */
  bootMarker: { startedAt: string; pid: number } | null
  /** Consecutive crashed boots observed. Drives how many recent bundles get disabled (1, 2, …). */
  crashSeq: number
  /** Bundles auto-disabled by the last recovery, oldest first. */
  autoDisabled: RecoveredBundle[]
  /** True once a clean boot followed a recovery. */
  stabilized: boolean
  /** Bundles re-enabled after stabilization. */
  restored: string[]
  /** Exit code of the last run, when it ended badly. */
  lastExitCode?: number
  /** True when the previous run ended with a non-zero exit code. */
  crashedRun?: boolean
  /**
   * 最近一次恢复判定的白盒快照（v0.9.1）：status 工具与面板据此显示
   * 「观察中 N/M 轮」或「为什么关了它」。undefined = 本分区还没有
   * 崩溃决策发生过（诚实缺省，不造一份假判定）。
   */
  lastRecoveryVerdict?: {
    at: string
    crashSeq: number
    evidence: 'deterministic' | 'probabilistic'
    rounds: number
    required: number
    act: boolean
    label: string
    headSuspect: string | null
  }
  /**
   * 连续「异常终止但未留下哨兵」的轮数（v0.12.1）。
   *
   * ## 为什么需要这个计数（用户旅程实测出的 P0 缺口）
   *
   * 崩溃信号此前**只有**哨兵文件，而哨兵写在 `process.on('exit')` 里。
   * SIGKILL / OOM killer / 断电 / 原生段错误这些死法**根本不会运行 exit 处理器**
   * —— 实测：强杀沙箱后 `bootMarker` 残留（pid 39576）而 `crashSeq` 仍是 0，
   * 面板说「启动时未发现上次崩溃」。
   *
   * 危险的不是「少记一次」，而是**崩溃循环失去升级依据**：插件把宿主
   * 以原生方式撞死时，每一轮都只看得到残留的 bootMarker，每一轮都被当成
   * 「干净启动」把计数清零 ⇒ 永远停在「关 0 个」，正是本插件要防的那个场景。
   *
   * ## 为什么它是**概率性**证据而不是确定性证据
   *
   * 残留的 bootMarker 同样可由「用户主动杀进程 / 关机」产生（recovery-policy
   * 的 v0.9 分级早已把这两类归为偶发不确定证据）。所以它**不能**单独触发关闭，
   * 只能像多嫌疑场景那样累计到 `confirmRounds` 轮才动手 —— 沿用既有分级，
   * 不新造一套策略。
   */
  abnormalExitSeq?: number
}

export interface PrebootDecision {
  capturedAt: string
  /** Suspect bundles, newest change first（形状与 `decision.ts` 的 `Decision` 一致）。 */
  suspects: DecisionSuspect[]
  /** Bundle names to disable for this boot. Empty means "load everything". */
  disable: string[]
  reason: 'none' | 'crash-recovery'
  crashSeq?: number
  /**
   * 两阶段标记（v0.9.0）：prepared = 已记录待执行；quarantined = 已生效。
   * 守护行只认 disable 名单，phase 供 reconcile 与面板对账。
   */
  phase?: 'prepared' | 'quarantined' | 'reconciled'
}

export function emptyState(): GuardState {
  return { bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] }
}

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

export class Store {
  /** profile 根目录下的守护目录（分区索引与归档都在这里）。 */
  readonly rootDir: string
  /**
   * 本分区的目录 —— 所有状态、日志、决策、备份都在这里。
   *
   * **分区隔离的实现点**：不同项目（工作区）各有自己的分区目录，
   * 它们的 journal / state / decision / backups 完全独立。
   * 一个项目的崩溃不会让另一个项目进入恢复流程。
   */
  readonly dir: string
  private readonly journalPath: string
  private readonly snapshotPath: string
  private readonly statePath: string
  private readonly decisionPath: string
  private readonly backupsDir: string
  /** 备份根的绝对路径（面板「备份」卡片展示；v0.9.0 只读暴露）。 */
  get backupsRoot(): string {
    return this.backupsDir
  }

  /**
   * @param profileDir profile 目录
   * @param partitionKey 分区键；缺省时用 `default`（单项目 profile）。
   */
  constructor(profileDir: string, partitionKey = 'default', backupRootOverride?: string) {
    this.rootDir = join(profileDir, STATE_DIRNAME)
    this.dir = join(this.rootDir, 'projects', partitionKey)
    this.journalPath = join(this.dir, 'journal.jsonl')
    this.snapshotPath = join(this.dir, 'snapshot.json')
    this.statePath = join(this.dir, 'state.json')
    this.decisionPath = join(this.dir, 'decision.json')
    this.backupsDir = resolveBackupsDir(backupRootOverride, this.dir, partitionKey)
  }

  async init(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true })
    // v0.11.1 紧急修复：清掉上一个崩溃进程遗留的失效写锁。
    // 0 字节锁无法被 atomic-write 接管（它要求锁内有可读 PID），会让
    // 本次启动的 updateState 等满超时后抛错 —— 实测直接把宿主拖进
    // fatal load failure。清理失败不阻断 init（那只是少一道保险）。
    try {
      cleanStaleLocks(this.dir)
    } catch {
      /* best effort：init 的唯一硬要求是备份目录存在 */
    }
  }

  /** 本分区的绝对路径（供面板与日志引用）。 */
  get partitionPath(): string {
    return this.dir
  }

  // ---------- journal ----------

  /**
   * Append journal events asynchronously.
   *
   * 复杂度：O(n) 读 + O(n) 写（n = 既有行数 ≤ JOURNAL_MAX_LINES），
   * 不是真正的 O(1) 追加 —— 原子写要整文件替换，读改写无法避免。
   * 已知竞态：同一 profile 的两个进程同时 append 会有一条被覆盖。
   * 当前调用方全在启动/备份路径（单进程），因此未加文件锁；
   * 若将来在并发路径上追加，必须换成 `withFileLock` 或真 O(1) 追加（appendFile）。
   */
  async append(events: JournalEvent | JournalEvent[]): Promise<void> {
    const list = Array.isArray(events) ? events : [events]
    if (list.length === 0) return
    const stamped: JournalRecord[] = list.map((e) => ({ ...e, t: new Date().toISOString() }))
    const prev = existsSync(this.journalPath) ? await readFile(this.journalPath, 'utf8') : ''
    const lines = journalLines(prev)
    for (const e of stamped) lines.push(JSON.stringify(e))
    await writeFileAtomic(this.journalPath, serializeJournal(lines), { mode: 0o644 })
  }

  /**
   * Write a journal event synchronously.
   *
   * The plugin's own startup can be interrupted by the very crash it is meant
   * to guard against: a suspect plugin throws during the same boot, and the
   * process dies before any awaited write completes. The journal must therefore
   * be written synchronously, so the record of "what was installed and when"
   * survives the crash it documents.
   */
  appendSync(event: JournalEvent): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      const record: JournalRecord = { ...event, t: new Date().toISOString() }
      const prev = existsSync(this.journalPath) ? readFileSync(this.journalPath, 'utf8') : ''
      const lines = journalLines(prev)
      lines.push(JSON.stringify(record))
      writeFileSync(this.journalPath, serializeJournal(lines), 'utf8')
    } catch {
      /* best effort: the journal must never break the host's startup */
    }
  }

  async readJournal(limit = 100): Promise<JournalRecord[]> {
    if (!existsSync(this.journalPath)) return []
    return parseJournalLines(await readFile(this.journalPath, 'utf8'), limit)
  }

  // ---------- snapshot (version tracking) ----------

  async readSnapshot(): Promise<Record<string, string>> {
    if (!existsSync(this.snapshotPath)) return {}
    try {
      return JSON.parse(await readFile(this.snapshotPath, 'utf8'))
    } catch {
      return {}
    }
  }

  /**
   * 观测快照（v0.8.1）—— 独立于主版本快照的「上次观测态」存取。
   *
   * 为什么不复用 readSnapshot/writeSnapshot：主快照是 `Record<string, string>`
   * （bundle → version），观测态的值是对象（version + enabled），类型形状
   * 不同；混写会让 install/update 的 diff 读到脏键。独立文件 `observations.json`
   * —— 两个真相源物理隔离，比键前缀约定更不可能互相污染。
   */
  async readObservationSnapshot(name: string): Promise<Map<string, { version?: string; enabled: boolean }>> {
    return readObservation(this.dir, name)
  }

  /** 同步读观测快照（v0.13）—— 崩溃路径不能 await，共现采集需要它。 */
  readObservationSnapshotSync(name: string): Map<string, { version?: string; enabled: boolean }> {
    return readObservationSync(this.dir, name)
  }

  async writeObservationSnapshot(name: string, state: Map<string, { version?: string; enabled: boolean }>): Promise<void> {
    await writeObservation(this.dir, name, state)
  }

  /**
   * 读共现样本（v0.13 方向④）。
   *
   * 实现委托给 `cooccurrence-store.ts`：store.ts 的复杂度已顶到预算上限
   * （123/100），共现是**旁路数据面**（只服务验证，与恢复主线无控制依赖），
   * 拆出去后主干的读者不必多背一层无关分支。
   */
  readCooccurrenceSync(): { schemaVersion: 1; samples: unknown[] } {
    return readCooccurrenceSync(this.dir) as { schemaVersion: 1; samples: unknown[] }
  }

  /** 写共现样本（同步：崩溃路径不能 await）。委托实现见 `cooccurrence-store.ts`。 */
  writeCooccurrenceSync(store: { schemaVersion: 1; samples: unknown[] }): void {
    writeCooccurrenceSync(this.dir, store as never)
  }

  async writeSnapshot(snap: Record<string, string>): Promise<void> {
    await writeFileAtomic(this.snapshotPath, JSON.stringify(snap, null, 2), { mode: 0o644 })
  }

  /** Read the version snapshot synchronously. */
  readSnapshotSync(): Record<string, string> {
    try {
      if (!existsSync(this.snapshotPath)) return {}
      return JSON.parse(readFileSync(this.snapshotPath, 'utf8'))
    } catch {
      return {}
    }
  }

  /** Read the journal synchronously. */
  readJournalSync(limit = 100): JournalRecord[] {
    try {
      if (!existsSync(this.journalPath)) return []
      return parseJournalLines(readFileSync(this.journalPath, 'utf8'), limit)
    } catch {
      return []
    }
  }

  /** Write the state file synchronously. */
  writeStateSync(state: GuardState): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch {
      /* best effort */
    }
  }

  /** Write the version snapshot synchronously. */
  writeSnapshotSync(snap: Record<string, string>): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.snapshotPath, JSON.stringify(snap, null, 2), 'utf8')
    } catch {
      /* best effort */
    }
  }

  // ---------- state ----------

  async readState(): Promise<GuardState> {
    if (!existsSync(this.statePath)) return emptyState()
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'))
      return { ...emptyState(), ...parsed }
    } catch {
      return emptyState()
    }
  }

  async writeState(state: GuardState): Promise<void> {
    await writeFileAtomic(this.statePath, JSON.stringify(state, null, 2), { mode: 0o644 })
  }

  /** Serialized read-modify-write across processes. */
  async updateState(mutate: (s: GuardState) => GuardState | Promise<GuardState>): Promise<GuardState> {
    const run = (): Promise<GuardState> =>
      withFileLock(
        this.statePath,
        async () => {
          const cur = await this.readState()
          const mutated = await mutate(cur)
          await this.writeState(mutated)
          return mutated
        },
        { waitMs: 3000 },
      )
    try {
      return await run()
    } catch (error) {
      // v0.11.1 紧急修复：锁超时先清理失效锁再重试一次。
      // 定向处理（只认锁超时）——写失败/权限错误不该被重试掩盖。
      if (!isLockTimeout(error)) throw error
      // 此刻多半是「锁被活进程持有」或「记录不完整」；清理只动
      // 失效记录（空/PID 已死/超过年龄阈值），活锁会被保留，重试仍超时
      // 则如实抛出（由调用方决定降级）。
      cleanStaleLocks(this.dir)
      return run()
    }
  }

  /**
   * Re-arm the crash marker synchronously.
   *
   * Called from the `process.on('exit')` handler, where only synchronous work
   * completes. A non-zero exit code means the process died badly, so the
   * marker must survive for the next boot to detect.
   */
  markCrashedSync(exitCode: number): void {
    try {
      const cur = this.readStateSync()
      const next: GuardState = {
        ...cur,
        bootMarker: { startedAt: new Date().toISOString(), pid: process.pid },
        lastExitCode: exitCode,
        // The previous run ended badly; the next boot reads this to decide how
        // many suspects to disable.
        crashedRun: true,
      }
      const tmp = `${this.statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      renameSync(tmp, this.statePath)
    } catch {
      /* best effort: without the marker the next boot simply starts fresh */
    }
  }

  /** Read the state file synchronously. */
  readStateSync(): GuardState {
    try {
      if (!existsSync(this.statePath)) return emptyState()
      return { ...emptyState(), ...JSON.parse(readFileSync(this.statePath, 'utf8')) }
    } catch {
      return emptyState()
    }
  }

  // ---------- pre-boot decision ----------

  /**
   * Publish the decision the guarded patch rows read BEFORE their modules load.
   *
   * The write is SYNCHRONOUS on purpose: the decision has to be on disk before
   * the next boot imports the suspect plugin, and the crash this plugin guards
   * against can kill the process at any moment.
   */
  writeDecisionSync(decision: PrebootDecision): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.decisionPath, JSON.stringify(decision, null, 2), 'utf8')
    } catch {
      /* best effort */
    }
  }

  /** Read the decision file synchronously. */
  readDecisionSync(): PrebootDecision | null {
    try {
      if (!existsSync(this.decisionPath)) return null
      return JSON.parse(readFileSync(this.decisionPath, 'utf8')) as PrebootDecision
    } catch {
      return null
    }
  }

  // ---------- config backups ----------

  async writeBackup(bundle: string, config: unknown): Promise<string> {
    const file = join(this.backupsDir, `${sanitize(bundle)}.json`)
    await writeFileAtomic(
      file,
      JSON.stringify({ bundle, savedAt: new Date().toISOString(), config }, null, 2),
      { mode: 0o644 },
    )
    await this.append({ kind: 'config-backup', bundle })
    return file
  }

  /**
   * 带版本的时间戳备份（v0.8.0 备份增强）。
   *
   * ## 与 writeBackup 的分工
   *
   * writeBackup 只留**最近一份**（文件名 = 插件名），服务「重新启用时恢复配置」；
   * 本方法留**时间线**（文件名 = 插件名 + 版本 + 时刻），服务「插件更新前后的
   * 状态对账」—— 用户原话是「记录插件更新的前后状态」。一个插件被连升三个
   * 版本时，writeBackup 只剩最后一版，而本方法三版都在，且能看出版本间的
   * 配置差异（用户升级后行为变了，先对比备份再排查，少走弯路）。
   *
   * ## 保留策略
   *
   * 每个插件最多留 `retain` 份（默认 5），超出时**删最旧**。为什么按插件
   * 计数而不是全目录计数：用户关心的是「单个插件能回溯多远」，全目录上限
   * 会让装了 30 个插件的 profile 把每个插件的备份挤到只剩 1 份。
   *
   * 失败绝不抛出：备份是 best-effort（与 writeBackup 同一纪律），
   * 更新检测的主流程不能因为备份写不进去而中断。
   */
  async writeVersionedBackup(
    bundle: string,
    version: string,
    config: unknown,
    options: { retain?: number } = {},
  ): Promise<string | null> {
    try {
      const dir = join(this.backupsDir, 'versions', sanitize(bundle))
      await mkdir(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = join(dir, `${sanitize(version) || 'unknown'}@${stamp}.json`)
      await writeFileAtomic(
        file,
        JSON.stringify({ bundle, version, savedAt: new Date().toISOString(), config }, null, 2),
        { mode: 0o644 },
      )
      await this.pruneVersionedBackups(bundle, options.retain ?? 5)
      return file
    } catch {
      return null
    }
  }

  /** 一个插件的时间线备份清单（旧 → 新），供工具与面板对账。 */
  async listVersionedBackups(bundle: string): Promise<Array<{ file: string; version: string; savedAt: string }>> {
    const dir = join(this.backupsDir, 'versions', sanitize(bundle))
    if (!existsSync(dir)) return []
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const rows: Array<{ file: string; version: string; savedAt: string }> = []
    for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
      try {
        const parsed = JSON.parse(await readFile(join(dir, f), 'utf8')) as { version?: string; savedAt?: string }
        rows.push({
          // 完整路径：调用方（prune、工具层）不再自己拼路径，避免两处路径规则漂移。
          file: join(dir, f),
          version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
          savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
        })
      } catch {
        /* 损坏行不计入清单，但不删 —— 用户可能要手工抢救 */
      }
    }
    return rows
  }

  /** 按插件清点全部时间线备份（工具 backups 用）。 */
  async listVersionedBackupBundles(): Promise<Array<{ bundle: string; count: number; latestVersion?: string; latestAt?: string }>> {
    const root = join(this.backupsDir, 'versions')
    if (!existsSync(root)) return []
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      return []
    }
    const out: Array<{ bundle: string; count: number; latestVersion?: string; latestAt?: string }> = []
    for (const name of names.sort()) {
      const rows = await this.listVersionedBackups(name)
      if (rows.length === 0) continue
      const latest = rows[rows.length - 1]
      out.push({ bundle: name, count: rows.length, latestVersion: latest?.version, latestAt: latest?.savedAt })
    }
    return out
  }

  /** 每插件保留最近 `retain` 份，删最旧。best-effort：删不掉就留着。 */
  private async pruneVersionedBackups(bundle: string, retain: number): Promise<void> {
    try {
      const rows = await this.listVersionedBackups(bundle)
      if (rows.length <= retain) return
      for (const row of rows.slice(0, rows.length - retain)) {
        try {
          await unlink(row.file)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  async readBackup(bundle: string): Promise<{ bundle: string; savedAt: string; config: unknown } | null> {
    const file = join(this.backupsDir, `${sanitize(bundle)}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return null
    }
  }

  async listBackups(): Promise<string[]> {
    if (!existsSync(this.backupsDir)) return []
    const files = await readdir(this.backupsDir)
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  }
}

/** 切分 journal 行（丢掉空行）。 */
function journalLines(raw: string): string[] {
  return raw ? raw.split('\n').filter(Boolean) : []
}

/** 序列化 journal：先封顶（保留最后 JOURNAL_MAX_LINES 行）再拼回。 */
function serializeJournal(lines: readonly string[]): string {
  return `${lines.slice(-JOURNAL_MAX_LINES).join('\n')}\n`
}

/**
 * 解析 journal 行，容忍崩溃时写坏的尾部半行。
 *
 * 为什么容忍而不是报错：崩溃路径上的写可能被进程死亡截断，让一行残缺的
 * JSON 使整份 journal 不可读，等于把守护者自己的证据链也弄丢了。
 * `limit <= 0` 返回空数组（「读 0 行」就是一行都不读；旧实现里
 * `slice(-0)` 会返回全部行，是个静默的语义反转）。
 */
function parseJournalLines(raw: string, limit: number): JournalRecord[] {
  const lines = journalLines(raw)
  const take = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), lines.length) : 0
  const out: JournalRecord[] = []
  for (const line of lines.slice(lines.length - take)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip a torn tail line from a crash mid-write */
    }
  }
  return out
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._@/-]/g, '_')
}

/**
 * 解析备份根目录。
 *
 * 优先级：显式 override（环境变量）> 面板配置 > profile 内默认。
 * 自定义目录下仍按 **分区键** 分层（`<root>/<partitionKey>`）：集中存放
 * 不能破坏分区隔离 —— 两个项目的备份混在一个目录里，回滚时拿错就是事故。
 * 非法值（空白字符串除外）静默回退到默认：备份位置错了不如用默认位置。
 */
function resolveBackupsDir(override: string | undefined, partitionDir: string, partitionKey: string): string {
  const custom = (override ?? '').trim()
  if (custom === '') return join(partitionDir, 'backups')
  try {
    const resolved = resolve(custom)
    if (!isAbsolute(custom)) return join(partitionDir, 'backups')
    void resolved
    return join(resolved, partitionKey)
  } catch {
    return join(partitionDir, 'backups')
  }
}

/**
 * The profile's own plugins and their resolved versions, read SYNCHRONOUSLY.
 *
 * The recency ranking needs this before the first await, because the crash
 * this plugin guards against can happen during the same boot. Only the
 * profile's DECLARED dependencies count: a plugin is what the user installed,
 * while a transitive dependency of that plugin is not a separate suspect.
 */
export function bundleVersionsSync(profileDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const declared = declaredDependenciesSync(profileDir)
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) return out
  for (const name of declared) {
    const version = readPackageVersion(join(nm, ...name.split('/')))
    if (version) out[name] = version
  }
  return out
}

/** The profile manifest's declared dependency names. */
export function declaredDependenciesSync(profileDir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const deps = manifest?.dependencies
    return deps && typeof deps === 'object' ? Object.keys(deps) : []
  } catch {
    return []
  }
}

function readPackageVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * mtimes of the profile's declared dependencies, read SYNCHRONOUSLY.
 * Seeds the ranking when the journal has no install event yet.
 */
export function bundleMtimesSync(profileDir: string): Record<string, number> {
  const out: Record<string, number> = {}
  const nm = join(profileDir, 'node_modules')
  for (const name of declaredDependenciesSync(profileDir)) {
    try {
      out[name] = statSync(join(nm, ...name.split('/'))).mtimeMs
    } catch {
      /* ignore */
    }
  }
  return out
}

/**
 * Recency bootstrap source: mtimes of the profile's node_modules entries.
 * Seeds the ranking on the first run, before the journal has install events.
 */
export async function bundleMtimes(profileDir: string): Promise<Record<string, number>> {
  const nm = join(profileDir, 'node_modules')
  const out: Record<string, number> = {}
  if (!existsSync(nm)) return out
  let scopes: string[]
  try {
    scopes = await readdir(nm)
  } catch {
    return out
  }
  for (const entry of scopes) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      const scopeDir = join(nm, entry)
      let children: string[] = []
      try {
        children = await readdir(scopeDir)
      } catch {
        continue
      }
      for (const child of children) {
        const pkgDir = join(scopeDir, child)
        try {
          const s = await stat(pkgDir)
          out[`${entry}/${child}`] = s.mtimeMs
        } catch {
          /* ignore */
        }
      }
    } else {
      const pkgDir = join(nm, entry)
      try {
        const s = await stat(pkgDir)
        out[entry] = s.mtimeMs
      } catch {
        /* ignore */
      }
    }
  }
  return out
}
