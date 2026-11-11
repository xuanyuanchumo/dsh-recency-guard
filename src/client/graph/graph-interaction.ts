/**
 * 图谱交互模型 —— 拖拽 / 悬停邻域 / 图例开关 / 搜索键盘 / fit 纪律。
 *
 * ## 为什么单独一层纯函数
 *
 * 这些行为在浏览器里的失败形态全是「看起来有点怪」，而不是抛错：
 * - 拖节点时缩放不是 1，偏移量按屏幕像素写进世界坐标 ⇒ 拖动距离与指针错位（缩放越大差得越多）；
 * - 切布局后偏移仍套在新投影上 ⇒ 用户摆好的图「跳走了」；
 * - 悬停高亮若在渲染循环里现算邻居，边与节点的判定会各算各的（图上出现「亮节点连着暗边」）；
 * - 「轮询不得重置缩放」这条铁律此前只写在注释里，任何一次 effect 重构都可能悄悄破坏它。
 *
 * 因此交互规则全部落成可断言函数（tests/client/graph-interaction.test.ts），
 * 组件只做「把结果画出来 + 派发事件」。
 *
 * 本文件不 import React / DOM，也不 import host。
 */
import type { GraphEdge, GraphNode } from '../../shared/graph-contract.ts'
import { DRAG_THRESHOLD, type LayoutMode } from './graph-model.ts'
import { centerOn, fitToView, type Point, type Rect, type Size, type Viewport } from './viewport.ts'

/* ---------- 指针手势与拖拽 ---------- */

/**
 * 位移是否已经越过「拖拽」阈值。
 *
 * 用 L1 距离（|dx|+|dy|）而不是欧氏距离：斜向小幅移动时 L1 更大，会让
 * 「斜着抖一下」更容易被判定为拖拽。这是有意为之 —— 节点卡片上的点击
 * 若被 1~2px 手抖吞掉，用户会觉得「点不中」；宁可把轻微的斜向移动当拖拽
 * （拖拽的后果只是布局微调，可重置）。
 */
export function isDragDistance(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  const x = Number.isFinite(dx) ? dx : 0
  const y = Number.isFinite(dy) ? dy : 0
  const limit = Number.isFinite(threshold) && threshold >= 0 ? threshold : DRAG_THRESHOLD
  return Math.abs(x) + Math.abs(y) >= limit
}

/**
 * 屏幕位移 → 世界位移（视图坐标反变换）。
 *
 * 为什么必须反变换：偏移存的是**世界坐标**（与布局同坐标系），而指针事件
 * 给的是屏幕像素。scale=4 时若直接用屏幕像素当世界偏移，指针移动 100px
 * 卡片只走 25px —— 缩放越大「拖不动」越明显；scale=0.25 时则反过来甩飞。
 * 退化输入（scale=0/NaN）回落到 1，避免把 Infinity 写进布局记忆。
 */
export function dragDeltaToWorld(dxScreen: number, dyScreen: number, scale: number): Point {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    x: (Number.isFinite(dxScreen) ? dxScreen : 0) / s,
    y: (Number.isFinite(dyScreen) ? dyScreen : 0) / s,
  }
}

/**
 * 布局记忆 —— **按布局分别记**用户拖拽后的偏移。
 *
 * 为什么不是一张全局 offset 表：偏移是「相对某个投影的修正量」。分层布局
 * 里把枢纽拖到左上角后切到环形，同一个偏移会套在完全不同的基坐标上 ——
 * 切回来时位置虽然还在（同一个 key），但中间那次环形布局被用户的手势
 * 污染成了无意义形状。按布局分开记，两种布局各自保持用户摆好的样子。
 *
 * 轮询只换数据、不换布局 ⇒ 同一档位内的偏移稳定不丢（铁律）。
 */
export interface LayoutOffsetMemory {
  layered: Readonly<Record<string, Point>>
  radial: Readonly<Record<string, Point>>
}

export function emptyOffsetMemory(): LayoutOffsetMemory {
  // 每次返回**新对象**：模块级共享常量会被某次原地修改悄悄污染所有实例。
  return { layered: {}, radial: {} }
}

/** 当前布局的偏移表（渲染与命中测试都用它，单一真相源）。 */
export function offsetsFor(memory: LayoutOffsetMemory, layout: LayoutMode): Readonly<Record<string, Point>> {
  return memory[layout]
}

/** 叠加一次拖拽增量；返回新对象而不是原地改（React 才能看到变化）。 */
export function withDragOffset(
  memory: LayoutOffsetMemory,
  layout: LayoutMode,
  id: string,
  delta: Point,
): LayoutOffsetMemory {
  const prior = memory[layout][id] ?? { x: 0, y: 0 }
  const next = {
    x: prior.x + (Number.isFinite(delta.x) ? delta.x : 0),
    y: prior.y + (Number.isFinite(delta.y) ? delta.y : 0),
  }
  return { ...memory, [layout]: { ...memory[layout], [id]: next } }
}

/** 是否任何布局都还有用户拖拽（决定「重置」按钮是否可点）。 */
export function hasAnyOffset(memory: LayoutOffsetMemory): boolean {
  return Object.keys(memory.layered).length > 0 || Object.keys(memory.radial).length > 0
}

/* ---------- 悬停邻域高亮 ---------- */

export type HoverFocus = 'node' | 'edge'

export interface HighlightSelection {
  /** 应当提亮的节点（悬停节点自身 + 1 跳邻居 / 悬停边的两端）。 */
  nodes: ReadonlySet<string>
  /** 应当提亮的边（悬停节点的关联边 / 悬停边自身）。 */
  edges: ReadonlySet<string>
  focus: HoverFocus
}

export interface HoverTarget {
  nodeId?: string | null
  edgeId?: string | null
}

/**
 * 悬停高亮集 —— 一次算出节点集与边集。
 *
 * 为什么两集合必须同源：若「提亮的节点」用邻接表算、而边用另一套判断，
 * 就会出现亮节点连着暗边 / 亮边指向暗节点 —— 用户读到的是两种互相矛盾
 * 的「相关」。这里先把**关联边**收齐，再由这些边推出邻居节点，集合天然闭合。
 *
 * 边界：
 * - 悬停对象不在当前可见图里 ⇒ 返回 null（调用方按「无高亮」处理，绝不
 *   画一个指向已过滤节点的幽灵高亮）；
 * - 自环：节点悬停时自环同时进入 edges，且节点集只有它自己；
 * - 两者都为空 ⇒ null（离开恢复）。
 * - 节点优先于边：组件同一时刻只会设置一个，但纯函数要给出确定语义。
 */
export function highlightForHover(
  target: HoverTarget,
  nodes: readonly Pick<GraphNode, 'id'>[],
  edges: readonly Pick<GraphEdge, 'id' | 'from' | 'to'>[],
): HighlightSelection | null {
  const nodeId = target.nodeId ?? null
  if (nodeId !== null) {
    if (!nodes.some((node) => node.id === nodeId)) return null
    const nodeSet = new Set<string>([nodeId])
    const edgeSet = new Set<string>()
    for (const edge of edges) {
      if (edge.from === nodeId || edge.to === nodeId) {
        edgeSet.add(edge.id)
        nodeSet.add(edge.from === nodeId ? edge.to : edge.from)
      }
    }
    return { nodes: nodeSet, edges: edgeSet, focus: 'node' }
  }
  const edgeId = target.edgeId ?? null
  if (edgeId !== null) {
    const edge = edges.find((candidate) => candidate.id === edgeId)
    if (edge === undefined) return null
    return { nodes: new Set([edge.from, edge.to]), edges: new Set([edge.id]), focus: 'edge' }
  }
  return null
}

/** 命中集合的元素该不该被降透明度（null 高亮 = 没有高亮，谁都不降）。 */
export function isDimmedByHighlight(
  highlight: HighlightSelection | null,
  kind: HoverFocus,
  id: string,
): boolean {
  if (highlight === null) return false
  return kind === 'node' ? !highlight.nodes.has(id) : !highlight.edges.has(id)
}

/* ---------- 图例开关 ---------- */

/**
 * 切换集合成员（返回新集合）。
 *
 * 用 Set 而不是数组：图例开关是「成员资格」查询，每次渲染都要对每个节点/边
 * 判一次；数组的 includes 在 60 节点 × 4 类上肉眼不可见，但把 O(1) 写成
 * O(n) 的代价会在「每次 pointermove 都重算过滤」时被放大。
 */
export function toggleSetMember<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/* ---------- 搜索与键盘 ---------- */

/** 搜索游标步进（↑↓/回车共用；负数与超界都回落到合法下标）。 */
export function cycleIndex(current: number, delta: number, total: number): number {
  if (!(total > 0)) return 0
  const base = Number.isFinite(current) ? Math.floor(current) : 0
  const step = Number.isFinite(delta) ? Math.floor(delta) : 0
  // 与 searchSummary 同一取模形态：负数 delta（↑）不产生负下标。
  return ((base + step) % total + total) % total
}

/** 搜索框按键动作。`hasMatches` 为 false 时方向键不抢输入法/光标行为。 */
export type SearchKeyAction = 'next' | 'previous' | 'clear' | 'none'

export function searchKeyAction(key: string, hasMatches: boolean): SearchKeyAction {
  if (key === 'Escape') return 'clear'
  if (!hasMatches) return 'none'
  if (key === 'Enter' || key === 'ArrowDown') return 'next'
  if (key === 'ArrowUp') return 'previous'
  return 'none'
}

/** 画布按键动作（把键位表从 JSX 里抽出，才可逐键断言）。 */
export type GraphKeyAction =
  | 'escape'
  | 'zoom-in'
  | 'zoom-out'
  | 'fit'
  | 'focus-left'
  | 'focus-right'
  | 'focus-up'
  | 'focus-down'
  | 'none'

export function graphKeyAction(key: string): GraphKeyAction {
  switch (key) {
    case 'Escape':
      return 'escape'
    case '+':
    case '=':
      return 'zoom-in'
    case '-':
    case '_':
      return 'zoom-out'
    case '0':
      return 'fit'
    case 'ArrowLeft':
      return 'focus-left'
    case 'ArrowRight':
      return 'focus-right'
    case 'ArrowUp':
      return 'focus-up'
    case 'ArrowDown':
      return 'focus-down'
    default:
      return 'none'
  }
}

/* ---------- fit 纪律 ---------- */

/**
 * 何时允许重跑 fit。
 *
 * CLAUDE.md 铁律：**图谱 fit 不能在数据轮询时重跑**，否则用户调好的缩放
 * 每次轮询都被重置。此前这条纪律只靠 effect 的依赖数组表达 —— 一次手滑
 * 把 `bounds` 加进依赖就静默破坏，而界面表现只是「缩放老跳」，不像 bug。
 *
 * 这里把「什么原因可以 fit」写成白名单：
 * - `initial`：一次未 fit 过 ⇒ 是（首次必须有画面）；
 * - `layout-switch`：显式换投影 ⇒ 是（旧视口对着空白，不 fit 才是错的）；
 * - `resize`：容器尺寸变化 ⇒ 否，只重新钳制平移（用户缩放意图仍有效）；
 * - `data-poll`：数据刷新 ⇒ **否**，铁律本身。
 */
export type FitReason = 'initial' | 'layout-switch' | 'resize' | 'data-poll'

export function shouldFit(reason: FitReason, alreadyFitted: boolean): boolean {
  if (reason === 'initial') return !alreadyFitted
  if (reason === 'layout-switch') return true
  return false
}

/* ---------- 边标签降噪 ---------- */

/**
 * 低于该缩放比例时，边标签只给「悬停 / 选中」的边。
 *
 * 为什么必须是常量 + 纯函数：52% 缩放下 40+ 条边的语义标签会与节点文字
 * 互相压（真机截图实测）。渲染层若各写一个 `viewport.scale < 0.75`，
 * 阈值会随改动漂移，而且「悬停的边必须仍可读」这个例外很容易漏。
 */
export const EDGE_LABEL_MIN_SCALE = 0.75

/**
 * 是否显示某条边的语义标签。
 *
 * @param scale 当前缩放
 * @param active 该边是否处于聚焦高亮（可以由缩放决定是否降噪）
 * @param pinned 该边是否被悬停或选中（**永远显示**，这是用户的当前操作对象）
 */
export function shouldShowEdgeLabel(scale: number, active: boolean, pinned: boolean): boolean {
  if (pinned) return true
  if (!active) return false
  return !Number.isFinite(scale) || scale >= EDGE_LABEL_MIN_SCALE
}

/* ---------- Esc 的分层语义 ---------- */

export type EscapeAction = 'collapse-expand' | 'clear-observation' | 'none'

/**
 * Esc 一次只退一层。
 *
 * 放大视图是**最外层**观察态：先收起它，再清高亮/搜索/悬停。一次清光会让
 * 用户丢掉「我正在看哪个节点」的上下文 —— 展开与收起本该可逆。
 */
export function escapeAction(expanded: boolean, hasObservation: boolean): EscapeAction {
  if (expanded) return 'collapse-expand'
  if (hasObservation) return 'clear-observation'
  return 'none'
}

/* ---------- 可读 fit ---------- */

/** fit 的可读下界：再小文字就不可读（真机 52% 实测）。 */
export const FIT_SCALE_MIN = 0.65
/** fit 的上界：小图不该被放大到夸张的尺寸。 */
export const FIT_SCALE_MAX = 1.2

export interface ReadableFit {
  viewport: Viewport
  /** 'max' = 被可读上界钳制过（内容本来就小）；null = 未钳制。 */
  clamped: 'max' | null
  /**
   * true = fit-all 的比例已低于可读阈值（内容太大）。
   *
   * 此时**保持 fit-all**（首屏完整性优先：所有节点必须完整可见），
   * 状态栏不谎称「已按可读下界适配」，而是提示可点「放大视图/＋」。
   */
  belowReadable: boolean
}

/**
 * fit-to-view 的**可读上界**版本 —— 首屏完整性优先。
 *
 * ## 语义（v0.16 真机回归后修正）
 *
 * 真机截图暴露出「把 scale 从 fit-all 抬到 0.65」的代价：内容比视口大时
 * 抬高比例必然裁掉内容；而「裁哪边」取决于居中/钳制的组合，很容易出现
 * 「左列被切、右侧留白」这种视觉回归。**首屏不允许把节点切出视口**是
 * 不变式，因此：
 *
 * - `fitScale < 0.65`（内容太大）：**保持 fit-all**，标记 `belowReadable`，
 *   由状态栏提示用户点「放大视图/＋」—— 「看得全」优先于「字够大」；
 * - `fitScale > 1.2`（内容很小）：抬到 1.2 并把内容中心对齐视口中心
 *   （内容一定比视口小，四边留白对称）；
 * - 区间内：原样返回 fit（同样天然居中、四边对称）。
 *
 * 三个分支都满足：内容中心 == 视口中心（容差 0），且内容包围盒完整落在
 * 视口内。`clampPan` 对「内容比视口小」的分支会得到完全相同的居中值，
 * 不会再次移动视图。
 */
export function readableFitViewport(bounds: Rect, size: Size, margin = 16): ReadableFit {
  const fitted = fitToView(bounds, size, margin)
  if (bounds.width <= 0 || bounds.height <= 0 || size.width <= 0 || size.height <= 0) {
    return { viewport: fitted, clamped: null, belowReadable: false }
  }
  if (fitted.scale < FIT_SCALE_MIN) {
    return { viewport: fitted, clamped: null, belowReadable: true }
  }
  if (fitted.scale > FIT_SCALE_MAX) {
    return {
      viewport: centerOn({ scale: FIT_SCALE_MAX, tx: 0, ty: 0 }, size, {
        x: bounds.minX + bounds.width / 2,
        y: bounds.minY + bounds.height / 2,
      }),
      clamped: 'max',
      belowReadable: false,
    }
  }
  return { viewport: fitted, clamped: null, belowReadable: false }
}

/**
 * 首次打开面板时是否自动进入「放大视图」。
 *
 * 为什么按节点数：默认图谱区在 730×380 量级，20+ 节点的图 fit-all 后
 * 文字必然低于可读阈值（实测 22 节点/49 边 → 52%）。自动撑到 70vh 是
 * **一次性的可读性补救**，不影响之后的交互；用户随时可还原。
 * 阈值 20 来自真机：19 节点仍可读，22 节点已明显拥挤。
 */
export const AUTO_EXPAND_NODE_THRESHOLD = 20

export function shouldAutoExpand(nodeCount: number): boolean {
  if (!Number.isFinite(nodeCount)) return false
  return nodeCount > AUTO_EXPAND_NODE_THRESHOLD
}

/** 「放大视图」的目标比例与最小高度。 */
export const EXPANDED_VIEWPORT_RATIO = 0.7
export const EXPANDED_VIEWPORT_MIN = 420

/**
 * 「放大视图」的像素高度（**纯函数，不依赖 CSS vh**）。
 *
 * 为什么不用 `70vh` 直接写进 inline style：真机表现为「按钮文案变了、
 * 高度没变」—— vh 在宿主 slot/缩放环境下不一定等于用户看到的高度，
 * 而且测量与布局都依赖具体像素。这里显式算出 px：
 *
 * - 收起：原样返回 base；
 * - 展开：`max(1.5×base, 0.7×视口高, 420)`，并四舍五入到整像素。
 *   1.5× 是**可见性下限**（否则 70vh 可能刚好等于原高度，按钮看起来
 *   没生效）；70% 视口是目标；420px 保证小窗口里也真的变大。
 * - 坏输入（NaN/≤0）回落到安全值 —— 高度是布局输入，绝不能是 NaN。
 */
export function expandedViewportHeight(base: number, viewportHeight: number, expanded: boolean): number {
  const baseHeight = Number.isFinite(base) && base > 0 ? base : EXPANDED_VIEWPORT_MIN
  if (!expanded) return Math.round(baseHeight)
  const target = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight * EXPANDED_VIEWPORT_RATIO : 0
  return Math.round(Math.max(baseHeight * 1.5, target, EXPANDED_VIEWPORT_MIN))
}

/* ---------- 长文本省略（渲染策略，必须计数） ---------- */

export interface Ellipsized {
  /** 实际显示文本（截断时带省略号）。 */
  text: string
  truncated: boolean
  /** 被省略的**字符数** —— 显示层必须把它说出来，而不是静默截断。 */
  omitted: number
  full: string
}

/**
 * 截断长文本并给出省略计数。
 *
 * 数据层不做截断（CLAUDE.md），这里是渲染策略：SVG 卡片放不下整段 label，
 * 但省略必须可数、完整文本必须另有出口（`<title>` 与详情卡）。
 * `max` 非有限/负数时退化为不截断 —— 宁可撑破布局，也不静默吞内容。
 */
export function ellipsize(value: string, max: number): Ellipsized {
  if (!Number.isFinite(max) || max < 0) return { text: value, truncated: false, omitted: 0, full: value }
  const limit = Math.floor(max)
  if (value.length <= limit) return { text: value, truncated: false, omitted: 0, full: value }
  return {
    text: `${value.slice(0, limit)}…`,
    truncated: true,
    omitted: value.length - limit,
    full: value,
  }
}