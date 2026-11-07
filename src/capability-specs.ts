import {
  CapabilityGraph,
  TOOL_SURFACE,
  declaredExposedNames,
  declaredHostServices,
  exposedNamesOf,
  type CapabilityRecord,
} from './capability.js'
import { ROUTE_SURFACE, ROUTE_PATHS, type RouteSurfaceEntry } from './routes.js'
import type { GuardStage } from './lifecycle.js'

/**
 * 能力清单 —— 本插件对外承诺的全部能力，及其生产/消费关系。
 *
 * 纪律（承 dsh-anic `capabilityIndex.ts`）：
 *
 * ① **投影而非第二真相源**：真相在注册处（`ctx.tools.register` 用的
 *    `TOOL_SURFACE`、路由注册用的 `ROUTE_SURFACE`、事件发射、状态写入）。
 *    本清单只声明「有哪些能力、谁生产、谁消费」，由**契约测试**做双向比对：
 *    注册了但清单里没有 → 漏登；清单里有但没注册 → 虚登。
 * ② **摘要不冒充描述**：`summary` 是能力语（能做什么），不是触发条件。
 * ③ **每个能力都有它的位置**：非暴露能力必须被消费（否则产出无人读到，
 *    是白盒可见的浪费，`analyze()` 会报 over-production）；暴露能力必须能在
 *    注册面上找到位点（工具 action / 路由），否则 `verifySurfaceAlignment`
 *    报 unregistered。
 * ④ **依赖要声明**：`hostServices` 写清楚这个能力依赖哪些宿主服务，
 *    契约测试拿它跟真实 inject 面**双向**核对 —— 声明了空气依赖、或注入了
 *    没人解释的服务，都会失败。
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
  // ---------- 观察面 ----------
  {
    id: 'guard.observe.journal',
    title: '安装更新日志',
    summary: '记录插件安装与更新的时间线',
    produces: 'journal',
    carrier: 'file',
    consumes: [],
    consumedBy: [
      'guard.observe.metrics',
      'guard.present.panel',
      'guard.tool.history',
      'guard.recover.evidence',
      'guard.decide.suspects',
      'guard.govern.archive',
    ],
    stage: 'monitoring',
    exposed: false,
    hostServices: ['pluginManager', 'profileContext'],
  },
  {
    id: 'guard.observe.crash',
    title: '崩溃检测',
    summary: '以退出码判定上次运行是否异常结束',
    produces: 'crash',
    carrier: 'event',
    consumes: [],
    consumedBy: ['guard.decide.suspects', 'guard.observe.metrics', 'guard.observe.lifecycle'],
    stage: 'crashed',
    exposed: false,
  },
  {
    id: 'guard.observe.state',
    title: '生命周期状态',
    summary: '守护所处的阶段与合法迁移历史',
    produces: 'state',
    carrier: 'remote',
    consumes: [],
    consumedBy: [
      'guard.present.panel',
      'guard.present.graph',
      'guard.observe.lifecycle',
      'guard.govern.reset',
      'guard.govern.isolation',
      'guard.govern.archive',
      'guard.tool.status',
    ],
    stage: 'monitoring',
    exposed: false,
  },
  {
    id: 'guard.observe.lifecycle',
    title: '生命周期步骤流',
    summary: '每个阶段/步骤的进入、退出、耗时与失败原因',
    produces: 'state',
    carrier: 'remote',
    consumes: ['guard.observe.state', 'guard.observe.crash', 'guard.observe.metrics'],
    consumedBy: ['guard.present.panel', 'guard.present.graph'],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency-guard.lifecycle',
  },
  {
    id: 'guard.observe.config',
    title: '配置快照读取',
    summary: '从 configEditor 读出插件当前生效的配置，供关闭前备份',
    produces: 'backup',
    carrier: 'file',
    consumes: [],
    consumedBy: ['guard.recover.evidence', 'guard.tool.backups'],
    stage: 'monitoring',
    exposed: false,
    hostServices: ['configEditor'],
  },
  {
    id: 'guard.observe.metrics',
    title: '量化指标',
    summary: '崩溃率、恢复耗时、检出率与隔离纯度',
    produces: 'metric',
    carrier: 'remote',
    consumes: ['guard.observe.crash', 'guard.observe.journal', 'guard.govern.isolation'],
    consumedBy: ['guard.present.panel', 'guard.present.graph', 'guard.tool.status', 'guard.observe.lifecycle'],
    stage: 'monitoring',
    exposed: false,
  },

  // ---------- 决策面 ----------
  {
    id: 'guard.decide.suspects',
    title: '嫌疑排序',
    summary: '按最近更新与实验性标记给插件排风险',
    produces: 'decision',
    carrier: 'file',
    consumes: ['guard.observe.crash', 'guard.observe.journal'],
    consumedBy: [
      'guard.recover.apply',
      'guard.recover.manual',
      'guard.present.graph',
      'guard.present.panel',
      'guard.tool.status',
      'guard.decide.risk',
    ],
    stage: 'deciding',
    exposed: false,
    hostServices: ['pluginManager', 'profileContext'],
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

  // ---------- 恢复面 ----------
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
    hostServices: ['pluginManager'],
  },
  {
    id: 'guard.recover.evidence',
    title: '配置备份与证据链',
    summary: '关闭前备份配置并保留完整恢复证据',
    produces: 'backup',
    carrier: 'file',
    consumes: ['guard.recover.apply', 'guard.observe.config', 'guard.observe.journal'],
    consumedBy: ['guard.recover.restore', 'guard.recover.reenable', 'guard.tool.backups'],
    stage: 'stabilizing',
    exposed: false,
    hostServices: ['configEditor'],
  },
  {
    id: 'guard.recover.restore',
    title: '恢复被关闭的配置',
    summary: '稳定后重新启用非首要嫌疑插件',
    produces: 'state',
    carrier: 'tool',
    consumes: ['guard.recover.evidence'],
    // 方向铁律（CLAUDE.md）：consumes = 我消费谁；consumedBy = 谁消费我。
    // 管理面板会展示并触发 restore，所以「我」被面板消费 —— 这条必须写在
    // consumedBy 上。清单原文两侧都要写全：buildCapabilityGraph 会补镜像，
    // 而契约测试刻意核对**原文**，正是为了让这种单向声明无处可藏。
    consumedBy: ['guard.present.panel'],
    stage: 'recovered',
    exposed: true,
    exposedAs: 'recency_guard',
    // v0.11：restore 同时作为**动作路由**暴露（/action/restore），面板的
    // 「恢复非嫌疑插件」按钮走这条路由 —— 名称必须声明，契约测试双向核对。
    exposedAlsoAs: ['recency-guard.restore'],
    exposedActions: ['restore'],
    hostServices: ['tools', 'pluginManager'],
  },
  {
    id: 'guard.recover.reenable',
    title: '手动重新启用插件',
    summary: '把某个插件重新打开，并报告是否存在配置备份',
    produces: 'state',
    carrier: 'tool',
    consumes: ['guard.recover.evidence'],
    consumedBy: [],
    stage: 'recovered',
    exposed: true,
    exposedAs: 'recency_guard',
    exposedAlsoAs: ['recency-guard.reenable'],
    exposedActions: ['reenable'],
    hostServices: ['tools', 'pluginManager'],
  },
  {
    id: 'guard.recover.manual',
    title: '手动恢复触发',
    summary: '立即按最近更新执行一次恢复关闭',
    produces: 'decision',
    carrier: 'tool',
    consumes: ['guard.decide.suspects'],
    consumedBy: [],
    stage: 'deciding',
    exposed: true,
    exposedAs: 'recency_guard',
    exposedAlsoAs: ['recency-guard.recover'],
    exposedActions: ['recover'],
    hostServices: ['tools', 'pluginManager'],
  },

  // ---------- 治理面 ----------
  {
    id: 'guard.govern.archive',
    title: '归档与留档',
    summary: '把当前产物搬走并留下清单（先读后搬），供对照与举他',
    produces: 'archive',
    carrier: 'file',
    consumes: ['guard.observe.state', 'guard.observe.journal'],
    consumedBy: ['guard.govern.reset', 'guard.present.panel'],
    stage: 'recovered',
    exposed: true,
    exposedAs: 'recency-guard.archives',
    exposedAlsoAs: ['recency_guard'],
    exposedActions: ['archives'],
    hostServices: ['tools'],
  },
  {
    id: 'guard.govern.reset',
    title: '归档重置',
    summary: '归档产物后按最新事实重跑自举（不继承旧结论）',
    produces: 'state',
    carrier: 'tool',
    consumes: ['guard.govern.archive', 'guard.observe.state'],
    consumedBy: [],
    stage: 'recovered',
    exposed: true,
    exposedAs: 'recency_guard',
    exposedAlsoAs: ['recency-guard.reset'],
    exposedActions: ['archive'],
    hostServices: ['tools'],
  },
  {
    id: 'guard.govern.isolation',
    title: '项目隔离',
    summary: '多工作区并存时状态与决策互不串扰',
    produces: 'state',
    carrier: 'remote',
    consumes: ['guard.observe.state'],
    consumedBy: ['guard.present.panel', 'guard.observe.metrics'],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency-guard.isolation',
    hostServices: ['webServer', 'profileContext'],
  },

  // ---------- 展示面 ----------
  {
    id: 'guard.present.panel',
    title: '管理面板',
    summary: '状态、指标、排名与图谱的统一视图',
    produces: 'graph',
    carrier: 'remote',
    consumes: [
      'guard.observe.metrics',
      'guard.observe.state',
      'guard.observe.lifecycle',
      'guard.observe.journal',
      'guard.decide.suspects',
      'guard.decide.risk',
      'guard.recover.restore',
      'guard.govern.archive',
      'guard.govern.isolation',
    ],
    consumedBy: [],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency-guard.panel',
    hostServices: ['webServer', 'profileContext'],
  },
  {
    id: 'guard.present.graph',
    title: '可交互图谱',
    summary: '能力生产消费关系与生命周期流动的可视化',
    produces: 'graph',
    carrier: 'remote',
    consumes: [
      'guard.observe.metrics',
      'guard.observe.state',
      'guard.observe.lifecycle',
      'guard.decide.risk',
      'guard.decide.suspects',
    ],
    consumedBy: [],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency-guard.graph',
    hostServices: ['webServer'],
  },

  // ---------- 工具面 ----------
  {
    id: 'guard.tool.status',
    title: '守护状态查询',
    summary: '查询崩溃状态、嫌疑排名与自动关闭记录',
    produces: 'metric',
    carrier: 'tool',
    consumes: ['guard.observe.metrics', 'guard.observe.state', 'guard.decide.suspects'],
    consumedBy: [],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency_guard',
    exposedActions: ['status'],
    hostServices: ['tools'],
  },
  {
    id: 'guard.tool.history',
    title: '事件时间线查询',
    summary: '按时间顺序读安装/更新/崩溃/恢复事件',
    produces: 'journal',
    carrier: 'tool',
    consumes: ['guard.observe.journal'],
    consumedBy: [],
    stage: 'monitoring',
    exposed: true,
    exposedAs: 'recency_guard',
    exposedActions: ['history'],
    hostServices: ['tools'],
  },
  {
    id: 'guard.tool.backups',
    title: '配置备份清单',
    summary: '列出关闭前留下的配置备份',
    produces: 'backup',
    carrier: 'tool',
    consumes: ['guard.observe.config', 'guard.recover.evidence'],
    consumedBy: [],
    stage: 'stabilizing',
    exposed: true,
    exposedAs: 'recency_guard',
    exposedActions: ['backups'],
    hostServices: ['tools'],
  },
] as const

/**
 * 构建能力图。
 *
 * 连线由清单的 `consumes` 声明驱动：`connect(consumer, upstream)` 的语义是
 * 「consumer 消费 upstream 的产出」，与清单的方向一致。`connect` 会**双向**
 * 登记（consumes 与 consumedBy），因此关系不会只在一侧存在。
 *
 * 注意：这里补镜像只保证**索引自洽**，不赦免清单写错方向 —— 契约测试另外
 * 逐条核对 `consumedBy` 在对方的 `consumes` 里（镜像补齐前就核对）。
 */
export function buildCapabilityGraph(specs: readonly CapabilityRecord[] = CAPABILITY_SPECS): CapabilityGraph {
  const graph = new CapabilityGraph()
  for (const spec of specs) {
    graph.upsert({
      ...spec,
      consumes: [...spec.consumes],
      consumedBy: [...spec.consumedBy],
      ...(spec.exposedAlsoAs === undefined ? {} : { exposedAlsoAs: [...spec.exposedAlsoAs] }),
      ...(spec.exposedActions === undefined ? {} : { exposedActions: [...spec.exposedActions] }),
      ...(spec.hostServices === undefined ? {} : { hostServices: [...spec.hostServices] }),
    })
  }
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
 * 契约校验（运行期自检用）：清单声明的对外名称 vs 实际注册出来的名称。
 *
 * @param registeredExposedAs 实际注册出来的对外名称（工具名 / 路由名）。
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
  const declared = declaredExposedNames(graph)
  const actual = new Set(registeredExposedAs)
  const missing = [...declared].filter((name) => !actual.has(name))
  // 「实际注册但清单没声明」：任何声明过的名字都不算遗漏 ——
  // 多个能力可以共用一个对外名称（`recency_guard` 承载 8 个 action）。
  const extra = [...actual].filter((name) => !declared.has(name))
  return { missing, extra, ok: missing.length === 0 && extra.length === 0 }
}

/**
 * 注册面 —— 由**注册表**（`TOOL_SURFACE` / `ROUTE_SURFACE`）投影出来的形状。
 *
 * 它与清单是**两条独立的线**：注册表被注册代码直接消费，清单只描述意图。
 * 双向比对必须在两者之间做，自己核对自己永远为真。
 */
export interface RegistrationSurface {
  toolName: string
  toolActions: readonly string[]
  routes: readonly RouteSurfaceEntry[]
}

/** 当前真实的注册面。 */
export function currentRegistrationSurface(): RegistrationSurface {
  return { toolName: TOOL_SURFACE.name, toolActions: TOOL_SURFACE.actions, routes: ROUTE_SURFACE }
}

/** 一条注册面缺口。 */
export interface SurfaceGap {
  /** 缺口种类：一眼看出该改哪边。 */
  kind:
    | 'unregistered-capability' // 清单声明暴露，但注册面上没有位点
    | 'undeclared-registration' // 注册面上有，但清单没声明
    | 'action-not-registered' // 清单声明了 action，但工具表里没有
    | 'action-not-declared' // 工具表里有 action，但清单没声明
    | 'dangling-route' // 路由指向不存在的能力
    | 'route-name-mismatch' // 路由的暴露名不在该能力的名称集合里
    | 'missing-consumer' // 非暴露能力没有消费方（产出无人读）
    | 'host-service-not-injected' // 声明的宿主服务不在 inject 面
    | 'host-service-not-declared' // inject 面上的服务没人声明
  /** 相关的能力 id 或注册面名称。 */
  subject: string
  detail: string
}

/**
 * 双向比对：清单 ↔ 注册面（含 action 细化与宿主服务依赖）。
 *
 * @param graph 能力图（清单投影）
 * @param surface 注册面（注册表投影）
 * @param injectedServices 真实的 inject 面（服务名）
 */
export function verifySurfaceAlignment(
  graph: CapabilityGraph,
  surface: RegistrationSurface = currentRegistrationSurface(),
  injectedServices: Iterable<string> = [],
): { gaps: SurfaceGap[]; ok: boolean } {
  const gaps: SurfaceGap[] = []
  const routesByCapability = new Map<string, RouteSurfaceEntry[]>()
  for (const route of surface.routes) {
    const list = routesByCapability.get(route.capability) ?? []
    list.push(route)
    routesByCapability.set(route.capability, list)
  }

  for (const record of graph.all()) {
    const names = exposedNamesOf(record)
    const needsTool = (record.exposedActions ?? []).length > 0 || names.includes(surface.toolName)
    const routes = routesByCapability.get(record.id) ?? []

    if (record.exposed) {
      // 注册 ⊃ 清单：暴露的能力必须至少有一条注册路径。
      if (names.length === 0) {
        gaps.push({
          kind: 'unregistered-capability',
          subject: record.id,
          detail: '声明暴露但没有对外名称，注册面无从承载',
        })
      }
      if (!needsTool && routes.length === 0) {
        gaps.push({
          kind: 'unregistered-capability',
          subject: record.id,
          detail: `声明的名称 ${names.join(', ') || '(无)'} 在注册面上没有位点`,
        })
      }
    } else if (names.length > 0) {
      // 非暴露能力不该有对外名称：有名称意味着它其实被暴露，却标成内部能力。
      gaps.push({
        kind: 'undeclared-registration',
        subject: record.id,
        detail: `非暴露能力声明了对外名称 ${names.join(', ')}`,
      })
    }

    // 工具 action：清单 ⊃ 注册（声明的必须存在）与 注册 ⊃ 清单（存在的必须被声明）。
    for (const action of record.exposedActions ?? []) {
      if (!surface.toolActions.includes(action)) {
        gaps.push({
          kind: 'action-not-registered',
          subject: record.id,
          detail: `声明了工具 action「${action}」，但 ${surface.toolName} 没有这个 action`,
        })
      }
      if (!names.includes(surface.toolName)) {
        gaps.push({
          kind: 'route-name-mismatch',
          subject: record.id,
          detail: `声明了工具 action 却没把工具名 ${surface.toolName} 列入对外名称`,
        })
      }
    }

    // 路由：能力 id 必须存在（反向在下面统一查），暴露名必须在该能力的名称里。
    for (const route of routes) {
      if (!names.includes(route.exposedName)) {
        gaps.push({
          kind: 'route-name-mismatch',
          subject: record.id,
          detail: `路由 ${route.path} 的暴露名 ${route.exposedName} 不在能力的名称集合里`,
        })
      }
    }

    // 非暴露能力必须有消费方：产出无人读 = 白盒可见的浪费。
    if (!record.exposed && record.consumedBy.length === 0) {
      gaps.push({
        kind: 'missing-consumer',
        subject: record.id,
        detail: '非暴露能力没有任何消费方（产出无人读）',
      })
    }
  }

  // 注册面侧：路由指向的能力必须存在。
  for (const route of surface.routes) {
    if (graph.get(route.capability) === undefined) {
      gaps.push({
        kind: 'dangling-route',
        subject: route.capability,
        detail: `路由 ${route.path} 指向不存在的能力`,
      })
    }
    if (route.path !== ROUTE_PATHS[route.name]) {
      gaps.push({
        kind: 'dangling-route',
        subject: route.capability,
        detail: `路由 ${route.name} 的路径 ${route.path} 与 ROUTE_PATHS 不一致`,
      })
    }
  }

  // 注册 ⊃ 清单：工具 action 必须被某个能力声明。
  for (const action of surface.toolActions) {
    const declared = graph
      .all()
      .some((record) => (record.exposedActions ?? []).includes(action) && exposedNamesOf(record).includes(surface.toolName))
    if (!declared) {
      gaps.push({
        kind: 'action-not-declared',
        subject: `${surface.toolName}.${action}`,
        detail: '工具注册了该 action，但清单里没有任何能力声明它',
      })
    }
  }

  // 注册 ⊃ 清单：路由暴露名必须被某个能力声明。
  const declaredNames = declaredExposedNames(graph)
  for (const route of surface.routes) {
    if (!declaredNames.has(route.exposedName)) {
      gaps.push({
        kind: 'undeclared-registration',
        subject: route.exposedName,
        detail: `路由 ${route.path} 注册了该名称，但清单没声明`,
      })
    }
  }
  if (!declaredNames.has(surface.toolName)) {
    gaps.push({
      kind: 'undeclared-registration',
      subject: surface.toolName,
      detail: '工具名被注册，但清单没声明',
    })
  }

  // 依赖声明 ↔ inject 面（双向）。
  const injected = new Set(injectedServices)
  const declaredServices = declaredHostServices(graph)
  for (const service of declaredServices) {
    if (!injected.has(service)) {
      gaps.push({
        kind: 'host-service-not-injected',
        subject: service,
        detail: '清单声明依赖该宿主服务，但 inject 面上没有它',
      })
    }
  }
  for (const service of injected) {
    if (!declaredServices.has(service)) {
      gaps.push({
        kind: 'host-service-not-declared',
        subject: service,
        detail: 'inject 面上有该服务，但没有任何能力声明依赖它',
      })
    }
  }

  return { gaps, ok: gaps.length === 0 }
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
