import type { CapabilityGraph } from './capability.js'
import { buildCapabilityGraph, capabilitiesByStage, verifyCapabilityContract } from './capability-specs.js'
import type { GuardStage, StageTransition } from './lifecycle.js'
import { ALL_STAGES } from './lifecycle.js'
import { computeMetrics, rankHazards, type MetricsSnapshot, type Observation, type RankedRisk } from './observability.js'
import { deriveEventFlow, type FlowEvent } from './observations.js'
import { computeRevision, type RevisionFacts } from './change-guard.js'
import { markovAnalysis, type MarkovAnalysis } from './markov.js'
import { STAGE_LABELS, buildGraphData, connectedComponents, type GraphData, type GraphNode } from './graph-data.js'
import { readPartitionIndex, type PartitionIndex } from './isolation.js'

/**
 * 事件流快照的条数上限。
 *
 * 为什么是 64：面板的「流动」视图是**最近发生了什么**，不是全历史；
 * limit 同时也是环形缓冲的容量（额外内存 O(limit)），防止 journal 尾部
 * 的 1000 行原样进入快照契约。
 */
export const EVENT_FLOW_LIMIT = 64

/**
 * 观测面 —— 把分散的事实汇成一份**面板与图谱共用的快照**。
 *
 * 为什么是一个快照而不是多个接口
 * ------------------------------
 * 面板要同时展示状态、指标、排名、图谱、能力矩阵。若每块各调一个接口，
 * 各接口之间可能出现**时间点不一致**（状态是 A 时刻、指标是 B 时刻），
 * 用户会看到自相矛盾的界面。因此这里产出**一次成型的快照**，
 * 所有视图渲染同一份数据 —— 事实一致是可观测性的底线。
 *
 * 数据来源全部是**只读投影**：能力图来自清单，指标来自日志，
 * 状态来自状态机。观测面本身**不写**任何东西。
 */

/** 面板快照。 */
export interface PanelSnapshot {
  /** 快照时刻。 */
  at: string
  /** profile 名。 */
  profile: string
  /** 当前工作区（分区键）。 */
  projectKey: string
  /** 当前生命周期阶段。 */
  stage: GuardStage
  /** 阶段中文标签。 */
  stageLabel: string
  /** 迁移历史（按时间顺序）。 */
  transitions: StageTransition[]
  /** 稳定性评分 ∈ [0,1]。 */
  stabilityScore: number
  /** 量化指标。 */
  metrics: MetricsSnapshot
  /** 嫌疑风险排名。 */
  risks: RankedRisk[]
  /** 当前决策文件的嫌疑名单（含因子证据，v0.13 方向③）。 */
  decisionSuspects: ReadonlyArray<{
    bundle: string
    version?: string
    lastChangeAt: string
    evidence?: {
      rank: number
      risk: number
      factors: { recency: number; experimental: number; crashFrequency: number }
      streak: number
      changeCount: number
      source?: 'journal' | 'mtime'
    }
  }>
  /** 能力矩阵摘要。 */
  capability: {
    total: number
    exposed: number
    connected: number
    connectivity: number
    gaps: Array<{ kind: string; capability: string; detail: string }>
    byStage: Array<{ stage: GuardStage; label: string; capabilities: string[] }>
  }
  /** 图谱连通性摘要。 */
  graphConnectivity: { components: number; largest: number; isolated: number }
  /** 最近恢复判定（面板生命周期卡片显示「观察中 N/M 轮」）。 */
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
  /** 备份策略投影（面板「备份」卡片）。 */
  backupPolicy: {
    versionedBackups: boolean
    retain: number
    customRoot: boolean
    root: string
    configEditorAvailable: boolean
  }
  /** 项目分区列表（隔离可见性）。 */
  partitions: Array<{ key: string; label: string; workspace: string; lastSeenAt: string }>
  /**
   * 写状态的乐观并发凭证（v0.12）。
   *
   * 为什么放在快照里：面板每 5s 轮询一次快照，用户点「重新启用」时依据的
   * 就是这张快照。带上 revision，动作请求才能回传「我是按哪份事实做的决定」；
   * 宿主比对不符就 409，而不是按一张过期地图执行破坏性动作。
   * 由 change-guard.computeRevision 从 state+decision+journal 尾部派生
   * （哈希而非计数器 ⇒ 崩溃重启后同一事实必得同一枚 revision）。
   */
  revision: string
  /** 已恢复的插件。 */
  restored: string[]
  /** 自动关闭的插件。 */
  autoDisabled: Array<{ name: string; reason: string; crashSeq: number; disabledAt: string }>
  /**
   * 最近事件流（journal 尾部投影）—— 「可视化流动」的数据源。
   *
   * 只投影面板要显示的字段，不透传整条 journal 行：
   * 快照是观测面，字段越少，前端与快照的契约越稳定。
   *
   * @deprecated 由 `eventFlow` 取代（后者带阶段/动作/流向/来源）。保留本字段
   * 只为不改动既有消费方；新代码一律读 `eventFlow`，迁移完成后删除。
   */
  recentEvents: Array<{ t: string; kind: string; bundle?: string; detail?: string }>
  /**
   * 事件流 / 状态流转的时序契约（升序，最近 `EVENT_FLOW_LIMIT` 条）。
   *
   * 「可视化流动」的全部数据基础：时间点 `at`、阶段 `stage`、动作
   * `action`/`actionLabel`、流向 `flow.from → flow.to`、来源 `source`。
   * 纯投影、无副作用、排序确定 —— 同一份输入必得逐字节相同的输出。
   */
  eventFlow: FlowEvent[]
  /** 马尔可夫转移矩阵（v0.10 R11）：阶段行为的「去向分布」+ 平稳分布。 */
  markov: MarkovAnalysis
  /**
   * 系统诊断投影（v0.10 R12）：宿主与插件的版本事实 + 数据面状态。
   *
   * 为什么是投影而非让前端自读：客户端拿不到宿主进程信息（浏览器沙箱），
   * 版本事实只能在宿主侧收集后随快照下发；`available:false` 是诚实边界
   * （不是所有宿主都提供 version 服务），绝不填假值。
   */
  diagnostics: {
    /** 插件自身版本（package.json version，构建期注入或运行时读）。 */
    pluginVersion: string | null
    /** 宿主版本（ctx.env?.version；宿主不提供时 null）。 */
    hostVersion: string | null
    /** 平台标识（win32/darwin/linux）。 */
    platform: string
    /** Node 版本（宿主进程）。 */
    nodeVersion: string
    /** 数据面路由是否可达（能产出这份快照 ⇒ 恒 true）。 */
    dataPlane: true
    /** 快照产出的耗时（毫秒，观测面自身的白盒开销）。 */
    snapshotMs: number
    /**
     * 反馈入口（v0.10 R18）：来自插件 package.json 的 repository.url 与 bugs.url。
     * 没有登记时为 null —— 前端**隐藏按钮**而不是放一条必 404 的死链。
     */
    repositoryUrl: string | null
    /** 问题反馈直达链接（GitHub Issues；未登记时 null）。 */
    issuesUrl: string | null
  }
}

/** 观测面需要的输入。 */
export interface SnapshotInput {
  profile: string
  projectKey: string
  stage: GuardStage
  transitions: readonly StageTransition[]
  stabilityScore: number
  observations: Observation[]
  riskInputs: Array<{
    bundle: string
    experimental: boolean
    lastChangeAt: string
    suspectHits: number
    observations: number
  }>
  /**
   * 当前决策文件的嫌疑名单（含因子证据，v0.13 方向③）。
   *
   * 形状与 `decision.ts` 的 `DecisionSuspect` 一致（投影）。空 = 无决策文件
   * 或决策文件里没有 suspects（首次安装、从未崩溃）。
   *
   * 为什么面板需要它：`risks`（`RankedRisk[]`）只给总分，回答不了「A 是靠
   * experimental 拉高还是靠 recency 拉高」。决策证据把分解、streak、changeCount
   * 一起给出来，面板才能解释「为什么是它被选中」。
   */
  decisionSuspects: ReadonlyArray<{
    bundle: string
    version?: string
    lastChangeAt: string
    evidence?: {
      rank: number
      risk: number
      factors: { recency: number; experimental: number; crashFrequency: number }
      streak: number
      changeCount: number
      source?: 'journal' | 'mtime'
    }
  }>
  restored: readonly string[]
  autoDisabled: Array<{ name: string; reason: string; crashSeq: number; disabledAt: string }>
  partitions: PartitionIndex
  /** 最近事件（journal 尾部，快照按序投影）。 */
  recentEvents: Array<{ t: string; kind: string; bundle?: string; detail?: string }>
  /** 实际注册出来的对外名称（契约校验用）。 */
  registeredExposedAs: readonly string[]
  /** 最近恢复判定（v0.9.1：观察中 N/M 轮或「为什么关了它」）。 */
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
  /** 备份策略（v0.9：面板可视化配置的数据源；只读投影，改配置走宿主设置页）。 */
  backupPolicy: {
    versionedBackups: boolean
    retain: number
    customRoot: boolean
    root: string
    configEditorAvailable: boolean
  }
  /** 系统诊断输入（v0.10 R12/R18）：版本事实由宿主侧收集，null = 宿主未提供（诚实边界）。 */
  diagnostics: {
    pluginVersion: string | null
    hostVersion: string | null
    repositoryUrl: string | null
    issuesUrl: string | null
  }
  /**
   * revision 派生所需的写状态事实（v0.12）。
   *
   * 为什么给**完整事实**而不是让本文件自己拼：面板快照的 revision 与动作路由
   * 核对的 revision 必须是同一组字段跑同一算法。两处各自装配时，将来加一个
   * 字段漏改另一处的后果不是「少核对一项」，而是**每次动作都 409**（面板
   * 发出去的凭证永远核对不过）—— 一个可选加强项变成整体失效。
   * 装配唯一在 `Guard.revisionFactsFrom()`，本文件只消费并派生。
   *
   * 为什么给输入而不是给现成的 revision 字符串：`revision` 必须是**派生值**
   * （投影），而不是调用方随手传进来的字符串 —— 否则「快照说 revision=X
   * 但事实早已变」这种漂移就无法在结构上排除。
   */
  revisionFacts: RevisionFacts
}

/**
 * 构造面板快照。
 *
 * 纯函数：给定输入必得同一输出（无时间依赖、无随机），
 * 因此可被契约测试逐字节比对。
 */
export function buildPanelSnapshot(input: SnapshotInput, now = Date.now()): PanelSnapshot {
  const graph = buildCapabilityGraph()
  const analysis = graph.analyze()
  const metrics = computeMetrics(input.observations, input.stabilityScore, partitionHealth(input.partitions), now)
  // 排名走白盒版本（带样本量/置信度/公式），数组形态由 `.value` 提供；
  // 空队列时 `.value` 为 null ⇒ 用空数组表示「没有嫌疑插件」，与「排名失败」区分。
  const risks = rankHazards(input.riskInputs, now).value ?? []
  const graphData = buildGraphDataFor(graph)

  const byStage = capabilitiesByStage(graph)
  const stageBreakdown = ALL_STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    capabilities: (byStage.get(stage) ?? []).map((r) => r.id),
  }))

  const contract = verifyCapabilityContract(graph, input.registeredExposedAs)

  return {
    at: new Date(now).toISOString(),
    profile: input.profile,
    projectKey: input.projectKey,
    stage: input.stage,
    stageLabel: STAGE_LABELS[input.stage],
    transitions: [...input.transitions],
    stabilityScore: input.stabilityScore,
    metrics,
    risks,
    decisionSuspects: [...input.decisionSuspects],
    backupPolicy: input.backupPolicy,
    lastRecoveryVerdict: input.lastRecoveryVerdict,
    capability: {
      total: analysis.total,
      exposed: analysis.exposed,
      connected: analysis.connected,
      connectivity: analysis.connectivity,
      gaps: [
        ...analysis.broken.map((g) => ({ kind: g.kind, capability: g.capability, detail: g.detail })),
        ...analysis.overproduced.map((g) => ({ kind: g.kind, capability: g.capability, detail: g.detail })),
        ...analysis.isolated.map((g) => ({ kind: g.kind, capability: g.capability, detail: g.detail })),
        ...contract.missing.map((name) => ({ kind: 'undeclared-registration', capability: name, detail: '清单声明暴露但未注册' })),
        ...contract.extra.map((name) => ({ kind: 'unregistered-declaration', capability: name, detail: '已注册但清单未声明' })),
      ],
      byStage: stageBreakdown,
    },
    graphConnectivity: (() => {
      const components = connectedComponents(graphData.nodes, graphData.edges)
      return { components: components.count, largest: components.largest, isolated: components.isolated.length }
    })(),
    partitions: input.partitions.partitions.map((p) => ({
      key: p.key,
      label: p.label,
      workspace: p.workspace,
      lastSeenAt: p.lastSeenAt,
    })),
    restored: [...input.restored],
    autoDisabled: input.autoDisabled.map((d) => ({ ...d })),
    // revision 是**派生**的：同一份事实重算必得同一枚值（哈希而非计数器），
    // 所以它不需要持久化位点，也不会在崩溃后说谎。字段装配唯一在
    // Guard.revisionFactsFrom（见 SnapshotInput 注释）—— 本函数只投影不拼字段。
    revision: computeRevision(input.revisionFacts),
    recentEvents: input.recentEvents.slice(-24).map((e) => ({ ...e })),
    eventFlow: deriveEventFlow(input.recentEvents, input.transitions, EVENT_FLOW_LIMIT),
    markov: markovAnalysis(input.transitions),
    diagnostics: {
      pluginVersion: input.diagnostics.pluginVersion,
      hostVersion: input.diagnostics.hostVersion,
      repositoryUrl: input.diagnostics.repositoryUrl,
      issuesUrl: input.diagnostics.issuesUrl,
      platform: process.platform,
      nodeVersion: process.version,
      dataPlane: true,
      snapshotMs: Math.max(0, Math.round(Date.now() - now)),
    },
  }
}

/**
 * 构造图谱数据。
 *
 * 能力节点 + 边（生产/消费）+ 缺口节点。
 * 缺口节点是**一等公民**：把「断链」「过度生产」画进图里，
 * 让缺口在视觉上无法被忽略。
 */
export function buildGraphDataFor(graph: CapabilityGraph): GraphData {
  const records = graph.all()
  const edges: Array<{ from: string; to: string; kind?: 'produces' | 'consumes' }> = []
  for (const record of records) {
    // 边的方向是「生产方 → 消费方」：`consumedBy` 就是「谁消费我的产出」。
    for (const consumer of record.consumedBy) {
      edges.push({ from: record.id, to: consumer, kind: 'produces' })
    }
  }

  const analysis = graph.analyze()
  const extras: GraphNode[] = []
  for (const gap of [...analysis.broken, ...analysis.overproduced, ...analysis.isolated]) {
    extras.push({
      id: `gap:${gap.capability}:${gap.detail}`,
      kind: 'gap',
      label: gapLabel(gap.kind),
      detail: `${gap.capability} · ${gap.detail}`,
      shape: 'triangle',
      tone: 'error',
      x: 0,
      y: 0,
      column: 0,
      ref: gap.capability,
    })
  }

  return buildGraphData(records, edges, extras)
}

/** 缺口的可读标签。 */
function gapLabel(kind: string): string {
  switch (kind) {
    case 'broken-consumption':
      return '消费断链'
    case 'over-production':
      return '过度生产'
    case 'isolated':
      return '孤立能力'
    default:
      return kind
  }
}

/**
 * 分区健康度 —— 用于隔离纯度指标。
 *
 * 一个分区「被污染」的判定：本分区的事件里出现了其它分区的项目键。
 * 这里用**分区索引里的重复工作区**作为可判定信号：
 * 同一个规范化路径出现在两个不同键下 ⇒ 隔离被破坏。
 */
function partitionHealth(index: PartitionIndex): Array<{ key: string; contaminated: boolean }> {
  const byWorkspace = new Map<string, string[]>()
  for (const partition of index.partitions) {
    const keys = byWorkspace.get(partition.workspace) ?? []
    keys.push(partition.key)
    byWorkspace.set(partition.workspace, keys)
  }
  return index.partitions.map((partition) => ({
    key: partition.key,
    contaminated: (byWorkspace.get(partition.workspace)?.length ?? 0) > 1,
  }))
}

/** 读取分区索引（只读；文件不存在时返回空索引）。 */
export { readPartitionIndex }
