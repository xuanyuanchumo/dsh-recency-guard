import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-sync.ts'

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

/**
 * 写分区索引。
 *
 * ## 为什么不能只「序列化后 writeFileSync」（v0.15 修复）
 *
 * isolation-dev 的跨进程实测：4 个子进程并发
 * `readPartitionIndex → registerPartition → writePartitionIndex`（每条 boot 都这么做），
 * 最终索引条目数实测出现过 **4/4、3/4、2/4** —— 丢了工作区引用。
 * 根因是两件事叠加：
 * 1. `writeFileSync` 先截断再写（并发读者会看到 0 字节，索引整体读不出）；
 * 2. 无锁的 read-modify-write（后写者用自己读到的旧快照覆盖前者新增的条目）。
 *
 * ## 修法分两层（各自解决一个根因）
 *
 * 1. **原子提交**：改用 `writeFileAtomicSync`（临时文件 + rename）⇒ 读者
 *    永远看到完整的旧索引或完整的新索引，不会看到 0 字节。
 * 2. **写入前重新合并**：把调用方传入的索引与**落盘的最新索引**按 key 求并集，
 *    再提交。这把「丢失窗口」从「整个 read-modify-write 周期」压缩到
 *    「最后一次读取到 rename 之间」的极短区间。
 *
 * ## 残留缺陷（诚实登记，不假装已解决）
 *
 * 第 2 层只是**缩小**窗口，不是消除竞态：两个进程若在「读最新 → rename」之间
 * 同时进入，仍可能丢一个条目。真正根治需要跨进程文件锁（`withFileLock` 是
 * async，而本条调用链在同步的 `apply()` 里，改异步会波及启动路径的同步纪律）。
 * 已登记为 TD-4：把分区索引改成「每分区一个引用文件 + 读取时合成」的
 * 无共享结构，从结构上消灭 read-modify-write。
 */
export function writePartitionIndex(profileDir: string, index: PartitionIndex): void {
  try {
    const dir = join(profileDir, '.recency-guard')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, PARTITION_INDEX_FILENAME)

    // 第 2 层：与落盘的最新索引求并集（以落盘为准的 key 集合 + 本索引的更新）。
    // 为什么以「落盘最新」为基：本进程的 index 可能是几百毫秒前读的旧快照，
    // 它缺的条目应由落盘版本补回；而本进程对已有 key 的更新（lastSeenAt/label）
    // 应当覆盖落盘版本。两者按 key 合并，语义上等价于「乐观合并」。
    const merged = mergePartitionIndexes(readPartitionIndex(profileDir), index)

    // 第 1 层：原子提交。写失败只降级（索引丢失只损失分区可读性，不影响守护）。
    writeFileAtomicSync(path, JSON.stringify(merged, null, 2))
  } catch {
    /* best effort: 索引丢失只是失去分区可读性，不影响守护本身 */
  }
}

/**
 * 按 key 合并两份索引：`base` 提供键集，`incoming` 覆盖同名键。
 *
 * 顺序保持 base 在前、incoming 的新键追加在后 —— 索引是给人看的列表，
 * 顺序稳定比「按时间重排」更重要（面板不应因为一次并发写而跳动）。
 */
function mergePartitionIndexes(base: PartitionIndex, incoming: PartitionIndex): PartitionIndex {
  const byKey = new Map<string, ProjectPartition>()
  for (const entry of base.partitions) byKey.set(entry.key, entry)
  for (const entry of incoming.partitions) byKey.set(entry.key, entry)
  const ordered: ProjectPartition[] = []
  const seen = new Set<string>()
  for (const entry of [...base.partitions, ...incoming.partitions]) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    const merged = byKey.get(entry.key)
    if (merged !== undefined) ordered.push(merged)
  }
  return { schemaVersion: 1, partitions: ordered }
}

/**
 * 隔离视图 —— 「不同工作区互不污染」的可判定形态。
 *
 * 判据只有一条：**一个规范化工作区必须恰好映射到一个分区键**。
 * 一个工作区对应两个键 ⇒ 它有两份记忆（同一项目自我分裂）；
 * 两个工作区共用一个键 ⇒ 它们互相污染。两者都会让 `isolated` 为 false，
 * 因此这条视图不是展示用的装饰，而是可以直接断言的判据。
 */
export interface IsolationView {
  /** 当前工作区的分区（未登记时为 null —— 不猜）。 */
  current: ProjectPartition | null
  /** 本 profile 下的全部分区（其它工作区只出现为引用，不含它们的状态）。 */
  partitions: ProjectPartition[]
  /** 除当前工作区外的分区 —— 「互不可见」的对照面。 */
  others: ProjectPartition[]
  /** 当前工作区是唯一分区（单项目 profile 的常见形态）。 */
  exclusive: boolean
  /** 一个工作区一个键（隔离成立）。 */
  isolated: boolean
}

/** 构造隔离视图（只读：不登记、不写索引）。 */
export function isolationView(profileDir: string, workspace: string): IsolationView {
  const index = readPartitionIndex(profileDir)
  const normalized = normalizeWorkspace(workspace)
  const current = index.partitions.find((p) => p.workspace === normalized) ?? null
  const others = index.partitions.filter((p) => p.workspace !== normalized)

  // 键与工作区必须是双射：一个工作区一个键（右侧），一个键一个工作区（左侧）。
  const keysByWorkspace = new Map<string, Set<string>>()
  const workspacesByKey = new Map<string, Set<string>>()
  for (const partition of index.partitions) {
    const keys = keysByWorkspace.get(partition.workspace) ?? new Set<string>()
    keys.add(partition.key)
    keysByWorkspace.set(partition.workspace, keys)
    const workspaces = workspacesByKey.get(partition.key) ?? new Set<string>()
    workspaces.add(partition.workspace)
    workspacesByKey.set(partition.key, workspaces)
  }
  const isolated =
    current !== null &&
    [...keysByWorkspace.values()].every((keys) => keys.size === 1) &&
    [...workspacesByKey.values()].every((workspaces) => workspaces.size === 1)

  return {
    current,
    partitions: index.partitions.map((p) => ({ ...p })),
    others: others.map((p) => ({ ...p })),
    exclusive: index.partitions.length <= 1,
    isolated,
  }
}

/**
 * 面板用的隔离视图（v0.12.1 从 index.ts 的 Guard 方法抽出）。
 *
 * 为什么抽出来：它是**纯投影**（读分区索引 + 拼路径），却因为写在
 * `Guard` 类里而被计入 index.ts 的复杂度热点（实测 14 个分支）。
 * 复杂度按**文件**计分，把方法从一个类移到另一个类没有意义 ——
 * 必须把代码移出该文件。抽到这里之后，这段只要给定 profileDir/workspace
 * 就能被单测直接驱动，不必构造整个 Guard。
 *
 * `others` 只给出键/标签/工作区路径：面板据此回答「还有谁在用这个 profile」，
 * 但绝不把对方的状态读进来 —— 隔离在数据结构上就成立，不靠调用方自觉。
 * 同时给出对方分区的产物路径清单，作为「互不可见」可断言的对照面。
 */
export interface GuardIsolationView {
  profile: string
  workspace: string
  projectKey: string
  current: ProjectPartition | null
  others: Array<{ key: string; label: string; workspace: string; lastSeenAt: string }>
  isolated: boolean
  exclusive: boolean
  artifacts: string[]
  foreignArtifacts: Array<{ key: string; label: string; paths: string[] }>
}

export function buildGuardIsolationView(input: {
  profileDir: string
  profileName: string
  workspace: string
  projectKey: string
}): GuardIsolationView {
  const view = isolationView(input.profileDir, input.workspace)
  return {
    profile: input.profileName,
    workspace: input.workspace,
    projectKey: input.projectKey,
    current: view.current,
    others: view.others.map((p) => ({
      key: p.key,
      label: p.label,
      workspace: p.workspace,
      lastSeenAt: p.lastSeenAt,
    })),
    isolated: view.isolated,
    exclusive: view.exclusive,
    artifacts: partitionArtifacts(input.profileDir, input.projectKey),
    foreignArtifacts: view.others.map((p) => ({
      key: p.key,
      label: p.label,
      paths: partitionArtifacts(input.profileDir, p.key),
    })),
  }
}

/**
 * 一个分区产物的绝对路径集合 —— 隔离的**否定性证据**。
 *
 * 「互不可见」很难直接证明，但它的反面很容易：列出对方分区的全部产物路径，
 * 再断言本分区读到的每个事实都**不在**其中。测试用它对两个工作区做交叉验证。
 */
export function partitionArtifacts(profileDir: string, key: string): string[] {
  const dir = partitionDir(profileDir, key)
  return ['journal.jsonl', 'snapshot.json', 'state.json', 'decision.json', 'backups'].map((name) =>
    join(dir, name),
  )
}
