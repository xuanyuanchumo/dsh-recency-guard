import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Process-level crash sentinel.
 *
 * WHY A SENTINEL FILE
 * -------------------
 * The harness disposes its plugin fibers on BOTH a clean exit and a crash, so
 * a plugin disposer cannot tell the two apart. The exit code can: a clean
 * shutdown ends with code 0, a crash with code 1.
 *
 * But a `process.on('exit')` listener registered by a plugin is removed when
 * that plugin's fiber is disposed — and disposers run in reverse order, so the
 * listener is gone before the process actually exits. The signal must therefore
 * live at the PROCESS level, not at the fiber level.
 *
 * The sentinel is a separate file from `state.json` on purpose: it is written
 * synchronously at exit time, with no chance to interleave with the async
 * state writes the plugin performs during a normal shutdown.
 */

/** Name of the sentinel file inside the guard's state directory. */
export const SENTINEL_NAME = 'crashed'

export interface CrashSentinel {
  /** Exit code of the crashed run. */
  exitCode: number
  /** ISO time the crash was observed. */
  at: string
  /** PID of the crashed run. */
  pid: number
}

/** The sentinel path inside a profile directory. */
/** 哨兵文件的绝对路径（参数是**分区目录**）。 */
export function sentinelPath(partitionDir: string): string {
  return join(partitionDir, SENTINEL_NAME)
}

/** Read the sentinel, or null when the previous run ended cleanly. */
export function readSentinel(partitionDir: string): CrashSentinel | null {
  try {
    const path = sentinelPath(partitionDir)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as CrashSentinel
  } catch {
    return null
  }
}

/** Remove the sentinel after it has been consumed. */
export function clearSentinel(partitionDir: string): void {
  try {
    const path = sentinelPath(partitionDir)
    if (existsSync(path)) renameSync(path, `${path}.consumed`)
  } catch {
    /* best effort */
  }
}

/**
 * Write the sentinel synchronously. Called from the `process.on('exit')`
 * handler, where only synchronous work completes.
 */
export function writeSentinel(partitionDir: string, exitCode: number): void {
  try {
    const dir = partitionDir
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SENTINEL_NAME), JSON.stringify({ exitCode, at: new Date().toISOString(), pid: process.pid }), 'utf8')
  } catch {
    /* best effort: without the sentinel the next boot simply starts fresh */
  }
}

const installed = new Map<string, { handler: (code: number) => void; onCrash?: (exitCode: number) => void }>()

/**
 * Install the process-level exit listener for one profile.
 *
 * The listener stays installed for the lifetime of the process: it is NOT
 * removed when the plugin's fiber is disposed, because the signal it carries
 * must survive that disposal.
 *
 * `onCrash` runs synchronously inside the exit handler, so it may only use
 * synchronous APIs. It is where the recovery decision is published — the
 * decision must be on disk before the NEXT boot imports the suspect module.
 *
 * Calling this twice for one profile replaces the crash callback rather than
 * installing a second listener, so the newest callback always wins.
 */
export function installExitSentinel(partitionDir: string, onCrash?: (exitCode: number) => void): void {
  const existing = installed.get(partitionDir)
  if (existing) {
    existing.onCrash = onCrash
    return
  }
  const entry: { handler: (code: number) => void; onCrash?: (exitCode: number) => void } = {
    handler: () => {},
    onCrash,
  }
  entry.handler = (code: number) => {
    if (code === 0) return
    writeSentinel(partitionDir, code)
    try {
      entry.onCrash?.(code)
    } catch (error) {
      // The sentinel is already written, so the crash is recorded even if the
      // decision could not be published. Report the failure so it is visible
      // in the crash log next to the original error.
      try {
        process.stderr.write(`dsh-recency-guard: publishing the recovery decision failed: ${String(error)}\n`)
      } catch {
        /* stderr is gone; nothing more to do */
      }
    }
  }
  installed.set(partitionDir, entry)
  process.on('exit', entry.handler)
}

/** Remove the process-level listener (tests only). */
export function uninstallExitSentinel(partitionDir: string): void {
  const entry = installed.get(partitionDir)
  if (!entry) return
  process.off('exit', entry.handler)
  installed.delete(partitionDir)
}
