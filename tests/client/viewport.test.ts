import {
  IDENTITY,
  SCALE_MAX,
  SCALE_MIN,
  SpatialGrid,
  clampPan,
  clampScale,
  centerOf,
  clipToRect,
  fitToView,
  panBy,
  screenToWorld,
  traceFrom,
  worldToScreen,
  zoomAt,
  zoomBy,
  type Rect,
} from '../../src/client/viewport.ts'
import { shapePath } from '../../src/client/GuardGraph.tsx'
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

  console.log('\n== i18n ==')
  const lang = detectClientLang()
  check('the detected language is a known one', lang === 'zh' || lang === 'en', lang)
  const translated = t('panel.title')
  check('a known key is translated', translated !== 'panel.title', translated)
  const missing = t('does.not.exist')
  check('a missing key falls back to the key itself', missing === 'does.not.exist', missing)
  check('interpolation substitutes the placeholder', t('archives.entries', { count: 7 }).includes('7'), t('archives.entries', { count: 7 }))
  check('the host locale sync is callable', (() => { setLocaleFromHost('en'); return true })())

  console.log('\n== response shape validation ==')
  check('a snapshot shape is accepted', isSnapshot({ at: '2026-01-01', stage: 'monitoring' }))
  check('a snapshot without a timestamp is rejected', !isSnapshot({ stage: 'monitoring' }))
  check('a null response is rejected', !isSnapshot(null))
  check('a graph shape is accepted', isGraph({ nodes: [], edges: [] }))
  check('a graph without edges is rejected', !isGraph({ nodes: [] }))
  check('an unavailable marker is not a snapshot', !isSnapshot({ available: false, reason: 'x' }))

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
