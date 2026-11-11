import {
  EDGE_LABEL_MIN_SCALE,
  EXPANDED_VIEWPORT_MIN,
  FIT_SCALE_MAX,
  FIT_SCALE_MIN,
  escapeAction,
  expandedViewportHeight,
  readableFitViewport,
  shouldAutoExpand,
  shouldShowEdgeLabel,
} from '../../src/client/graph/graph-interaction.ts'
import {
  COMPACT_SPACING_FACTOR,
  compactLayoutPositions,
  layeredBarycentric,
  layoutPositionsOf,
  layoutSpacingFactor,
} from '../../src/client/graph/graph-layout.ts'
import { longEdgeCurvature } from '../../src/client/graph/graph-model.ts'
import type { GraphEdge, GraphNode } from '../../src/shared/graph-contract.ts'
import { LAYOUT } from '../../src/shared/graph-contract.ts'

/**
 * 视觉 polish 的纯函数 —— 降噪阈值、可读 fit、重心排序、长边曲率、Esc 分层。
 *
 * 这些规则在浏览器里只会表现为「看起来挤/乱/点不到」，没有断言就没人守；
 * 尤其是重心排序必须**确定性**（同数据两次渲染位置一致），否则用户每次
 * 轮询都会看到图跳一下。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function node(id: string, column: number, y: number): GraphNode {
  return { id, kind: 'capability', label: id, shape: 'circle', tone: 'neutral', x: column * 260, y, column }
}
function edge(id: string, from: string, to: string): GraphEdge {
  return { id, from, to, kind: 'produces', tone: 'neutral' }
}

console.log('\n[边标签降噪阈值]')
check('阈值是 0.75', EDGE_LABEL_MIN_SCALE === 0.75)
check('低缩放 + 仅聚焦高亮 ⇒ 隐藏', !shouldShowEdgeLabel(0.52, true, false))
check('低缩放 + 悬停/选中 ⇒ 仍显示（当前操作对象永远可读）', shouldShowEdgeLabel(0.52, true, true))
check('低缩放 + 无高亮 ⇒ 隐藏', !shouldShowEdgeLabel(0.52, false, false))
check('阈值上 + 聚焦高亮 ⇒ 显示', shouldShowEdgeLabel(0.75, true, false))
check('高缩放 + 无高亮 ⇒ 仍隐藏（不给全图每条边标字，否则是噪声）', !shouldShowEdgeLabel(2, false, false))
check('NaN 缩放退化为显示（不因坏值把标签全藏）', shouldShowEdgeLabel(Number.NaN, true, false))

console.log('\n[Esc 一次只退一层]')
check('展开视图优先收起', escapeAction(true, true) === 'collapse-expand')
check('未展开且有观察态 ⇒ 清观察态', escapeAction(false, true) === 'clear-observation')
check('什么都没有 ⇒ 不动作', escapeAction(false, false) === 'none')
check('展开即使无观察态也只收起', escapeAction(true, false) === 'collapse-expand')

console.log('\n[可读 fit：首屏完整性优先]')
const bounds = { minX: 0, minY: 0, maxX: 1400, maxY: 900, width: 1400, height: 900 }
const size = { width: 800, height: 400 }
const large = readableFitViewport(bounds, size)
check('大图 ⇒ 保持 fit-all，不抬到 0.65（先看得全）', large.belowReadable === true && large.clamped === null)
check('scale 就是 fit-all 比例（0.4089）而不是 0.65', Math.abs(large.viewport.scale - 368 / 900) < 1e-12, large.viewport.scale)
check('状态提示标记 belowReadable（文案不得谎称下界钳制）', large.belowReadable === true)
checkContained('大图四角完整落在视口内', large.viewport, bounds, size)
checkCentered('大图内容中心 == 视口中心', large.viewport, bounds, size)

// 真实回归代理：内容略大于视口（fit 0.613 < 0.65），此前会被抬到 0.65 并裁边。
const tight = { minX: 40, minY: 20, maxX: 1240, maxY: 620, width: 1200, height: 600 }
const tightFit = readableFitViewport(tight, size)
check('略微超视口的图也保持 fit-all（不裁左列）', tightFit.belowReadable && tightFit.viewport.scale < FIT_SCALE_MIN)
checkContained('紧边界四角完整可见', tightFit.viewport, tight, size)
checkCentered('紧边界仍居中', tightFit.viewport, tight, size)

const small = readableFitViewport({ minX: 0, minY: 0, maxX: 100, maxY: 50, width: 100, height: 50 }, size)
check('小图抬到可读上界（clamped=max）', small.clamped === 'max' && small.viewport.scale === FIT_SCALE_MAX)
checkContained('小图四角完整可见', small.viewport, { minX: 0, minY: 0, maxX: 100, maxY: 50, width: 100, height: 50 }, size)
checkCentered('小图内容中心 == 视口中心', small.viewport, { minX: 0, minY: 0, maxX: 100, maxY: 50, width: 100, height: 50 }, size)

const normal = readableFitViewport({ minX: 0, minY: 0, maxX: 700, maxY: 350, width: 700, height: 350 }, size)
check('可读区间内自然适配（不做无谓钳制）', normal.clamped === null && normal.belowReadable === false)
check('自然适配保持 fitToView 的比例', Math.abs(normal.viewport.scale - 368 / 350) < 1e-9, normal.viewport.scale)
checkContained('常规图四角完整可见', normal.viewport, { minX: 0, minY: 0, maxX: 700, maxY: 350, width: 700, height: 350 }, size)
check('空图不制造 NaN', Number.isFinite(readableFitViewport({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }, size).viewport.scale))

/** fit 的不变式：内容四角都在视口内（容差 1px）。 */
function checkContained(name: string, viewport: { scale: number; tx: number; ty: number }, rect: { minX: number; minY: number; maxX: number; maxY: number }, viewportSize: { width: number; height: number }): void {
  const xs = [rect.minX * viewport.scale + viewport.tx, rect.maxX * viewport.scale + viewport.tx]
  const ys = [rect.minY * viewport.scale + viewport.ty, rect.maxY * viewport.scale + viewport.ty]
  const inside = xs.every((x) => x >= -1 && x <= viewportSize.width + 1) && ys.every((y) => y >= -1 && y <= viewportSize.height + 1)
  check(name, inside, { xs, ys })
}

/** fit 的不变式：内容包围盒中心 == 视口中心（容差 1px）。 */
function checkCentered(name: string, viewport: { scale: number; tx: number; ty: number }, rect: { minX: number; minY: number; maxX: number; maxY: number }, viewportSize: { width: number; height: number }): void {
  const cx = rect.minX + (rect.maxX - rect.minX) / 2
  const cy = rect.minY + (rect.maxY - rect.minY) / 2
  const dx = Math.abs(cx * viewport.scale + viewport.tx - viewportSize.width / 2)
  const dy = Math.abs(cy * viewport.scale + viewport.ty - viewportSize.height / 2)
  check(name, dx <= 1 && dy <= 1, { dx, dy })
}

console.log('\n[放大视图自动展开]')
check('20 节点以内不自动展开', !shouldAutoExpand(20))
check('21 节点起自动展开（默认高度里 fit 后文字不可读）', shouldAutoExpand(21))
check('空图不展开', !shouldAutoExpand(0))
check('坏输入不展开', !shouldAutoExpand(Number.NaN))

console.log('\n[放大视图像素高度（不用 vh）]')
check('收起时原样返回基准高度', expandedViewportHeight(380, 714, false) === 380)
check('展开后至少是基准的 1.5 倍（保证肉眼可见）', expandedViewportHeight(380, 714, true) >= 380 * 1.5, expandedViewportHeight(380, 714, true))
check('展开后达到 70% 视口（目标）', expandedViewportHeight(380, 900, true) >= 900 * 0.7)
check('小窗口也至少 420px', expandedViewportHeight(200, 400, true) >= EXPANDED_VIEWPORT_MIN)
check('坏输入回到安全高度（不产生 NaN）', Number.isFinite(expandedViewportHeight(Number.NaN, Number.NaN, true)))
check('高度是整像素', Number.isInteger(expandedViewportHeight(380.4, 714.3, true)))

console.log('\n[分层重心排序]')
const left = [node('L1', 0, 0), node('L2', 0, 100)]
const right = [node('R1', 1, 0), node('R2', 1, 100)]
const crossingEdges = [edge('e1', 'L1', 'R2'), edge('e2', 'L2', 'R1')]
/** 交叉数：两条边端点顺序相反即交叉（一对一列测试用）。 */
function crossings(positions: Record<string, { x: number; y: number }>, edges: readonly GraphEdge[]): number {
  let count = 0
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i]!
      const b = edges[j]!
      const aFrom = positions[a.from]!
      const aTo = positions[a.to]!
      const bFrom = positions[b.from]!
      const bTo = positions[b.to]!
      const sameSide = aFrom.y < aTo.y
      const otherSide = bFrom.y < bTo.y
      if (sameSide !== otherSide) count += 1
    }
  }
  return count
}
const original = Object.fromEntries([...left, ...right].map((n) => [n.id, { x: n.x, y: n.y }]))
const reordered = layeredBarycentric([...left, ...right], crossingEdges)
check('交叉边被一阶重心重排消掉', crossings(original, crossingEdges) === 1 && crossings(reordered, crossingEdges) === 0, { before: crossings(original, crossingEdges), after: crossings(reordered, crossingEdges) })
check('左列（无上游）保持原序', reordered.L1?.y === 0 && reordered.L2?.y === 100)
check('结果完全确定（同输入两次逐字节相同）', JSON.stringify(layeredBarycentric([...left, ...right], crossingEdges)) === JSON.stringify(reordered))
check('x 坐标不变（只排同列 y）', reordered.R1?.x === 260 && reordered.R2?.x === 260)
check('槽位集合不变（不改变列内间距）', JSON.stringify([reordered.R1?.y, reordered.R2?.y].sort((a, b) => (a ?? 0) - (b ?? 0))) === JSON.stringify([0, 100]))

const withIsolated = layeredBarycentric(
  [...left, node('R3', 1, 200)],
  crossingEdges,
)
check('孤立节点保留在原槽位（不被重心算法挤走）', withIsolated.R3?.y === 200, withIsolated.R3)

console.log('\n[布局入口兼容]')
const identity = layoutPositionsOf([...left, ...right], 'layered')
check('不传边 ⇒ 保持宿主原坐标（旧调用方零改动）', identity.L1?.y === 0 && identity.R2?.y === 100)
const withEdges = layoutPositionsOf([...left, ...right], 'layered', crossingEdges)
check('传边 ⇒ 走重心排序', withEdges.R1?.y === 100 && withEdges.R2?.y === 0)
check('环形布局忽略边集（路径不变）', layoutPositionsOf([...left, ...right], 'radial', crossingEdges).L1 !== undefined)

console.log('\n[长边曲率]')
const short = longEdgeCurvature(node('a', 0, 0), node('b', 0, 0), 0)
check('短边不弯（保持直线与旧观感）', short === 0)
const longEven = longEdgeCurvature({ x: 0, y: 0 }, { x: 0, y: 500 }, 0)
check('长边产生轻微弯曲', longEven > 0 && longEven <= 56)
check('奇偶边反向（相邻长边不粘成一条粗带）', longEdgeCurvature({ x: 0, y: 0 }, { x: 0, y: 500 }, 1) === -longEven)
check('弯曲量有上限（不甩出视野）', longEdgeCurvature({ x: 0, y: 0 }, { x: 0, y: 2000 }, 0) === 56)
check('长度阈值以下不弯', longEdgeCurvature({ x: 0, y: 0 }, { x: 0, y: 300 }, 0) === 0)
check('同输入同输出（确定性）', longEdgeCurvature({ x: 0, y: 0 }, { x: 0, y: 500 }, 0) === longEven)

console.log('\n[窄容器间距自适应]')
check('宽容器不压缩（1185px ⇒ 1）', layoutSpacingFactor(1185) === 1)
check('窄容器压缩间距（730px ⇒ 0.8）', layoutSpacingFactor(730) === COMPACT_SPACING_FACTOR)
check('坏输入退回 1（不产生 NaN 坐标）', layoutSpacingFactor(Number.NaN) === 1 && layoutSpacingFactor(0) === 1)
const wide = { a: { x: 0, y: 0 }, b: { x: 260, y: 76 } }
check('factor=1 零变化（宽屏逐字节不变）', JSON.stringify(compactLayoutPositions(wide, 1)) === JSON.stringify(wide))
const compact = compactLayoutPositions(wide, COMPACT_SPACING_FACTOR)
check('压缩只作用于间距（左上角不动）', compact.a?.x === 0 && compact.a?.y === 0)
check('列距 260×0.8=208', Math.abs((compact.b?.x ?? 0) - 208) < 1e-9, compact.b)
check('行距 76×0.8=60.8', Math.abs((compact.b?.y ?? 0) - 60.8) < 1e-9, compact.b)
check('压缩后卡片仍不重叠（列距 > 卡片宽）', LAYOUT.columnGap * COMPACT_SPACING_FACTOR >= LAYOUT.nodeWidth)
check('压缩后行距仍大于卡片高', LAYOUT.rowGap * COMPACT_SPACING_FACTOR > LAYOUT.nodeHeight)
check('压缩是确定性投影（同输入同输出）', JSON.stringify(compactLayoutPositions(wide, 0.8)) === JSON.stringify(compact))

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')