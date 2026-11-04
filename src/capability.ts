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
  /** 暴露时的名称（工具名 / 远程方法名）。 */
  exposedAs?: string
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
