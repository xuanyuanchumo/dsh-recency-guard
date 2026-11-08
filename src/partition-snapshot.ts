import { readPartitionIndex } from './isolation.js'
import { Store } from './store.js'
import { readHostVersion } from './self-describe.js'

/**
 * 跨分区只读快照 —— 数据面 `?partition=` 查询的宿主侧实现（v0.11）。
 *
 * 为什么是「磁盘投影」而不是切 Store 实例复用运行时视图：跨分区查看是
 * **观察**动作，绝不能影响本分区的运行时事实（状态机、内存观测、注册面）。
 * 因此这里只用另一个 Store 实例**读盘**，把能从磁盘还原的字段投影出来；
 * 运行时独有的字段（阶段 = 内存状态机、耗时 = 进程内计时）如实降级
 * （stage 恒 idle + 说明标签、metrics/markov 为 null），绝不拿当前分区的
 * 事实冒充对方 —— 那是本插件最忌讳的假绿。
 *
 * 隔离边界：读的是**对方分区目录**（isolation.ts 的 partitionDir 语义），
 * 不经对方工作区的任何进程通道 —— 与「分区互不可见」的否定性证据
 * （partitionArtifacts）同一条边界。独立成模块的副因：index.ts 复杂度
 * 预算 100，内联投影让 hotspot 到 103（band-detector 实测）。
 */

/** 跨分区快照需要的宿主侧事实（由 Guard 提供自身分区的元数据）。 */
export interface PartitionSnapshotInput {
  profileDir: string
  profileName: string
  /** 当前分区的配置投影（备份策略随分区目录走，但开关本身是全局配置）。 */
  config: {
    versionedBackups: boolean
    backupRetain: number
    configEditorAvailable: boolean
  }
  selfPackage: {
    version: string | null
    repositoryUrl: string | null
    issuesUrl: string | null
  }
}

/** 跨分区只读快照（形状与 PanelSnapshot 同名子集 + readonly 标记）。 */
export async function buildPartitionSnapshot(
  input: PartitionSnapshotInput,
  key: string,
): Promise<Record<string, unknown>> {
  // 未知分区 → 404 语义（available:false + reason），不返回空快照假绿。
  const index = readPartitionIndex(input.profileDir)
  const target = index.partitions.find((p) => p.key === key)
  if (!target) {
    return {
      available: false,
      reason: `未知分区 ${key}（本 profile 只有 ${index.partitions.length} 个分区）`,
    }
  }
  const viewer = new Store(input.profileDir, key)
  const [state, journal] = await Promise.all([viewer.readState(), viewer.readJournal(40)])
  const events = journal
    .slice(-40)
    .map((e) => ({ t: e.t, kind: e.kind, bundle: e.bundle, detail: e.detail }))
  return {
    at: new Date().toISOString(),
    profile: input.profileName,
    projectKey: key,
    // 运行时字段如实归属：阶段与评分是**当前进程**的状态机事实，
    // 别的分区没有自己的守护进程在跑，这里不能替它编一个阶段。
    stage: 'idle',
    stageLabel: '跨分区只读视图（阶段为当前分区语义，非对方实时状态）',
    transitions: [],
    stabilityScore: null,
    metrics: null,
    risks: [],
    capability: null,
    graphConnectivity: null,
    restored: state.restored,
    autoDisabled: state.autoDisabled.map((d) => ({
      name: d.name,
      reason: d.reason,
      crashSeq: d.crashSeq,
      disabledAt: d.disabledAt,
    })),
    lastRecoveryVerdict: state.lastRecoveryVerdict ?? null,
    partitions: index.partitions.map((p) => ({ ...p })),
    /**
     * 跨分区视图**不提供**乐观并发凭证（v0.12，恒 null）。
     *
     * 为什么是 null 而不是照算一枚对方的 revision：凭证的用途是「我按这份
     * 事实发起动作，宿主核对事实有没有变」。但这个视图是只读的，动作路由
     * 只作用于**当前**分区 —— 把对方的凭证发给宿主核对，结果必然 409，
     * 而那次冲突是假的（当前分区什么都没变）。null 让调用方走「不带凭证」
     * 分支，语义诚实；配合 readonly:true，面板据此禁用动作按钮。
     *
     * 用 null 而不是省略字段：省略会让「这个版本没有凭证」与「跨分区没有
     * 凭证」两种事实共用同一个 undefined，前端无法区分（本插件纪律：
     * 缺席要可归因）。
     */
    revision: null,
    eventFlow: [],
    recentEvents: events,
    markov: null,
    backupPolicy: {
      versionedBackups: input.config.versionedBackups,
      retain: input.config.backupRetain,
      customRoot: false,
      root: viewer.backupsRoot,
      configEditorAvailable: input.config.configEditorAvailable,
    },
    diagnostics: {
      pluginVersion: input.selfPackage.version,
      hostVersion: readHostVersion(),
      platform: process.platform,
      nodeVersion: process.version,
      dataPlane: true,
      snapshotMs: null,
      repositoryUrl: input.selfPackage.repositoryUrl,
      issuesUrl: input.selfPackage.issuesUrl,
    },
    readonly: true,
    workspace: target.workspace,
  }
}
