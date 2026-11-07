import type { CapabilityGraph } from './capability.js'
import { buildCapabilityGraph, capabilitiesByStage, verifyCapabilityContract } from './capability-specs.js'
import type { GuardStage, StageTransition } from './lifecycle.js'
import { ALL_STAGES } from './lifecycle.js'
import { computeMetrics, rankHazards, type MetricsSnapshot, type Observation, type RankedRisk } from './observability.js'
import { deriveEventFlow, type FlowEvent } from './observations.js'
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
  restored: readonly string[]
  autoDisabled: Array<{ name: string; reason: string; crashSeq: number; disabledAt: string }>
  partitions: PartitionIndex
  /** 最近事件（journal 尾部，快照按序投影）。 */
  recentEvents: Array<{ t: string; kind: string; bundle?: string; detail?: string }>
  /** 实际注册出来的对外名称（契约校验用）。 */
  registeredExposedAs: readonly string[]
  /** 备份策略（v0.9：面板可视化配置的数据源；只读投影，改配置走宿主设置页）。 */
  backupPolicy: {
    versionedBackups: boolean
    retain: number
    customRoot: boolean
    root: string
    configEditorAvailable: boolean
  }
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
    backupPolicy: input.backupPolicy,
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
    recentEvents: input.recentEvents.slice(-24).map((e) => ({ ...e })),
    eventFlow: deriveEventFlow(input.recentEvents, input.transitions, EVENT_FLOW_LIMIT),
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
