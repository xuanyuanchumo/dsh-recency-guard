import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

/**
 * Journal / state store for dsh-recency-guard.
 *
 * Everything lives under `<profile>/.recency-guard/`:
 *   journal.jsonl  – append-only event log (install / update / enable / disable / crash / recover)
 *   snapshot.json  – last observed { bundleName -> version } for update detection
 *   state.json     – crash-recovery state (crash counter, auto-disabled set, boot marker)
 *   decision.json  – the bundles the guarded patch rows must keep off for this boot
 *   backups/<bundle>.json – config snapshot taken before a disable
 */

export const STATE_DIRNAME = '.recency-guard'

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
  | 'note'

/** An event as written to the journal. `t` is stamped by the store. */
export interface JournalEvent {
  kind: JournalKind
  bundle?: string
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
}

export interface PrebootDecision {
  capturedAt: string
  /** Suspect bundles, newest change first. */
  suspects: Array<{ bundle: string; version?: string; lastChangeAt: string }>
  /** Bundle names to disable for this boot. Empty means "load everything". */
  disable: string[]
  reason: 'none' | 'crash-recovery'
  crashSeq?: number
}

export function emptyState(): GuardState {
  return { bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] }
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

  /**
   * @param profileDir profile 目录
   * @param partitionKey 分区键；缺省时用 `default`（单项目 profile）。
   */
  constructor(profileDir: string, partitionKey = 'default') {
    this.rootDir = join(profileDir, STATE_DIRNAME)
    this.dir = join(this.rootDir, 'projects', partitionKey)
    this.journalPath = join(this.dir, 'journal.jsonl')
    this.snapshotPath = join(this.dir, 'snapshot.json')
    this.statePath = join(this.dir, 'state.json')
    this.decisionPath = join(this.dir, 'decision.json')
    this.backupsDir = join(this.dir, 'backups')
  }

  async init(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true })
  }

  /** 本分区的绝对路径（供面板与日志引用）。 */
  get partitionPath(): string {
    return this.dir
  }

  // ---------- journal ----------

  async append(events: JournalEvent | JournalEvent[]): Promise<void> {
    const list = Array.isArray(events) ? events : [events]
    if (list.length === 0) return
    const stamped: JournalRecord[] = list.map((e) => ({ ...e, t: new Date().toISOString() }))
    const prev = existsSync(this.journalPath) ? await readFile(this.journalPath, 'utf8') : ''
    const lines = prev ? prev.split('\n').filter(Boolean) : []
    for (const e of stamped) lines.push(JSON.stringify(e))
    // Cap the journal so it never grows unbounded.
    const trimmed = lines.slice(-1000)
    await writeFileAtomic(this.journalPath, `${trimmed.join('\n')}\n`, { mode: 0o644 })
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
      const lines = prev ? prev.split('\n').filter(Boolean) : []
      lines.push(JSON.stringify(record))
      const trimmed = lines.slice(-1000)
      writeFileSync(this.journalPath, `${trimmed.join('\n')}\n`, 'utf8')
    } catch {
      /* best effort: the journal must never break the host's startup */
    }
  }

  async readJournal(limit = 100): Promise<JournalRecord[]> {
    if (!existsSync(this.journalPath)) return []
    const raw = await readFile(this.journalPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const out: JournalRecord[] = []
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line))
      } catch {
        /* skip a torn tail line from a crash mid-write */
      }
    }
    return out
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
      const lines = readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean)
      const out: JournalRecord[] = []
      for (const line of lines.slice(-limit)) {
        try {
          out.push(JSON.parse(line))
        } catch {
          /* skip a torn tail line */
        }
      }
      return out
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
    return withFileLock(this.statePath, async () => {
      const cur = await this.readState()
      const mutated = await mutate(cur)
      await this.writeState(mutated)
      return mutated
    }, { waitMs: 3000 })
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

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._@/-]/g, '_')
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
