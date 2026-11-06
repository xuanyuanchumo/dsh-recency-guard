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
  /**
   * Where `lastChangeAt` came from.
   *
   * 白盒理由：journal 事件是**安装事实**，node_modules 的 mtime 只是
   * **引导值**（首次运行、journal 还没有记录时用它排序）。两者的证据强度
   * 完全不同，面板/工具不应该把它们显示成同一种「最近更新」。
   * 可选是为了不强迫既有调用点（`index.ts` 里用空串占位的合成条目）补齐。
   */
  source?: 'journal' | 'mtime'
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
 *
 * The guard itself is NEVER a suspect: disabling it would remove the very
 * mechanism that recovers the profile. The sync crash path filtered its own
 * package by name (index.ts rankedSuspectsSync), but this async path — used by
 * the manual `recover` action — did not: 0.5.0 sandbox实测，recover 把守护自己
 * 关掉了（它是 profile 里唯一的非官方插件）。这里在分类源头排除，两条路径
 * 共享同一不变式。
 */
const GUARD_PACKAGE = 'dsh-recency-guard'

export function isSuspectClass(b: BundleLike): boolean {
  if (!b.name) return false
  if (isOfficial(b.name)) return false
  if (b.name === GUARD_PACKAGE) return false
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
 *
 * 排序规则（确定性，可逐字节比对）：
 * 1. 时刻升序取反 ⇒ 最新在前；
 * 2. 时刻不可解析（空串/'x'）⇒ 视为最旧（**排最后**，不静默当 1970-01-01，
 *    也不让 `NaN` 进入比较器 —— `NaN` 参与比较是未定义行为，会让顺序随机）；
 * 3. 同刻按包名字典序 —— 真实 profile 里几十个插件常常同秒安装，
 *    没有这条兜底时排序结果取决于 `listBundles()` 的返回顺序。
 *
 * 复杂度 O(s log s)（s = 嫌疑插件数），对几十个量级可忽略。
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
      entries.push({ bundle: b.name, version: j.version ?? b.version, lastChangeAt: j.at, lastKind: j.kind, source: 'journal' })
      continue
    }
    const m = mtimes[b.name]
    if (m !== undefined) {
      entries.push({
        bundle: b.name,
        version: b.version,
        lastChangeAt: new Date(m).toISOString(),
        lastKind: 'install',
        source: 'mtime',
      })
    }
  }
  entries.sort((a, b) => {
    const ta = sortableTime(a.lastChangeAt)
    const tb = sortableTime(b.lastChangeAt)
    if (ta !== tb) return tb - ta
    return a.bundle.localeCompare(b.bundle)
  })
  return entries
}

/** 可比较的时刻：不可解析 ⇒ −∞（排最后）。两个 −∞ 由调用方走名字兜底，避免 NaN。 */
function sortableTime(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
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
