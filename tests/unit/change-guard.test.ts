/**
 * change-guard（v0.12）的 Core 层单测 —— 纯函数，无需宿主。
 *
 * 钉死的三条不变式：
 * 1. revision 是**确定性派生**：同一事实必得同一枚值（崩溃重启后不撒谎）；
 *    任一事实字段变化必须换值（否则过期按钮检测形同虚设）；
 * 2. checkRevision 只有三种结局（相符 / 过期 / 未带），不存在「带了但没核对」；
 * 3. 列表编码边界（含分隔符插件名）不能被折叠成同一枚 revision。
 */
import { checkRevision, computeRevision, auditEnvelope, type RevisionFacts } from '../../src/change-guard.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const base: RevisionFacts = {
  crashSeq: 0,
  autoDisabled: ['dsh-a', 'dsh-b'],
  restored: [],
  stabilized: false,
  decisionDisable: ['dsh-a'],
  journalTail: '2026-11-08T16:00:00.000Z',
}

console.log('\n== revision 派生 ==')
check('same facts ⇒ byte-identical revision', computeRevision(base) === computeRevision({ ...base }))
check('revision is 12 hex chars', /^[0-9a-f]{12}$/.test(computeRevision(base)), computeRevision(base))

// 逐字段敏感度：每个事实字段都必须能翻转 revision。
const mutations: Array<[string, Partial<RevisionFacts>]> = [
  ['crashSeq', { crashSeq: 1 }],
  ['stabilized', { stabilized: true }],
  ['decisionDisable', { decisionDisable: ['dsh-a', 'dsh-b'] }],
  ['journalTail', { journalTail: '2026-11-08T16:00:01.000Z' }],
  ['autoDisabled 内容', { autoDisabled: ['dsh-a'] }],
  ['autoDisabled 顺序', { autoDisabled: ['dsh-b', 'dsh-a'] }],
  ['restored', { restored: ['dsh-c'] }],
]
for (const [label, patch] of mutations) {
  const next = { ...base, ...patch }
  check(`changing ${label} changes the revision`, computeRevision(next) !== computeRevision(base))
}

// 顺序敏感度是刻意设计：autoDisabled 的先后是因果信息（先关谁）。
check(
  'order of autoDisabled is causal, not normalized away',
  computeRevision({ ...base, autoDisabled: ['dsh-a', 'dsh-b'] }) !==
    computeRevision({ ...base, autoDisabled: ['dsh-b', 'dsh-a'] }),
)

// 编码边界：`["a","b,c"]` 与 `["a,b","c"]` 若用裸 join 会得到同一个串。
check(
  'delimiter inside a bundle name does not collapse two states',
  computeRevision({ ...base, autoDisabled: ['a', 'b,c'] }) !==
    computeRevision({ ...base, autoDisabled: ['a,b', 'c'] }),
)
check(
  'empty vs one-element list are distinct',
  computeRevision({ ...base, autoDisabled: [] }) !== computeRevision({ ...base, autoDisabled: [''] }),
)

console.log('\n== checkRevision 三态 ==')
const r = computeRevision(base)
const matched = checkRevision(r, r)
check('相符 ⇒ ok 且 unchecked:false', matched.ok === true && matched.stale === false && matched.unchecked === false, matched)
const absent = checkRevision(r, undefined)
check('未带 ⇒ ok 但显式标记 unchecked（不冒充核对过）', absent.ok === true && absent.unchecked === true, absent)
const emptyString = checkRevision(r, '')
check('空串按「未带」处理（不是拿空串去比）', emptyString.ok === true && emptyString.unchecked === true, emptyString)
const wrong = checkRevision(r, 'stale0000000')
check('不符 ⇒ ok:false + stale', wrong.ok === false && wrong.stale === true, wrong)
check('不符时回传当前值（供调用方重读）', !wrong.ok && wrong.current === r && wrong.expected === 'stale0000000', wrong)
check('非字符串的 expected 走「未带」而不是抛错', checkRevision(r, 12345 as unknown).unchecked === true)

console.log('\n== 审计信封 ==')
const withReason = auditEnvelope('tool', 'recover', '沙箱旅程验证')
check('带理由时原样保留', withReason.justification === '沙箱旅程验证', withReason)
check('actor 与 action 可跨通道对账', withReason.actor === 'tool' && withReason.action === 'recover', withReason)
const noReason = auditEnvelope('panel', 'archive', '   ')
check(
  '空理由写成「调用方未提供」而不是空串（审计时不误读成无需理由）',
  noReason.justification.includes('未提供理由') && noReason.justification.includes('panel'),
  noReason.justification,
)
const nonString = auditEnvelope('boot', 'auto-disable', { oops: true } as unknown as string)
check('非字符串理由同样降级为可审计默认', nonString.justification.includes('未提供理由'), nonString.justification)

console.log(failures === 0 ? '\nchange-guard 全部通过\n' : `\n${failures} 个断言失败\n`)
if (failures > 0) process.exit(1)
