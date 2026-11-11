/**
 * 布局投影 —— 分层 / 环形的**确定性坐标**与用户拖拽偏移的叠加。
 *
 * ## 为什么从 graph-model.ts 抽出来（v0.16 复杂度门禁）
 *
 * 布局与「图例词汇」是两件正交的事：布局回答「节点画在哪」，词汇回答
 * 「它长什么样」。此前它们在同一个 700 行模块里，改一个图例计数也要
 * 穿过整段几何推导。拆出来后：
 * - 本文件只依赖 shared 契约与视口类型，**不 import graph-model**（否则
 *   形成值环：model 为了让旧调用方继续可用会 re-export 本文件）；
 * - `NODE_WIDTH/HEIGHT` 的唯一来源仍是 shared 的 `LAYOUT` —— 这里只是
 *   本地取一次，不复制数字。
 *
 * 纪律与 model 相同：纯函数、无 React / DOM / host 依赖，可逐字节断言。
 */
import type { GraphEdge, GraphNode } from '../../shared/graph-contract.ts'
import { LAYOUT } from '../../shared/graph-contract.ts'
import type { Point } from './viewport.ts'

/**
 * 节点尺寸直接取宿主布局常量。
 *
 * 为什么不再各自写死 200×56：命中测试（客户端）与布局（宿主）一旦用了
 * 不同的尺寸，点击热区就会与卡片错位 —— 而且错位量随主题字号变化，
 * 属于「偶发点不中」这类最难复现的缺陷。单一来源 = 不可能错位。
 */
export const NODE_WIDTH = LAYOUT.nodeWidth
export const NODE_HEIGHT = LAYOUT.nodeHeight

/** 布局口径 —— 分层（宿主投影）与环形（客户端闭式投影）。 */
export type LayoutMode = 'layered' | 'radial'

/** 环形布局的常数：卡片之间留出的最小间隔。 */
const RADIAL_GAP = 28
const RADIAL_RING_GAP = NODE_HEIGHT + 40

/**
 * 环形布局 —— 分层列 = 同心环，列内按 label 字典序均匀铺在环上。
 *
 * 为什么是闭式而不是力导向：力导向在几十节点规模上抖动，且同一份数据
 * 两次渲染位置不同 —— 白盒无法逐字节比对，用户每次刷新都会「图变了」。
 * 环形与分层一样是**确定性投影**：同输入 → 同输出（已由测试钉死）。
 *
 * 半径下界由**弦长**推出：环上相邻两点的弦长必须容下一张卡片，
 * 否则卡片沿环互相叠压（`(w+gap) / (2·sin(π/n))`）。
 */
export function radialPositions(nodes: readonly GraphNode[]): Record<string, Point> {
  const groups = new Map<number, GraphNode[]>()
  for (const node of nodes) {
    const list = groups.get(node.column) ?? []
    list.push(node)
    groups.set(node.column, list)
  }
  const columns = [...groups.keys()].sort((a, b) => a - b)
  const out: Record<string, Point> = {}
  let previousRadius = -1
  let maxRadius = 0
  for (const column of columns) {
    const ring = [...(groups.get(column) ?? [])].sort(
      (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    )
    const count = ring.length
    const needed = count < 2 ? 0 : (NODE_WIDTH + RADIAL_GAP) / (2 * Math.sin(Math.PI / count))
    const radius = previousRadius < 0 ? needed : Math.max(needed, previousRadius + RADIAL_RING_GAP)
    // 奇偶列的角度相位错开半个步长：相邻两环的节点不会沿同一半径「排成一条线」，
    // 环间的边因此不会与穿过圆心的射线重合（否则视觉上像一根粗轴）。
    const step = (2 * Math.PI) / Math.max(count, 1)
    const phase = -Math.PI / 2 + (column % 2 === 0 ? 0 : step / 2)
    ring.forEach((node, index) => {
      const angle = phase + step * index
      out[node.id] = {
        x: radius * Math.cos(angle) - NODE_WIDTH / 2,
        y: radius * Math.sin(angle) - NODE_HEIGHT / 2,
      }
    })
    previousRadius = radius
    maxRadius = Math.max(maxRadius, radius)
  }
  // 平移到正坐标区：与分层布局的坐标系一致（fit/clamp 的推导都假设 padding 在前），
  // 否则第一次 fit 会把负坐标的一半内容算到视口外。
  const shiftX = maxRadius + NODE_WIDTH / 2 + LAYOUT.padding
  const shiftY = maxRadius + NODE_HEIGHT / 2 + LAYOUT.padding
  for (const id of Object.keys(out)) {
    out[id] = { x: (out[id]?.x ?? 0) + shiftX, y: (out[id]?.y ?? 0) + shiftY }
  }
  return out
}

/** 布局紧凑化的宽度阈值：低于它按比例压缩**间距**（不是卡片尺寸）。 */
export const COMPACT_WIDTH_THRESHOLD = 900
/** 间距压缩系数：0.8 时列间仍留 8px、行间仍留 4.8px（见 LAYOUT 常量）。 */
export const COMPACT_SPACING_FACTOR = 0.8

/**
 * 容器宽度 → 间距压缩系数。
 *
 * 为什么需要自适应：宿主布局的列距/行距是固定常量（260/76），在 730px
 * 的窄图谱区里三列就占 780px，fit 后文字必然被压到可读线以下。压缩的是
 * **节点之间的空白**，不是卡片尺寸 —— 卡片保持 200×56，命中测试/小地图/
 * 拖拽语义全都不变；0.8 的取值保证列间与行间仍为正间隔（不重叠）。
 */
export function layoutSpacingFactor(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1
  return viewportWidth < COMPACT_WIDTH_THRESHOLD ? COMPACT_SPACING_FACTOR : 1
}

/**
 * 按系数压缩布局坐标的**间距部分**（相对左上角），保持顺序不变。
 *
 * 只压缩坐标范围，不缩放卡片尺寸：`x' = minX + (x − minX) × factor`。
 * factor=1 逐字节返回原坐标（宽屏零变化），因此布局仍是确定性投影。
 */
export function compactLayoutPositions(
  positions: Record<string, Point>,
  factor: number,
): Record<string, Point> {
  const ids = Object.keys(positions)
  if (ids.length === 0) return positions
  const safe = Number.isFinite(factor) && factor > 0 && factor <= 1 ? factor : 1
  if (safe === 1) return positions
  let minX = Infinity
  let minY = Infinity
  for (const id of ids) {
    minX = Math.min(minX, positions[id]?.x ?? 0)
    minY = Math.min(minY, positions[id]?.y ?? 0)
  }
  const out: Record<string, Point> = {}
  for (const id of ids) {
    const point = positions[id] ?? { x: 0, y: 0 }
    out[id] = { x: minX + (point.x - minX) * safe, y: minY + (point.y - minY) * safe }
  }
  return out
}

/**
 * 分层布局的**一阶重心排序**（barycenter）—— 减少同列内的边交叉。
 *
 * 宿主给的 y 是按能力域固定顺序排的，与谁连向谁无关：跨列长边因此
 * 频繁穿过同列卡片。这里做一次**向下单向**的重心扫描：
 *
 * 1. 每个节点的锚 = 其**上游**（column 更小的列）邻居当前 y 的均值；
 *    没有上游邻居则用自身 y（孤立节点不该被邻居算法丢到列首）；
 * 2. 同列按 (锚, 原 y, id) 排序 —— 三级键保证**完全确定**，不含随机；
 * 3. 把该列**原有的 y 槽位**按排序结果重新分配（不改变列内卡片间距）。
 *
 * 为什么是**向下单向**而不是两边同时重排：左右两列同时按对方重心重排，
 * 会收敛到「整体反向」的自洽解 —— 交叉数一点没少（对称重排的交叉数
 * 不变）。固定上游、只排下游，才是标准的一阶 barycenter 降交叉。
 *
 * 为什么只做一阶（一遍）而不是迭代到收敛：迭代版会让同一份数据在不同
 * 渲染次数下收敛到不同局部最优（浮点累加顺序敏感），违反「布局必须是
 * 确定性投影」的铁律；一阶已经能消掉「相邻两列反向配对」这类主要交叉。
 */
export function layeredBarycentric(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Record<string, Point> {
  const columns = new Map<number, GraphNode[]>()
  for (const node of nodes) {
    const list = columns.get(node.column) ?? []
    list.push(node)
    columns.set(node.column, list)
  }
  // 先建 id→node 索引：在边循环里 `nodes.find` 是 O(E·V)，本仓库已为同款
  // 扫描写过两次实测债注释（connectedComponents / buildNodeIndex）。
  const index = new Map(nodes.map((node) => [node.id, node]))
  // 锚只取**上游**邻居（column 更小）：固定上游、排下游才不会对称抵消。
  const sum = new Map<string, number>()
  const count = new Map<string, number>()
  for (const edge of edges) {
    const from = index.get(edge.from)
    const to = index.get(edge.to)
    if (from === undefined || to === undefined) continue
    if (to.column > from.column) {
      sum.set(to.id, (sum.get(to.id) ?? 0) + from.y)
      count.set(to.id, (count.get(to.id) ?? 0) + 1)
    } else if (from.column > to.column) {
      sum.set(from.id, (sum.get(from.id) ?? 0) + to.y)
      count.set(from.id, (count.get(from.id) ?? 0) + 1)
    }
  }
  const anchorOf = (node: GraphNode): number => {
    const links = count.get(node.id) ?? 0
    return links > 0 ? (sum.get(node.id) ?? node.y) / links : node.y
  }
  const out: Record<string, Point> = {}
  for (const [, group] of columns) {
    // 槽位 = 该列已有 y 的升序（host 的确定性投影，不改间距）。
    const slots = group.map((node) => node.y).sort((a, b) => a - b)
    const ordered = [...group].sort((a, b) => {
      return anchorOf(a) - anchorOf(b) || a.y - b.y || a.id.localeCompare(b.id)
    })
    ordered.forEach((node, index) => {
      out[node.id] = { x: node.x, y: slots[index] ?? node.y }
    })
  }
  return out
}

/** 布局投影：分层走重心重排（可选边集；省略边 = 保持宿主原序），环形现算。 */
export function layoutPositionsOf(
  nodes: readonly GraphNode[],
  mode: LayoutMode,
  edges: readonly GraphEdge[] = [],
): Record<string, Point> {
  if (mode === 'radial') return radialPositions(nodes)
  if (edges.length === 0) {
    const identity: Record<string, Point> = {}
    for (const node of nodes) identity[node.id] = { x: node.x, y: node.y }
    return identity
  }
  return layeredBarycentric(nodes, edges)
}

/**
 * 把布局投影与用户拖拽偏移叠加成实际坐标。
 *
 * 叠加层而不是「改布局」：布局是数据的确定性投影，用户调整是**视图事实**，
 * 轮询刷新数据时不得重置（CLAUDE.md 铁律）。偏移只在用户拖动后存在，
 * 且按布局分档记忆（拖拽语义见 graph-interaction.ts）。
 */
export function withLayout(
  nodes: readonly GraphNode[],
  positions: Record<string, Point>,
  offsets: Record<string, Point>,
): GraphNode[] {
  return nodes.map((node) => {
    const base = positions[node.id] ?? { x: node.x, y: node.y }
    const offset = offsets[node.id]
    return {
      ...node,
      x: offset ? base.x + offset.x : base.x,
      y: offset ? base.y + offset.y : base.y,
    }
  })
}