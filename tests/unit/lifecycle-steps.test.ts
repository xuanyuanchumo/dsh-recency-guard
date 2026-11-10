/**
 * 生命周期步骤区间测试（cycle-13 · 变异测试发现的真缺口）。
 *
 * 为什么单独一个文件
 * -----------------
 * `scripts/mutation.mjs` 把 `endStep` 的 `for (let i = this.spans.length - 1; i >= 0; i -= 1)`
 * 改成 `i > 0` 后**没有任何测试变红**。那不是等价变异体：
 * `i > 0` 会**永远关不掉 index 0 的区间**，也就是「只有一条步骤记录时，
 * 它永远停在未结束状态」——这会让面板的「进行中步骤」永远挂着一项，
 * 也让 `openSteps` 永远非空（进而影响 status 的生命周期投影）。
 *
 * 既有 lifecycle 测试都在多区间场景下跑（至少 2 条），所以从未暴露这个边界。
 * 这个文件专钉**单区间 / 首区间**两个形态。
 */
import { StageMachine } from '../../src/lifecycle.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n== 只有一个区间时 endStep 必须能关掉它（index 0 边界）==')
{
  const machine = new StageMachine('idle')
  const span = machine.beginStep('recover')
  check('beginStep 返回未结束区间', span.endedAt === undefined)

  const closed = machine.endStep('recover')
  check('endStep 关闭了唯一的区间（不是返回 undefined）', closed !== undefined, closed)
  check('被关闭的正是那一区间', closed === span)
  check('区间带上了 endedAt', typeof span.endedAt === 'string' && span.endedAt.length > 0, span.endedAt)
  check('区间带上了 durationMs', typeof span.durationMs === 'number' && span.durationMs >= 0, span.durationMs)
  check('关闭后 openSteps 为空（不会永远挂着）', machine.openSteps().length === 0, machine.openSteps)
}

console.log('\n== 首区间在栈底时仍能被关闭（多区间形态）==')
{
  const machine = new StageMachine('idle')
  // 先开一个别的步骤占住 index 0，再开目标步骤 → 目标在 index 1。
  machine.beginStep('observe')
  machine.beginStep('decide')
  // 关掉栈底那个（只有它名字匹配）—— 变异体 i>0 会跳过 index 0。
  const closedObserve = machine.endStep('observe')
  check('栈底的 observe 能被关闭', closedObserve !== undefined, closedObserve)
  check('关闭后 openSteps 只剩 decide', machine.openSteps().join(',') === 'decide', machine.openSteps)

  // 现在只剩 decide（index 0 位置变了）⇒ 再关一次，钉住「单区间」再现。
  const closedDecide = machine.endStep('decide')
  check('剩余的唯一区间也能被关闭', closedDecide !== undefined, closedDecide)
  check('全部关闭后 openSteps 为空', machine.openSteps().length === 0, machine.openSteps)
}

console.log('\n== 反向：同名未结束区间取最近一个（不是最旧）==')
{
  const machine = new StageMachine('idle')
  const first = machine.beginStep('recover')
  const second = machine.beginStep('recover')
  const closed = machine.endStep('recover')
  check('关闭的是最近进入的那个（second）', closed === second, { first: first.endedAt, second: second.endedAt })
  check('较旧的那个仍开着（栈语义）', first.endedAt === undefined && machine.openSteps().length === 1, machine.openSteps)
}

console.log('\n== 反向：没有对应进入记录时不补造区间 ==')
{
  const machine = new StageMachine('idle')
  check('未 begin 就 end ⇒ undefined（不补造）', machine.endStep('decide') === undefined)
  check('不补造 ⇒ spans 仍为空', machine.steps.length === 0, machine.steps)
}

console.log('\n== 反向：已结束的区间不会被重复关闭 ==')
{
  const machine = new StageMachine('idle')
  const span = machine.beginStep('recover')
  const at1 = machine.endStep('recover')?.endedAt
  const at2 = machine.endStep('recover')
  check('重复 endStep 返回 undefined（没有未结束的同名区间）', at2 === undefined)
  check('首次关闭的 endedAt 未被覆写', span.endedAt === at1, { at1, now: span.endedAt })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)