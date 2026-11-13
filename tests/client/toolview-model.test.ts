import {
  buildToolViewModel,
  extractMetaFacts,
  extractOutputText,
  summarizeArgs,
} from '../../src/client/toolview/toolview-model.ts'

/**
 * `tool.call.toolview` 卡片数据抽取层的单测。
 *
 * ## 为什么这层要单独测
 *
 * 卡片渲染的是**宿主给的 wire block**，形状由宿主控制且会演进。
 * 抽取层必须对敌对输入（null / 数组 / 缺字段 / 非字符串 / 数字 NaN）
 * **只降级、不抛异常** —— 展示路径抛错会把一次成功的工具调用变成失败调用。
 *
 * 本文件钉死的高危不变式：
 *
 * 1. **缺失即缺失**：没有 exitCode 就显示「未提供」，绝不臆造 0。
 * 2. **meta 是事实**：facts / sections / omitted 只从 host 侧 meta 取，
 *    不从正文里猜结构。
 * 3. **省略计数是真值**：omitted=0 是「完整展示」，不是「未知」。
 * 4. **相位三分**：preparing / start / result 各有自己的字段集，
 *    不得串味（例如 result 阶段不该冒出参数摘要）。
 * 5. **敌对输入不崩**：所有取值路径都要能吃下畸形 block。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

// ---------- summarizeArgs ----------

check(
  '参数摘要：字符串/数字/布尔进摘要',
  summarizeArgs({ action: 'status', limit: 40, deep: true }) === 'action=status · limit=40 · deep=true',
  summarizeArgs({ action: 'status', limit: 40, deep: true }),
)
check('参数摘要：对象/数组不进摘要（只摊平标量）', summarizeArgs({ action: 'x', obj: { a: 1 } }) === 'action=x', summarizeArgs({ action: 'x', obj: { a: 1 } }))
check('参数摘要：非对象返回空串', summarizeArgs(null) === '' && summarizeArgs('nope') === '' && summarizeArgs(undefined) === '')
check('参数摘要：NaN/Infinity 不进摘要', summarizeArgs({ n: Number.NaN, m: Number.POSITIVE_INFINITY }) === '', summarizeArgs({ n: Number.NaN }))

// ---------- extractMetaFacts ----------

const metaOk = extractMetaFacts({
  title: '崩溃守护状态',
  ok: true,
  summary: '一切正常',
  facts: [{ label: '阶段', value: '监控中' }, { label: '', value: '孤立值' }],
  sections: [{ title: '明细', lines: ['a', 'b'], collapsed: true, omitted: 3 }],
  omitted: 3,
})
check('meta：标题被取出', metaOk.title === '崩溃守护状态', metaOk.title)
check('meta：摘要被取出', metaOk.summary === '一切正常', metaOk.summary)
check('meta：ok 默认 true（缺字段不判失败）', metaOk.ok === true)
check('meta：facts 被取出', metaOk.facts.length === 2, metaOk.facts)
check('meta：空 label 的 fact 用占位符', metaOk.facts[1].label === '—', metaOk.facts[1])
check('meta：sections 被取出', metaOk.sections.length === 1, metaOk.sections)
check('meta：section 的 collapsed 被保留', metaOk.sections[0].collapsed === true)
check('meta：section 的 omitted 被保留', metaOk.sections[0].omitted === 3)
check('meta：总 omitted 被取出', metaOk.omitted === 3)

const metaEmpty = extractMetaFacts(null)
check('meta：null 返回空态而非抛错', metaEmpty.facts.length === 0 && metaEmpty.sections.length === 0 && metaEmpty.omitted === 0)
check('meta：undefined 返回空态', extractMetaFacts(undefined).title === '')
check('meta：ok=false 被识别', extractMetaFacts({ ok: false }).ok === false)
check('meta：非数组 facts 被忽略', extractMetaFacts({ facts: 'x' }).facts.length === 0)
check('meta：facts 里的非对象项被跳过', extractMetaFacts({ facts: [null, 1, 'x', { label: 'k', value: 'v' }] }).facts.length === 1)
check('meta：section 里的非字符串 line 被过滤', extractMetaFacts({ sections: [{ title: 't', lines: ['a', 1, null, 'b'] }] }).sections[0].lines.length === 2)
check('meta：无标题无行的空 section 被丢弃', extractMetaFacts({ sections: [{ title: '', lines: [] }] }).sections.length === 0)
check('meta：无标题的 section 用默认标题', extractMetaFacts({ sections: [{ title: '', lines: ['x'] }] }).sections[0].title === '明细')
check('meta：非数字 omitted 归零', extractMetaFacts({ omitted: 'x' }).omitted === 0)
check('meta：NaN omitted 归零', extractMetaFacts({ omitted: Number.NaN }).omitted === 0)

// ---------- extractOutputText ----------

check('正文：text 块被拼接', extractOutputText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'a\nb', extractOutputText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))
check('正文：非 text 块被跳过', extractOutputText({ content: [{ type: 'image', text: 'x' }, { type: 'text', text: 'a' }] }) === 'a')
check('正文：字符串 content 直接返回', extractOutputText({ content: 'hello' }) === 'hello')
check('正文：坏块被跳过不崩', extractOutputText({ content: [null, 1, 'raw', { type: 'text', text: 'a' }] }) === 'raw\na', extractOutputText({ content: [null, 1, 'raw', { type: 'text', text: 'a' }] }))
check('正文：null block 返回空串', extractOutputText(null) === '')
check('正文：缺 content 返回空串', extractOutputText({}) === '')

// ---------- buildToolViewModel ----------

const preparing = buildToolViewModel({ toolName: 'recency_guard', phase: 'preparing', cwd: '/tmp' })
check('preparing：pending 为真', preparing.pending === true)
check('preparing：无正文无事实', preparing.output === '' && preparing.facts.length === 0)
check('preparing：无 exitCode（不臆造）', preparing.exitCode === undefined)
check('preparing：cwd 被保留', preparing.cwd === '/tmp')

const start = buildToolViewModel({
  toolName: 'recency_guard',
  phase: 'start',
  cwd: '/work',
  block: { arguments: { action: 'history', limit: 20 } },
})
check('start：参数摘要被生成', start.argsSummary === 'action=history · limit=20', start.argsSummary)
check('start：pending 为假', start.pending === false)
check('start：不产出正文', start.output === '')
check('start：无 exitCode', start.exitCode === undefined)

const result = buildToolViewModel({
  toolName: 'recency_guard',
  phase: 'result',
  cwd: '/work',
  block: {
    content: [{ type: 'text', text: '守护正常' }],
    meta: {
      title: '崩溃守护状态',
      ok: true,
      summary: '监控中',
      facts: [{ label: '崩溃率', value: '0%' }],
      sections: [{ title: '明细', lines: ['x'], collapsed: false, omitted: 0 }],
      omitted: 0,
      exitCode: 0,
      durationMs: 12,
    },
  },
})
check('result：标题取 host 侧给的', result.title === '崩溃守护状态', result.title)
check('result：摘要被取出', result.summary === '监控中')
check('result：事实被取出', result.facts.length === 1 && result.facts[0].label === '崩溃率')
check('result：分区被取出', result.sections.length === 1)
check('result：正文被取出', result.output === '守护正常')
check('result：exitCode 被取出', result.exitCode === 0)
check('result：耗时被取出', result.durationMs === 12)
check('result：omitted=0 是真值不是未知', result.omitted === 0)
check('result：cwd 被保留', result.cwd === '/work')
check('result：不产出参数摘要（那是 start 的字段）', result.argsSummary === '')

const resultNoMeta = buildToolViewModel({
  toolName: 'recency_guard',
  phase: 'result',
  block: { content: [{ type: 'text', text: '裸输出' }] },
})
check('result 无 meta：标题退化为工具名', resultNoMeta.title === 'recency_guard', resultNoMeta.title)
check('result 无 meta：exitCode 未提供（不是 0）', resultNoMeta.exitCode === undefined)
check('result 无 meta：耗时未提供', resultNoMeta.durationMs === undefined)
check('result 无 meta：正文仍在（诚实展示）', resultNoMeta.output === '裸输出')

// 敌对输入：全部不得抛异常。
const hostileInputs: unknown[] = [
  null,
  undefined,
  'string',
  42,
  { phase: 'weird-phase' },
  { phase: 'result', block: null },
  { phase: 'result', block: 'not-an-object' },
  { phase: 'result', block: { meta: 'not-an-object' } },
  { phase: 'result', block: { meta: { facts: 'x', sections: 42, omitted: {} } } },
  { phase: 'result', block: { content: 42 } },
]
let hostileOk = true
const hostileDetail: unknown[] = []
for (const input of hostileInputs) {
  try {
    const model = buildToolViewModel(input)
    if (typeof model.title !== 'string') {
      hostileOk = false
      hostileDetail.push({ input, reason: 'title 不是字符串' })
    }
  } catch (error) {
    hostileOk = false
    hostileDetail.push({ input, reason: String(error) })
  }
}
check('敌对输入：全部不抛异常且返回合法模型', hostileOk, hostileDetail)

// 未知相位：按 result 处理（最保守：显示结果而不是假装在准备）。
const weirdPhase = buildToolViewModel({ toolName: 'recency_guard', phase: 'nonsense', block: { content: [{ type: 'text', text: 'x' }] } })
check('未知相位：按 result 兜底', weirdPhase.phase === 'result' && weirdPhase.output === 'x', weirdPhase.phase)

if (failures > 0) {
  console.error(`\ntoolview-model: ${failures} 条断言失败`)
  process.exit(1)
}
console.log('\ntoolview-model 全部通过')
