import {
  IDENTITY,
  SCALE_MAX,
  SCALE_MIN,
  SpatialGrid,
  clampPan,
  clampScale,
  centerOf,
  centerOn,
  clipToRect,
  curveControl,
  curveEdgePath,
  fitToView,
  matchNodes,
  midpointOfQuadratic,
  panBy,
  pinchViewport,
  parallelCurvature,
  parallelIndexes,
  screenToWorld,
  traceFrom,
  worldToScreen,
  zoomAt,
  zoomBy,
  type Rect,
} from '../../src/client/viewport.ts'
// 图谱的纯数学已从 GuardGraph.tsx 抽到 graph-model.ts（组件拆分的产物）：
// 测试要跟着**定义**走，而不是跟着某个消费它的组件走 —— 组件还会继续搬。
import { shapePath } from '../../src/client/graph-model.ts'
import { detectClientLang, t, setLocaleFromHost } from '../../src/client/i18n.ts'
import { isSnapshot, isGraph } from '../../src/client/api.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function main() {
  console.log('\n== viewport scaling ==')
  check('the scale is clamped to the lower bound', clampScale(0.001) === SCALE_MIN, clampScale(0.001))
  check('the scale is clamped to the upper bound', clampScale(999) === SCALE_MAX, clampScale(999))
  check('a NaN scale falls back to 1', clampScale(Number.NaN) === 1, clampScale(Number.NaN))
  check('Infinity falls back to 1', clampScale(Number.POSITIVE_INFINITY) === 1)

  console.log('\n== zoom anchoring ==')
  // 指针下的世界坐标在缩放前后必须不变 —— 否则用户的视线会漂移。
  const viewport = { scale: 1, tx: 0, ty: 0 }
  const anchor = { x: 300, y: 200 }
  const worldBefore = screenToWorld(viewport, anchor)
  const zoomed = zoomAt(viewport, anchor, 2)
  const worldAfter = screenToWorld(zoomed, anchor)
  check(
    'the world point under the anchor is unchanged by zooming',
    Math.abs(worldBefore.x - worldAfter.x) < 1e-9 && Math.abs(worldBefore.y - worldAfter.y) < 1e-9,
    { worldBefore, worldAfter },
  )
  check('zooming in increases the scale', zoomed.scale === 2, zoomed.scale)
  const zoomedOut = zoomBy(viewport, anchor, 1 / 1.15)
  check('zooming out decreases the scale', zoomedOut.scale < 1, zoomedOut.scale)

  console.log('\n== coordinate transforms ==')
  const transformed = worldToScreen({ scale: 2, tx: 10, ty: 20 }, { x: 5, y: 5 })
  check('world to screen applies the transform', transformed.x === 20 && transformed.y === 30, transformed)
  const back = screenToWorld({ scale: 2, tx: 10, ty: 20 }, { x: 20, y: 30 })
  check('screen to world is the inverse', back.x === 5 && back.y === 5, back)

  console.log('\n== pan clamping (the deadlock guard) ==')
  const bounds: Rect = { minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000 }
  const size = { width: 800, height: 600 }
  const draggedFar = clampPan({ scale: 1, tx: -99999, ty: -99999 }, size, bounds)
  check('the graph cannot be dragged entirely off-screen', draggedFar.tx > -1000 - 48, draggedFar)
  check('a visible margin is always kept', draggedFar.tx <= 48, draggedFar)
  const smallContent: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 }
  const centered = clampPan({ scale: 1, tx: 5000, ty: 5000 }, size, smallContent)
  // 居中的判据是「内容中心落在视口中心」，不是「tx 为 0」。
  const contentCentre = worldToScreen(centered, { x: 50, y: 50 })
  check(
    'content smaller than the viewport is centred',
    Math.abs(contentCentre.x - size.width / 2) < 1e-6 && Math.abs(contentCentre.y - size.height / 2) < 1e-6,
    { centered, contentCentre },
  )
  // 世界原点不为 0 时，居中仍要正确（原点必须算进去）。
  const offsetContent: Rect = { minX: 1000, minY: 500, maxX: 1100, maxY: 600, width: 100, height: 100 }
  const offsetCentred = clampPan({ scale: 1, tx: 0, ty: 0 }, size, offsetContent)
  const offsetCentre = worldToScreen(offsetCentred, { x: 1050, y: 550 })
  check(
    'centring accounts for a non-zero world origin',
    Math.abs(offsetCentre.x - size.width / 2) < 1e-6 && Math.abs(offsetCentre.y - size.height / 2) < 1e-6,
    { offsetCentred, offsetCentre },
  )

  console.log('\n== fit to view ==')
  const fitted = fitToView(bounds, size, 16)
  check('the fitted scale shows the whole graph', fitted.scale > 0 && fitted.scale < 1, fitted.scale)
  const fittedScreen = worldToScreen(fitted, { x: bounds.minX, y: bounds.minY })
  check('the fitted view starts inside the viewport', fittedScreen.x >= 0 && fittedScreen.y >= 0, fittedScreen)
  const degenerate = fitToView({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }, size)
  check('an empty graph fits to the identity viewport', degenerate.scale === 1 && degenerate.tx === 0, degenerate)
  check('the identity viewport is the default', IDENTITY.scale === 1)

  console.log('\n== centre of the viewport ==')
  check('the centre is half the size', centerOf({ width: 800, height: 600 }).x === 400)
  check('a zero size yields a zero centre', centerOf({ width: 0, height: 0 }).x === 0)

  console.log('\n== panning ==')
  const panned = panBy({ scale: 1, tx: 10, ty: 20 }, 5, -5)
  check('panning moves the translation', panned.tx === 15 && panned.ty === 15, panned)
  check('panning keeps the scale', panned.scale === 1)

  console.log('\n== spatial grid hit testing ==')
  const nodes = [
    { id: 'a', x: 0, y: 0, w: 200, h: 56 },
    { id: 'b', x: 500, y: 500, w: 200, h: 56 },
    { id: 'c', x: 5000, y: 5000, w: 200, h: 56 },
  ]
  const grid = new SpatialGrid(nodes, 120)
  check('a click on a node hits it', grid.hit({ x: 100, y: 28 })?.id === 'a', grid.hit({ x: 100, y: 28 }))
  check('a click on empty space misses', grid.hit({ x: 300, y: 300 }) === null)
  check('a far node is still reachable', grid.hit({ x: 5100, y: 5028 })?.id === 'c')
  check('a click just outside the node misses', grid.hit({ x: 100, y: 200 }) === null)

  console.log('\n== graph tracing (BFS) ==')
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'x', to: 'y' },
  ]
  const traced = traceFrom('a', edges, 'outgoing')
  check('tracing follows the edges', traced.has('b') && traced.has('c'), [...traced])
  check('tracing does not reach unrelated nodes', !traced.has('y'), [...traced])
  const backwards = traceFrom('c', edges, 'incoming')
  check('backward tracing finds the producers', backwards.has('b') && backwards.has('a'), [...backwards])
  const both = traceFrom('b', edges, 'both')
  check('bidirectional tracing covers both sides', both.has('a') && both.has('c'), [...both])
  check('tracing starts with the origin', traced.has('a'))

  console.log('\n== node shapes (colour is not the only channel) ==')
  const shapes = ['circle', 'square', 'diamond', 'triangle', 'hexagon'] as const
  check('every shape produces a path', shapes.every((s) => shapePath(s, 10, 20).length > 0))
  check('different shapes produce different paths', new Set(shapes.map((s) => shapePath(s, 10, 20))).size === shapes.length)

  console.log('\n== edge clipping (cycle-3) ==')
  // 水平边：端点应裁到目标矩形左缘（箭头贴边，不扎进卡片中心）。
  const h = clipToRect(0, 50, 300, 50, { x: 200, y: 0, w: 100, h: 100 })
  check('a horizontal edge clips at the target left edge', h.x === 200 && h.y === 50, h)
  // 对角边：交点落在矩形边界上。
  const d = clipToRect(0, 0, 400, 400, { x: 200, y: 200, w: 100, h: 100 })
  check('a diagonal edge clips on the rect boundary', d.x === 200 && d.y === 200, d)
  // 完全不相交：退回原端点（不发明交点）。
  const miss = clipToRect(0, 0, 10, 10, { x: 200, y: 200, w: 100, h: 100 })
  check('a missing intersection returns the original endpoint', miss.x === 10 && miss.y === 10, miss)

  console.log('\n== curved edges (cycle v2) ==')
  // 零曲率 = 直线（与旧行为一致，老数据不变形）。
  check('zero curvature produces a straight line', curveEdgePath(0, 0, 100, 0, 0) === 'M 0 0 L 100 0', curveEdgePath(0, 0, 100, 0, 0))
  // 曲率沿法线方向推开控制点：水平边的控制点应在正上方或正下方。
  const c1 = curveControl(0, 0, 100, 0, 20)
  check('a positive curvature bows the control point off the line', c1.x === 50 && Math.abs(c1.y) === 20, c1)
  const c2 = curveControl(0, 0, 100, 0, -20)
  check('a negative curvature bows the other way', c1.y === -c2.y, { c1, c2 })
  // 端点重合：控制点退化为中点（不除零）。
  const c3 = curveControl(50, 50, 50, 50, 20)
  check('coincident endpoints degrade to the midpoint', c3.x === 50 && c3.y === 50, c3)
  // 路径指令：曲线用 Q，直线用 L。
  check('a curved path uses the Q command', curveEdgePath(0, 0, 100, 0, 20).includes('Q'), curveEdgePath(0, 0, 100, 0, 20))
  // 贝塞尔中点闭式公式：t=0.5 时 0.25A + 0.5C + 0.25B。
  const mid = midpointOfQuadratic(0, 0, 50, 20, 100, 0)
  check('the quadratic midpoint matches the closed form', mid.x === 50 && Math.abs(mid.y - 10) < 1e-9, mid)

  console.log('\n== parallel edge curvatures (cycle v2) ==')
  const pEdges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
    { from: 'a', to: 'b' },
  ]
  const pIdx = parallelIndexes(pEdges)
  check('parallel indexes count prior siblings', pIdx[0] === 0 && pIdx[1] === 1 && pIdx[2] === 2, pIdx)
  // 互逆边视为同一端点对：a→b 与 b→a 是第 0、1 条同伙边。
  check('reciprocal edges share the endpoint pair', pIdx[1] === 1, pIdx)
  check('the first parallel edge stays straight', parallelCurvature(0) === 0)
  const pos = parallelCurvature(1)
  const neg = parallelCurvature(2)
  check('odd siblings bow one way and even siblings the other', pos > 0 && neg < 0 && Math.abs(pos) === Math.abs(neg), { pos, neg })
  check('magnitude grows with the sibling index', Math.abs(parallelCurvature(3)) > Math.abs(parallelCurvature(1)))
  const lone = parallelIndexes([{ from: 'x', to: 'y' }])
  check('a lone edge has no curvature', parallelCurvature(lone[0] ?? 0) === 0)

  console.log('\n== search matching (cycle v2) ==')
  const searchable = [
    { id: 'guard.present.panel', label: '管理面板', ref: 'guard.present.panel' },
    { id: 'guard.tool.panel', label: '面板入口', ref: 'guard.tool.panel' },
    { id: 'guard.observe.metrics', label: '量化指标', ref: 'guard.observe.metrics' },
  ]
  check('an empty query matches nothing', matchNodes(searchable, '').length === 0)
  check('a whitespace query matches nothing', matchNodes(searchable, '   ').length === 0)
  // 精确 id 命中优先于标签子串。
  const exact = matchNodes(searchable, 'guard.present.panel')
  check('an exact id match ranks first', exact[0]?.id === 'guard.present.panel', exact.map((n) => n.id))
  const prefix = matchNodes(searchable, 'guard.tool')
  check('a prefix match beats a substring match', prefix[0]?.id === 'guard.tool.panel', prefix.map((n) => n.id))
  const byLabel = matchNodes(searchable, '面板')
  check('a label substring matches both panels', byLabel.length === 2, byLabel.map((n) => n.id))
  check('the limit caps the result count', matchNodes(searchable, 'guard', 2).length === 2)

  console.log('\n== centring on a node (cycle v2) ==')
  const centeredOn = centerOn({ scale: 1, tx: 0, ty: 0 }, { width: 800, height: 600 }, { x: 100, y: 50 })
  check(
    'centring puts the world point at the viewport centre',
    worldToScreen(centeredOn, { x: 100, y: 50 }).x === 400 && worldToScreen(centeredOn, { x: 100, y: 50 }).y === 300,
    centeredOn,
  )
  const zoomedCenter = centerOn({ scale: 1, tx: 0, ty: 0 }, { width: 800, height: 600 }, { x: 100, y: 50 }, 2)
  check('centring can retarget the scale', zoomedCenter.scale === 2, zoomedCenter)
  check(
    'the anchor stays centred after retargeting',
    worldToScreen(zoomedCenter, { x: 100, y: 50 }).x === 400,
    worldToScreen(zoomedCenter, { x: 100, y: 50 }),
  )

  console.log('\n== graph neighbor derivation (cycle-4 T04) ==')
  // 邻居派生与 GuardGraph 内的 useMemo 同一逻辑（可见边 + 可见节点过滤，
  // 自环不算邻居）：上游 = 指向我的边；下游 = 我指出的边；端点不可见时不算邻居。
  const neighborEdges = [
    { from: 'guard.observe.metrics', to: 'guard.present.panel' },
    { from: 'guard.decide.risk', to: 'guard.present.panel' },
    { from: 'guard.present.panel', to: 'guard.present.panel' }, // 自环：不算邻居
    { from: 'ghost.unknown', to: 'guard.present.panel' }, // 端点不在节点表里
  ]
  const neighborNodes = [
    { id: 'guard.observe.metrics' },
    { id: 'guard.decide.risk' },
    { id: 'guard.present.panel' },
    // 真正孤立（无任何边触及）的节点：必须在节点表里，否则「无边节点」
    // 断言对不存在的东西恒真——空洞为真不是证据（cycle-4 修复）。
    { id: 'guard.tool.lonely' },
  ]
  const nodeIds = new Set(neighborNodes.map((n) => n.id))
  const focus = 'guard.present.panel'
  const upstream = [
    ...new Set(
      neighborEdges.filter((e) => e.to === focus && e.from !== focus && nodeIds.has(e.from)).map((e) => e.from),
    ),
  ]
  const downstream = [
    ...new Set(
      neighborEdges.filter((e) => e.from === focus && e.to !== focus && nodeIds.has(e.to)).map((e) => e.to),
    ),
  ]
  check('upstream neighbours are the edges pointing at the focus', upstream.length === 2, upstream)
  check('a ghost endpoint is not a neighbour', !upstream.includes('ghost.unknown'))
  check('a self-loop does not make the node its own neighbour', !upstream.includes(focus) && !downstream.includes(focus), { upstream, downstream })
  check('downstream neighbours follow outgoing edges', downstream.length === 0, downstream)
  check('a node with no edges has no neighbours',
    (() => {
      // 真正孤立（无任何边触及）的节点：上游与下游都为空。
      const lonelyId = 'guard.tool.lonely'
      // 先钉「它在表里」，否则空集断言对幽灵 id 恒真。
      if (!nodeIds.has(lonelyId)) return false
      const lonelyIn = neighborEdges.filter((e) => e.to === lonelyId && e.from !== lonelyId && nodeIds.has(e.from)).map((e) => e.from)
      const lonelyOut = neighborEdges.filter((e) => e.from === lonelyId && e.to !== lonelyId && nodeIds.has(e.to)).map((e) => e.to)
      return lonelyIn.length === 0 && lonelyOut.length === 0
    })(),
  )

  console.log('\n== i18n ==')
  const lang = detectClientLang()
  check('the detected language is a known one', lang === 'zh' || lang === 'en', lang)
  const translated = t('panel.title')
  check('a known key is translated', translated !== 'panel.title', translated)
  const missing = t('does.not.exist')
  check('a missing key falls back to the key itself', missing === 'does.not.exist', missing)
  check('interpolation substitutes the placeholder', t('archives.entries', { count: 7 }).includes('7'), t('archives.entries', { count: 7 }))
  check('the host locale sync is callable', (() => { setLocaleFromHost('en'); return true })())
  // cycle v2 新键：图例（kind.*）与 KPI 文案走字典，缺失时回退键本身（看得见）。
  check('the graph kind legend keys are translated', t('graph.kind.capability') !== 'graph.kind.capability', t('graph.kind.capability'))
  check('the search placeholder is translated', t('graph.search') !== 'graph.search', t('graph.search'))
  check('the CUSUM metric label is translated', t('metrics.changePoint') !== 'metrics.changePoint', t('metrics.changePoint'))
  // cycle-4 新键：邻居导航、崩溃压力、归档摘要、分区路径。
  check('the neighbor group keys are translated', t('graph.neighborsUp') !== 'graph.neighborsUp' && t('graph.neighborsDown') !== 'graph.neighborsDown', { up: t('graph.neighborsUp'), down: t('graph.neighborsDown') })
  check('the crash pressure label is translated', t('metrics.crashPressure') !== 'metrics.crashPressure', t('metrics.crashPressure'))
  check('the archive summary keys are translated', t('archives.summaryCrashes', { count: 3 }).includes('3'), t('archives.summaryCrashes', { count: 3 }))

  console.log('\n== response shape validation ==')
  check('a snapshot shape is accepted', isSnapshot({ at: '2026-01-01', stage: 'monitoring' }))
  check('a snapshot without a timestamp is rejected', !isSnapshot({ stage: 'monitoring' }))
  check('a null response is rejected', !isSnapshot(null))
  check('a graph shape is accepted', isGraph({ nodes: [], edges: [] }))
  check('a graph without edges is rejected', !isGraph({ nodes: [] }))
  check('an unavailable marker is not a snapshot', !isSnapshot({ available: false, reason: 'x' }))

  console.log('\n== 双指捏合（v0.11.4）==')
  {
    // 两指距离翻倍、中点不动 ⇒ 缩放 ×2，中点下的世界点保持不动。
    const before = { scale: 1, tx: 0, ty: 0 }
    const zoomed = pinchViewport(before, { a: { x: 100, y: 100 }, b: { x: 200, y: 100 } }, { a: { x: 50, y: 100 }, b: { x: 250, y: 100 } })
    check('pinch out doubles the scale', Math.abs(zoomed.scale - 2) < 1e-9, zoomed)
    check(
      'the world point under the midpoint stays put',
      Math.abs(zoomed.tx + 150 * zoomed.scale - 150) < 1e-9 && Math.abs(zoomed.ty + 100 * zoomed.scale - 100) < 1e-9,
      zoomed,
    )
    // 中点平移、距离不变 ⇒ 视口跟随手指平移。
    const moved = pinchViewport(before, { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, { a: { x: 20, y: 0 }, b: { x: 120, y: 0 } })
    check('a moving midpoint pans the viewport', Math.abs(moved.scale - 1) < 1e-9 && Math.abs(moved.tx - 20) < 1e-9, moved)
    // 退化输入（两点重合/非有限）⇒ 原视口，绝不产生 Infinity。
    const degenerate = pinchViewport(before, { a: { x: 10, y: 10 }, b: { x: 10, y: 10 } }, { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } })
    check('coincident fingers return the viewport unchanged', degenerate.scale === before.scale && degenerate.tx === before.tx, degenerate)
    // 缩放上界钳制。
    const huge = pinchViewport(before, { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, { a: { x: 0, y: 0 }, b: { x: 100000, y: 0 } })
    check('pinch respects the scale ceiling', huge.scale === SCALE_MAX, huge.scale)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
