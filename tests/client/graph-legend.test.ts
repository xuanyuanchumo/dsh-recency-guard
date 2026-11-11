import {
  clampHops,
  edgeKindCounts,
  filterGraph,
  kHopNeighborhood,
  kindCounts,
  linkRangeHops,
  toneCounts,
} from '../../src/client/graph/graph-model.ts'
import { toggleSetMember } from '../../src/client/graph/graph-interaction.ts'
import type { GraphEdge, GraphNode } from '../../src/shared/graph-contract.ts'

/**
 * 图例可开关 —— 三个正交维度（节点类型 / 边语义 / 语义色）。
 *
 * 关键不变式：**节点集与边集必须同源**。任何「先滤节点再用原边表」或
 * 「边滤了但端点没滤」的写法都会在图上留下指向空气的箭头，而界面
 * 不报错。这里的断言直接检查「边的两个端点都在可见节点集里」。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function node(id: string, kind: GraphNode['kind'], tone: GraphNode['tone'] = 'neutral'): GraphNode {
  return { id, kind, label: id, shape: 'circle', tone, x: 0, y: 0, column: 0 }
}
function edge(id: string, from: string, to: string, kind: GraphEdge['kind'] = 'produces'): GraphEdge {
  return { id, from, to, kind, tone: 'neutral' }
}

const nodes = [
  node('cap', 'capability', 'info'),
  node('bundle', 'bundle', 'error'),
  node('metric', 'metric', 'warn'),
]
const edges = [
  edge('e-produces', 'cap', 'metric', 'produces'),
  edge('e-consumes', 'metric', 'cap', 'consumes'),
  edge('e-ranks', 'bundle', 'cap', 'ranks'),
]

console.log('\n[按边语义隐藏]')
const noRanks = filterGraph(nodes, edges, { hidden: new Set(), onlyConnectedWith: null, hiddenEdgeKinds: new Set(['ranks']) })
check('节点集不受边过滤影响', noRanks.nodes.length === 3)
check('ranks 边被隐藏', noRanks.edges.length === 2 && noRanks.edges.every((e) => e.kind !== 'ranks'))
const noProduces = filterGraph(nodes, edges, { hidden: new Set(), onlyConnectedWith: null, hiddenEdgeKinds: new Set(['produces']) })
check('produces 边被隐藏', noProduces.edges.length === 2 && noProduces.edges.every((e) => e.kind !== 'produces'))
const allEdgesHidden = filterGraph(nodes, edges, {
  hidden: new Set(),
  onlyConnectedWith: null,
  hiddenEdgeKinds: new Set(['produces', 'consumes', 'ranks']),
})
check('全部边语义关掉 ⇒ 无边但节点仍在（空图不是空数据）', allEdgesHidden.edges.length === 0 && allEdgesHidden.nodes.length === 3)

console.log('\n[按语义色隐藏（含端点级联）]')
const noErrorTone = filterGraph(nodes, edges, { hidden: new Set(), onlyConnectedWith: null, hiddenTones: new Set(['error']) })
check('error 色的 bundle 消失', noErrorTone.nodes.every((n) => n.id !== 'bundle'))
check('连到 bundle 的 ranks 边同时消失（无幽灵箭头）', noErrorTone.edges.every((e) => e.from !== 'bundle' && e.to !== 'bundle'))
const toneAndEdge = filterGraph(nodes, edges, {
  hidden: new Set(),
  onlyConnectedWith: null,
  hiddenTones: new Set(['warn']),
  hiddenEdgeKinds: new Set(['consumes']),
})
check('两维过滤取交集', toneAndEdge.nodes.length === 2 && toneAndEdge.edges.length === 1 && toneAndEdge.edges[0]?.id === 'e-ranks')

console.log('\n[类型图例与端点一致性]')
const hiddenKinds = filterGraph(nodes, edges, { hidden: new Set(['bundle']), onlyConnectedWith: null })
const visible = new Set(hiddenKinds.nodes.map((n) => n.id))
check('隐藏类型后所有边的端点都可见', hiddenKinds.edges.every((e) => visible.has(e.from) && visible.has(e.to)))
check('旧调用方（不传新字段）行为不变', hiddenKinds.nodes.length === 2 && hiddenKinds.edges.length === 2)

console.log('\n[开关集合]')
const set = new Set(['ranks'])
const added = toggleSetMember(set, 'produces')
check('切换添加返回新集合', added.has('ranks') && added.has('produces'))
check('原集合不被修改（React 才能看到变化）', set.size === 1)
const removed = toggleSetMember(added, 'ranks')
check('再次切换即移除', !removed.has('ranks') && removed.has('produces'))

console.log('\n[图例计数取原始图]')
const kinds = kindCounts(nodes)
const tones = toneCounts(nodes)
const edgeKinds = edgeKindCounts(edges)
check('类型计数', kinds.capability === 1 && kinds.bundle === 1 && kinds.metric === 1, kinds)
check('语义色计数', tones.info === 1 && tones.error === 1 && tones.warn === 1, tones)
check('边语义计数', edgeKinds.produces === 1 && edgeKinds.consumes === 1 && edgeKinds.ranks === 1, edgeKinds)

console.log('\n[k 跳深度夹紧（1..3）]')
check('下界夹紧：0 → 1', clampHops(0) === 1)
check('负数夹紧到 1', clampHops(-5) === 1)
check('上界夹紧：99 → 3', clampHops(99) === 3)
check('小数向下取整', clampHops(2.9) === 2)
check('NaN → 1', clampHops(Number.NaN) === 1)
check('Infinity → 3（有限化后夹到上界）', clampHops(Number.POSITIVE_INFINITY) === 3)
check('档位映射：直接 = 1', linkRangeHops('hops1') === 1)
check('档位映射：两跳 = 2', linkRangeHops('hops2') === 2)
check('档位映射：三跳 = 3', linkRangeHops('hops3') === 3)
check('档位映射：闭包 = null', linkRangeHops('closure') === null)

console.log('\n[k 跳与档位同源（链 a-b-c-d）')
const chain = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd')]
check('1 跳 = 直接邻居', [...kHopNeighborhood('a', chain, clampHops(1))].sort().join(',') === 'a,b')
check('2 跳 = 邻居的邻居', [...kHopNeighborhood('a', chain, clampHops(2))].sort().join(',') === 'a,b,c')
check('3 跳 = 整条链（不越过夹紧上限）', [...kHopNeighborhood('a', chain, clampHops(3))].sort().join(',') === 'a,b,c,d')
check('闭包仍是传递闭包', [...kHopNeighborhood('a', chain, 3)].length === 4)
check('k 跳邻域包含起点自身', kHopNeighborhood('a', chain, 1).has('a'))

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')