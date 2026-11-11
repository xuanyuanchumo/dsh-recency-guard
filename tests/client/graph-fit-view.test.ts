import { shouldFit, type FitReason } from '../../src/client/graph/graph-interaction.ts'
import { clampPan, fitToView, resetToActualSize, type Rect } from '../../src/client/graph/viewport.ts'

/**
 * fit / reset 视图按钮与「轮询不重 fit」纪律。
 *
 * 这条纪律在本仓库是铁律（CLAUDE.md）：数据轮询会让节点引用变化，
 * 若 effect 顺手重 fit，用户刚调好的缩放每 5 秒被重置一次。此前它只靠
 * effect 依赖数组表达 —— 一次手滑把 bounds 加进依赖就静默破坏。现在
 * `shouldFit` 是白名单，可逐原因断言。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n[fit 白名单]')
check('首次且未 fit 过 ⇒ 允许（否则没有画面）', shouldFit('initial', false))
check('首次但已 fit 过 ⇒ 拒绝（重复挂载不重置）', !shouldFit('initial', true))
check('显式切换布局 ⇒ 允许（旧视口对着空白）', shouldFit('layout-switch', true))
check('容器尺寸变化 ⇒ 拒绝（只重钳制平移，不动缩放）', !shouldFit('resize', true))
check('数据轮询 ⇒ 拒绝（铁律本身）', !shouldFit('data-poll', true))
check('数据轮询在未 fit 时也不接管（首次 fit 有专属时机）', !shouldFit('data-poll', false))
// 穷举：除了这三个允许的组合，其余一律拒绝 —— 白名单漏一项就是回归。
const ALLOWED = new Set(['initial:false', 'layout-switch:true', 'layout-switch:false'])
const reasons: FitReason[] = ['initial', 'layout-switch', 'resize', 'data-poll']
let mismatches = 0
for (const reason of reasons) {
  for (const fitted of [false, true]) {
    const expected = ALLOWED.has(`${reason}:${fitted}`)
    if (shouldFit(reason, fitted) !== expected) mismatches += 1
  }
}
check('8 种组合的放行面与白名单完全一致', mismatches === 0, mismatches)

console.log('\n[reset：1:1 + 居中]')
const bounds: Rect = { minX: 0, minY: 0, maxX: 400, maxY: 200, width: 400, height: 200 }
const size = { width: 800, height: 400 }
const reset = resetToActualSize(bounds, size)
check('缩放恒为 1（不是 fit 出来的比例）', reset.scale === 1)
check('水平居中：tx = (800-400)/2', reset.tx === 200, reset)
check('垂直居中：ty = (400-200)/2', reset.ty === 100, reset)
check('内容中心映射到视口中心', 200 * reset.scale + reset.tx === 400 && 100 * reset.scale + reset.ty === 200)

const offsetBounds: Rect = { minX: -100, minY: 40, maxX: 300, maxY: 240, width: 400, height: 200 }
const offsetReset = resetToActualSize(offsetBounds, size)
check('非零原点也居中（减去 minX/minY）', offsetBounds.minX * 1 + offsetReset.tx === 200 && offsetBounds.minY * 1 + offsetReset.ty === 100)

console.log('\n[reset vs fit：大图上的区别]')
const bigBounds: Rect = { minX: 0, minY: 0, maxX: 4000, maxY: 2000, width: 4000, height: 2000 }
const fitted = fitToView(bigBounds, size)
check('fit 会缩小到看得全（< 1）', fitted.scale < 1, fitted)
check('reset 仍是 100%（承诺原始尺寸）', resetToActualSize(bigBounds, size).scale === 1)
check('reset 后大图仍可用 clampPan 钳制（不留死锁）', clampPan(resetToActualSize(bigBounds, size), size, bigBounds).tx !== undefined)

console.log('\n[退化输入]')
const empty = resetToActualSize({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }, size)
check('空图 reset 仍返回合法视口（scale=1，无 NaN）', empty.scale === 1 && Number.isFinite(empty.tx))
const zeroSize = resetToActualSize(bounds, { width: 0, height: 0 })
check('零尺寸容器不产生 NaN', Number.isFinite(zeroSize.tx) && Number.isFinite(zeroSize.ty) && zeroSize.scale === 1)

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')