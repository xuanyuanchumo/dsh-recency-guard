/**
 * 图谱的**展示词汇表** —— 颜色 / 类型标签 / 图例计数与代表形状。
 *
 * ## 为什么从 graph-model.ts 抽出来（v0.16 复杂度门禁）
 *
 * graph-model 已越过预算上限带（105→120）。它承担了四件互相独立的事：
 * 布局投影、过滤、边几何、**展示词汇**。前三件事是图的不变式，第四件
 * 只是「把事实翻译成人能读的颜色与名字」—— 一改图例就要动一个本应稳定的
 * 几何模块，正好说明分层错了。
 *
 * 本文件仍然只认类型与数字：不 import React / DOM / host，可在无浏览器
 * 环境逐条断言（tests/client/graph-legend.test.ts 覆盖计数与开关口径）。
 */
import type { GraphEdge, GraphNode, GraphNodeKind } from '../../shared/graph-contract.ts'

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

/** 一个节点的着色键。 */
export function colorOf(
  node: GraphNode,
  mode: ColorMode,
  stageOf: (column: number) => string | undefined,
): string {
  if (mode === 'kind') return KIND_COLOR[node.kind]
  if (mode === 'stage') return STAGE_COLOR[stageOf(node.column) ?? ''] ?? TONE_COLOR.neutral
  return TONE_COLOR[node.tone]
}

/**
 * 类型图例顺序 —— 固定顺序而非「按出现顺序」：图例是一块位置记忆，
 * 每次轮询重排会让用户的肌肉记忆失效。
 */
export const KIND_ORDER: readonly GraphNodeKind[] = ['capability', 'stage', 'metric', 'bundle', 'gap']

/**
 * 语义色图例顺序 —— 与类型图例同理固定顺序：图例位置是肌肉记忆。
 * neutral 放最后：它是「无风险信号」的那一档，用户按危险程度扫读时
 * 它不该占据第一眼位置。
 */
export const TONE_ORDER: readonly GraphNode['tone'][] = ['info', 'success', 'warn', 'error', 'neutral']

/** 边语义的固定顺序（图例与详情共用；不按数据出现顺序重排）。 */
export const EDGE_KIND_ORDER: readonly GraphEdge['kind'][] = ['produces', 'consumes', 'transitions', 'ranks']

/** 节点类型的文案键（走 i18n，英文界面也要可读）。 */
export function kindKey(kind: GraphNodeKind): string {
  return `graph.kind.${kind}`
}

/** 语义色 → i18n 键（图例按钮的可读标签）。 */
export function toneKey(tone: GraphNode['tone']): string {
  return `graph.tone.${tone}`
}

/** 边语义 → i18n 键。 */
export function edgeKindKey(kind: GraphEdge['kind']): string {
  switch (kind) {
    case 'produces':
      return 'graph.edgeProduces'
    case 'consumes':
      return 'graph.edgeConsumes'
    case 'transitions':
      return 'graph.edgeTransitions'
    case 'ranks':
    default:
      return 'graph.edgeRanks'
  }
}

/** 各类型的节点数（图例上带计数：用户不必先点开才知道那类有多少个）。 */
export function kindCounts(nodes: readonly GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1
  return counts
}

/** 各语义色的节点数（图例总数必须来自**原始数据**，不随过滤缩水）。 */
export function toneCounts(nodes: readonly GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of nodes) counts[node.tone] = (counts[node.tone] ?? 0) + 1
  return counts
}

/** 各语义类型的边数（边图例的计数来源；同样取原始图，不取过滤后的视图）。 */
export function edgeKindCounts(edges: readonly GraphEdge[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const edge of edges) counts[edge.kind] = (counts[edge.kind] ?? 0) + 1
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