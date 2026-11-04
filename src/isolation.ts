import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 项目隔离 —— 让同一个守护插件在多个工作区并存时互不污染。
 *
 * 污染的三条真实路径
 * ----------------
 * 1. **状态路径**：所有数据若落在固定的 `<profile>/.recency-guard/`，
 *    工作区 A 的崩溃会让工作区 B 也进入恢复流程。
 * 2. **决策串扰**：`decision.json` 里的 `disable` 列表是全局的，
 *    A 项目的嫌疑插件会挡住 B 项目的插件。
 * 3. **展示串扰**：面板把多个工作区的事件混在一个时间线上，
 *    用户看到的事实无法归因到具体项目。
 *
 * 隔离设计
 * --------
 * - **分区存储**：每个工作区一个独立的分区目录
 *   `<profile>/.recency-guard/projects/<projectKey>/`，journal / state /
 *   backups / decision 全部落在分区里。根目录只保留一个**分区索引**。
 * - **稳定键**：项目键由工作区**规范化绝对路径**的 SHA-256 前 16 位派生，
 *   路径大小写与分隔符归一化，避免同一工作区因写法不同产生两个分区。
 * - **决策按项目**：决策文件带分区键，恢复时只读取本项目的决策。
 * - **归因**：每条事件都带 `projectKey`，面板按项目分组展示。
 *
 * 为什么用 SHA-256 而不是路径编码：路径可能含中文、盘符、`..`，
 * 编码后不可读且可能超长；哈希定长、无字符集问题、不泄露路径。
 * 可读性由「分区索引」里的 `label` 字段补回。
 */

/** 一个项目的分区键与展示信息。 */
export interface ProjectPartition {
  /** 稳定键（路径哈希派生）。 */
  key: string
  /** 工作区规范化绝对路径。 */
  workspace: string
  /** 展示名（默认取路径最后一段）。 */
  label: string
  /** 首次见到该项目的时间。 */
  firstSeenAt: string
  /** 最近一次见到该项目的时间。 */
  lastSeenAt: string
}

/** 分区索引（写在 profile 根目录）。 */
export interface PartitionIndex {
  schemaVersion: 1
  partitions: ProjectPartition[]
}

/**
 * 规范化工作区路径。
 *
 * - 统一分隔符为 `/`
 * - Windows 盘符转小写（`C:` 与 `c:` 是同一目录）
 * - 去掉末尾分隔符（根目录除外）
 * - 解析 `.` / `..` 片段（`path.resolve` 的语义）
 */
export function normalizeWorkspace(workspace: string): string {
  let normalized = workspace.replace(/\\/g, '/')
  // Windows 路径**大小写不敏感**：`D:/Project/Alpha` 与 `d:/project/alpha`
  // 指向同一个目录。若不折叠大小写，同一工作区会因写法不同产生两个分区 ——
  // 那正是「同一项目被拆成两份记忆」这类污染的源头。
  const isWindowsDrive = /^[A-Za-z]:/.test(normalized)
  if (isWindowsDrive) {
    normalized = normalized.toLowerCase()
  }
  // 解析 . 与 ..，但不改变根目录。
  const isAbsolute = normalized.startsWith('/')
  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else if (!isAbsolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  if (isAbsolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

/**
 * 由规范化工作区派生稳定的项目键。
 *
 * SHA-256 前 16 个十六进制字符 = 64 位碰撞概率，对几十个项目绰绰有余，
 * 且长度固定、字符集受限、可安全做目录名。
 */
export function projectKey(workspace: string): string {
  return createHash('sha256').update(normalizeWorkspace(workspace)).digest('hex').slice(0, 16)
}

/** 由路径派生展示名。 */
export function projectLabel(workspace: string): string {
  // 展示名用**原始路径**的最后一段（保留用户写的大小写），
  // 而键用规范化路径（折叠大小写）—— 两者职责不同。
  const raw = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = raw.split('/').filter(Boolean)
  return segments.length === 0 ? raw : segments[segments.length - 1]
}

/** 分区目录的根。 */
export function partitionsRoot(profileDir: string): string {
  return join(profileDir, '.recency-guard', 'projects')
}

/** 某个项目的分区目录。 */
export function partitionDir(profileDir: string, key: string): string {
  return join(partitionsRoot(profileDir), key)
}

/** 构造一份新的分区索引。 */
export function emptyPartitionIndex(): PartitionIndex {
  return { schemaVersion: 1, partitions: [] }
}

/**
 * 登记（并更新）一个项目分区。
 *
 * 返回该项目的键与分区目录。已存在的分区只更新 `lastSeenAt` 与 `label`，
 * **不重置**任何状态 —— 这正是「同一项目跨会话延续记忆」的要求。
 */
export function registerPartition(
  index: PartitionIndex,
  workspace: string,
  now = new Date().toISOString(),
): { partition: ProjectPartition; index: PartitionIndex } {
  const key = projectKey(workspace)
  const label = projectLabel(workspace)
  const existing = index.partitions.find((p) => p.key === key)
  if (existing) {
    const updated: ProjectPartition = {
      ...existing,
      label,
      workspace: normalizeWorkspace(workspace),
      lastSeenAt: now,
    }
    return {
      partition: updated,
      index: {
        ...index,
        partitions: index.partitions.map((p) => (p.key === key ? updated : p)),
      },
    }
  }
  const partition: ProjectPartition = {
    key,
    label,
    workspace: normalizeWorkspace(workspace),
    firstSeenAt: now,
    lastSeenAt: now,
  }
  return {
    partition,
    index: { ...index, partitions: [...index.partitions, partition] },
  }
}

/** 按键取分区。 */
export function findPartition(index: PartitionIndex, key: string): ProjectPartition | undefined {
  return index.partitions.find((p) => p.key === key)
}

/** 分区索引的文件名（写在 profile 根目录，供全局索引使用）。 */
export const PARTITION_INDEX_FILENAME = 'partitions.json'

/** 读分区索引；文件不存在或损坏时返回空索引（不抛）。 */
export function readPartitionIndex(profileDir: string): PartitionIndex {
  try {
    const raw = readFileSync(join(profileDir, '.recency-guard', PARTITION_INDEX_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as PartitionIndex
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.partitions)) return emptyPartitionIndex()
    return parsed
  } catch {
    return emptyPartitionIndex()
  }
}

/** 写分区索引。 */
export function writePartitionIndex(profileDir: string, index: PartitionIndex): void {
  try {
    const dir = join(profileDir, '.recency-guard')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, PARTITION_INDEX_FILENAME), JSON.stringify(index, null, 2), 'utf8')
  } catch {
    /* best effort: 索引丢失只是失去分区可��性，不影响守护本身 */
  }
}
