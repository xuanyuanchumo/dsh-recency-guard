/**
 * Bundle classification + recency ranking for dsh-recency-guard.
 *
 * "Suspect" plugins are third-party or experimental bundles the user recently
 * installed or updated. Official first-party DSH bundles are never treated as
 * suspects: the user did not just add them, and the crash-recovery
 * auto-disable must never touch the harness core.
 */

/**
 * The subset of `ctx.pluginManager.listBundles()` this plugin relies on.
 * Verified against dsh-plugin-manager's `listBundles()` return shape.
 */
export interface BundleLike {
  name: string
  /** Declared in the profile's package.json dependencies. */
  installed?: boolean
  /** Selected into the composition (contributes its patch layer). */
  enabled?: boolean
  /** Project-maintained / official optional bundle. */
  official?: boolean
  /** Resolved package version, when the bundle resolves. */
  version?: string
  /** Resolution error, when the bundle failed to resolve. */
  error?: unknown
}

export interface RecencyEntry {
  bundle: string
  version?: string
  /** ISO time of the most recent install-or-update we recorded. */
  lastChangeAt: string
  lastKind: 'install' | 'update'
}

/** Official first-party scope; never a recovery suspect. */
const OFFICIAL_SCOPES = ['@deepseek-ai/']

/** Name fragments that mark a bundle as "experimental" even outside a namespace. */
const EXPERIMENTAL_HINTS = ['experimental', '-exp', 'beta', 'canary', 'nightly', '-rc', 'alpha']

export function isOfficial(name: string): boolean {
  return OFFICIAL_SCOPES.some((s) => name.startsWith(s))
}

export function isExperimentalName(name: string): boolean {
  const n = name.toLowerCase()
  return EXPERIMENTAL_HINTS.some((h) => n.includes(h))
}

/**
 * A bundle is a plausible recovery suspect when the user (not the harness)
 * controls it: it is installed, enabled, and not official. The definition stays
 * deliberately broad — the recency ranking decides who actually gets disabled.
 */
export function isSuspectClass(b: BundleLike): boolean {
  if (!b.name) return false
  if (isOfficial(b.name)) return false
  if (b.installed === false) return false
  if (b.enabled === false) return false
  return true
}

/** The suspect set: installed, enabled, non-official bundles. */
export function suspectBundles(bundles: BundleLike[]): BundleLike[] {
  return bundles.filter(isSuspectClass)
}

/**
 * Rank suspect bundles by how recently they changed, combining:
 *  1. journal events (install/update) — authoritative when present
 *  2. node_modules mtime                — bootstrap when the journal is empty
 * Newest first.
 */
export function rankByRecency(
  suspects: BundleLike[],
  journalChanges: Map<string, { at: string; kind: 'install' | 'update'; version?: string }>,
  mtimes: Record<string, number>,
): RecencyEntry[] {
  const entries: RecencyEntry[] = []
  for (const b of suspects) {
    const j = journalChanges.get(b.name)
    if (j) {
      entries.push({ bundle: b.name, version: j.version ?? b.version, lastChangeAt: j.at, lastKind: j.kind })
      continue
    }
    const m = mtimes[b.name]
    if (m !== undefined) {
      entries.push({
        bundle: b.name,
        version: b.version,
        lastChangeAt: new Date(m).toISOString(),
        lastKind: 'install',
      })
    }
  }
  entries.sort((a, b) => Date.parse(b.lastChangeAt) - Date.parse(a.lastChangeAt))
  return entries
}

/**
 * Pick the N most-recently-changed suspect bundles to disable after a crash.
 * `n` grows with consecutive crashes: 1 on the first, 2 on the next, etc.
 */
export function pickSuspects(ranked: RecencyEntry[], n: number): RecencyEntry[] {
  return ranked.slice(0, Math.max(0, n))
}

/**
 * Diff the current installed-bundle version map against the previous snapshot
 * to classify install / update / remove events for the journal.
 */
export function diffVersions(
  prev: Record<string, string>,
  current: Record<string, string>,
): {
  install: Array<{ name: string; version: string }>
  update: Array<{ name: string; from: string; to: string }>
} {
  const install: Array<{ name: string; version: string }> = []
  const update: Array<{ name: string; from: string; to: string }> = []
  for (const [name, ver] of Object.entries(current)) {
    const before = prev[name]
    if (before === undefined) install.push({ name, version: ver })
    else if (before !== ver) update.push({ name, from: before, to: ver })
  }
  return { install, update }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
