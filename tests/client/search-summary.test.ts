import { matchNodes, searchSummary } from '../../src/client/graph/viewport.ts'

/**
 * 搜索结果投影测试：matchNodes 的「全量」与 searchSummary 的「窗口」。
 *
 * 这组断言钉的是一个**可验证的假话**：此前 matchNodes 默认 limit=8，
 * 同一个 8 既当「显示上限」又当「回车循环的范围」，于是匹配 20 个时
 * 指示器显示「第 1/8 个」、第 9~20 个既看不见也跳不到。
 * 现在数据层给全量，显示层截断并显式给出省略数（CLAUDE.md 纪律）。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 24 个 id 都含 hub，标签各不相同（用于造出「匹配数 > 显示上限」）。 */
const many = Array.from({ length: 24 }, (_, index) => ({
  id: `hub.${String(index).padStart(2, '0')}`,
  label: `节点 ${index}`,
  ref: `hub.${String(index).padStart(2, '0')}`,
}))

function main() {
  console.log('\n== matchNodes：默认给全量 ==')
  {
    const all = matchNodes(many, 'hub')
    check('默认不再截断到 8（数据层给全量）', all.length === 24, all.length)
    check('显式 limit 仍然生效（调用方要截就自己截）', matchNodes(many, 'hub', 3).length === 3)
    check('limit 超过总数时给全量', matchNodes(many, 'hub', 999).length === 24)
    check('Infinity 是合法的「不截断」', matchNodes(many, 'hub', Number.POSITIVE_INFINITY).length === 24)
    check('负 limit 退回空表（脏输入不抛异常）', matchNodes(many, 'hub', -1).length === 0)
    check('小数 limit 向下取整', matchNodes(many, 'hub', 2.9).length === 2)
    // 排序契约不能被「全量化」改掉：相关度优先级仍是 id 精确 > 前缀 > 标签。
    const ranked = matchNodes(
      [
        { id: 'x', label: 'hub 标签' },
        { id: 'hub', label: '别的' },
        { id: 'hub.y', label: 'y' },
      ],
      'hub',
    )
    check('精确 id 命中排第一', ranked[0]?.id === 'hub', ranked.map((n) => n.id))
    check('前缀命中排第二', ranked[1]?.id === 'hub.y', ranked.map((n) => n.id))
  }

  console.log('\n== searchSummary：窗口 / 总数 / 省略数同源 ==')
  {
    const all = matchNodes(many, 'hub')
    const first = searchSummary(all, 8, 0)
    check('total 是全量而不是窗口大小', first.total === 24 && first.visible.length === 8, {
      total: first.total,
      visible: first.visible.length,
    })
    check('omitted 显式给出（渲染层据此出展开按钮）', first.omitted === 24 - first.visible.length, first.omitted)
    check('游标 0 时窗口就是前缀（常见情形不打乱观感）',
      first.visible.every((node, index) => node.id === all[index]?.id))

    // 关键回归：游标越过显示上限时，当前命中必须在窗口里可见。
    const later = searchSummary(all, 8, 15)
    const currentId = all[15]?.id
    check('游标越界后当前命中仍在窗口里（否则「定位成功但看不见自己」）',
      later.visible.some((node) => node.id === currentId), { currentId, window: later.visible.map((n) => n.id) })
    check('cycleIndex 是真实下标而不是窗口下标', later.cycleIndex === 15, later.cycleIndex)
    check('ordinal（真实序数）与 cycleIndex 一致', later.cycleIndex + 1 === 16)
    // 窗口必须**排名连续**：不能为了塞进当前命中而跳着挑。
    const start = all.findIndex((node) => node.id === later.visible[0]?.id)
    check('窗口是连续切片（保持相关度排序）',
      later.visible.every((node, index) => node.id === all[start + index]?.id), { start })
    check('窗口长度不超过显示上限', later.visible.length === 8, later.visible.length)
    check('当前命中在窗口内的位置正确',
      later.visible[later.indexInVisible]?.id === currentId, { indexInVisible: later.indexInVisible })

    // 取模：越过末尾回到开头（旧行为是 % matches.length ⇒ 只在前 8 个里循环）。
    const wrapped = searchSummary(all, 8, 24)
    check('游标 = 总数 ⇒ 取模回到第 0 个（循环覆盖全量）', wrapped.cycleIndex === 0, wrapped.cycleIndex)
    const beyond = searchSummary(all, 8, 30)
    check('游标远超总数仍落在合法下标', beyond.cycleIndex === 6 && all[beyond.cycleIndex] !== undefined, beyond.cycleIndex)
    const negative = searchSummary(all, 8, -1)
    check('负游标落回合法下标（不返回 -1 让调用方拿到 undefined）',
      negative.cycleIndex >= 0 && negative.cycleIndex < all.length, negative.cycleIndex)

    // 展开态：显示上限 = Infinity ⇒ 无省略。
    const expanded = searchSummary(all, Number.POSITIVE_INFINITY, 15)
    check('展开后窗口=全量、省略=0', expanded.visible.length === 24 && expanded.omitted === 0, expanded.omitted)
    check('展开后当前命中仍在窗口内且序数不变',
      expanded.visible[expanded.indexInVisible]?.id === currentId && expanded.cycleIndex === 15)

    // 边界：空命中、单命中、显示上限为 0。
    const none = searchSummary([] as typeof many, 8, 0)
    check('空命中：total 0 / 窗口空 / 序数不越界',
      none.total === 0 && none.visible.length === 0 && none.indexInVisible === -1, none)
    const single = searchSummary([many[0] as (typeof many)[number]], 8, 5)
    check('单命中：任何游标都落在 0', single.cycleIndex === 0 && single.visible.length === 1)
    const zeroLimit = searchSummary(all, 0, 3)
    check('显示上限 0：窗口空但 total 仍是全量（总数不被显示策略吞掉）',
      zeroLimit.visible.length === 0 && zeroLimit.total === 24, zeroLimit)
    check('NaN 游标退回 0（不产生 undefined 命中）', searchSummary(all, 8, Number.NaN).cycleIndex === 0)
  }

  console.log('\n== 确定性 ==')
  {
    const a = JSON.stringify(searchSummary(matchNodes(many, 'hub'), 8, 9))
    const b = JSON.stringify(searchSummary(matchNodes(many, 'hub'), 8, 9))
    check('同输入同输出（轮询不得改变搜索结果顺序）', a === b)
  }

  console.log(failures === 0 ? '\nsearch-summary 全部通过\n' : `\n${failures} 个断言失败\n`)
  if (failures > 0) process.exit(1)
}

main()
