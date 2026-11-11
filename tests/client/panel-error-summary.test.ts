import { degradedRoutes, errorSummary } from '../../src/client/panel/panel-model.ts'

/**
 * 错误边界与降级清单 —— 诚实边界的可断言形态。
 *
 * 缺陷形态：
 * - `String(error)` 得到 `[object Object]`，报障时零信息；
 * - `JSON.stringify` 遇循环引用抛错，错误处理路径自己再抛 ⇒ 白屏；
 * - 「归档路由注入失败」与「宿主根本没提供归档路由」混为一谈 ⇒ 面板
 *   对旧宿主谎报降级，或对真故障假装一切正常。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n[错误摘要可复制]')
const err = new Error('boom')
const summary = errorSummary(err)
check('保留 name 与 message', summary.startsWith('Error: boom'), summary)
check('带上栈（排查需要调用点）', summary.includes(err.stack?.split('\n')[1] ?? 'never'), summary.slice(0, 120))
class CustomError extends Error {
  override name = 'CustomError'
}
check('自定义 name 不被覆盖', errorSummary(new CustomError('x')).startsWith('CustomError: x'))
check('字符串错误原样返回', errorSummary('plain failure') === 'plain failure')
check('null 也有可读文本', errorSummary(null) === 'null')
check('数字错误转字符串', errorSummary(42) === '42')
check('普通对象可序列化', errorSummary({ code: 'E1' }) === '{"code":"E1"}')

// 循环引用：JSON.stringify 会抛 TypeError，摘要函数必须自己兜住。
const circular: Record<string, unknown> = { name: 'loop' }
circular.self = circular
const circularSummary = errorSummary(circular)
check('循环引用不抛异常', typeof circularSummary === 'string' && circularSummary.length > 0)
check('循环引用回退为 [object Object] 而不是空白', circularSummary === '[object Object]', circularSummary)

console.log('\n[降级清单]')
const graphFail = degradedRoutes({
  graph: { ok: false, reason: 'graph-route-500' },
  archives: { ok: true },
  archivesInjected: true,
})
check('图谱失败 ⇒ 一条降级', graphFail.length === 1 && graphFail[0]?.key === 'graph')
check('原因原样保留（不吞细节）', graphFail[0]?.reason === 'graph-route-500')
const bothFail = degradedRoutes({
  graph: { ok: false, reason: 'timeout' },
  archives: { ok: false, reason: 'archives-route-500' },
  archivesInjected: true,
})
check('两条路由都失败 ⇒ 两条降级（不合并成一句含糊话）', bothFail.length === 2)
check('归档原因可归因', bothFail[1]?.key === 'archives' && bothFail[1]?.reason === 'archives-route-500')
const okRoutes = degradedRoutes({
  graph: { ok: true },
  archives: { ok: true },
  archivesInjected: true,
})
check('全部成功 ⇒ 无提示（不无病呻吟）', okRoutes.length === 0)
const archivesAbsent = degradedRoutes({
  graph: { ok: true },
  archives: { ok: false, reason: 'archives-absent' },
  archivesInjected: false,
})
check('宿主未注入归档路由 ⇒ 不算降级（隐藏能力 ≠ 故障）', archivesAbsent.length === 0)
const missingReason = degradedRoutes({
  graph: { ok: false },
  archives: { ok: true },
  archivesInjected: true,
})
check('无原因时给 unknown 而不是空白理由', missingReason[0]?.reason === 'unknown')

console.log('\n[降级与空态的区分]')
// 降级清单只描述「读不到」，不描述「读到了但为空」：空图是成功结果，走 graph.empty。
const emptyGraphStillOk = degradedRoutes({
  graph: { ok: true },
  archives: { ok: false, reason: 'archives-absent' },
  archivesInjected: false,
})
check('空图（ok=true）不进入降级清单', emptyGraphStillOk.length === 0)

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')