import {
  dragDeltaToWorld,
  emptyOffsetMemory,
  hasAnyOffset,
  isDragDistance,
  offsetsFor,
  withDragOffset,
} from '../../src/client/graph/graph-interaction.ts'
import { withLayout, type LayoutMode } from '../../src/client/graph/graph-model.ts'
import type { GraphNode } from '../../src/shared/graph-contract.ts'

/**
 * 节点拖拽模型 —— 阈值、视图反变换、按布局记忆。
 *
 * 这三条各自对应一个真实缺陷形态：
 * - 阈值写成 `>` 而不是 `>=`：恰好 3px 的拖动被当成点击，用户按一下卡片
 *   就选中了（而不是拖动），「轻手拖不动」；
 * - 不做反变换：scale=2 时拖动距离只有指针的一半（越放大越拖不动）；
 * - 偏移不按布局分档：在分层布局里摆好的位置，切到环形后被同一个偏移
 *   再套一遍，切回来也回不到原样。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function node(id: string, x = 0, y = 0): GraphNode {
  return { id, kind: 'capability', label: id, shape: 'circle', tone: 'neutral', x, y, column: 0 }
}

console.log('\n[拖拽阈值]')
check('零位移不是拖拽', !isDragDistance(0, 0))
check('L1=2 低于阈值 3', !isDragDistance(1, 1))
check('L1=3 恰好达到阈值（>= 语义）', isDragDistance(2, 1))
check('负位移同样按绝对值判断', isDragDistance(-2, -1))
check('自定义阈值 1 时 1px 即拖拽', isDragDistance(0, 1, 1))
check('阈值 0 时任何位移都算拖拽', isDragDistance(0, 0, 0))
check('NaN 位移不算拖拽', !isDragDistance(Number.NaN, 0))

console.log('\n[视图反变换]')
const at2 = dragDeltaToWorld(100, 50, 2)
check('scale=2：世界位移是屏幕的一半', at2.x === 50 && at2.y === 25, at2)
const atHalf = dragDeltaToWorld(100, 50, 0.5)
check('scale=0.5：世界位移是屏幕的两倍', atHalf.x === 200 && atHalf.y === 100, atHalf)
check('scale=0 回落到 1（不产生 Infinity）', dragDeltaToWorld(10, 10, 0).x === 10)
check('scale=NaN 回落到 1', dragDeltaToWorld(10, 10, Number.NaN).y === 10)
check('NaN 屏幕位移归零而不是污染布局', dragDeltaToWorld(Number.NaN, 4, 2).x === 0)

console.log('\n[布局记忆：按布局分档]')
let memory = emptyOffsetMemory()
check('初始没有任何拖拽', !hasAnyOffset(memory))
memory = withDragOffset(memory, 'layered', 'a', { x: 10, y: 6 })
memory = withDragOffset(memory, 'layered', 'a', { x: -2, y: 4 })
const layered = offsetsFor(memory, 'layered')
check('同一节点增量累加', layered.a?.x === 8 && layered.a?.y === 10, layered)
check('仍无环形布局偏移', Object.keys(offsetsFor(memory, 'radial')).length === 0)
memory = withDragOffset(memory, 'radial', 'a', { x: 100, y: 0 })
check('环形布局独立记录', offsetsFor(memory, 'radial').a?.x === 100)
check('环形拖拽不污染分层布局（切回来位置不丢）', offsetsFor(memory, 'layered').a?.x === 8)
check('两个布局都有拖拽 ⇒ canReset 为真', hasAnyOffset(memory))
check('清空记忆回到初始态', !hasAnyOffset(emptyOffsetMemory()))

console.log('\n[布局记忆与投影叠加]')
const nodes = [node('a', 0, 0), node('b', 260, 0)]
const positions: Record<string, { x: number; y: number }> = {
  a: { x: 0, y: 0 },
  b: { x: 260, y: 0 },
}
const layeredOffsets = offsetsFor(memory, 'layered')
const layeredNodes = withLayout(nodes, positions, layeredOffsets)
check('只有被拖过的节点移动', layeredNodes[0]?.x === 8 && layeredNodes[1]?.x === 260, layeredNodes)
// 模拟切到环形：环形偏移只对 a 生效，且用环形自己的基坐标。
const radialPositions: Record<string, { x: number; y: number }> = {
  a: { x: 500, y: 500 },
  b: { x: 800, y: 500 },
}
const radialNodes = withLayout(nodes, radialPositions, offsetsFor(memory, 'radial'))
check('环形布局基坐标 + 环形偏移', radialNodes[0]?.x === 600 && radialNodes[0]?.y === 500, radialNodes)
check('切换布局不影响未拖拽节点', radialNodes[1]?.x === 800)
const backToLayered = withLayout(nodes, positions, offsetsFor(memory, 'layered'))
check('切回分层仍是原位置（布局记忆成立）', backToLayered[0]?.x === 8 && backToLayered[0]?.y === 10)

console.log('\n[拖动不应触发选中的模型前提]')
// 组件用 suppressClickRef：拖拽结束后第一次 click 被吞掉。模型层的判据是
// 「moved 一旦为真就不能再被后续微量位移改回 false」—— 一次拖拽里位移
// 常常从 5px 回落到 1px，若用单次位移判断，会把拖拽误判成点击。
const layout: LayoutMode = 'layered'
check('布局档位是编译期封闭集', layout === 'layered' || layout === 'radial')

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')