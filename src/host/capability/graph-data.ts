import type { CapabilityRecord } from './capability.ts'
import type { GuardStage } from '../core/lifecycle.ts'

/**
 * 图谱数据模型 —— 面板里那张可交互图的数据契约。
 *
 * 三条设计约束
 * ------------
 * 1. **图是投影，不是真相**：节点/边由能力图与生命周期状态**导出**，
 *    不额外维护一份手写拓扑。手写拓扑必然与实现漂移。
 * 2. **颜色不是唯一通道**：每个节点带 `shape` 与 `label`，
 *    形状与文字承载同样的信息，灰度打印与色盲模式下仍可读。
 * 3. **诚实边界**：没有数据就不画。没有 testReport 不画健康环；
 *    没有崩溃记录就不画崩溃节点 —— 缺席与「值为零」是两件事。
 *
 * 布局算法
 * --------
 * 采用**分层布局（按阶段分列）**而非力导向：
 *
 * - 能力图是**有向无环**的（能力图无环：生产者→消费者不构成回边），
 *   分层布局直接对应语义（列 = 生命周期阶段）。
 * - 力导向在 20~60 节点规模上抖动且不可复现（同一数据两次渲染位置不同），
 *   白盒可审计要求**确定性**：同样的输入必须得到同样的图。
 * - 复杂度 O(V + E)，力导向是 O(iterations × V²)。
 *
 * 节点位置的算法细节见 `layoutGraph`。
 */

// 图契约（节点/边/图/布局常量/阶段标签）来自**跨运行时定义层**：
// client 也要用这些词汇，若定义在 host 就会让浏览器 bundle 反向依赖宿主实现
// （v0.15 边界契约测试：client 不得 import src/host/**）。
import {
  ALL_STAGES,
  LAYOUT,
  STAGE_LABELS,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  type GraphShape,
  type GraphTone,
} from '../../shared/graph-contract.ts'
export {
  LAYOUT,
  STAGE_LABELS,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  type GraphShape,
  type GraphTone,
}

/**
 * 阶段 → 列序（本文件私有的布局顺序，不是契约）。
 *
 * 注意：`STAGE_LABELS` 与 `ALL_STAGES` 已下沉到 `shared/graph-contract.ts`
 * （client 也要用同一份词汇），这里**只在上面 re-export，不再本地定义**
 * —— 两份定义必然漂移（本项目已多次因「两处各写一份」踩坑）。
 */
const STAGE_ORDER: GuardStage[] = [...ALL_STAGES]

/** 能力 → 形状。不同职责面用不同形状，避免只靠颜色区分。 */
const CAPABILITY_SHAPES: Record<string, GraphShape> = {
  'guard.observe': 'circle',
  'guard.decide': 'diamond',
  'guard.recover': 'triangle',
  'guard.present': 'square',
  'guard.govern': 'hexagon',
  'guard.tool': 'circle',
}

/** 能力 → 语义色。 */
const CAPABILITY_TONES: Record<string, GraphNode['tone']> = {
  'guard.observe': 'info',
  'guard.decide': 'warn',
  'guard.recover': 'success',
  'guard.present': 'neutral',
  'guard.govern': 'neutral',
  'guard.tool': 'info',
}

/**
 * 从能力图导出图数据。
 *
 * @param records 能力记录
 * @param edges 能力之间的生产/消费边
 * @param extras 额外节点（指标、嫌疑插件、缺口）
 */
export function buildGraphData(
  records: readonly CapabilityRecord[],
  edges: ReadonlyArray<{ from: string; to: string; kind?: GraphEdge['kind'] }>,
  extras: GraphNode[] = [],
): GraphData {
  const nodes: GraphNode[] = []
  for (const record of records) {
    const domain = record.id.split('.').slice(0, 2).join('.')
    nodes.push({
      id: record.id,
      kind: 'capability',
      label: record.title,
      detail: record.summary,
      shape: CAPABILITY_SHAPES[domain] ?? 'circle',
      tone: CAPABILITY_TONES[domain] ?? 'neutral',
      x: 0,
      y: 0,
      column: 0,
      weight: record.exposed ? 1 : 0,
      ref: record.id,
      domain,
    })
  }
  nodes.push(...extras)

  const graphEdges: GraphEdge[] = edges.map((edge, index) => ({
    id: `e${index}`,
    from: edge.from,
    to: edge.to,
    kind: edge.kind ?? 'produces',
    tone: 'neutral',
  }))

  const columns = STAGE_ORDER.map((stage, index) => ({
    index,
    label: STAGE_LABELS[stage],
    stage,
  }))

  return layoutGraph({ nodes, edges: graphEdges, columns })
}

/**
 * 分层布局 —— 按列排布，列内按语义分组。
 *
 * 算法（确定性）：
 * 1. 每个节点按其语义归属定列（能力按阶段，指标/插件按类型）。
 * 2. 列内按 `label` 字典序排序 —— 保证同一数据两次布局完全一致。
 * 3. 行号 = 列内序号，y = padding + 序号 × rowGap。
 * 4. x = padding + 列号 × columnGap。
 *
 * 复杂度 O(V log V)（排序主导），对 200 节点仍 < 1ms。
 */
export function layoutGraph(graph: { nodes: GraphNode[]; edges: GraphEdge[]; columns: Array<{ index: number; label: string; stage?: GuardStage }> }): GraphData {
  const columnOf = new Map<string, number>()
  for (const column of graph.columns) columnOf.set(column.label, column.index)

  // 按节点 kind 分列：只有能力节点归入其阶段列，其余（指标/插件/缺口/阶段）
  // 统一进入末尾的「附加」列。此前写成四个 else-if 分支各赋同一个值 ——
  // 等价但读起来像有区别，下一个维护者会以为漏了分支而「补全」它。
  const auxiliaryColumn = graph.columns.length
  const groups = new Map<number, GraphNode[]>()
  for (const node of graph.nodes) {
    const stage = node.kind === 'capability' && node.ref ? stageOfCapability(node.ref) : undefined
    const column = stage === undefined ? auxiliaryColumn : (columnOf.get(STAGE_LABELS[stage]) ?? auxiliaryColumn)
    const list = groups.get(column) ?? []
    list.push(node)
    groups.set(column, list)
  }

  // 就地写入坐标：调用方拿到的是同一批节点对象（client 依赖这一身份），
  // 因此这里不复制节点 —— 复制会让「先布局再画」出现两份真相。
  for (const [column, list] of groups) {
    list.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    list.forEach((node, index) => {
      node.column = column
      node.x = LAYOUT.padding + column * LAYOUT.columnGap
      node.y = LAYOUT.padding + index * LAYOUT.rowGap
    })
  }

  const bounds = computeBounds(graph.nodes)
  return { nodes: graph.nodes, edges: graph.edges, bounds, columns: graph.columns }
}

/** 能力 id → 阶段（由 id 的域推断；具体阶段由注册处补齐，这里只作布局分组）。 */
function stageOfCapability(id: string): GuardStage | undefined {
  if (id.startsWith('guard.observe')) return 'monitoring'
  if (id.startsWith('guard.decide')) return 'deciding'
  if (id.startsWith('guard.recover')) return 'stabilizing'
  if (id.startsWith('guard.present')) return 'monitoring'
  if (id.startsWith('guard.govern')) return 'recovered'
  if (id.startsWith('guard.tool')) return 'monitoring'
  return undefined
}

/** 计算图边界。 */
export function computeBounds(nodes: readonly GraphNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + LAYOUT.nodeWidth)
    maxY = Math.max(maxY, node.y + LAYOUT.nodeHeight)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 邻接查询 —— 找出与某节点直接相连的所有边。
 *
 * 用 Map 索引（节点 id → 边下标），避免每次渲染 O(E) 扫描。
 */
export function buildAdjacency(edges: readonly GraphEdge[]): {
  outgoing: Map<string, GraphEdge[]>
  incoming: Map<string, GraphEdge[]>
} {
  const outgoing = new Map<string, GraphEdge[]>()
  const incoming = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    const out = outgoing.get(edge.from) ?? []
    out.push(edge)
    outgoing.set(edge.from, out)
    const inc = incoming.get(edge.to) ?? []
    inc.push(edge)
    incoming.set(edge.to, inc)
  }
  return { outgoing, incoming }
}

/**
 * 邻接矩阵的可视化摘要 —— 回答「这张图连得通吗」。
 *
 * 用**弱连通分量**（并查集）而不是强连通分量：用户关心的是
 * 「这些能力是不是一坨孤立的碎片」，而不是「有没有环」。
 *
 * 复杂度 O(V + E · α(V))。
 */
export function connectedComponents(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): {
  count: number
  largest: number
  isolated: string[]
} {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    // 路径压缩
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) ?? root
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const node of nodes) parent.set(node.id, node.id)
  for (const edge of edges) {
    if (parent.has(edge.from) && parent.has(edge.to)) union(edge.from, edge.to)
  }
  const sizes = new Map<string, number>()
  for (const node of nodes) {
    const root = find(node.id)
    sizes.set(root, (sizes.get(root) ?? 0) + 1)
  }
  // 孤立判定用邻接索引（O(V + E)）。此前对每个节点做 `edges.some(...)`，
  // 是 O(V·E) 的实测债 —— 节点数一涨，面板每次轮询都要重算全图。
  const { outgoing, incoming } = buildAdjacency(edges)
  const isolated = nodes
    .filter((n) => (outgoing.get(n.id)?.length ?? 0) === 0 && (incoming.get(n.id)?.length ?? 0) === 0)
    .map((n) => n.id)
  return {
    count: sizes.size,
    largest: sizes.size === 0 ? 0 : Math.max(...sizes.values()),
    isolated,
  }
}
