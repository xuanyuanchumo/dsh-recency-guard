import type { GraphEdge, GraphNode } from '../../src/graph-data.ts'
import {
  KIND_COLOR,
  STAGE_COLOR,
  TONE_COLOR,
  edgeColor,
  edgeCurvatures,
  filterGraph,
  graphBounds,
  kindCounts,
  layoutPositionsOf,
  legendColorOf,
  legendShapeOf,
  neighborsOf,
  degreeOf,
  radialPositions,
  shapePath,
  withLayout,
  zoomLabel,
  type ColorMode,
} from '../../src/client/graph-model.ts'

/**
 * graph-model 纯函数测试 —— 补上「文件头自称已由测试钉死但测试不存在」的
 * 审计缺口（cycle-6 P0）。本文件钉死的高危不变式：
 *
 * 1. **过滤与边共源**：隐藏类型后不得出现「连到幽灵节点的边」。
 * 2. **布局确定性**：radial/layered 同输入同输出（白盒比对的前提）。
 * 3. **图例与着色同源**：图例色必须等于同口径下节点的实际颜色。
 * 4. **几何一致性**：曲线边的曲率互不相同（平行边方向可辨）。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 一个最小节点（只填测试关心的字段）。 */
function node(id: string, kind: GraphNode['kind'], x = 0, y = 0, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind,
    label: id,
    shape: 'circle',
    tone: 'neutral',
    x,
    y,
    column: 0,
    ...overrides,
  }
}

function edge(id: string, from: string, to: string, kind: GraphEdge['kind'] = 'produces'): GraphEdge {
  return { id, from, to, kind, tone: 'neutral' }
}

function main() {
  console.log('\n== filterGraph：过滤与边共源 ==')
  const nodes = [
    node('cap.a', 'capability', 0, 0, { shape: 'square' }),
    node('cap.b', 'capability', 260, 0, { shape: 'diamond' }),
    node('gap.x', 'gap', 520, 0, { shape: 'triangle' }),
  ]
  const edges = [edge('e1', 'cap.a', 'cap.b'), edge('e2', 'cap.a', 'gap.x')]
  {
    const { nodes: keptNodes, edges: keptEdges } = filterGraph(nodes, edges, {
      hidden: new Set(['gap']),
      onlyConnectedWith: null,
    })
    check('隐藏 gap 后节点表不含 gap', keptNodes.every((n) => n.kind !== 'gap'), keptNodes.map((n) => n.id))
    check('隐藏 gap 后边表不含连向 gap 的边', keptEdges.every((e) => e.to !== 'gap.x' && e.from !== 'gap.x'), keptEdges)
    check('隐藏类型后仍保留无关边', keptEdges.some((e) => e.id === 'e1'))

    const linked = filterGraph(nodes, edges, { hidden: new Set(), onlyConnectedWith: 'cap.b' })
    check(
      '只看关联：保留与 cap.b 双向可达的全部端点',
      linked.nodes.some((n) => n.id === 'cap.a') && linked.nodes.some((n) => n.id === 'cap.b'),
      linked.nodes.map((n) => n.id),
    )
  }

  console.log('\n== 布局确定性 ==')
  {
    const layered1 = layoutPositionsOf(nodes, 'layered')
    const layered2 = layoutPositionsOf(nodes, 'layered')
    check('layered 同输入同输出', JSON.stringify(layered1) === JSON.stringify(layered2))
    const radial1 = radialPositions(nodes)
    const radial2 = radialPositions(nodes)
    check('radial 同输入同输出', JSON.stringify(radial1) === JSON.stringify(radial2))
    check('radial 全部落在正坐标区', Object.values(radial1).every((p) => p.x >= 0 && p.y >= 0), radial1)
    const withOffset = withLayout(nodes, layered1, { 'cap.a': { x: 10, y: -4 } })
    const a = withOffset.find((n) => n.id === 'cap.a')
    check('拖拽偏移叠加到布局坐标', a?.x === layered1['cap.a']!.x + 10 && a?.y === layered1['cap.a']!.y - 4, a)
    const untouched = withOffset.find((n) => n.id === 'cap.b')
    check('无偏移的节点保持布局坐标', untouched?.x === layered1['cap.b']!.x)
  }

  console.log('\n== 图例与着色同源 ==')
  {
    // gap 节点在生产数据里 tone=error（snapshot.ts extras）——测试数据必须
    // 与生产口径一致，否则「图例=节点色」断言测的是假数据。
    const gapNode = node('gap.x', 'gap', 0, 0, { tone: 'error' })
    for (const mode of ['tone', 'kind'] as const) {
      const nodeColor = ((): string => {
        if (mode === 'kind') return KIND_COLOR[gapNode.kind]
        return TONE_COLOR[gapNode.tone]
      })()
      const legend = legendColorOf(gapNode.kind, mode as ColorMode)
      check(`图例色 = 节点色（口径 ${mode}）`, legend === nodeColor, { legend, nodeColor })
    }
    check('stage 口径下图例退回代表色（可判定字符串）', typeof legendColorOf('capability', 'stage') === 'string')
    check('stage 阶段色表完整（六阶段）', Object.keys(STAGE_COLOR).length === 6, Object.keys(STAGE_COLOR))
    // 代表形状多数票：两个 circle 一个 square ⇒ circle 胜出。
    const tallyNodes = [node('x1', 'capability', 0, 0, { shape: 'circle' }), node('x2', 'capability', 0, 1, { shape: 'circle' }), node('x3', 'capability', 0, 2, { shape: 'square' })]
    check('代表形状取多数票', legendShapeOf('capability', tallyNodes) === 'circle')
    check('空类型退回 circle（不抛异常）', legendShapeOf('bundle', tallyNodes) === 'circle')
  }

  console.log('\n== 边几何与度数 ==')
  {
    const a = node('a', 'capability', 0, 0)
    const b = node('b', 'capability', 300, 0)
    const index = new Map<string, GraphNode>([[a.id, a], [b.id, b]])
    const edges2 = [edge('p1', 'a', 'b'), edge('p2', 'a', 'b')]
    const curves = edgeCurvatures(edges2)
    // 首条平行边 index=0 曲率为 0（直线），第二条 index=1 曲率 +18（右侧绕行）——
    // 这正是「同一对端点的平行边方向可辨」的实现语义。
    check('平行边曲率可辨（0 与 +18）', curves[0] === 0 && curves[1] === 18, curves)
    check('edgeColor neutral 用描边色', edgeColor({ tone: 'neutral' }) === 'var(--dsw-alias-border-l3)')
    check('edgeColor warn 用语义色', edgeColor({ tone: 'warn' }) === TONE_COLOR.warn)
    const deg = degreeOf('a', edges2)
    check('度数：生产方 out=2 in=0', deg.out === 2 && deg.in === 0, deg)
    const nb = neighborsOf('b', edges2, index)
    check('邻居：b 的上游是 a', nb.upstream.length === 1 && nb.upstream[0] === 'a' && nb.downstream.length === 0, nb)
  }

  console.log('\n== 杂项投影 ==')
  {
    check('kindCounts 计数正确', kindCounts(nodes)['capability'] === 2 && kindCounts(nodes)['gap'] === 1)
    const bounds = graphBounds(nodes)
    check('bounds 覆盖全部节点宽度', bounds.maxX >= 520 + 200 && bounds.minX === 0, bounds)
    check('空图 bounds 是零矩形而不是 Infinity', Object.values(graphBounds([])).every((v) => v === 0))
    check('zoomLabel 百分比可读', zoomLabel(1) === '100%' && zoomLabel(0.5) === '50%')
    check('五种形状路径互不相同', new Set([shapePath('circle', 8, 0), shapePath('square', 8, 0), shapePath('diamond', 8, 0), shapePath('triangle', 8, 0), shapePath('hexagon', 8, 0)]).size === 5)
  }

  console.log(failures === 0 ? '\ngraph-model 全部通过\n' : `\n${failures} 个断言失败\n`)
  if (failures > 0) process.exit(1)
}

main()
