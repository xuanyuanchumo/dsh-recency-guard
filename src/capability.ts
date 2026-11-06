/**
 * 能力模型（Capability Model）—— dsh-recency-guard 的「注册 ↔ 生产 ↔ 消费」单一真值源。
 *
 * 为什么要有这一层
 * ----------------
 * 守护类插件的能力很容易散落：工具在 `ctx.tools.register` 里、状态在 `state.json`、
 * 面板在 client 侧、告警在日志里。于是「有哪些能力、谁生产、谁消费」这个问题
 * 只能靠人读代码回答 —— 这正是「注册了但没激活」「面板显示了但没人消费」这类
 * 缺口长期不被发现的根因。
 *
 * 本模块把「能力」建模成一张**有向图**：
 *
 *   能力(capability) ──生产(produces)──▶ 事件/事实(fact)
 *                    └─消费(consumes)──▶ 事件/事实(fact)
 *
 * 生产者与消费者都登记自己，索引据此做**双向可达性**检查：
 *   - 产出无人消费的事实  → 「过度生产」（白盒可见的浪费）
 *   - 消费无人生产的事实  → 「消费断链」（功能不连通）
 *   - 声明了却没被任何插件实例化 → 「注册面缺口」
 *
 * 这与 dsh-anic 的能力索引纪律一致：**索引是投影，不是第二真相源**。
 * 真相在注册处（工具注册、事件发射、状态写入），索引只投影它们的形状，
 * 并由契约测试做双向比对。
 */

/** 能力标识。 */
export type CapabilityId = string

/** 事实的类型标签（生产出来的产物）。 */
export type FactKind =
  | 'crash' // 崩溃事实
  | 'decision' // 恢复决策事实
  | 'journal' // 安装/更新日志事实
  | 'backup' // 配置备份事实
  | 'metric' // 量化指标事实
  | 'state' // 生命周期状态事实
  | 'graph' // 图谱节点/边事实
  | 'archive' // 归档留档事实（清单 + 搬走记录）

/** 事实的载体类型。 */
export type FactCarrier =
  | 'tool' // 由工具产出（模型消费）
  | 'event' // 由事件产出（订阅消费）
  | 'file' // 由文件产出（面板轮询消费）
  | 'remote' // 由远程方法产出（client 消费）

/** 能力的一条登记记录。 */
export interface CapabilityRecord {
  /** 稳定的能力 id。 */
  id: CapabilityId
  /** 中文标题（面板与索引展示）。 */
  title: string
  /** 一句话说明「这个能力能做什么」。 */
  summary: string
  /** 事实种类。 */
  produces: FactKind
  /** 载体。 */
  carrier: FactCarrier
  /**
   * 上游：我消费谁的产出（"我读它的数据"）。
   *
   * 命名纪律：`consumes` / `consumedBy` 一眼可辨方向，不靠记忆解读。
   * （旧字段名 consumers/producers 方向相反，是真实的可读性缺陷。）
   */
  consumes: CapabilityId[]
  /** 下游：谁消费我的产出（"它读我的数据"）。 */
  consumedBy: CapabilityId[]
  /** 生命周期阶段（见 lifecycle.ts）。 */
  stage: string
  /** 是否为对外暴露的能力（工具 / 远程方法）。 */
  exposed: boolean
  /**
   * 暴露时的主名称（工具名 / 客户端面名 / 服务名）。
   *
   * 一个能力可以有多条暴露路径（例如「手动恢复」既走工具 action，也走
   * HTTP 动作路由），因此主名称之外还有 `exposedAlsoAs` —— 二者并集才是
   * 该能力声明的**全部对外名称**。契约测试按并集与注册面双向比对。
   */
  exposedAs?: string
  /** 次要对外名称（路由/别称）；与 `exposedAs` 并集参与契约比对。 */
  exposedAlsoAs?: readonly string[]
  /**
   * 该能力经工具暴露时的 action 列表。
   *
   * 工具是**一个**注册名（`TOOL_SURFACE.name`）承载多个业务动作的载体，
   * 因此「注册面 ⊃ 清单」在工具侧必须细化到 action：声明了不存在的
   * action、或注册了没人声明的 action，都是真实缺口。
   */
  exposedActions?: readonly string[]
  /**
   * 该能力依赖的**宿主服务名**（inject 面）。
   *
   * 声明依赖而不是从 inject 数组猜：契约测试做双向核对 ——
   * 声明的服务必须真的在 inject 面上（否则能力写的是空气依赖），
   * inject 面上的服务也必须被至少一个能力声明（否则是无人解释的注入）。
   */
  hostServices?: readonly string[]
}

/**
 * 能力图 —— 有向图 + 双向可达性分析。
 *
 * 数据结构选择（白盒透明化的依据）：
 * - **邻接表**（`Map<id, CapabilityRecord>` + 记录内的 id 数组）而非邻接矩阵：
 *   能力数在几十量级，矩阵是 O(n²) 空间且稀疏，邻接表是 O(n+m)。
 * - 消费者/生产者用 **Set 语义**（数组去重）而非数组：同一能力被多处消费是常态。
 * - 索引的**插入顺序**由 `Map` 保证（JS Map 保持插入序），因此投影输出稳定可比对。
 */
export class CapabilityGraph {
  private readonly records = new Map<CapabilityId, CapabilityRecord>()

  /**
   * 登记或更新一条能力。
   *
   * 缺省的关系数组会被补成空数组 —— 否则调用方只写「我消费谁」时，
   * `consumedBy` 会是 undefined，`analyze()` 遍历它时抛错。
   * 关系数组是**引用拷贝**，调用方之后修改自己的数组不会影响索引。
   */
  upsert(record: CapabilityRecord): void {
    this.records.set(record.id, {
      ...record,
      consumes: [...(record.consumes ?? [])],
      consumedBy: [...(record.consumedBy ?? [])],
    })
  }

  /** 读取一条能力。 */
  get(id: CapabilityId): CapabilityRecord | undefined {
    return this.records.get(id)
  }

  /** 全部能力（按登记顺序）。 */
  all(): CapabilityRecord[] {
    return [...this.records.values()]
  }

  /** 对外暴露的能力（工具 / 远程方法）。 */
  exposed(): CapabilityRecord[] {
    return this.all().filter((r) => r.exposed)
  }

  /** 能力数量。 */
  get size(): number {
    return this.records.size
  }

  /** 登记一条消费关系：consumer 消费 producer 产出的事实。 */
  connect(consumer: CapabilityId, producer: CapabilityId): void {
    const c = this.records.get(consumer)
    const p = this.records.get(producer)
    if (!c || !p) return
    if (!c.consumes.includes(producer)) c.consumes.push(producer)
    if (!p.consumedBy.includes(consumer)) p.consumedBy.push(consumer)
  }

  /**
   * 连通性分析 —— 三类缺口。
   *
   * 1. **消费断链**：消费的事实没有生产者 —— 功能不连通。
   * 2. **过度生产**：产出的事实没有消费者 —— 产出浪费（白盒可见）。
   * 3. **孤立能力**：既不生产也不消费 —— 死能力。
   */
  analyze(): CapabilityAnalysis {
    const broken: CapabilityGap[] = []
    const overproduced: CapabilityGap[] = []
    const isolated: CapabilityGap[] = []

    for (const record of this.records.values()) {
      // 上游断链：我声明消费 U，但 U 不存在，或 U 没有反向登记我。
      for (const upstream of record.consumes) {
        const producer = this.records.get(upstream)
        if (!producer) {
          broken.push({ kind: 'broken-consumption', capability: record.id, detail: upstream })
          continue
        }
        if (!producer.consumedBy.includes(record.id)) {
          broken.push({ kind: 'broken-consumption', capability: record.id, detail: upstream })
        }
      }
      // 下游悬空：我声明被 D 消费，但 D 不存在，或 D 没有反向登记我。
      for (const downstream of record.consumedBy) {
        const consumer = this.records.get(downstream)
        if (!consumer) {
          overproduced.push({ kind: 'over-production', capability: record.id, detail: downstream })
          continue
        }
        if (!consumer.consumes.includes(record.id)) {
          overproduced.push({ kind: 'over-production', capability: record.id, detail: downstream })
        }
      }
      // 生产无人消费：非暴露能力若没有任何消费方，它的产出永远不会被读到 ——
      // 「产出浪费」的实质形态。归入 overproduced（同一语义家族）而不是新开
      // 一类，避免面板/图谱的既有缺口投影漏掉它。
      if (!record.exposed && record.consumedBy.length === 0) {
        overproduced.push({ kind: 'over-production', capability: record.id, detail: '产出无人消费' })
      }
      if (record.consumes.length === 0 && record.consumedBy.length === 0) {
        isolated.push({ kind: 'isolated', capability: record.id, detail: record.title })
      }
    }

    const connected = this.records.size - new Set([...broken, ...overproduced, ...isolated].map((g) => g.capability)).size

    return {
      total: this.records.size,
      exposed: this.exposed().length,
      connected,
      broken,
      overproduced,
      isolated,
      /** 连通率 = 有连接的能力 / 总能力。 */
      connectivity: this.records.size === 0 ? 1 : connected / this.records.size,
    }
  }
}

/** 一条缺口记录。 */
export interface CapabilityGap {
  kind: 'broken-consumption' | 'over-production' | 'isolated'
  capability: CapabilityId
  detail: string
}

/** 连通性分析结果。 */
export interface CapabilityAnalysis {
  total: number
  exposed: number
  connected: number
  broken: CapabilityGap[]
  overproduced: CapabilityGap[]
  isolated: CapabilityGap[]
  /** 连通率 ∈ [0,1]。 */
  connectivity: number
}

/**
 * 工具对外面注册表 —— **暴露名称的唯一定义处**。
 *
 * 为什么放在这里而不是 `capability-specs.ts`
 * ----------------------------------------
 * `capability-specs.ts` 是**投影**（清单），它不能同时是注册真值，否则
 * 「清单与注册不一致」这句话就没有意义了（自己核对自己永远一致）。
 * 注册真值必须在**注册处**：`apply()` 用 `TOOL_SURFACE.name` / `.actions`
 * 调 `defineTool`，因此这份表面**先于注册存在**，是注册的输入而不是副本。
 *
 * 契约测试据此做双向比对：
 *   - 注册 ⊃ 清单：`TOOL_SURFACE.actions` 里每个 action 都必须被某个能力声明；
 *   - 清单 ⊃ 注册：每个声明走工具的能力，其 `exposedActions` 必须在该表内。
 */
export const TOOL_SURFACE = {
  name: 'recency_guard',
  /**
   * 工具的 action 枚举。顺序即模型看到的选择顺序（status 在前：最常用）。
   * `as const` 保留字面量类型，注册处展开成数组喂给 schema。
   */
  actions: ['status', 'history', 'recover', 'restore', 'reenable', 'backups', 'archive', 'archives'],
} as const

/** 工具 action 的字面量类型。 */
export type ToolAction = (typeof TOOL_SURFACE.actions)[number]

/**
 * 一个能力声明的**全部对外名称**（主名称 ∪ 次要名称）。
 *
 * 单独抽出来是因为「注册面 ⊃ 清单」与「清单 ⊃ 注册」两侧都必须用同一个
 * 并集口径比对；任何一侧漏掉 `exposedAlsoAs` 都会让多暴露路径的能力
 * 被误报成缺口。
 */
export function exposedNamesOf(record: CapabilityRecord): string[] {
  const names: string[] = []
  if (typeof record.exposedAs === 'string' && record.exposedAs !== '') names.push(record.exposedAs)
  for (const extra of record.exposedAlsoAs ?? []) {
    if (extra !== '' && !names.includes(extra)) names.push(extra)
  }
  return names
}

/** 图里所有能力声明的对外名称集合。 */
export function declaredExposedNames(graph: CapabilityGraph): Set<string> {
  const out = new Set<string>()
  for (const record of graph.all()) {
    for (const name of exposedNamesOf(record)) out.add(name)
  }
  return out
}

/** 图里所有能力声明的宿主服务依赖（inject 面）。 */
export function declaredHostServices(graph: CapabilityGraph): Set<string> {
  const out = new Set<string>()
  for (const record of graph.all()) {
    for (const service of record.hostServices ?? []) out.add(service)
  }
  return out
}
