/**
 * 小地图投影（Overview + 缩略导航）—— 世界坐标 ⇄ 小地图坐标的**可逆**映射。
 *
 * 为什么从小地图逻辑从 graph-model.ts 拆出来（v0.12）：
 * graph-model 加了 k 跳邻域 / 方向导航 / 边宽编码之后热点分越过了复杂度预算
 * 100（band-detector 实测 117）。小地图是**独立的几何子域** —— 它不参与过滤、
 * 布局、命中测试的任何一条数据流，只消费 `graphBounds` 的输出。拆出去既守住
 * 预算，也让「投影保纵横比」这条纪律有自己能被逐条断言的家。
 *
 * 为什么两个轴不各自缩放：若各轴独立缩放，长条图会被拉成方块，用户据此做的
 * 方向判断全错 —— 所以投影必须保纵横比（与 viewport 的 `fitToView` 同一纪律）。
 * 又因为「拖框定位」需要逆映射，正逆必须写成**一对闭式函数**，否则会出现
 * 除以 scale 却漏掉 offset 的「越纠偏越偏」缺陷 —— 成对写出才能被测试钉死
 * 往返误差 < 1e-9。
 */

import type { GraphNode } from '../../src/graph-data.ts'
import { LAYOUT } from '../../src/graph-data.ts'
import type { Point, Rect } from './viewport.ts'

/**
 * 节点尺寸直接取宿主布局常量。
 *
 * 为什么从这里 import LAYOUT 而不是复用 graph-model 的 NODE_WIDTH/NODE_HEIGHT：
 * 那会让 graph-model ⇄ minimap-model 形成**循环依赖** —— 打包器能容忍，
 * 但常量在循环里的初始化顺序不确定（TDZ），症状是「小地图矩形尺寸随机为 0」
 * 这类只在一台机器上复现的缺陷。同一份真相（LAYOUT）各自直读，依赖图保持单向。
 */
const NODE_WIDTH = LAYOUT.nodeWidth
const NODE_HEIGHT = LAYOUT.nodeHeight

/** 小地图投影的参数（由 `minimapProjection` 一次性算清）。 */
export interface MinimapProjection {
  /** 世界 → 小地图的统一缩放（纵横比守恒）。 */
  worldScale: number
  /** 小地图内的居中偏移（含 padding）。 */
  offsetX: number
  offsetY: number
  /** 被投影矩形的世界原点（空图时为 0，避免 ±Infinity 进映射）。 */
  minX: number
  minY: number
  /**
   * 整张图在**小地图坐标**下的宽高。
   *
   * 为什么要带上它：判断「用户是否已经看全」的比较对象是**图的投影尺寸**，
   * 不是画布尺寸。画布比图宽时（长条图 + 方画布）用 canvas.width 当阈值，
   * 框永远够不到阈值 ⇒ 明明已全览却还显示一个「局部」的框 ——
   * 说谎的指南针比没有指南针更糟。
   */
  figureWidth: number
  figureHeight: number
}

/** 小地图画布尺寸（面板宽度不足时由调用方收紧）。 */
export interface MinimapCanvas {
  width: number
  height: number
}

/** 小地图内边距：留 4px 才看得出「框贴边」与「框出界」的区别。 */
export const MINIMAP_PADDING = 4

/**
 * 建立投影。退化输入（空图 / 零矩形 / 零画布）返回恒等映射 ——
 * 小地图此时什么都不画，但绝不能返回 NaN 把整块 SVG 弄成空白。
 */
export function minimapProjection(bounds: Rect, canvas: MinimapCanvas, padding = MINIMAP_PADDING): MinimapProjection {
  const drawWidth = canvas.width - padding * 2
  const drawHeight = canvas.height - padding * 2
  if (!(bounds.width > 0) || !(bounds.height > 0) || !(drawWidth > 0) || !(drawHeight > 0)) {
    return {
      worldScale: 1,
      offsetX: padding,
      offsetY: padding,
      minX: 0,
      minY: 0,
      figureWidth: 0,
      figureHeight: 0,
    }
  }
  const worldScale = Math.min(drawWidth / bounds.width, drawHeight / bounds.height)
  const figureWidth = bounds.width * worldScale
  const figureHeight = bounds.height * worldScale
  return {
    worldScale,
    // 居中：空白在两侧均分，小地图里的「图居中」才与主视口 fit 的居中同构。
    offsetX: padding + (drawWidth - figureWidth) / 2,
    offsetY: padding + (drawHeight - figureHeight) / 2,
    minX: bounds.minX,
    minY: bounds.minY,
    figureWidth,
    figureHeight,
  }
}

/** 世界 → 小地图。 */
export function worldToMinimap(proj: MinimapProjection, point: Point): Point {
  return {
    x: proj.offsetX + (point.x - proj.minX) * proj.worldScale,
    y: proj.offsetY + (point.y - proj.minY) * proj.worldScale,
  }
}

/** 小地图 → 世界（`worldToMinimap` 的闭式逆）。 */
export function minimapToWorld(proj: MinimapProjection, point: Point): Point {
  if (!(proj.worldScale > 0) || !Number.isFinite(proj.worldScale)) return { x: proj.minX, y: proj.minY }
  return {
    x: (point.x - proj.offsetX) / proj.worldScale + proj.minX,
    y: (point.y - proj.offsetY) / proj.worldScale + proj.minY,
  }
}

/** 小地图里的一个节点矩形（带语义色：小地图不是另一套词典）。 */
export interface MinimapNodeRect {
  id: string
  x: number
  y: number
  w: number
  h: number
  fill: string
}

/**
 * 节点矩形表 —— 每个节点画成一块最小 1.5×1 px 的矩形。
 *
 * 为什么要下界：worldScale 在 40 节点的图上会到 0.05 以下，卡片按真实比例
 * 只有 0.x px —— 亚像素矩形在 SVG 里直接不可见，小地图就成了空的黑块。
 * 1.5px 是「仍能被看见、又不至于连成一片」的经验下界。
 */
export function minimapNodeRects(
  nodes: readonly GraphNode[],
  proj: MinimapProjection,
  color: (node: GraphNode) => string,
): MinimapNodeRect[] {
  return nodes.map((node) => {
    const at = worldToMinimap(proj, { x: node.x, y: node.y })
    return {
      id: node.id,
      x: at.x,
      y: at.y,
      w: Math.max(1.5, NODE_WIDTH * proj.worldScale),
      h: Math.max(1, NODE_HEIGHT * proj.worldScale),
      fill: color(node),
    }
  })
}

/** 小地图里的视口框（这就是「我现在看的是哪一块」的唯一答案）。 */
export interface MinimapViewportRect {
  x: number
  y: number
  w: number
  h: number
  /**
   * 已经是「全览」：可见区覆盖了整张图，框此时铺满图形 ——
   * 组件用虚线描边把它与「局部」区分开（两个状态看起来一样比看起来怪更糟）。
   */
  zoomedOut: boolean
}

/**
 * 视口框 —— 「我现在看的是整张图的哪一块」的唯一答案。
 *
 * 三条几何纪律（各对应一个真实缺陷形态）：
 * 1. **与图形求交**：可见区常常大于图（缩到 0.25 时），不取交集会画出
 *    一块比图还大的框、溢出小地图边缘，看起来像控件坏了。
 * 2. **判定「全览」的比较对象是图的投影尺寸**，不是画布尺寸 —— 长条图
 *    配方画布时两者差几倍，用画布宽度当阈值就永远判不出全览（说谎的指南针）。
 * 3. **全览时框铺满整张图并标 zoomedOut**，而不是不画：不画会让用户以为
 *    小地图坏了；「没有看不见的部分」正是此时唯一正确的事实。
 */
export function minimapViewportRect(
  proj: MinimapProjection,
  viewport: { scale: number; tx: number; ty: number },
  size: { width: number; height: number },
): MinimapViewportRect {
  const scale = viewport.scale
  if (!(proj.figureWidth > 0) || !(proj.figureHeight > 0)) {
    // 空图 / 退化画布：什么都不画才诚实，但也不能画 0×0 的假框。
    return { x: 0, y: 0, w: 0, h: 0, zoomedOut: true }
  }
  const figureLeft = proj.offsetX
  const figureTop = proj.offsetY
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return { x: figureLeft, y: figureTop, w: proj.figureWidth, h: proj.figureHeight, zoomedOut: true }
  }
  // 屏幕左上/右下角 → 世界 → 小地图：两个对角点即可表达任意缩放下可见矩形。
  const toWorld = (point: Point): Point => ({
    x: (point.x - viewport.tx) / scale,
    y: (point.y - viewport.ty) / scale,
  })
  const a = worldToMinimap(proj, toWorld({ x: 0, y: 0 }))
  const b = worldToMinimap(proj, toWorld({ x: size.width, y: size.height }))
  const left = Math.max(Math.min(a.x, b.x), figureLeft)
  const top = Math.max(Math.min(a.y, b.y), figureTop)
  const right = Math.min(Math.max(a.x, b.x), figureLeft + proj.figureWidth)
  const bottom = Math.min(Math.max(a.y, b.y), figureTop + proj.figureHeight)
  // 容差：clampPan 把内容**恰好**居中时交集恰好等于整张图，浮点「差一点点」
  // 不该被读成「还有一小块没看见」。
  const epsilon = 0.5
  const w = Math.max(0, right - left)
  const h = Math.max(0, bottom - top)
  if (w + epsilon >= proj.figureWidth && h + epsilon >= proj.figureHeight) {
    return { x: figureLeft, y: figureTop, w: proj.figureWidth, h: proj.figureHeight, zoomedOut: true }
  }
  if (w <= 0 || h <= 0) {
    // 交集为空（理论上被 clampPan 挡住，但 bounds 会随过滤变化）⇒ 把框贴到
    // 图形最近的角：方向信息仍在，比画一个看不见的零尺寸矩形更有用。
    return {
      x: Math.min(Math.max(Math.min(a.x, b.x), figureLeft), figureLeft + proj.figureWidth),
      y: Math.min(Math.max(Math.min(a.y, b.y), figureTop), figureTop + proj.figureHeight),
      w: 0,
      h: 0,
      zoomedOut: false,
    }
  }
  return { x: left, y: top, w, h, zoomedOut: false }
}
