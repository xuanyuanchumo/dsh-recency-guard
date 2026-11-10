import type { GraphEdge, GraphNode } from '../../src/host/capability/graph-data.ts'
import {
  EDGE_DEGREE_SUM_MAX,
  EDGE_DEGREE_SUM_MIN,
  EDGE_WIDTH_MAX,
  EDGE_WIDTH_MIN,
  degreeTally,
  directionalCandidate,
  edgeDegreeSum,
  edgeWidthOf,
  filterGraph,
  kHopNeighborhood,
  linkRangeHops,
  logScale,
  type LinkRange,
} from '../../src/client/graph/graph-model.ts'
import { IDENTITY, isWorldPointVisible, type Viewport } from '../../src/client/graph/viewport.ts'

/**
 * 聚焦邻域 / 键盘导航 / 边粗细编码的纯函数测试。
 *
 * 这三组都是**本轮新增**的交互逻辑，它们的缺陷在浏览器里只会表现为
 * 「图看起来有点怪」或「方向键时好时坏」，而不是任何断言失败 ——
 * 所以必须在这里逐条钉死，而不是靠手点。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 最小节点（只填被测字段）。 */
function node(id: string, kind: GraphNode['kind'] = 'capability', column = 0): GraphNode {
  return { id, kind, label: id, shape: 'circle', tone: 'neutral', x: column * 260, y: 0, column }
}

function edge(id: string, from: string, to: string): GraphEdge {
  return { id, from, to, kind: 'produces', tone: 'neutral' }
}

/** 一条链：a → b → c → d（每个节点度数最多 2）。 */
const chain = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd')]

function main() {
  console.log('\n== kHopNeighborhood：跳数语义 ==')
  {
    const zero = kHopNeighborhood('a', chain, 0)
    check('0 跳只含起点自己（不是空集）', zero.size === 1 && zero.has('a'), [...zero])
    const one = kHopNeighborhood('b', chain, 1)
    check('1 跳 = 起点 + 直接邻居（双向）', one.size === 3 && one.has('a') && one.has('b') && one.has('c'), [...one])
    check('1 跳不含 2 格外的 d（闭包会含）', !one.has('d'), [...one])
    const two = kHopNeighborhood('a', chain, 2)
    check('2 跳含 a/b/c 且仍不含 d', two.size === 3 && two.has('c') && !two.has('d'), [...two])
    const beyond = kHopNeighborhood('a', chain, 99)
    check('跳数超过图直径 ⇒ 收敛到连通分量（不越界）', beyond.size === 4, [...beyond])
    const isolated = kHopNeighborhood('x', chain, 3)
    check('不存在的起点只返回自己（不抛异常）', isolated.size === 1 && isolated.has('x'))
    const negative = kHopNeighborhood('a', chain, -1)
    check('负跳数退回起点（脏输入不炸观测设施）', negative.size === 1)
    const fractional = kHopNeighborhood('b', chain, 1.7)
    check('小数跳数向下取整（1.7 = 1 跳）', fractional.size === 3, [...fractional])
    // 自环不得把邻域炸开（自环邻居是自己，已在 visited 内）。
    const looped = [...chain, edge('e4', 'a', 'a')]
    check('自环不重复计入邻域', kHopNeighborhood('a', looped, 1).size === 2, [...kHopNeighborhood('a', looped, 1)])
  }

  console.log('\n== 自环的度数口径 ==')
  {
    // 「这条边连着谁」两端都记 ⇒ 自环给该节点度数 +2。
    const tally = degreeTally([edge('l', 'a', 'a'), edge('e1', 'a', 'b')])
    check('自环计入两端（a=3, b=1）', tally.get('a') === 3 && tally.get('b') === 1, [...tally])
    check('空边表 ⇒ 空度数表（不是 undefined）', degreeTally([]).size === 0)
  }

  console.log('\n== linkRangeHops：档位 → 跳数 ==')
  {
    check('hops1 ⇒ 1', linkRangeHops('hops1') === 1)
    check('hops2 ⇒ 2', linkRangeHops('hops2') === 2)
    check('closure ⇒ null（走传递闭包）', linkRangeHops('closure') === null)
    // 档位必须是穷举的：新增档位却忘了映射会静默落到默认分支。
    const all: readonly LinkRange[] = ['hops1', 'hops2', 'closure']
    check('三档都有定义', all.every((range) => linkRangeHops(range) !== undefined))
  }

  console.log('\n== filterGraph + maxHops：过滤与边共源 ==')
  {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const edges = chain
    // 缺省（省略字段）= 闭包 = 新增该字段之前的行为，逐字节一致。
    const omitted = filterGraph(nodes, edges, { hidden: new Set(), onlyConnectedWith: 'a' })
    const closure = filterGraph(nodes, edges, { hidden: new Set(), onlyConnectedWith: 'a', maxHops: null })
    check('省略 maxHops 与显式 null 结果相同（老行为不变）',
      JSON.stringify(omitted) === JSON.stringify(closure))
    check('闭包保留整条链（4 节点 3 边）', closure.nodes.length === 4 && closure.edges.length === 3, closure)
    const oneHop = filterGraph(nodes, edges, { hidden: new Set(), onlyConnectedWith: 'b', maxHops: 1 })
    check('1 跳只留 a/b/c', oneHop.nodes.length === 3 && !oneHop.nodes.some((n) => n.id === 'd'), oneHop.nodes.map((n) => n.id))
    check('1 跳的边表不含连向 d 的边（无幽灵箭头）', oneHop.edges.every((e) => e.to !== 'd' && e.from !== 'd'), oneHop.edges)
    // 两个条件必须**一次成型**：类型过滤 + 跳数同时生效时不得漏边。
    const mixed = filterGraph(
      [node('a'), node('b', 'gap'), node('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'a', 'c')],
      { hidden: new Set(['gap']), onlyConnectedWith: 'a', maxHops: 1 },
    )
    check('隐藏类型 + 1 跳：边端点都在节点表里',
      mixed.edges.every((e) => mixed.nodes.some((n) => n.id === e.from) && mixed.nodes.some((n) => n.id === e.to)),
      mixed)
    check('隐藏类型后连向 gap 的边彻底消失', mixed.edges.every((e) => e.to !== 'b' && e.from !== 'b'), mixed.edges)
  }

  console.log('\n== logScale：对数刻度与边界契约 ==')
  {
    check('logScale(0) = 0（下界，不是负数）', logScale(0, 18) === 0)
    check('负输入 = 0（绝不返回负刻度）', logScale(-5, 18) === 0)
    check('NaN = 0', logScale(Number.NaN, 18) === 0)
    check('恰好到界 = 1', logScale(18, 18) === 1)
    check('超界饱和在 1', logScale(1000, 18) === 1)
    check('domainMax ≤ 0 ⇒ 0（没有可比性就不制造差异）', logScale(5, 0) === 0 && logScale(5, -3) === 0)
    const mid = logScale(9, 18)
    check('单调递增', mid > logScale(3, 18) && logScale(3, 18) > logScale(1, 18), mid)
    // 关键卖点：大值不压扁小值。诚实的断言是「与线性刻度**比**」而不是
    // 拍一个绝对阈值 —— 线性下 1→2 差 1/18≈0.0556，对数下 0.1377，
    // 分辨率约 2.5 倍；而我一开始写的「>0.2」是想当然，被测试打回来了。
    const linearGap = (2 - 1) / 18
    const logGap = logScale(2, 18) - logScale(1, 18)
    check('1 与 2 的视觉差优于线性刻度', logGap > linearGap * 2, { logGap, linearGap })
    check('高段压缩（17→18 的差小于 1→2 的差）',
      logScale(18, 18) - logScale(17, 18) < logScale(2, 18) - logScale(1, 18))
  }

  console.log('\n== edgeWidthOf：粗细编码 ==')
  {
    const leafToLeaf = edgeWidthOf(degreeTally([edge('x', 'a', 'b')]), { from: 'a', to: 'b' })
    check('叶子↔叶子 = 下界宽度（全图唯一一条边时不冒充最粗）', leafToLeaf === EDGE_WIDTH_MIN, leafToLeaf)
    check('参考刻度是常量（不随数据变）', EDGE_DEGREE_SUM_MAX === 20 && EDGE_DEGREE_SUM_MIN === 2)
    // 度数扫描 1..40：宽度必须始终落在 [min,max]（越界即 SVG 负宽/压卡片）。
    let inRange = true
    let monotonic = true
    let previous = -1
    for (let degree = 1; degree <= 40; degree += 1) {
      // 造一条边：from 有 degree 条入边，to 是叶子。
      const edges: Array<{ from: string; to: string }> = [{ from: 'hub', to: 'leaf' }]
      for (let i = 0; i < degree - 1; i += 1) edges.push({ from: 'hub', to: `p${i}` })
      const tally = degreeTally(edges)
      const width = edgeWidthOf(tally, { from: 'hub', to: 'leaf' })
      if (!(width >= EDGE_WIDTH_MIN && width <= EDGE_WIDTH_MAX)) inRange = false
      if (width < previous) monotonic = false
      previous = width
    }
    check('任意度数下宽度都在 [min,max] 内', inRange)
    check('度数越大宽度不减（单调）', monotonic)
    const weak = edgeWidthOf(degreeTally([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]), { from: 'a', to: 'b' })
    const strong = edgeWidthOf(
      degreeTally([
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
        { from: 'a', to: 'e' },
        { from: 'b', to: 'f' },
        { from: 'b', to: 'g' },
      ]),
      { from: 'a', to: 'b' },
    )
    check('同一对端点：枢纽链路比叶子链路粗', strong > weak, { weak, strong })
    check('边强度 = 两端度数之和', edgeDegreeSum(degreeTally([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]), { from: 'a', to: 'b' }) === 3)
    check('未知端点按 0 度算（不抛异常）', edgeDegreeSum(new Map(), { from: 'ghost', to: 'a' }) === 0)
  }

  console.log('\n== directionalCandidate：二维方向导航 ==')
  {
    // 3×2 网格（列 0/300/600，行 0/200）—— 这里传的就是中心点。
    const grid = [
      { id: 'n00', x: 0, y: 0 },
      { id: 'n10', x: 300, y: 0 },
      { id: 'n20', x: 600, y: 0 },
      { id: 'n01', x: 0, y: 200 },
      { id: 'n11', x: 300, y: 200 },
    ]
    check('向右走一格', directionalCandidate({ x: 0, y: 0 }, 'right', grid) === 'n10')
    check('再向右走到列尾', directionalCandidate({ x: 300, y: 0 }, 'right', grid) === 'n20')
    check('最右列向右 = null（到头，焦点不动）', directionalCandidate({ x: 600, y: 0 }, 'right', grid) === null)
    check('向左回到上一格', directionalCandidate({ x: 300, y: 0 }, 'left', grid) === 'n00')
    check('最左列向左 = null', directionalCandidate({ x: 0, y: 0 }, 'left', grid) === null)
    // 屏幕坐标 y 轴向下：所以「下」= 更大的 y。这一条正是最容易写反的地方。
    check('向下走到第二行', directionalCandidate({ x: 0, y: 0 }, 'down', grid) === 'n01')
    check('向上走回第一行', directionalCandidate({ x: 0, y: 200 }, 'up', grid) === 'n00')
    check('最上行向上 = null', directionalCandidate({ x: 0, y: 0 }, 'up', grid) === null)
    check('最下行向下 = null', directionalCandidate({ x: 300, y: 200 }, 'down', grid) === null)
    // 同带优先：向右时同一横带里更远的点要胜过下一行的近邻。
    const skewed = [
      { id: 'near-below', x: 150, y: 900 },
      { id: 'far-right', x: 900, y: 5 },
    ]
    check('同行优先于「斜下方但更近」', directionalCandidate({ x: 0, y: 0 }, 'right', skewed) === 'far-right',
      directionalCandidate({ x: 0, y: 0 }, 'right', skewed))
    // 空候选集不得抛异常。
    check('空候选 = null', directionalCandidate({ x: 0, y: 0 }, 'right', []) === null)
    // 同坐标（重叠卡片）不算前进。
    check('重叠节点不被当成方向上的前进', directionalCandidate({ x: 0, y: 0 }, 'right', [{ id: 'same', x: 0, y: 0 }]) === null)
    // 确定性：同一输入两次结果一致（可比对）。
    check('同输入同输出',
      directionalCandidate({ x: 300, y: 0 }, 'down', grid) === directionalCandidate({ x: 300, y: 0 }, 'down', grid))
  }

  console.log('\n== isWorldPointVisible：只在看不见时才移动视野 ==')
  {
    const size = { width: 800, height: 600 }
    const at = (scale: number, tx: number, ty: number): Viewport => ({ scale, tx, ty })
    check('身份视口下的原点可见', isWorldPointVisible(IDENTITY, size, { x: 10, y: 10 }))
    check('视口外的世界点不可见', !isWorldPointVisible(IDENTITY, size, { x: 900, y: 10 }))
    check('平移后原位置跑到屏外', !isWorldPointVisible(at(1, -2000, 0), size, { x: 100, y: 10 }))
    check('缩得很小时远处仍在视野内', isWorldPointVisible(at(0.25, 0, 0), size, { x: 3000, y: 2000 }))
    // 容差语义：中心离边缘不足一个 margin ⇒ 判不可见（焦点环已被裁掉）。
    check('容差把「贴边」判为不可见', !isWorldPointVisible(at(1, 0, 0), size, { x: 20, y: 20 }, 40))
    check('容差内但足够远 ⇒ 仍可见', isWorldPointVisible(at(1, 0, 0), size, { x: 60, y: 60 }, 40))
    check('NaN scale ⇒ 不可见（宁可多移动一次）', !isWorldPointVisible(at(Number.NaN, 0, 0), size, { x: 10, y: 10 }))
    check('NaN 世界点 ⇒ 不可见', !isWorldPointVisible(IDENTITY, size, { x: Number.NaN, y: 10 }))
    check('零 scale ⇒ 不可见（除零保护）', !isWorldPointVisible(at(0, 0, 0), size, { x: 10, y: 10 }))
  }

  console.log(failures === 0 ? '\ngraph-focus 全部通过\n' : `\n${failures} 个断言失败\n`)
  if (failures > 0) process.exit(1)
}

main()
