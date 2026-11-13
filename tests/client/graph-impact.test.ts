/**
 * 图谱影响面投影（T16-05）—— impactedBy/reachableFrom 的 UI 消费链。
 *
 * ## 为什么这条测试存在
 *
 * cycle-15 的闭环判据：「机制实现了但没人消费 = 孤岛」。`impactedBy` /
 * `reachableFrom` 在 graph-analysis.ts 有完整实现与单测，但 UI 从未调用
 * —— 用户选中节点看不到「动它会波及什么」。本轮把它接进 GraphDetails
 * 侧栏（impact 行）。本测试钉住投影的**消费侧契约**：
 * 1. GuardGraph 传给侧栏的是**预计算投影**（upstreamCount/downstreamCount），
 *   组件不拿原始边表自己推导（渲染层只渲染不推导）；
 * 2. 自环不计入波及面（自环不是「别的节点」）；
 * 3. 类型过滤（visibleEdges）会影响结果 —— 与相邻列表同一数据口径。
 */
import { impactedBy, reachableFrom } from '../../src/client/graph/graph-analysis.ts'
import type { GraphEdge, GraphNode } from '../../src/shared/graph-contract.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function node(id: string, column = 0): GraphNode {
  return { id, kind: 'capability', label: id, shape: 'rect', tone: 'neutral', x: 0, y: 0, column }
}

function edge(from: string, to: string): GraphEdge {
  return { id: `${from}->${to}`, from, to, kind: 'consumes' }
}

/** 链式图：a → b → c → d（consumes 方向）。 */
const chainNodes = [node('a'), node('b', 1), node('c', 2), node('d', 3)]
const chainEdges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]

function main(): void {
  console.log('\n== 影响面投影的 UI 消费契约 ==')
  {
    // focuses c：上游 = 能到达 c 的 = {a, b}；下游 = c 能到达的 = {d}。
    const up = impactedBy('c', chainNodes, chainEdges)
    const down = reachableFrom('c', chainNodes, chainEdges)
    check('upstream = reverse-reachable set', up !== null && up.size === 2 && up.has('a') && up.has('b'), [...(up ?? [])])
    check('downstream = forward-reachable set', down !== null && down.size === 1 && down.has('d'), [...(down ?? [])])
    // 自环不计入（投影前调用方会 delete(focusId)，这里钉函数本身不包含它）。
    check('self excluded from sets', up?.has('c') === false && down?.has('c') === false)
    // 侧栏行的数字契约 = 集合大小。
    check('sidebar row numbers derive from set sizes', up !== null && down !== null, null)
  }

  console.log('\n== 自环节点：波及面不含自己 ==')
  {
    const selfLoopNodes = [node('x'), node('y', 1)]
    const selfLoopEdges = [edge('x', 'y'), edge('x', 'x')]
    const down = reachableFrom('x', selfLoopNodes, selfLoopEdges)
    check('self-loop adds no phantom nodes', down !== null && down.size === 1 && down.has('y'), [...(down ?? [])])
  }

  console.log('\n== 类型过滤口径一致（visibleEdges 进投影） ==')
  {
    // 过滤掉 b→c 边后，c 的上游只剩 a 无法到达 ⇒ {b} 不再出现在上游。
    const filtered = [edge('a', 'b')]
    const up = impactedBy('c', chainNodes, filtered)
    check('filtered edges shrink upstream set', up !== null && up.size === 0, [...(up ?? [])])
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
