import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 归档重置 —— 「产物归档后重新开始执行，并能以最新的项目事实重跑自举」。
 *
 * 为什么需要归档而不是直接删除
 * --------------------------
 * 守护的产物（journal / state / decision / backups）是**事故证据链**：
 * 用户问「上周那次崩溃到底关了什么插件」，答案在这些文件里。直接删除
 * 会毁掉唯一的追溯依据，也会让「按最新事实重跑」失去对比基线。
 *
 * 因此归档的语义是**搬走 + 留档**：
 * 1. 把当前产物整体移到 `archive/<时间戳>/`；
 * 2. 写一份 `manifest.json` 记录归档了什么、何时、为什么；
 * 3. 生成一份**新的空状态**，让下一次启动以「最新事实」从头开始。
 *
 * 「最新项目事实」的含义
 * --------------------
 * 重置后，守护**不继承**旧结论：崩溃计数归零、嫌疑排名改由当前
 * `node_modules` 与 profile 清单重新推导。被归档的旧决策**不再生效** ——
 * 否则「重置」只是换个地方继续用过期结论。
 *
 * 归档与「举他」的关系
 * --------------------
 * 归档是**当前工作区**的动作；「举他」是在**另一个工作区**上重跑同一套
 * 自举流程。两者共用本模块的产物清单格式，因此被归档的产物可以被
 * 另一个工作区读取作为对照基线 —— 但**不共享状态**（隔离纪律）。
 */

/** 归档清单。 */
export interface ArchiveManifest {
  schemaVersion: 1
  /** 归档时刻。 */
  archivedAt: string
  /** 归档原因。 */
  reason: string
  /** 触发归档的工作区（规范化路径）。 */
  workspace: string
  /** 被归档的条目（相对 profile 目录的路径 + 字节数）。 */
  entries: Array<{ path: string; bytes: number; kind: 'journal' | 'state' | 'decision' | 'backup' | 'other' }>
  /**
   * 搬不动的条目（诚实记录）。
   *
   * 旧实现把搬失败静默吞掉：清单看起来「归档了 N 项」，实际有残留还在原地，
   * 而残留物会继续参与下一轮判断 —— 这正是「历史产物污染判断」的入口。
   */
  skipped?: string[]
  /** 归档时的关键事实摘要（供对照）。 */
  summary: {
    crashSeq: number
    autoDisabled: string[]
    journalEvents: number
  }
}

/** 归档结果。 */
export interface ArchiveResult {
  /** 归档目录的绝对路径。 */
  archiveDir: string
  /** 清单。 */
  manifest: ArchiveManifest
  /** 被归档的条目数。 */
  count: number
  /** 搬不动的条目名（空数组表示干净归档）。 */
  skipped: string[]
}

/** 产物的分类（决定清单里的 kind 字段）。 */
function classify(name: string): ArchiveManifest['entries'][number]['kind'] {
  if (name === 'journal.jsonl') return 'journal'
  if (name === 'state.json') return 'state'
  if (name === 'decision.json') return 'decision'
  if (name === 'backups') return 'backup'
  return 'other'
}

/**
 * 归档当前工作区的产物并重置。
 *
 * @param partitionDir profile 目录
 * @param workspace 当前工作区（写入清单，用于跨工作区对照）
 * @param reason 归档原因（写入清单）
 * @param now 归档时刻（注入以便测试确定性）
 */
export function archiveAndReset(
  partitionDir: string,
  workspace: string,
  reason: string,
  now = new Date(),
): ArchiveResult {
  const stateDir = partitionDir
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const archiveRoot = join(stateDir, 'archive', stamp)
  const archiveDir = join(archiveRoot, 'artifacts')

  const entries: ArchiveManifest['entries'] = []
  const skipped: string[] = []

  // 读取被归档的状态与日志 —— 必须在**搬走之前**读。
  // （先搬后读是真实缺陷：清单里的 crashSeq 永远是 0，摘要静默失真。）
  let crashSeq = 0
  let autoDisabled: string[] = []
  let journalEvents = 0
  try {
    const raw = readFileSync(join(stateDir, 'state.json'), 'utf8')
    const state = JSON.parse(raw) as { crashSeq?: number; autoDisabled?: Array<{ name: string }> }
    crashSeq = state.crashSeq ?? 0
    autoDisabled = (state.autoDisabled ?? []).map((d) => d.name)
  } catch {
    /* 状态不存在 ⇒ 归档的是一个空守护 */
  }
  try {
    const raw = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')
    journalEvents = raw.split('\n').filter(Boolean).length
  } catch {
    /* 无日志 */
  }

  if (existsSync(stateDir)) {
    mkdirSync(archiveDir, { recursive: true })
    for (const name of readdirSync(stateDir)) {
      // archive 目录本身不搬（否则递归）。
      if (name === 'archive') continue
      const source = join(stateDir, name)
      const target = join(archiveDir, name)
      try {
        const bytes = statSync(source).isDirectory() ? directoryBytes(source) : statSync(source).size
        renameSync(source, target)
        entries.push({ path: name, bytes, kind: classify(name) })
      } catch {
        // 搬不动的条目留在原地（不阻断重置），但必须**记名** ——
        // 静默跳过等于让残留物继续污染下一轮判断。
        skipped.push(name)
        continue
      }
    }
  }

  const manifest: ArchiveManifest = {
    schemaVersion: 1,
    archivedAt: now.toISOString(),
    reason,
    workspace,
    entries,
    ...(skipped.length === 0 ? {} : { skipped }),
    summary: { crashSeq, autoDisabled, journalEvents },
  }
  mkdirSync(archiveRoot, { recursive: true })
  writeFileSync(join(archiveRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  // 生成新的空状态：崩溃计数归零，决策清空（不继承旧结论）。
  resetArtifacts(stateDir, now)

  return { archiveDir, manifest, count: entries.length, skipped }
}

/**
 * 生成一份**全新的空产物**（归档后重置的落盘动作）。
 *
 * 单独抽出来是因为它不只被归档调用：任何「以最新事实重新开始」的入口
 * （归档重置、自举重跑）都必须走同一条落盘路径 —— 复制一份「空状态」的
 * 写法早晚会漂移，而漂移的空状态意味着旧结论从缝隙里漏回来。
 */
export function resetArtifacts(stateDir: string, now = new Date()): void {
  mkdirSync(join(stateDir, 'backups'), { recursive: true })
  writeFileSync(
    join(stateDir, 'decision.json'),
    JSON.stringify({ capturedAt: now.toISOString(), suspects: [], disable: [], reason: 'none' }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(stateDir, 'state.json'),
    JSON.stringify({ bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] }, null, 2),
    'utf8',
  )
}

/** 目录的字节数（递归）。 */
function directoryBytes(dir: string): number {
  let total = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const info = statSync(path)
      total += info.isDirectory() ? directoryBytes(path) : info.size
    } catch {
      continue
    }
  }
  return total
}

/**
 * 列出归档（按时间倒序）。
 *
 * 排序依据：目录名里的时间戳（ISO 变体，字典序即时间序）——
 * 不解析文件内容，快且无歧义。
 */
export function listArchives(partitionDir: string): Array<{ dir: string; archivedAt: string; reason: string; count: number }> {
  const archiveRoot = join(partitionDir, 'archive')
  if (!existsSync(archiveRoot)) return []
  const out: Array<{ dir: string; archivedAt: string; reason: string; count: number }> = []
  for (const name of readdirSync(archiveRoot)) {
    const dir = join(archiveRoot, name)
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ArchiveManifest
      out.push({
        dir,
        archivedAt: manifest.archivedAt,
        reason: manifest.reason,
        count: manifest.entries.length,
      })
    } catch {
      // 没有清单的目录不是一次合法归档，跳过（不猜）。
      continue
    }
  }
  out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
  return out
}

/**
 * 读取一份归档的清单 —— 「举他」时用它作对照基线。
 *
 * 注意：读取**不导入**任何状态 —— 另一个工作区只把这份清单当**只读参考**，
 * 不继承被归档工作区的崩溃计数或决策（隔离纪律）。
 */
export function readArchiveManifest(archiveDir: string): ArchiveManifest | null {
  try {
    return JSON.parse(readFileSync(join(archiveDir, 'manifest.json'), 'utf8')) as ArchiveManifest
  } catch {
    return null
  }
}
