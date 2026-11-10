/**
 * 图谱结构分析（v0.13 T11-08/09）的回归。
 *
 * 这一层解决的是「图能画但读不出结构」：枢纽、只生产、只消费、孤立、
 * 可达、影响面、最短路径。每个函数都是纯函数，因此可以逐条钉死。
 *
 * 重点覆盖**诚实边界**：
 * - 空图 ⇒ `empty=true`（不伪造「0 个枢纽」）
 * - 起点/目标不在图里 ⇒ `null`（不是空数组 —— 「问错了」≠「确实没有」）
 * - 自环与幽灵边不计度数（否则节点凭自环变成枢纽）
 */
import {
  analyzeStructure,
  impactedBy,
  reachableFrom,
  shortestPath,
  structureInsights,
} from '../../src/client/graph-analysis.ts'
import type { GraphEdge, GraphNode } from '../../src/capability/graph-data.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function node(id: string, label = id): GraphNode {
  return { id, kind: 'capability', label, shape: 'circle', tone: 'neutral', x: 0, y: 0, column: 0 }
}

function edge(from: string, to: string): GraphEdge {
  return { id: `${from}->${to}`, from, to, kind: 'produces', tone: 'neutral' }
}

function main() {
  console.log('\n== analyzeStructure：角色判定 ==')
  {
    // a -> b -> c，b -> d：b 是枢纽（进 1 出 2 = 3）
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('b', 'd')]
    const s = analyzeStructure(nodes, edges)
    const byId = new Map(s.degrees.map((d) => [d.id, d]))
    check('a 是 source（只出不进）', byId.get('a')?.role === 'source', byId.get('a'))
    check('b 是 hub（进 1 出 2，总度数 3）', byId.get('b')?.role === 'hub', byId.get('b'))
    check('c 是 sink（只进不出）', byId.get('c')?.role === 'sink', byId.get('c'))
    check('边数 3', s.edgeCount === 3)
    check('degrees 按总度数降序', s.degrees[0]?.id === 'b', s.degrees.map((d) => d.id))
    check('空图标记为 false', s.empty === false)
  }

  console.log('\n== 自环与幽灵边不计度数 ==')
  {
    const nodes = [node('x'), node('y')]
    // x 自环 5 次 + 幽灵边（端点不存在）
    const edges = [edge('x', 'x'), edge('x', 'x'), edge('x', 'x'), edge('ghost', 'x'), edge('x', 'ghost')]
    const s = analyzeStructure(nodes, edges)
    const x = s.degrees.find((d) => d.id === 'x')
    check('自环不让 x 变成 hub', x?.role === 'isolated', x)
    check('幽灵边不计入 edgeCount', s.edgeCount === 0, s.edgeCount)
  }

  console.log('\n== 空图：诚实返回，不伪造健康结论 ==')
  {
    const s = analyzeStructure([], [])
    check('empty=true', s.empty === true)
    check('无枢纽（不是「0 个枢纽」的假结论）', s.hubs.length === 0)
    check('structureInsights 返回空数组', structureInsights(s).length === 0, structureInsights(s))
  }

  console.log('\n== 孤立节点 ==')
  {
    const nodes = [node('a'), node('b'), node('lonely')]
    const s = analyzeStructure(nodes, [edge('a', 'b')])
    check('孤立节点被识别', s.isolated.length === 1 && s.isolated[0]?.id === 'lonely', s.isolated)
  }

  console.log('\n== reachableFrom：可达集 ==')
  {
    const nodes = [node('a'), node('b'), node('c'), node('z')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    const fromA = reachableFrom('a', nodes, edges)
    check('a 可达 b/c', fromA !== null && fromA.has('b') && fromA.has('c'), fromA === null ? null : [...fromA])
    check('a 不可达 z', fromA !== null && !fromA.has('z'))
    check('不含自身', fromA !== null && !fromA.has('a'))
    const fromC = reachableFrom('c', nodes, edges)
    check('c 无下游 ⇒ 空集（不是 null）', fromC !== null && fromC.size === 0)
    check('起点不存在 ⇒ null（问错了 ≠ 没有）', reachableFrom('nope', nodes, edges) === null)
  }

  console.log('\n== 环不导致死循环 ==')
  {
    const nodes = [node('a'), node('b')]
    const edges = [edge('a', 'b'), edge('b', 'a')]
    const r = reachableFrom('a', nodes, edges)
    check('双向环可达且终止', r !== null && r.has('b') && r.size === 1, r === null ? null : [...r])
  }

  console.log('\n== impactedBy：影响面（反向可达）==')
  {
    const nodes = [node('a'), node('b'), node('c'), node('z')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    const impactC = impactedBy('c', nodes, edges)
    check('改 c 波及 a/b', impactC !== null && impactC.has('a') && impactC.has('b'), impactC === null ? null : [...impactC])
    check('改 a 不波及任何上游', impactedBy('a', nodes, edges)?.size === 0)
    check('目标不存在 ⇒ null', impactedBy('nope', nodes, edges) === null)
  }

  console.log('\n== shortestPath：最短因果链 ==')
  {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('d', 'c')]
    const path = shortestPath('a', 'c', nodes, edges)
    check('返回长度 3 的路径（a 直接到 c 不存在，两条等价取先到）', path !== null && path.length === 3, path)
    check('路径首尾正确', path !== null && path[0] === 'a' && path[2] === 'c', path)
    check('同节点 ⇒ 单元素路径', JSON.stringify(shortestPath('a', 'a', nodes, edges)) === '["a"]')
    check('不可达 ⇒ null', shortestPath('c', 'a', nodes, edges) === null)
    check('端点不存在 ⇒ null', shortestPath('a', 'nope', nodes, edges) === null)
  }

  console.log('\n== structureInsights：可读结论 ==')
  {
    // 需要真正的枢纽：hub 总度数 ≥ 3 且进出都非零。
    const nodes = [node('src'), node('hub'), node('s1'), node('s2')]
    const s = analyzeStructure(nodes, [edge('src', 'hub'), edge('hub', 's1'), edge('hub', 's2')])
    const out = structureInsights(s)
    check('包含枢纽结论', out.some((l) => l.includes('枢纽')), out)
    check('包含边数结论', out.some((l) => l.includes('条边')), out)
    const chainOnly = analyzeStructure([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')])
    check('单线链无枢纽（总度数 2 低于阈值 3）', chainOnly.hubs.length === 0, chainOnly.hubs)
  }

  console.log('\n== 确定性：同输入同输出 ==')
  {
    const nodes = [node('b'), node('a'), node('c')]
    const edges = [edge('a', 'b')]
    const one = JSON.stringify(analyzeStructure(nodes, edges).degrees)
    const two = JSON.stringify(analyzeStructure(nodes, edges).degrees)
    check('度数排序确定性（同度数按 id 字典序）', one === two, { one, two })
    // 只让 c 孤立（a/b 有边，不孤立）
    const isolatedIds = analyzeStructure(nodes, edges).isolated.map((d) => d.id)
    check('孤立节点只含无边者', JSON.stringify(isolatedIds) === JSON.stringify(['c']), isolatedIds)
    // 两个孤立节点时按 id 字典序
    const twoIsolated = analyzeStructure([node('z'), node('a'), node('m')], []).isolated.map((d) => d.id)
    check('多个孤立节点按 id 字典序', JSON.stringify(twoIsolated) === JSON.stringify(['a', 'm', 'z']), twoIsolated)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
