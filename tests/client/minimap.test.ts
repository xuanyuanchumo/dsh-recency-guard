import type { GraphNode } from '../../src/graph-data.ts'
import { graphBounds } from '../../src/client/graph-model.ts'
// v0.12 拆分：小地图几何独立成 minimap-model.ts（graph-model 复杂度热点越预算）。
// graphBounds 留在 graph-model —— 它是节点集合的度量，不是小地图专属。
import {
  MINIMAP_PADDING,
  minimapNodeRects,
  minimapProjection,
  minimapViewportRect,
  minimapToWorld,
  worldToMinimap,
} from '../../src/client/minimap-model.ts'
import { IDENTITY, SCALE_MIN, clampPan, fitToView, type Rect } from '../../src/client/viewport.ts'

/**
 * 小地图投影的纯函数测试。
 *
 * 小地图是**指南针**：它一旦说谎，用户会按错误的方向去拖画面 ——
 * 比没有小地图更糟。所以这里钉死四类不变式：
 * 1. 正逆映射往返一致（否则「拖框定位」越纠偏越偏）；
 * 2. 纵横比守恒（长条图不能被拉成方块）；
 * 3. 视口框与图形求交且不溢出（否则看起来像控件坏了）；
 * 4. 全览判定的比较对象是**图的投影尺寸**而不是画布尺寸。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const CANVAS = { width: 152, height: 96 }

function node(id: string, x: number, y: number): GraphNode {
  return { id, kind: 'capability', label: id, shape: 'circle', tone: 'neutral', x, y, column: 0 }
}

function main() {
  console.log('\n== 投影：往返一致性 ==')
  {
    // 一张 3 列宽、2 行高的长条图。
    const nodes = [node('a', 40, 40), node('b', 300, 40), node('c', 560, 116)]
    const bounds = graphBounds(nodes)
    const proj = minimapProjection(bounds, CANVAS)
    let maxError = 0
    for (const point of [{ x: 0, y: 0 }, { x: 137, y: 61 }, { x: 24, y: 90 }, { x: bounds.minX, y: bounds.minY }]) {
      const back = minimapToWorld(proj, worldToMinimap(proj, point))
      maxError = Math.max(maxError, Math.abs(back.x - point.x), Math.abs(back.y - point.y))
    }
    check('world→map→world 往返误差 < 1e-9', maxError < 1e-9, maxError)
    check('投影保纵横比（单缩放系数）', proj.worldScale > 0 && Number.isFinite(proj.worldScale), proj.worldScale)
    // 纵横比守恒：世界里的正方形映射后仍是正方形（各轴同系数）。
    const squareA = worldToMinimap(proj, { x: 100, y: 100 })
    const squareB = worldToMinimap(proj, { x: 200, y: 200 })
    check('两轴的缩放增量相等', Math.abs(squareB.x - squareA.x - (squareB.y - squareA.y)) < 1e-9)
    check('投影落在画布内（含 padding）',
      squareA.x >= 0 && squareA.x <= CANVAS.width && squareA.y >= 0 && squareA.y <= CANVAS.height, squareA)
    check('offsetX 至少是 padding（留边可见）', proj.offsetX >= MINIMAP_PADDING && proj.offsetY >= MINIMAP_PADDING, proj)
  }

  console.log('\n== 退化输入：不产生 NaN / Infinity ==')
  {
    const empty: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
    const proj = minimapProjection(empty, CANVAS)
    check('空图投影仍是有限数', Number.isFinite(proj.worldScale) && proj.worldScale > 0, proj)
    check('空图 figureWidth = 0（什么都不画）', proj.figureWidth === 0 && proj.figureHeight === 0, proj)
    const zeroCanvas = minimapProjection(graphBounds([node('a', 0, 0)]), { width: 0, height: 0 })
    check('零画布不产生除零（Infinity 会污染整块 SVG）', Number.isFinite(zeroCanvas.worldScale), zeroCanvas)
    const roundTrip = minimapToWorld(proj, worldToMinimap(proj, { x: 5, y: 5 }))
    check('退化投影的逆映射有限', Number.isFinite(roundTrip.x) && Number.isFinite(roundTrip.y), roundTrip)
    const badScale = minimapViewportRect({ ...proj, worldScale: Number.NaN }, { scale: 1, tx: 0, ty: 0 }, { width: 800, height: 600 })
    check('NaN 缩放的框不溢出成 Infinity', Number.isFinite(badScale.x) && Number.isFinite(badScale.w), badScale)
    check('节点矩形表：空图给空表而不是 [NaN]', minimapNodeRects([], proj, () => '').length === 0)
  }

  console.log('\n== 节点矩形：可见性下界 ==')
  {
    // 一张很大的图（worldScale 会远小于 1）：按真实比例只有亚像素，
    // 亚像素矩形在 SVG 里不可见 ⇒ 小地图成了黑块。必须有下限。
    const wide = [node('a', 0, 0), node('b', 4000, 3000)]
    const proj = minimapProjection(graphBounds(wide), CANVAS)
    check('这张图的 worldScale 小于 1（真的会被缩到亚像素）', proj.worldScale < 0.05, proj.worldScale)
    const rects = minimapNodeRects(wide, proj, (n) => n.tone)
    check('每个矩形宽度 ≥ 1.5px（肉眼可见）', rects.every((r) => r.w >= 1.5), rects)
    check('每个矩形高度 ≥ 1px', rects.every((r) => r.h >= 1), rects)
    check('矩形 id 与节点一一对应（不截断）', rects.length === wide.length && rects.map((r) => r.id).join() === wide.map((n) => n.id).join())
    // 被拖出 bounds 之外的节点（bounds 变 → 投影变）仍需存在。
    check('矩形数量 = 传入节点数（数据层不截断）', rects.length === 2)
  }

  console.log('\n== 视口框：求交、饱和与全览判定 ==')
  {
    const nodes = [node('a', 40, 40), node('b', 300, 40), node('c', 560, 116)]
    const bounds = graphBounds(nodes)
    const proj = minimapProjection(bounds, CANVAS)
    const size = { width: 800, height: 600 }

    // fit 之后应该正好全览 ⇒ 框铺满图形并标 zoomedOut。
    const fitted = clampPan(fitToView(bounds, size), size, bounds)
    const fullView = minimapViewportRect(proj, fitted, size)
    check('fit 后判为全览', fullView.zoomedOut === true, fullView)
    check('全览时框 = 图形投影（不是画布尺寸）',
      Math.abs(fullView.w - proj.figureWidth) < 1e-9 && Math.abs(fullView.h - proj.figureHeight) < 1e-9,
      { fullView, proj })

    // 放大 4 倍并居中到一个角：框必须明显小于图形，且不溢出。
    const zoomed = { scale: 4, tx: -proj.minX * 4 + 10, ty: -proj.minY * 4 + 10 }
    const partial = minimapViewportRect(proj, zoomed, size)
    check('放大后判为非全览', partial.zoomedOut === false, partial)
    check('局部框严格落在图形内部',
      partial.x >= proj.offsetX - 1e-9 &&
        partial.y >= proj.offsetY - 1e-9 &&
        partial.x + partial.w <= proj.offsetX + proj.figureWidth + 1e-9 &&
        partial.y + partial.h <= proj.offsetY + proj.figureHeight + 1e-9,
      { partial, offsetX: proj.offsetX, figureWidth: proj.figureWidth })
    // 「在看局部」的准确含义：可见世界区间与图形区间**求交**后再投影。
    // 这里放大 4 倍后可见世界 x ∈ [37.5, 237.5]，而图形 x 从 40 起 ——
    // 左侧有 2.5 世界像素落在图外，所以框宽是 (237.5−40)·0.2=39.5 而不是 40。
    // 断言若按「可见宽×缩放」直算会得 40，那种写法本身就是这个函数要防的错。
    const worldLeft = (0 - zoomed.tx) / 4
    const worldRight = (size.width - zoomed.tx) / 4
    const worldTop = (0 - zoomed.ty) / 4
    const worldBottom = (size.height - zoomed.ty) / 4
    const expectedWidth = (Math.min(worldRight, bounds.maxX) - Math.max(worldLeft, bounds.minX)) * proj.worldScale
    const expectedHeight = (Math.min(worldBottom, bounds.maxY) - Math.max(worldTop, bounds.minY)) * proj.worldScale
    check('框宽 = 可见区间与图形区间的交集', Math.abs(partial.w - expectedWidth) < 1e-9, {
      got: partial.w,
      expected: expectedWidth,
    })
    check('框高 = 可见区间与图形区间的交集', Math.abs(partial.h - expectedHeight) < 1e-9, {
      got: partial.h,
      expected: expectedHeight,
    })
    check('看不全的那个轴确实短于图形', partial.w < proj.figureWidth, partial)
    check('装得下的那个轴恰好铺满图形（不虚假留白）',
      Math.abs(partial.h - proj.figureHeight) < 1e-9, { h: partial.h, figureHeight: proj.figureHeight })

    // 把视野整体拖到图形左上之外的极端视口：框不得溢出成负尺寸。
    const extreme = minimapViewportRect(proj, { scale: 4, tx: 20000, ty: 20000 }, size)
    check('极端偏移出界时框尺寸非负', extreme.w >= 0 && extreme.h >= 0, extreme)
    check('极端偏移出界时位置仍在画布内',
      extreme.x >= 0 && extreme.x <= CANVAS.width && extreme.y >= 0 && extreme.y <= CANVAS.height, extreme)

    // 全览判定的关键回归：**小图 + 大画布**。此时图形的投影远小于画布，
    // 若阈值写成 canvas.width/height（我第一版就是这么错的），框永远够不到
    // 阈值 ⇒ 明明已全览却显示一个「局部」框 —— 说谎的指南针。
    const smallNodes = [node('a', 0, 0), node('b', 260, 76)]
    const smallBounds = graphBounds(smallNodes)
    const smallProj = minimapProjection(smallBounds, CANVAS)
    check('这张小图的投影明显小于画布（构造出阈值误用的判据）',
      smallProj.figureWidth < CANVAS.width - 1 && smallProj.figureHeight < CANVAS.height - 1,
      { figure: [smallProj.figureWidth, smallProj.figureHeight], canvas: [CANVAS.width, CANVAS.height] })
    const smallFit = clampPan(fitToView(smallBounds, size), size, smallBounds)
    const smallView = minimapViewportRect(smallProj, smallFit, size)
    check('小图 fit 后判全览（用画布尺寸当阈值就会判错）', smallView.zoomedOut === true, smallView)
    check('全览框铺满图形而不是画布', Math.abs(smallView.w - smallProj.figureWidth) < 1e-9, smallView)

    // 诚实的另一半：一张 4200px 宽的长条图在 SCALE_MIN=0.25 下**装不进**视口，
    // 此时 fit 之后仍然不是全览 —— 小地图必须如实说「还有没看见的」，
    // 这恰是它存在的理由（状态条的百分比说不出这句话）。
    const longBounds = graphBounds([node('a', 0, 0), node('b', 4000, 100)])
    const longProj = minimapProjection(longBounds, CANVAS)
    const longFit = clampPan(fitToView(longBounds, size), size, longBounds)
    check('长条图 fit 后的缩放被钳在下界', longFit.scale === SCALE_MIN, longFit)
    check('长条图 fit 后仍判非全览（诚实：确有看不见的部分）',
      minimapViewportRect(longProj, longFit, size).zoomedOut === false,
      minimapViewportRect(longProj, longFit, size))

    // 恒等视口 + 小图：可见区远大于图 ⇒ 全览。
    const identityView = minimapViewportRect(proj, IDENTITY, size)
    check('恒等视口下小图判全览', identityView.zoomedOut === true, identityView)
  }

  console.log('\n== 确定性（同输入同输出）==')
  {
    const nodes = [node('a', 40, 40), node('b', 300, 40)]
    const bounds = graphBounds(nodes)
    const first = JSON.stringify(minimapNodeRects(nodes, minimapProjection(bounds, CANVAS), (n) => n.tone))
    const second = JSON.stringify(minimapNodeRects(nodes, minimapProjection(bounds, CANVAS), (n) => n.tone))
    check('矩形表是数据的确定性投影（轮询不改变小地图）', first === second)
    const viewA = minimapViewportRect(minimapProjection(bounds, CANVAS), { scale: 2, tx: 5, ty: 7 }, { width: 800, height: 600 })
    const viewB = minimapViewportRect(minimapProjection(bounds, CANVAS), { scale: 2, tx: 5, ty: 7 }, { width: 800, height: 600 })
    check('视口框同样确定', JSON.stringify(viewA) === JSON.stringify(viewB))
  }

  console.log(failures === 0 ? '\nminimap 全部通过\n' : `\n${failures} 个断言失败\n`)
  if (failures > 0) process.exit(1)
}

main()
