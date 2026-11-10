/**
 * 图谱视图模型 —— 全部**纯函数**，图谱组件只负责把结果画出来。
 *
 * 为什么把逻辑从 GuardGraph.tsx 抽到这里
 * ------------------------------------
 * 组件里的交互逻辑有三个测不到的缺陷形态，它们在浏览器里表现为「图看起来
 * 有点怪」，而不是任何断言失败：
 *
 * 1. **过滤与边不共源**：按类型隐藏节点时，若边仍按**未过滤**的端点表渲染，
 *    就会出现「连到幽灵节点的边」；反过来若用过滤后的节点表判断端点，
 *    一条两端都可见的边会因为第三方类型被隐藏而消失。过滤必须**一次性**
 *    同时产出节点集与边集（`filterGraph`）。
 * 2. **布局不是确定性投影**：力导向在同一份数据上两次渲染位置不同，
 *    白盒无法比对；环形布局必须是「同输入同输出」的闭式函数。
 * 3. **曲线边的标签锚点重算**：控制点被算了两次（一次画路径、一次算标签），
 *    两次参数一旦漂移，标签就会离开曲线（实测过）。几何一次算清（`edgeGeometry`）。
 *
 * 本文件只认数字与字符串：不 import React，不碰 DOM，因此能在无浏览器环境
 * 逐条断言（见 tests/client/graph-model.test.ts）。
 */
import type { GraphEdge, GraphNode, GraphNodeKind } from '../../src/capability/graph-data.ts'
import { LAYOUT } from '../../src/capability/graph-data.ts'
import {
  clipToRect,
  curveControl,
  curveEdgePath,
  midpointOfQuadratic,
  parallelCurvature,
  parallelIndexes,
  traceFrom,
  type Point,
  type Rect,
} from './viewport.ts'

/**
 * 节点尺寸直接取宿主布局常量。
 *
 * 为什么不再各自写死 200×56：命中测试（客户端）与布局（宿主）一旦用了
 * 不同的尺寸，点击热区就会与卡片错位 —— 而且错位量随主题字号变化，
 * 属于「偶发点不中」这类最难复现的缺陷。单一来源 = 不可能错位。
 */
export const NODE_WIDTH = LAYOUT.nodeWidth
export const NODE_HEIGHT = LAYOUT.nodeHeight

/** 视口高度：宽形态给足纵向空间，窄形态（侧栏/分屏）收紧避免吃掉列表。 */
export const VIEWPORT_HEIGHT_WIDE = 460
export const VIEWPORT_HEIGHT_NARROW = 340

/** 节点拖动阈值（屏幕像素）：超过才算拖拽，否则视为点击。 */
export const DRAG_THRESHOLD = 3

/**
 * 类型图例顺序 —— 固定顺序而非「按出现顺序」：图例是一块位置记忆，
 * 每次轮询重排会让用户的肌肉记忆失效。
 */
export const KIND_ORDER: readonly GraphNodeKind[] = ['capability', 'stage', 'metric', 'bundle', 'gap']

/** 节点类型的文案键（走 i18n，英文界面也要可读）。 */
export function kindKey(kind: GraphNodeKind): string {
  return `graph.kind.${kind}`
}

/** 语义色 → 主题变量（硬编码颜色只允许出现在 SVG 图形本身）。 */
export const TONE_COLOR: Record<GraphNode['tone'], string> = {
  neutral: 'var(--dsw-alias-label-secondary)',
  info: 'var(--dsw-alias-brand-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
}

/**
 * 着色口径 —— 用户可以在「按语义色 / 按类型 / 按阶段」之间切换。
 *
 * 为什么把「按类型」单独给一套色：节点的 shape 已经编码了类型，
 * 而 tone 编码的是风险语义。同一个颜色通道被两种口径争用时，用户会
 * 误读（把「缺口=红」当成「这个能力有风险」）。口径显式化后，图例的
 * 颜色只承诺一件事。
 */
export type ColorMode = 'tone' | 'kind' | 'stage'

/** 类型口径的配色（与 tone 口径不同：这里只回答「它是什么」）。 */
export const KIND_COLOR: Record<GraphNodeKind, string> = {
  capability: 'var(--dsw-alias-brand-primary)',
  stage: 'var(--dsw-alias-state-business-primary)',
  metric: 'var(--dsw-alias-state-warn-primary)',
  bundle: 'var(--dsw-alias-label-secondary)',
  gap: 'var(--dsw-alias-state-error-primary)',
}

/**
 * 阶段口径的配色 —— 生命周期六阶段。
 *
 * 为什么不用渐变色阶：阶段是**离散类别**，渐变会暗示「阶段 3 与阶段 4
 * 更接近」这种不存在的关系（它们是状态机上的不同状态，不是连续量）。
 */
export const STAGE_COLOR: Record<string, string> = {
  idle: 'var(--dsw-alias-label-secondary)',
  monitoring: 'var(--dsw-alias-brand-primary)',
  crashed: 'var(--dsw-alias-state-error-primary)',
  deciding: 'var(--dsw-alias-state-warn-primary)',
  stabilizing: 'var(--dsw-alias-state-business-primary)',
  recovered: 'var(--dsw-alias-state-success-primary)',
}

/** 边的颜色：neutral 用描边色（它必须比节点弱），其余走语义色。 */
export function edgeColor(edge: Pick<GraphEdge, 'tone'>): string {
  return edge.tone === 'neutral' ? 'var(--dsw-alias-border-l3)' : TONE_COLOR[edge.tone]
}

/** 布局口径 —— 分层（宿主投影）与环形（客户端闭式投影）。 */
export type LayoutMode = 'layered' | 'radial'

/** 一个节点的着色键。 */
export function colorOf(node: GraphNode, mode: ColorMode, stageOf: (column: number) => string | undefined): string {
  if (mode === 'kind') return KIND_COLOR[node.kind]
  if (mode === 'stage') return STAGE_COLOR[stageOf(node.column) ?? ''] ?? TONE_COLOR.neutral
  return TONE_COLOR[node.tone]
}

/** 节点索引 —— 每个节点数组只建一次（在边的回调里重建是 O(E·V) 实测债）。 */
export function buildNodeIndex(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>()
  for (const node of nodes) map.set(node.id, node)
  return map
}

/** 命中测试用的节点形状（世界坐标 + 卡片尺寸）。 */
export function hitNodesOf(nodes: readonly GraphNode[]): Array<{ id: string; x: number; y: number; w: number; h: number }> {
  return nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, w: NODE_WIDTH, h: NODE_HEIGHT }))
}

/**
 * 图谱过滤 —— 类型隐藏 + 「只看选中节点的关联」两个条件**一次成型**。
 *
 * 为什么合成一个函数：节点集与边集必须来自同一次判定。任何「先过滤节点、
 * 再拿原边表过滤」的写法都会漏掉「端点是被隐藏类型」的情形，于是图上出现
 * 指向空气的箭头（v0.4 实测：隐藏缺口三角后仍有边连过去）。
 */
/**
 * 「只看关联」的范围档位。
 *
 * 为什么把档位做成枚举而不是数字输入框：数字输入要处理空值/负数/超大值，
 * 而用户的真实问题只有两个 —— 「谁直接连着我」（1 跳）与
 * 「我在这张图的哪个连通块里」（闭包）。2 跳是常用的中间档（链路排错）。
 * 档位到跳数的映射在 `linkRangeHops`，UI 只显示档位文案。
 */
export type LinkRange = 'hops1' | 'hops2' | 'closure'

/** 档位 → 跳数（闭包 = null，交给 `filterGraph` 走传递闭包）。 */
export function linkRangeHops(range: LinkRange): number | null {
  return range === 'closure' ? null : range === 'hops2' ? 2 : 1
}

export interface GraphFilter {
  /** 被隐藏的节点类型（空集 = 全显示）。 */
  hidden: ReadonlySet<string>
  /** 只保留与该节点双向可达的子图（null = 不过滤）。 */
  onlyConnectedWith: string | null
  /**
   * 「只看关联」的跳数上界（省略或 null = 传递闭包，即原有行为）。
   *
   * 为什么要上限：闭包在一张 40 节点的连通图上等于**不做任何过滤** ——
   * 用户点「只看关联」却看到整张图，那个开关就成了摆设。BFS 的
   * 「最少跳数」正好对应「直接相关」（1 跳＝邻居，2 跳＝邻居的邻居），
   * 所以 UI 缺省给 1 跳而不是闭包；闭包保留成一个显式档位。
   * 字段本身是**可选**的：省略 = 闭包 = 老行为，这样新增档位不会悄悄改变
   * 任何没有传该字段的调用方（旧测试与旧组件因此零改动仍然成立）。
   */
  maxHops?: number | null
}

export function filterGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  filter: GraphFilter,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // 可达集用**全部边**计算：关联性是图的客观事实，不该被当前的类型过滤改变，
  // 否则「只看关联」会在用户切换图例时改变含义（同一个开关两种语义）。
  // 档位缺省（省略 = undefined）走**闭包**，与新增该字段前的行为逐字节一致。
  const hops = filter.maxHops ?? null
  const linked =
    filter.onlyConnectedWith === null
      ? null
      : hops === null
        ? traceFrom(filter.onlyConnectedWith, edges, 'both')
        : kHopNeighborhood(filter.onlyConnectedWith, edges, hops)
  const keptNodes = nodes.filter(
    (node) => !filter.hidden.has(node.kind) && (linked === null || linked.has(node.id)),
  )
  const keptIndex = buildNodeIndex(keptNodes)
  const keptEdges = edges.filter((edge) => keptIndex.has(edge.from) && keptIndex.has(edge.to))
  return { nodes: keptNodes, edges: keptEdges }
}

/**
 * k 跳邻域 —— 从起点出发、双向、跳数不超过 k 的节点集（含起点自己）。
 *
 * 为什么不是 `traceFrom`（传递闭包）：闭包没有「远近」概念，在连通图上
 * 会把整张图收进来；分层 BFS 天然给出跳数，能按 k 截断。
 * 复杂度 **O(V + E)**：每个节点最多入队一次（visited 在入队时标记，
 * 不是出队时 —— 否则同一节点会按不同路径重复入队，退化成 O(E)×队列）。
 */
export function kHopNeighborhood(
  startId: string,
  edges: ReadonlyArray<{ from: string; to: string }>,
  hops: number,
): Set<string> {
  const visited = new Set<string>([startId])
  const depth = Math.floor(hops)
  if (!(depth > 0)) return visited
  const adjacency = new Map<string, string[]>()
  const push = (from: string, to: string): void => {
    const list = adjacency.get(from)
    if (list) list.push(to)
    else adjacency.set(from, [to])
  }
  for (const edge of edges) {
    // 双向：「谁生产给我」和「我生产给谁」都是关联，方向已由边粗细与箭头表达。
    push(edge.from, edge.to)
    push(edge.to, edge.from)
  }
  let frontier: string[] = [startId]
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
    // 提前收敛：图比 k 小，继续循环只是空转（几十节点规模上也省下分配）。
    if (frontier.length === 0) break
  }
  return visited
}

/** 世界边界（供 fit / 平移钳制）。空图返回零矩形而不是 ±Infinity。 */
export function graphBounds(nodes: readonly GraphNode[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + NODE_WIDTH)
    maxY = Math.max(maxY, node.y + NODE_HEIGHT)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/** 平行边曲率（同一对端点第 i 条边错开弯曲方向，方向可辨）。 */
export function edgeCurvatures(edges: readonly GraphEdge[]): number[] {
  const indexes = parallelIndexes(edges)
  return edges.map((_, index) => parallelCurvature(indexes[index] ?? 0))
}

/** 一条边的几何 —— 路径、标签锚点一次算清（控制点只求一次）。 */
export interface EdgeGeometry {
  /** SVG 路径（零曲率退化为直线）。 */
  path: string
  /** 曲线中点（标签锚点）；零曲率时为 null（直线不标方向文字，避免噪声）。 */
  labelAnchor: Point | null
}

export function edgeGeometry(from: GraphNode, to: GraphNode, curvature: number): EdgeGeometry {
  const fromRect = { x: from.x, y: from.y, w: NODE_WIDTH, h: NODE_HEIGHT }
  const toRect = { x: to.x, y: to.y, w: NODE_WIDTH, h: NODE_HEIGHT }
  const fromCentre = { x: from.x + NODE_WIDTH / 2, y: from.y + NODE_HEIGHT / 2 }
  const toCentre = { x: to.x + NODE_WIDTH / 2, y: to.y + NODE_HEIGHT / 2 }
  // 裁剪取**进入点**（见 viewport.clipToRect）：箭头贴卡片边缘，不扎进卡片中心。
  const start = clipToRect(fromCentre.x, fromCentre.y, toCentre.x, toCentre.y, toRect)
  const end = clipToRect(toCentre.x, toCentre.y, fromCentre.x, fromCentre.y, fromRect)
  const path = curveEdgePath(start.x, start.y, end.x, end.y, curvature)
  if (curvature === 0) return { path, labelAnchor: null }
  const control = curveControl(start.x, start.y, end.x, end.y, curvature)
  return { path, labelAnchor: midpointOfQuadratic(start.x, start.y, control.x, control.y, end.x, end.y) }
}

/** 度数：入 = 谁生产给我，出 = 我生产给谁。自环两侧都算（度数不是邻居）。 */
export function degreeOf(id: string, edges: readonly Pick<GraphEdge, 'from' | 'to'>[]): { in: number; out: number } {
  let incoming = 0
  let outgoing = 0
  for (const edge of edges) {
    if (edge.to === id) incoming += 1
    if (edge.from === id) outgoing += 1
  }
  return { in: incoming, out: outgoing }
}

/**
 * 全图度数表（id → 总度数），**一次遍历** O(V + E)。
 *
 * 为什么不要在渲染循环里逐条调 `degreeOf`：`degreeOf` 每次都是 O(E) 的扫描，
 * 在「每条边都要查端点度数」的循环里就是 O(V·E) —— 本仓库已为同款问题
 * 写过两次实测债注释（`connectedComponents` 的孤立判定、`buildNodeIndex`）。
 */
export function degreeTally(edges: readonly Pick<GraphEdge, 'from' | 'to'>[]): Map<string, number> {
  const tally = new Map<string, number>()
  for (const edge of edges) {
    tally.set(edge.from, (tally.get(edge.from) ?? 0) + 1)
    // 自环两端都记：度数表达「这条边连着谁」，与 `degreeOf` 的口径一致。
    tally.set(edge.to, (tally.get(edge.to) ?? 0) + 1)
  }
  return tally
}

/**
 * 一条边的「连接强度」= 两端点度数之和。
 *
 * 为什么不用单边（恒为 1）或只取一端的度数：一条边的重要程度由**两端合计**
 * 决定 —— 连到枢纽的那条线承载的关系，和两个孤立节点之间的线不是一回事。
 * 两端都是度 1 的叶子 ⇒ 和为 2，这正是本编码的下界（见 `maxEdgeDegreeSum`）。
 */
export function edgeDegreeSum(tally: ReadonlyMap<string, number>, edge: Pick<GraphEdge, 'from' | 'to'>): number {
  return (tally.get(edge.from) ?? 0) + (tally.get(edge.to) ?? 0)
}

/** 度数之和的下界：两个叶子（度各 1）相连。 */
export const EDGE_DEGREE_SUM_MIN = 2

/**
 * 视觉编码的参考上界（度数之和）。
 *
 * 为什么用**固定**参考而不是取「当前图上的最大值」：相对刻度会让每条边的
 * 粗细随数据变化整体重排 —— 轮询多来一条边，所有既有边的视觉含义都变了
 * （「粗线」不再对应「20 度枢纽」，而是「本图恰好最粗的那条」）。
 * 这与本仓库「布局必须是确定性投影」的同一条纪律冲突。
 * 固定刻度下「粗」在任何一张图上说的是同一件事；超过参考值的部分
 * 饱和在最粗档，这是**诚实的饱和**（精确度数仍在 tooltip 与详情侧栏里）。
 */
export const EDGE_DEGREE_SUM_MAX = 20

/**
 * 对数刻度归一化：`log1p(value) / log1p(domainMax)`，落在 [0,1]。
 *
 * 为什么必须对数而不是线性：枢纽节点（`guard.observe` 这种）度数能到 20+，
 * 而多数节点只有 1~2。线性映射下「最粗的那条线」会把其余全部压成细线，
 * 视觉差异恰好落在用户要看的那一段（1 与 2 的差别）上消失；
 * log1p 让 1→2 与 10→20 的视觉增量可比。
 *
 * 边界契约（两条都对应可测的缺陷形态）：
 * - `value ≤ 0` ⇒ 0：下界，绝不返回负数（负 stroke-width 在 SVG 里不渲染）。
 * - `domainMax ≤ 0` ⇒ 0：没有可比性时**不制造假差异**。
 * - 超出 domainMax ⇒ 1（饱和），由调用方负责把饱和说出来。
 */
export function logScale(value: number, domainMax: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (!Number.isFinite(domainMax) || domainMax <= 0) return 0
  return Math.min(1, Math.log1p(value) / Math.log1p(domainMax))
}

/** 边宽的下界（不得细过中性边的既有观感）与上界（粗到能压住卡片就是噪声）。 */
export const EDGE_WIDTH_MIN = 1.2
export const EDGE_WIDTH_MAX = 3.4

/**
 * 一条边的视觉宽度：强度**超出下界的部分** → 固定参考刻度 → [min,max] 像素。
 *
 * 两个设计决定，各自对应一个真实缺陷形态：
 * 1. **减去下界**而不是直接用原始值：归一化的自变量必须是「比最弱的连接强
 *    多少」。否则全图只有一条边时那条叶子线就是「最大值」，会被画成最粗
 *    （假信号 —— 用户会以为它是最重要的链路）。
 * 2. **参考上界固定**（`EDGE_DEGREE_SUM_MAX`）而不是取当前图最大值：相对刻度
 *    会让每条边的粗细随数据整体重排，轮询多一条边就改变所有既有线的含义。
 *    超过参考值的部分饱和在最粗档；精确度数在 tooltip 与详情侧栏始终可读，
 *    所以饱和丢失的不是事实，只是视觉分辨率。
 */
export function edgeWidthOf(
  tally: ReadonlyMap<string, number>,
  edge: Pick<GraphEdge, 'from' | 'to'>,
  referenceMax = EDGE_DEGREE_SUM_MAX,
  minPx = EDGE_WIDTH_MIN,
  maxPx = EDGE_WIDTH_MAX,
): number {
  const excess = edgeDegreeSum(tally, edge) - EDGE_DEGREE_SUM_MIN
  const domainExcess = referenceMax - EDGE_DEGREE_SUM_MIN
  const raw = minPx + (maxPx - minPx) * logScale(excess, domainExcess)
  // 显式夹回区间：`min + (max-min) * 1` 在浮点下会溢出上界
  // （1.2 + 2.2*1 = 3.4000000000000004）。差 4e-16 肉眼看不见，但「声明
  // 了上界就可能越界」这件事本身会让任何对上界做断言/取 max 的下游代码
  // 出错 —— 契约要在位的级别成立，否则它就不是契约。
  return Math.min(maxPx, Math.max(minPx, raw))
}

/**
 * 边的详情投影（v0.11.3 图谱交互补齐）。
 *
 * 为什么要一个纯函数而不是在组件里直接拼：边的语义（生产/消费方向 +
 * kind + label）在面板与测试里都要用同一套措辞；组件只负责把结果画出来，
 * 断言可以逐字节比对。端点不可见（类型被过滤）时返回 null —— 与
 * `neighborsOf` 的「不导航到幽灵节点」同一条纪律。
 */
export interface EdgeDetail {
  /** 生产方（箭头起点）的可读标签。 */
  fromLabel: string
  /** 消费方（箭头终点）的可读标签。 */
  toLabel: string
  /** 边上声明的语义类型。 */
  kind: GraphEdge['kind']
  /** 边上可选的说明文字（数据里可能有；没有就是 undefined）。 */
  label?: string
}

export function edgeDetailOf(
  edge: Pick<GraphEdge, 'from' | 'to' | 'kind' | 'label'>,
  index: ReadonlyMap<string, GraphNode>,
): EdgeDetail | null {
  const from = index.get(edge.from)
  const to = index.get(edge.to)
  if (!from || !to) return null
  return {
    fromLabel: from.label,
    toLabel: to.label,
    kind: edge.kind,
    ...(edge.label === undefined ? {} : { label: edge.label }),
  }
}

/**
 * 邻居派生 —— 上游（生产方）/ 下游（消费方）。
 *
 * 三条规则各自都有实测理由：
 * - **端点不在可见节点表里时不算邻居**（类型过滤后不能导航到幽灵）；
 * - **自环不算**（导航到自身没有意义）；
 * - **按 label 字典序排序**（稳定可比对，同数据两次渲染顺序一致）。
 */
export function neighborsOf(
  id: string,
  edges: readonly GraphEdge[],
  index: ReadonlyMap<string, GraphNode>,
): { upstream: string[]; downstream: string[] } {
  const upstream: string[] = []
  const downstream: string[] = []
  for (const edge of edges) {
    if (edge.to === id && edge.from !== id && index.has(edge.from)) upstream.push(edge.from)
    if (edge.from === id && edge.to !== id && index.has(edge.to)) downstream.push(edge.to)
  }
  const byLabel = (a: string, b: string): number =>
    (index.get(a)?.label ?? a).localeCompare(index.get(b)?.label ?? b) || a.localeCompare(b)
  return {
    upstream: [...new Set(upstream)].sort(byLabel),
    downstream: [...new Set(downstream)].sort(byLabel),
  }
}

/** 各类型的节点数（图例上带计数：用户不必先点开才知道那类有多少个）。 */
export function kindCounts(nodes: readonly GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1
  return counts
}

/**
 * 图例的着色随「着色口径」走（v0.11 P0 修复）。
 *
 * 为什么图例必须跟口径切换：此前图例圆点永远用 `dotToneOf`（语义色调色板），
 * 而节点在「按类型 / 按阶段」口径下用的是 KIND_COLOR / STAGE_COLOR ——
 * 同一个图例块在两种口径下说两种谎（图例显示灰、节点显示业务色）。
 * 图例是「颜色通道的字典」，字典必须和正文用同一套词典。
 *
 * 阶段口径的图例不在这里：图例按**节点类型**过滤（类型是开关维度），
 * 阶段是**着色维度**，两个维度正交 —— 阶段色含义由「按阶段」分段控件旁的
 * title 提示承载，不混进类型图例。
 */
export function legendColorOf(kind: GraphNodeKind, mode: ColorMode): string {
  if (mode === 'kind') return KIND_COLOR[kind]
  // tone / stage 口径下类型图例退回语义色（tone 口径节点就是语义色；
  // stage 口径下同一类型可能是任意阶段色，用类型的中性代表色避免误读）。
  return TONE_COLOR[LEGEND_TONE[kind]]
}

/** 类型 → 代表语义色（图例在 tone 口径下的颜色；与 graph-data 的能力域色调一致）。 */
const LEGEND_TONE: Record<GraphNodeKind, GraphNode['tone']> = {
  capability: 'info',
  stage: 'neutral',
  metric: 'warn',
  bundle: 'neutral',
  gap: 'error',
}

/**
 * 类型 → 代表形状（v0.11 P0：形状图例缺失修复）。
 *
 * 形状是颜色之外的第二编码通道，但它只对「知道映射的人」可读 ——
 * 图例必须同时展示形状与颜色。能力域的形状映射真相在
 * `graph-data.ts` 的 CAPABILITY_SHAPES；这里用**实际出现的节点**导出
 * 代表形状（多数票），而不是复制一份映射 —— 复制就是第二真相源。
 */
export function legendShapeOf(kind: GraphNodeKind, nodes: readonly GraphNode[]): GraphNode['shape'] {
  const tally = new Map<GraphNode['shape'], number>()
  for (const node of nodes) {
    if (node.kind !== kind) continue
    tally.set(node.shape, (tally.get(node.shape) ?? 0) + 1)
  }
  let best: GraphNode['shape'] | null = null
  let bestCount = 0
  for (const [shape, count] of tally) {
    if (count > bestCount) {
      best = shape
      bestCount = count
    }
  }
  return best ?? 'circle'
}

/* ---------- 布局投影 ---------- */

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

/** 布局投影：分层直接用宿主给的 x/y（确定性来自 graph-data 的排序），环形现算。 */
export function layoutPositionsOf(nodes: readonly GraphNode[], mode: LayoutMode): Record<string, Point> {
  if (mode === 'radial') return radialPositions(nodes)
  const out: Record<string, Point> = {}
  for (const node of nodes) out[node.id] = { x: node.x, y: node.y }
  return out
}

/**
 * 把布局投影与用户拖拽偏移叠加成实际坐标。
 *
 * 叠加层而不是「改布局」：布局是数据的确定性投影，用户调整是**视图事实**，
 * 轮询刷新数据时不得重置（CLAUDE.md 铁律）。偏移只在用户拖动后存在。
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

/**
 * 邻格候选 —— 键盘方向键的落点。
 *
 * 为什么不是「图上的邻居」：这是**二维**导航（Tab 是一维的，走不完一张
 * 有行的网格），方向键必须在画布坐标上找下一个节点。规则是
 * 「方向半平面里、垂直偏移最小者」，再拿垂直容差筛掉「斜得离谱」的候选：
 * - 只按欧氏距离选，长图里「向右」会跳到下一列的第一行（哪怕它在最上面）；
 * - 只按行匹配选，行与行之间高度不齐时会跳不动（找不到同行的邻居）。
 * 两者取交集：优先「同一横带里最近的」，横带里没有人再退到半平面最近。
 * 返回 null 表示该方向到头了（焦点留在原地，绝不把焦点丢回容器）。
 */
export function directionalCandidate(
  from: { x: number; y: number },
  direction: 'left' | 'right' | 'up' | 'down',
  candidates: ReadonlyArray<{ id: string; x: number; y: number }>,
): string | null {
  const horizontal = direction === 'left' || direction === 'right'
  // 屏幕坐标系 y 轴向下：右 / 下 是正方向，左 / 上 是负方向。
  // （写成「left || down」是本类缺陷的高发点 —— 直觉上「下」像负方向，
  //  但在屏幕坐标里它恰恰是正方向；搞反会让方向键整体反向且只有一半人发现。）
  const sign = direction === 'left' || direction === 'up' ? -1 : 1
  // 只有严格在「前方」的节点才算候选；同坐标（重叠卡片）不算前进。
  const ahead = candidates.filter((node) => {
    const delta = horizontal ? node.x - from.x : node.y - from.y
    return delta * sign > 0
  })
  if (ahead.length === 0) return null
  // 垂直偏移：横向移动时看 dy，纵向移动时看 dx。
  const crossOf = (node: { x: number; y: number }): number =>
    Math.abs(horizontal ? node.y - from.y : node.x - from.x)
  const alongOf = (node: { x: number; y: number }): number =>
    Math.abs((horizontal ? node.x - from.x : node.y - from.y) * sign)
  const bestCross = Math.min(...ahead.map(crossOf))
  // 容差：一个卡片厚度（横向）/ 行间距的一半（纵向）。够宽才能「跨行找人」，
  // 又不至于把整条对角线当成同一带。
  const tolerance = Math.max(bestCross, horizontal ? NODE_HEIGHT : NODE_WIDTH / 2)
  const band = ahead.filter((node) => crossOf(node) <= tolerance)
  const pool = band.length > 0 ? band : ahead
  let best = pool[0]
  if (!best) return null
  let bestScore = alongOf(best) * 4 + crossOf(best)
  for (const node of pool) {
    const score = alongOf(node) * 4 + crossOf(node)
    if (score < bestScore) {
      best = node
      bestScore = score
    }
  }
  return best?.id ?? null
}

/* ---------- 展示辅助 ---------- */

/** 缩放读数（窄视口里只有「百分比」这一个数可靠地表达当前视野）。 */
export function zoomLabel(scale: number): string {
  if (!Number.isFinite(scale)) return '100%'
  return `${Math.round(scale * 100)}%`
}

/**
 * 节点形状路径 —— 颜色之外的第二编码通道（灰度打印/色盲模式下仍可分辨）。
 *
 * 从 GuardGraph.tsx 搬来：它同样是纯几何投影，放进模型层才能被测试钉死
 * 「六种形状互不相同」这条不变式。
 */
export function shapePath(shape: GraphNode['shape'], size: number, cy: number): string {
  const r = size
  switch (shape) {
    case 'square':
      return `M ${-r} ${cy - r} h ${r * 2} v ${r * 2} h ${-r * 2} Z`
    case 'diamond':
      return `M 0 ${cy - r} L ${r} ${cy} L 0 ${cy + r} L ${-r} ${cy} Z`
    case 'triangle':
      return `M 0 ${cy - r} L ${r} ${cy + r} L ${-r} ${cy + r} Z`
    case 'hexagon':
      return `M ${-r} ${cy - r * 0.6} L ${-r * 0.5} ${cy - r} L ${r * 0.5} ${cy - r} L ${r} ${cy - r * 0.6} L ${r * 0.5} ${cy + r} L ${-r * 0.5} ${cy + r} Z`
    case 'circle':
    default:
      return `M ${-r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`
  }
}
