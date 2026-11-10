/**
 * 显示层截断带省略说明 —— 「数据给全量，显示层显式省略计数」的纪律门。
 *
 * 为什么单独钉这一条（变异测试发现）
 * ----------------------------------
 * `scripts/mutation.mjs` 把 `if (omitted > 0)` / `if (extra > 0)` 改成 `>= 0`
 * 后**没有测试变红**。那不是等价变异体：改成 `>= 0` 会让「没有省略」的
 * 提示也打印出来（`omittedNote(0, ...)`），这是一条真实的显示缺陷。
 * 说明「省略提示是否真的出现」从未被断言过。
 *
 * 项目纪律（CLAUDE.md）原文：
 * > 数据层不做显示截断……截断是渲染策略：数据给全量，显示层显式省略计数。
 *
 * 这条测试就是那个「显式」的守卫：截断时必须**出现**省略提示，
 * 未截断时**不得**出现 —— 两个方向都要钉，只钉一个方向等于只防一半。
 */
import { renderOutcome, formatStatus } from '../../src/tool-render.js'

/**
 * 省略提示的**实际文案**是 `… 其余 N 项未展开（hint）`（见 tool-text.ts 的
 * `omittedNote`）。断言必须匹配这段真实文案 —— 早期版本只匹配 /省略/，
 * 而函数里根本没有「省略」二字，于是「把 `omitted > 0` 改成 `>= 0`」
 * 这个变异**照样存活**（`其余 0 项未展开` 不含「省略」），
 * 等于测试在测一个不存在的字符串。断言的锚点必须与实现文案同源。
 */
const NOTE_PATTERN = /其余\s*\d+\s*项未展开/

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造一个带 N 个嫌疑的 status，用于触发列表截断。 */
function statusWithSuspects(count: number): string {
  const ranking = Array.from({ length: count }, (_, i) => ({
    bundle: `dsh-suspect-${String(i).padStart(2, '0')}`,
    lastChangeAt: `2026-06-01T00:${String(i).padStart(2, '0')}:00.000Z`,
    lastKind: 'update',
  }))
  return renderOutcome(
    formatStatus({
      profile: 'desktop',
      dshVersion: 'test',
      enabled: true,
      crashedLastRun: false,
      crashSeq: 0,
      stabilized: true,
      autoDisabled: [],
      suspectRanking: ranking,
      experimentalSuspects: [],
    }),
  )
}

console.log('\n== 截断时必须出现省略提示（正方向）==')
{
  // 30 个嫌疑远超单节显示上限 ⇒ 必然截断。
  const many = statusWithSuspects(30)
  check('大量条目时出现省略提示', NOTE_PATTERN.test(many), many.replace(/\n/g, ' | ').slice(0, 400))
  check('省略提示带具体条数（不是只说「有省略」）', /其余\s*[1-9]\d*\s*项未展开/.test(many), many.slice(0, 400))
  check('截断不吞掉数据层：完整数据仍在 data 里（提示语指向 data）', many.includes('data') || many.includes('完整'), many.slice(0, 400))
}

console.log('\n== 未截断时不得出现省略提示（反方向）==')
{
  // 只有 2 个嫌疑 ⇒ 远低于显示上限 ⇒ 不得出现任何省略提示。
  const few = statusWithSuspects(2)
  check('少量条目时不出现省略提示', !NOTE_PATTERN.test(few), few.replace(/\n/g, ' | ').slice(0, 400))
  check('少量条目时两个嫌疑都完整列出', few.includes('dsh-suspect-00') && few.includes('dsh-suspect-01'), few.slice(0, 400))
  // 空列表：既不该有省略提示，也要说明「为什么是空的」。
  const none = statusWithSuspects(0)
  check('空列表时不出现省略提示', !NOTE_PATTERN.test(none), none.replace(/\n/g, ' | ').slice(0, 400))
}

console.log('\n== 边界：恰好等于上限时不得谎报省略 ==')
{
  // 取一个明显小于上限的数量并确认「不省略」，
  // 这样 `omitted > 0` 被改成 `>= 0` 时会立刻红（它会在 0 时也打印提示）。
  for (const count of [1, 3, 5]) {
    const text = statusWithSuspects(count)
    check(`${count} 个条目时不谎报省略`, !NOTE_PATTERN.test(text), { count, sample: text.slice(0, 200) })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
