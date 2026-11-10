/**
 * 图谱结构分析（v0.13 T11-08/09）—— 把「看连得通不通」升级为「看得懂结构」。
 *
 * ## 为什么需要这一层
 *
 * 现状：图谱能画、能缩放、能看邻居，但用户读不出**结构性问题**：
 * - 哪个能力是「枢纽」（删掉它断一大片）？
 * - 哪条链路是「主路径」（从能力到事实的最短因果）？
 * - 谁只生产不消费、谁只消费不生产？
 *
 * 这些问题靠肉眼数边是数不出来的，必须用图算法算。
 *
 * ## 选型（与 03 号文档的选型纪律一致）
 *
 * | 分析 | 算法 | 复杂度 | 为什么不用更"高级"的 |
 * |---|---|---|---|
 * | 度数（扇入/扇出） | 单遍计数 | O(E) | 已经够回答「谁最忙」 |
 * | 枢纽识别 | 度数排序 | O(V log V) | 中介数中心性要 O(V·E)，20~60 节点下收益不抵复杂度 |
 * | 可达性 | BFS | O(V + E) | 传递闭包是 O(V³)，且会退化成稠密矩阵 |
 * | 影响面 | 反向 BFS | O(V + E) | 与正向同一套原语 |
 * | 主路径 | BFS 最短路径 | O(V + E) | 所有路径枚举是指数级 |
 *
 * **确定性**：所有输出按 id 字典序兜底排序，保证同数据同结果（白盒可审计的前提）。
 *
 * ## 诚实边界
 *
 * - 空图 ⇒ 返回空结论，不伪造「0 个枢纽」（0 与「没有」是两件事）。
 * - 不可达 ⇒ `null`，不是空数组（空数组会被读成「没有路径」而不是「没算出来」）。
 * - 自环不计入度数：`produces` 自指在能力图里是数据错误，不是强连接。
 */

import type { GraphEdge, GraphNode } from '../../shared/graph-contract.ts'

/** 一个节点的度数摘要。 */
export interface NodeDegree {
  id: string
  label: string
  /** 入边数（谁指向我）。 */
  inDegree: number
  /** 出边数（我指向谁）。 */
  outDegree: number
  /** 总度数（扇入 + 扇出）。 */
  total: number
  /**
   * 结构角色：
   * - `source`：只出不进（生产者）
   * - `sink`：只进不出（消费者）
   * - `hub`：进出都多（枢纽）
   * - `isolated`：无边
   * - `middle`：普通中间节点
   */
  role: 'source' | 'sink' | 'hub' | 'isolated' | 'middle'
}

/** 结构分析结果。 */
export interface GraphStructure {
  /** 按总度数降序的节点度数（含角色判定）。 */
  degrees: NodeDegree[]
  /** 枢纽：总度数 ≥ 2 且进出都非零，按度数降序取前 N。 */
  hubs: NodeDegree[]
  /** 只生产不消费的节点（可能过度生产）。 */
  sources: NodeDegree[]
  /** 只消费不生产的节点（可能消费断链）。 */
  sinks: NodeDegree[]
  /** 孤立节点（无边）。 */
  isolated: NodeDegree[]
  /** 总边数（已去自环）。 */
  edgeCount: number
  /** 是否为空图（区分「没有结构问题」与「没有图」）。 */
  empty: boolean
}

/**
 * 计算节点度数 + 结构角色。O(V + E)。
 *
 * @param hubThreshold 枢纽的最小总度数（默认 3：进 1 出 2 这种单线不算枢纽）
 */
export function analyzeStructure(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  hubThreshold = 3,
): GraphStructure {
  const inCount = new Map<string, number>()
  const outCount = new Map<string, number>()
  const known = new Set(nodes.map((n) => n.id))
  let edgeCount = 0
  for (const edge of edges) {
    // 自环不计度数：能力图里的自指是数据错误，计入会让节点凭自环变成"枢纽"。
    if (edge.from === edge.to) continue
    // 端点必须存在：幽灵边（节点被过滤掉但边还在）不能让不存在的节点进排名。
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    edgeCount += 1
    outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1)
    inCount.set(edge.to, (inCount.get(edge.to) ?? 0) + 1)
  }

  const degrees: NodeDegree[] = nodes.map((node) => {
    const inDegree = inCount.get(node.id) ?? 0
    const outDegree = outCount.get(node.id) ?? 0
    const total = inDegree + outDegree
    const role: NodeDegree['role'] =
      total === 0
        ? 'isolated'
        : inDegree > 0 && outDegree > 0
          ? total >= hubThreshold
            ? 'hub'
            : 'middle'
          : outDegree > 0
            ? 'source'
            : 'sink'
    return { id: node.id, label: node.label, inDegree, outDegree, total, role }
  })

  degrees.sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))

  return {
    degrees,
    hubs: degrees.filter((d) => d.role === 'hub'),
    sources: degrees.filter((d) => d.role === 'source'),
    sinks: degrees.filter((d) => d.role === 'sink'),
    isolated: degrees.filter((d) => d.role === 'isolated'),
    edgeCount,
    empty: nodes.length === 0,
  }
}

/**
 * 从 `from` 出发的可达节点集（BFS，不含自身）。
 *
 * O(V + E)。返回 `null` 表示起点不在图里 —— 与「可达集为空」区分开：
 * 前者是「问错了」，后者是「确实没有下游」。
 */
export function reachableFrom(
  from: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Set<string> | null {
  if (!nodes.some((n) => n.id === from)) return null
  const known = new Set(nodes.map((n) => n.id))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    const list = outgoing.get(edge.from) ?? []
    list.push(edge.to)
    outgoing.set(edge.from, list)
  }
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const next of outgoing.get(cur) ?? []) {
      if (seen.has(next) || next === from) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/**
 * 影响面：改变 `target` 会波及谁（反向可达）。
 *
 * 这是「不要动这个节点」的证据 —— 上游越多，改它的代价越大。O(V + E)。
 * 返回 `null` 表示目标不在图里。
 */
export function impactedBy(
  target: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Set<string> | null {
  if (!nodes.some((n) => n.id === target)) return null
  const known = new Set(nodes.map((n) => n.id))
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    const list = incoming.get(edge.to) ?? []
    list.push(edge.from)
    incoming.set(edge.to, list)
  }
  const seen = new Set<string>()
  const queue = [target]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const prev of incoming.get(cur) ?? []) {
      if (seen.has(prev) || prev === target) continue
      seen.add(prev)
      queue.push(prev)
    }
  }
  return seen
}

/**
 * 两节点间的最短路径（BFS，边数最少）。O(V + E)。
 *
 * 返回 `null` 表示不可达或端点不存在 —— 与「空路径」区分。
 * 路径含首尾两端；同节点 ⇒ `[id]`。
 */
export function shortestPath(
  from: string,
  to: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): string[] | null {
  const known = new Set(nodes.map((n) => n.id))
  if (!known.has(from) || !known.has(to)) return null
  if (from === to) return [from]
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    const list = outgoing.get(edge.from) ?? []
    list.push(edge.to)
    outgoing.set(edge.from, list)
  }
  const parent = new Map<string, string>()
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const next of outgoing.get(cur) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      parent.set(next, cur)
      if (next === to) {
        const path = [to]
        let step = to
        while (step !== from) {
          const prev = parent.get(step)
          if (prev === undefined) return null
          path.unshift(prev)
          step = prev
        }
        return path
      }
      queue.push(next)
    }
  }
  return null
}

/**
 * 结构洞察摘要 —— 供面板一行行渲染（每条都是一个可核对的结论）。
 *
 * 诚实边界：空图返回 `[]`（而不是「一切正常」的假结论）。
 */
export function structureInsights(structure: GraphStructure): string[] {
  if (structure.empty) return []
  const out: string[] = []
  if (structure.hubs.length > 0) {
    const top = structure.hubs[0] as NodeDegree
    out.push(`枢纽 ${structure.hubs.length} 个，最高为 ${top.label}（进 ${top.inDegree} / 出 ${top.outDegree}）`)
  }
  if (structure.sources.length > 0) {
    out.push(`只生产不消费 ${structure.sources.length} 个：${structure.sources.slice(0, 3).map((d) => d.label).join('、')}`)
  }
  if (structure.sinks.length > 0) {
    out.push(`只消费不生产 ${structure.sinks.length} 个：${structure.sinks.slice(0, 3).map((d) => d.label).join('、')}`)
  }
  if (structure.isolated.length > 0) {
    out.push(`孤立节点 ${structure.isolated.length} 个：${structure.isolated.slice(0, 3).map((d) => d.label).join('、')}`)
  }
  out.push(`共 ${structure.edgeCount} 条边`)
  return out
}
