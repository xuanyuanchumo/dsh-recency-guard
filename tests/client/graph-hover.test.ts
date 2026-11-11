import {
  highlightForHover,
  isDimmedByHighlight,
} from '../../src/client/graph/graph-interaction.ts'
import type { GraphEdge, GraphNode } from '../../src/shared/graph-contract.ts'

/**
 * 悬停邻域高亮 —— 集合必须**闭合**：亮节点与亮边不能各说各的。
 *
 * 缺陷形态（浏览器里只表现为「图有点怪」）：
 * - 只高亮邻居节点、不高亮关联边 ⇒ 亮节点之间夹着暗边；
 * - 只高亮边、不把对端节点加进来 ⇒ 亮边指向暗节点；
 * - 悬停已过滤掉的节点时仍返回集合 ⇒ 画出一个指向空气的高亮。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function node(id: string): GraphNode {
  return { id, kind: 'capability', label: id, shape: 'circle', tone: 'neutral', x: 0, y: 0, column: 0 }
}
function edge(id: string, from: string, to: string): GraphEdge {
  return { id, from, to, kind: 'produces', tone: 'neutral' }
}

// a—b—c，a—d 构成一条分支；b—c 之外 c 只与 b 相邻。
const nodes = [node('a'), node('b'), node('c'), node('d')]
const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'a', 'd')]

console.log('\n[悬停节点：1 跳邻域 + 关联边]')
const hoverA = highlightForHover({ nodeId: 'a' }, nodes, edges)
check('返回高亮集而不是 null', hoverA !== null)
check('自身 + 1 跳邻居全部提亮', hoverA !== null && [...hoverA.nodes].sort().join(',') === 'a,b,d', hoverA?.nodes)
check('关联边全部提亮（e1,e3）', hoverA !== null && [...hoverA.edges].sort().join(',') === 'e1,e3', hoverA?.edges)
check('焦点类型是节点', hoverA?.focus === 'node')
check('2 跳的 c 不提亮', hoverA !== null && !hoverA.nodes.has('c'))
check('无关边 e2 不提亮', hoverA !== null && !hoverA.edges.has('e2'))

const hoverB = highlightForHover({ nodeId: 'b' }, nodes, edges)
check('中间节点连接两侧', hoverB !== null && [...hoverB.nodes].sort().join(',') === 'a,b,c' && hoverB.edges.size === 2)

console.log('\n[悬停边：两端节点 + 该边]')
const hoverEdge = highlightForHover({ edgeId: 'e2' }, nodes, edges)
check('两端节点提亮', hoverEdge !== null && [...hoverEdge.nodes].sort().join(',') === 'b,c', hoverEdge?.nodes)
check('只提亮这一条边', hoverEdge !== null && hoverEdge.edges.size === 1 && hoverEdge.edges.has('e2'))
check('焦点类型是边', hoverEdge?.focus === 'edge')
check('同端点的平行边不连带（e1 与 e2 端点不同）', hoverEdge !== null && !hoverEdge.edges.has('e1'))

console.log('\n[降透明度判定]')
check('悬停 a 时 2 跳节点 c 变暗', hoverA !== null && isDimmedByHighlight(hoverA, 'node', 'c'))
check('悬停 a 时邻居 b 不变暗', hoverA !== null && !isDimmedByHighlight(hoverA, 'node', 'b'))
check('悬停 a 时无关边 e2 变暗', hoverA !== null && isDimmedByHighlight(hoverA, 'edge', 'e2'))
check('悬停 a 时关联边 e1 不变暗', hoverA !== null && !isDimmedByHighlight(hoverA, 'edge', 'e1'))
check('无高亮时谁都不降', !isDimmedByHighlight(null, 'node', 'anything'))

console.log('\n[边界与恢复]')
check('离开悬停（空目标）返回 null', highlightForHover({}, nodes, edges) === null)
check('悬停不存在的节点返回 null（不画幽灵高亮）', highlightForHover({ nodeId: 'ghost' }, nodes, edges) === null)
check('悬停不存在的边返回 null', highlightForHover({ edgeId: 'ghost' }, nodes, edges) === null)
check('null 目标等价于离开', highlightForHover({ nodeId: null, edgeId: null }, nodes, edges) === null)

console.log('\n[自环]')
const selfEdge = edge('self', 'a', 'a')
const selfHighlight = highlightForHover({ nodeId: 'a' }, nodes, [selfEdge])
check('自环节点集只含自己', selfHighlight !== null && selfHighlight.nodes.size === 1 && selfHighlight.nodes.has('a'))
check('自环边进入高亮集', selfHighlight !== null && selfHighlight.edges.has('self'))
const selfEdgeHover = highlightForHover({ edgeId: 'self' }, nodes, [selfEdge])
check('悬停自环边两端是同一个节点', selfEdgeHover !== null && selfEdgeHover.nodes.size === 1 && selfEdgeHover.nodes.has('a'))

console.log('\n[过滤后的一致性]')
// 组件传入的是**可见**节点/边：被类型过滤掉的邻居不会出现在高亮集里。
const visibleNodes = [node('a'), node('b')]
const visibleEdges = [edge('e1', 'a', 'b')]
const filtered = highlightForHover({ nodeId: 'a' }, visibleNodes, visibleEdges)
check('邻居集只来自可见图', filtered !== null && [...filtered.nodes].sort().join(',') === 'a,b')
check('悬停已不可见的节点返回 null', highlightForHover({ nodeId: 'c' }, visibleNodes, visibleEdges) === null)

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')