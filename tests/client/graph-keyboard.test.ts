import {
  cycleIndex,
  ellipsize,
  graphKeyAction,
  searchKeyAction,
} from '../../src/client/graph/graph-interaction.ts'
import { matchNodes, searchSummary } from '../../src/client/graph/viewport.ts'

/**
 * 搜索与键盘状态机 —— 按键语义必须与「用户看到的窗口」一致。
 *
 * 缺陷形态：
 * - 只能回车前进、不能 ↑ 回退 ⇒ 越过一个匹配就得从头再按 N 次；
 * - 无命中时方向键仍被 preventDefault ⇒ 输入法候选词选不了；
 * - ↑ 用 `index - 1` 直接算 ⇒ 从第 0 个往上是 -1，定位到 undefined；
 * - 画布与搜索框共用一套键表 ⇒ 在搜索框里输入 `0` 触发「适配视图」。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n[搜索框按键]')
check('回车 = 下一个', searchKeyAction('Enter', true) === 'next')
check('↓ = 下一个', searchKeyAction('ArrowDown', true) === 'next')
check('↑ = 上一个（双向遍历）', searchKeyAction('ArrowUp', true) === 'previous')
check('Esc 永远清空（无命中也要能退出）', searchKeyAction('Escape', false) === 'clear')
check('无命中时回车不抢（不做无效定位）', searchKeyAction('Enter', false) === 'none')
check('无命中时 ↑ 不抢（输入法候选词可用）', searchKeyAction('ArrowUp', false) === 'none')
check('普通字符不拦截', searchKeyAction('a', true) === 'none')

console.log('\n[游标取模]')
check('前进 0→1', cycleIndex(0, 1, 3) === 1)
check('末尾前进回绕 2→0', cycleIndex(2, 1, 3) === 0)
check('开头后退回绕 0→2（不产生 -1）', cycleIndex(0, -1, 3) === 2)
check('大步长取模', cycleIndex(1, 5, 3) === 0)
check('空集合恒为 0', cycleIndex(0, 1, 0) === 0)
check('NaN 当前值归零', cycleIndex(Number.NaN, 0, 3) === 0)
check('负数当前值落回合法下标', cycleIndex(-1, 0, 3) === 2)

console.log('\n[画布键位表]')
check('Esc 退出观察态', graphKeyAction('Escape') === 'escape')
check('+ 放大', graphKeyAction('+') === 'zoom-in')
check('= 放大（美式键盘无 shift）', graphKeyAction('=') === 'zoom-in')
check('- 缩小', graphKeyAction('-') === 'zoom-out')
check('_ 缩小', graphKeyAction('_') === 'zoom-out')
check('0 适配视图', graphKeyAction('0') === 'fit')
check('方向键四向映射', graphKeyAction('ArrowLeft') === 'focus-left' && graphKeyAction('ArrowRight') === 'focus-right' && graphKeyAction('ArrowUp') === 'focus-up' && graphKeyAction('ArrowDown') === 'focus-down')
check('其它键不拦截', graphKeyAction('a') === 'none')
check('Tab 不被画布拦截（焦点遍历交给浏览器）', graphKeyAction('Tab') === 'none')

console.log('\n[搜索匹配：大小写与中文]')
interface TestNode {
  id: string
  label: string
  ref?: string
}
const nodes: TestNode[] = [
  { id: 'guard.observe', label: '能力观测', ref: 'guard.observe' },
  { id: 'guard.restore', label: '配置恢复', ref: 'guard.restore' },
  { id: 'plugin.alpha', label: 'Alpha Plugin', ref: 'alpha' },
]
const byId = (list: TestNode[]): string => list.map((n) => n.id).join(',')
check('英文大小写不敏感', byId(matchNodes(nodes, 'ALPHA')) === 'plugin.alpha')
check('中文子串命中', byId(matchNodes(nodes, '能力')) === 'guard.observe')
check('中文单字命中', byId(matchNodes(nodes, '恢复')) === 'guard.restore')
check('id 精确命中排第一', matchNodes(nodes, 'guard.observe')[0]?.id === 'guard.observe')
check('空查询不返回垃圾结果', matchNodes(nodes, '   ').length === 0)
check('无命中返回空', matchNodes(nodes, '不存在的词').length === 0)
check('全量命中（数据层不截断）', matchNodes(nodes, 'guard').length === 2)

console.log('\n[窗口与游标一致]')
// 实现的不变式：窗口**最小滑动**到刚好容得下当前命中，而不是把窗口推到最后。
// 游标 3、窗口 2 行：前缀 [0,1] 不含 3，因此滑到 [2,3]（c,d），当前命中 d
// 落在窗口**末位**。此前断言写成 d,e（窗口贴到尾部）是错的 —— 那会让
// 「当前命中」在窗口里的相对位置随总长度变化，用户看不到稳定的阅读锚点。
const summary = searchSummary(['a', 'b', 'c', 'd', 'e'], 2, 3)
check('窗口最小滑动并容下当前命中', summary.visible.join(',') === 'c,d', summary.visible)
check('真实序数来自全量', summary.cycleIndex === 3)
check('省略计数 = 总数 - 窗口', summary.omitted === 3)
check('当前命中在窗口末位可见', summary.indexInVisible === 1)
check('↑ 从窗口首行回到上一条（取模后仍是合法目标）', cycleIndex(summary.cycleIndex, -1, summary.total) === 2)
check('回到的上一条（c）仍在当前窗口内', summary.visible.includes('c'))

console.log('\n[长文本省略：计数 + 完整出口]')
const clipped = ellipsize('abcdefghij', 4)
check('截断文本带省略号', clipped.text === 'abcd…', clipped.text)
check('省略字符数可读（不是静默截断）', clipped.omitted === 6)
check('完整原文仍在（详情卡/弹层的出口）', clipped.full === 'abcdefghij')
check('标记 truncated', clipped.truncated)
const exact = ellipsize('abcd', 4)
check('恰好等长不截断（不制造多余省略号）', exact.text === 'abcd' && !exact.truncated && exact.omitted === 0)
const chinese = ellipsize('能力图谱很长', 3)
check('中文按字符截断并计数', chinese.text === '能力图…' && chinese.omitted === 3)
check('超长上限（Infinity）不截断', ellipsize('abc', Number.POSITIVE_INFINITY).truncated === false)
check('负数上限退化为不截断（宁可撑破也不吞内容）', ellipsize('abc', -1).text === 'abc')

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')