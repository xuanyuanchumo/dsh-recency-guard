import { CapabilityGraph, type CapabilityRecord } from './capability.js'
import type { GuardStage } from './lifecycle.js'

/**
 * 能力清单 —— 本插件对外承诺的全部能力，及其生产/消费关系。
 *
 * 纪律（承 dsh-anic `capabilityIndex.ts`）：
 *
 * ① **投影而非第二真相源**：真相在注册处（`ctx.tools.register`、路由注册、
 *    事件发射）。本清单只声明「有哪些能力、谁生产、谁消费」，由**契约测试**
 *    做双向比对：注册了但清单里没有 → 漏登；清单里有但没注册 → 虚登。
 * ② **摘要不冒充描述**：`summary` 是能力语（能做什么），不是触发条件。
 * ③ **每个暴露能力都有消费者**：暴露而不被消费的工具是死工具，
 *    由 `analyze()` 的过度生产检查检出。
 *
 * ## 方向约定（字段名即方向）
 *
 * - `consumes`   —— 本能力**消费**谁（我读它的数据）。
 * - `consumedBy` —— 本能力**被谁**消费（它读我的数据）。
 *
 * 能力 id 命名：`guard.<域>.<名>`，域取 observe / decide / recover /
 * present / govern / tool，对应观察、决策、恢复、展示、治理、工具六个职责面。
 */

/** 能力清单。 */
export const CAPABILITY_SPECS: readonly CapabilityRecord[] = [
  {
    id: 'guard.observe.journal',
    title: '安装更新日志',
    summary: '记录插件安装与更新的时间线',
    produces: 'journal',
    carrier: 'file',
    consumes: [],
    consumedBy: ['guard.present.panel', 'guard.recover.evidence'],
    stage: 'monitoring',
    exposed: false,
  },
  {
    id: 'guard.observe.crash',
    title: '崩溃检测',
    summary: '以退出码判定上次运行是否异常结束',
    produces: 'crash',
    carrier: 'event',
    consumes: [],
    consumedBy: ['guard.decide.suspects', 'guard.observe.metrics'],
    stage: 'crashed',
    exposed: false,
  },
  {
    id: 'guard.observe.metrics',
    title: '量化指标',
    summary: '崩溃率、恢复耗时、检出率与隔离纯度',
    produces: 'metric',
    carrier: 'remote',
    consumes: ['guard.observe.crash'],
    consumedBy: ['guard.present.panel', 'guard.present.graph'],
    stage: 'monitoring',
    exposed: false,
  },
  {
    id: 'guard.observe.state',
    title: '生命周期状态',
    summary: '守护所处的阶段与合法迁移历史',
    produces: 'state',
    carrier: 'remote',
    consumes: [],
    consumedBy: ['guard.present.panel', 'guard.present.graph', 'guard.govern.reset'],
    stage: 'monitoring',
    exposed: false,
  },
  {
    id: 'guard.decide.suspects',
    title: '嫌疑排序',
    summary: '按最近更新与实验性标记给插件排风险',
    produces: 'decision',
    carrier: 'file',
    consumes: ['guard.observe.crash', 'guard.observe.journal'],
    consumedBy: ['guard.recover.apply', 'guard.present.graph', 'guard.present.panel'],
    stage: 'deciding',
    exposed: false,
  },
  {
    id: 'guard.decide.risk',
    title: '风险评分',
    summary: '把变更时间、命名与历史折成可比较的风险分',
    produces: 'metric',
    carrier: 'remote',
    consumes: ['guard.decide.suspects'],
    consumedBy: ['guard.present.panel', 'guard.present.graph'],
    stage: 'deciding',
    exposed: false,
  },
  {
    id: 'guard.recover.apply',
    title: '自动关闭嫌疑插件',
    summary: '按崩溃次数递增关闭最近更新的插件',
    produces: 'decision',
    carrier: 'event',
    consumes: ['guard.decide.suspects'],
    consumedBy: ['guard.recover.evidence'],
    stage: 'deciding',
    exposed: false,
  },
  {
    id: 'guard.recover.evidence',
    title: '配置备份与证据链',
    summary: '关闭前备份配置并保留完整恢复证据',
    produces: 'backup',
    carrier: 'file',
    consumes: ['guard.recover.apply', 'guard.observe.journal'],
    consumedBy: ['guard.recover.restore'],
    stage: 'stabilizing',
    exposed: false,
  },
  {
    id: 'guard.recover.restore',
    title: '恢复被关闭的配置',
    summary: '稳定后重新启用非首要嫌疑插件',
    produces: 'state',
    carrier: 'event',
    consumes: ['guard.recover.evidence'],
    consumedBy: ['guard.present.panel'],
    stage: 'recovered',
    exposed: false,
  },
  {
    id: 'guard.present.panel',
    title: '管理面板',
    summary: '状态、指标、排名与图谱的统一视图',
    produces: 'graph',
    carrier: 'remote',
    consumes: [
      'guard.observe.metrics',
      'guard.observe.state',
      'guard.observe.journal',
      'guard.decide.suspects',
      'guard.decide.risk',
      'guard.recover.restore',
    ],
    consumedBy: [],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency-guard.panel',
  },
  {
    id: 'guard.present.graph',
    title: '可交互图谱',
    summary: '能力生产消费关系与生命周期流动的可视化',
    produces: 'graph',
    carrier: 'remote',
    consumes: ['guard.observe.metrics', 'guard.observe.state', 'guard.decide.risk', 'guard.decide.suspects'],
    consumedBy: [],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency-guard.graph',
  },
  {
    id: 'guard.govern.reset',
    title: '归档重置',
    summary: '归档产物后按最新事实重跑自举',
    produces: 'state',
    carrier: 'remote',
    consumes: ['guard.observe.state'],
    consumedBy: [],
    stage: 'recovered',
    exposed: true,
    exposedAs: 'recency-guard.reset',
  },
  {
    id: 'guard.govern.isolation',
    title: '项目隔离',
    summary: '多工作区并存时状态与决策互不串扰',
    produces: 'state',
    carrier: 'file',
    consumes: [],
    consumedBy: ['guard.present.panel', 'guard.observe.metrics'],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency-guard.isolation',
  },
  {
    id: 'guard.tool.status',
    title: '守护状态查询',
    summary: '查询崩溃状态、嫌疑排名与自动关闭记录',
    produces: 'metric',
    carrier: 'tool',
    consumes: ['guard.observe.metrics', 'guard.observe.state'],
    consumedBy: [],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency_guard',
  },
  {
    id: 'guard.tool.recover',
    title: '手动恢复触发',
    summary: '立即按最近更新执行一次恢复关闭',
    produces: 'decision',
    carrier: 'tool',
    consumes: ['guard.decide.suspects'],
    consumedBy: [],
    stage: 'deciding',
    exposed: true,
    exposedAs: 'recency_guard',
  },
] as const

/**
 * 构建能力图。
 *
 * 连线由清单的 `consumes` 声明驱动：`connect(consumer, upstream)` 的语义是
 * 「consumer 消费 upstream 的产出」，与清单的方向一致。`connect` 会**双向**
 * 登记（consumes 与 consumedBy），因此关系不会只在一侧存在。
 */
export function buildCapabilityGraph(specs: readonly CapabilityRecord[] = CAPABILITY_SPECS): CapabilityGraph {
  const graph = new CapabilityGraph()
  for (const spec of specs) {
    graph.upsert({ ...spec, consumes: [...spec.consumes], consumedBy: [...spec.consumedBy] })
  }
  // 双向登记：清单里的 `consumes` 与 `consumedBy` **互为镜像**，
  // 只连一侧会留下单向关系（被 analyze 报成缺口）。
  // 先按 consumes 连线（connect 会补 consumedBy），再校验 consumedBy 的镜像，
  // 缺失的一侧补上 —— 清单里写错方向时，索引仍然是自洽的。
  for (const spec of specs) {
    for (const upstream of spec.consumes) {
      graph.connect(spec.id, upstream)
    }
  }
  for (const spec of specs) {
    for (const downstream of spec.consumedBy) {
      const consumer = graph.get(downstream)
      if (consumer && !consumer.consumes.includes(spec.id)) {
        graph.connect(downstream, spec.id)
      }
    }
  }
  return graph
}

/**
 * 契约校验：清单与实际注册面是否一致。
 *
 * @param registeredExposedAs 实际注册出来的对外名称（工具名 / 路由路径）。
 */
export function verifyCapabilityContract(
  graph: CapabilityGraph,
  registeredExposedAs: Iterable<string>,
): {
  /** 清单声明暴露、但实际没注册。 */
  missing: string[]
  /** 实际注册、但清单没声明。 */
  extra: string[]
  /** 完全一致。 */
  ok: boolean
} {
  const declared = new Set(graph.exposed().map((r) => r.exposedAs).filter((v): v is string => v !== undefined))
  const actual = new Set(registeredExposedAs)
  const missing = [...declared].filter((name) => !actual.has(name))
  // 「实际注册但清单没声明」：只报**确实被清单完全遗漏**的名字。
  // 多个能力可以共用一个对外名称（本插件的 recency_guard 工具承载了
  // status / recover 两个能力），因此同名不算遗漏。
  const extra = [...actual].filter((name) => !declared.has(name) && !isDeclaredName(graph, name))
  return { missing, extra, ok: missing.length === 0 && extra.length === 0 }
}

/** 这个对外名称是否被任何能力声明过（含共用同一名称的多个能力）。 */
function isDeclaredName(graph: CapabilityGraph, name: string): boolean {
  return graph.all().some((record) => record.exposedAs === name)
}

/** 能力的阶段标签（用于面板分栏）。 */
export function capabilitiesByStage(graph: CapabilityGraph): Map<GuardStage, CapabilityRecord[]> {
  const byStage = new Map<GuardStage, CapabilityRecord[]>()
  for (const record of graph.all()) {
    const list = byStage.get(record.stage as GuardStage) ?? []
    list.push(record)
    byStage.set(record.stage as GuardStage, list)
  }
  return byStage
}
