/**
 * 纯投影模块直接单测（T15-04）：`boot-notes` / `status-view` / `tool-presentation`。
 *
 * 为什么补这条：三者都是**纯函数**（无 IO、无宿主实例），却因为从未被测试
 * 直接 import 而整体游离在变异池之外。纯函数最该直接测 —— 它们的输入输出
 * 就是契约本身。
 *
 * 覆盖边界（不假装覆盖）：`tool-presentation` 只测投影规则；宿主
 * `@deepseek-ai/dsh-tools` 的卡片渲染与 `presentCall/presentResult` 的接线
 * 不在本文件（那属于宿主运行时，需要真机加载）。
 */
import {
  abnormalExitEvents,
} from '../../src/host/guard/boot-notes.js'
import { buildStatusOutput, type StatusInput } from '../../src/host/surface/status-view.js'
import {
  describeCallArgs,
  displayModelFromMeta,
  displayModelOf,
  presentCallOf,
  presentResultOf,
  presentationMetaOf,
  titleForAction,
  truncationMetric,
} from '../../src/host/surface/tool-presentation.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n== boot-notes：四分类只写该写的事实 ==')
{
  const abnormal = abnormalExitEvents({
    exitClass: 'abnormal',
    nextSeq: 1,
    ageMs: 1000,
    abnormalDetail: '上次运行未留下退出码',
    concurrentDetail: null,
    selfReloadDetail: null,
  })
  check('abnormal ⇒ crash-detected（进崩溃证据链）', abnormal.length === 1 && abnormal[0]?.kind === 'crash-detected', abnormal)
  check('abnormal 的 exitCode 是 null（不伪造 0）', abnormal[0]?.exitCode === null, abnormal[0])
  check('abnormal 的 signal 标成 unobserved', abnormal[0]?.signal === 'unobserved', abnormal[0])
  const concurrent = abnormalExitEvents({
    exitClass: 'concurrent',
    nextSeq: 0,
    ageMs: 0,
    abnormalDetail: null,
    concurrentDetail: '另一个实例还开着',
    selfReloadDetail: null,
  })
  check('concurrent ⇒ note（不污染 crashSeq）', concurrent.length === 1 && concurrent[0]?.kind === 'note' && concurrent[0]?.detail === '另一个实例还开着', concurrent)
  const reload = abnormalExitEvents({
    exitClass: 'self-reload',
    nextSeq: 0,
    ageMs: 0,
    abnormalDetail: null,
    concurrentDetail: null,
    selfReloadDetail: '热重载',
  })
  check('self-reload ⇒ note', reload.length === 1 && reload[0]?.kind === 'note' && reload[0]?.detail === '热重载', reload)
  const clean = abnormalExitEvents({
    exitClass: 'clean',
    nextSeq: 0,
    ageMs: 0,
    abnormalDetail: null,
    concurrentDetail: null,
    selfReloadDetail: null,
  })
  check('clean ⇒ 不写任何事件（不制造噪声）', clean.length === 0, clean)
}

console.log('\n== status-view：投影是窗口，不是数据截断 ==')
{
  const ranked = Array.from({ length: 15 }, (_, i) => ({ bundle: `dsh-${i}`, lastChangeAt: `t${i}`, lastKind: 'install' }))
  const steps = Array.from({ length: 20 }, (_, i) => ({ title: `step-${i}` }))
  const rejected = Array.from({ length: 8 }, (_, i) => ({ from: 'a', to: 'b', reason: `r${i}` }))
  const transitions = [{ from: 'boot', to: 'observe' }, { from: 'observe', to: 'stable' }]
  const input: StatusInput = {
    profile: 'sb-profile',
    workspace: 'D:/Work',
    projectKey: 'k1',
    dshVersion: '0.17.0',
    pluginVersion: null,
    issuesUrl: null,
    enabled: true,
    state: {
      bootMarker: null,
      crashSeq: 2,
      autoDisabled: [],
      stabilized: false,
      restored: [],
      crashedRun: true,
    },
    ranked,
    experimentalSuspects: ['dsh-exp'],
    decisionFile: '/tmp/decision.json',
    decisionEvidence: { hasEvidence: false, items: [] },
    cooccurrence: {
      samples: 0,
      activeSamples: 0,
      inactiveSamples: 0,
      activeHitRate: null,
      inactiveHitRate: null,
      hitRateDelta: null,
      label: '样本不足',
      mayWeight: { allowed: false, reason: '样本不足' },
    },
    bayes: [],
    calibration: null,
    lifecycle: {
      stage: 'observing',
      stabilityScore: 0.5,
      steps,
      openSteps: ['boot'],
      rejected,
      transitions,
    },
    configEditorAvailable: false,
  }
  const out = buildStatusOutput(input) as Record<string, any>
  check('嫌疑排名保持全量（15 条，不伪装成切片）', out.suspectRanking.length === 15 && out.suspectTotal === 15, out.suspectTotal)
  check('steps 只保留最近 12 步（窗口语义）', out.lifecycle.steps.length === 12 && out.lifecycle.steps[0]?.title === 'step-8', out.lifecycle.steps.length)
  check('rejected 只保留最近 5 条', out.lifecycle.rejectedTransitions.length === 5, out.lifecycle.rejectedTransitions.length)
  check('lastTransition 取最后一条', out.lifecycle.lastTransition?.to === 'stable', out.lifecycle.lastTransition)
  check('openSteps 原样保留（不截断）', JSON.stringify(out.lifecycle.openSteps) === '["boot"]')
  check('crashedLastRun 来自 state.crashedRun === true', out.crashedLastRun === true)
  check('pluginVersion: null 诚实保留（不伪造版本）', out.pluginVersion === null)
  check('issuesUrl: null 诚实保留（不放死链）', out.issuesUrl === null)
  check('conflicts 未提供时是空数组（空 ≠ 未扫）', JSON.stringify(out.conflicts) === '[]')
  check('unresolved 未提供时是空数组', JSON.stringify(out.unresolved) === '[]')
  const withMore = buildStatusOutput({
    ...input,
    conflicts: [{ kind: 'dsh-version', severity: 'error' } as never],
    unresolved: [],
  }) as Record<string, any>
  check('conflicts 显式提供时原样上屏（不合并进 unresolved）', withMore.conflicts.length === 1 && withMore.unresolved.length === 0)
}

console.log('\n== tool-presentation：标题/摘要/退化（全函数，绝不抛）==')
{
  check('已知 action 的标题是人话', titleForAction('status') === '崩溃守护状态', titleForAction('status'))
  check('未知 action 退化为「插件崩溃守护（x）」', titleForAction('nope') === '插件崩溃守护（nope）', titleForAction('nope'))
  check('参数摘要只挑关键参数', describeCallArgs({ action: 'history', limit: 40 }) === 'history · 最多 40 条', describeCallArgs({ action: 'history', limit: 40 }))
  check('bundle/reason 进入摘要且 reason 被 trim', describeCallArgs({ action: 'recover', bundle: 'dsh-x', reason: ' 手动 ' }) === 'recover · 插件 dsh-x · 原因 手动', describeCallArgs({ action: 'recover', bundle: 'dsh-x', reason: ' 手动 ' }))
  check('非法参数退化为 unknown（不抛）', describeCallArgs(null) === 'unknown' && describeCallArgs('x') === 'unknown')
  const call = presentCallOf({ action: 'status' })
  check('presentCall 明确声明 generic 卡片', call.card === 'generic' && call.title === '崩溃守护状态' && call.rawInput === 'status', call)

  const zero = truncationMetric(0)
  check('省略 0 条是可判定真值（defined:true）', zero.defined === true && zero.value === 0, zero)
  check('省略 0 条的文案是「输出完整展示」', zero.label.includes('输出完整展示'), zero.label)
  const three = truncationMetric(3)
  check('省略 N 条的文案计数 N', three.value === 3 && three.label.includes('折叠 3 条'), three)

  const flat = displayModelFromMeta({ title: 'T', summary: 'S', omitted: 2 })
  check('平铺 meta 重建模型（title/omitted）', flat?.title === 'T' && flat?.omitted === 2 && flat?.summary === 'S', flat)
  check('平铺 meta 缺 title 时用 summary 兜底', displayModelFromMeta({ summary: 'S2' })?.title === 'S2')
  check('平铺 meta 的 ok 只在 === true 时为真', flat?.ok === false)
  check('displayModelFromMeta(null) ⇒ null', displayModelFromMeta(null) === null)
  const nested = displayModelFromMeta({ value: { display: { summary: 'D' } } })
  check('嵌套规范值也能读出模型', nested?.summary === 'D', nested)
  check('displayModelOf 无 display ⇒ null', displayModelOf({ summary: 'x' }) === null)
  check('displayModelOf 有 display 但无 summary ⇒ null', displayModelOf({ display: { title: 'x' } }) === null)

  const result = presentResultOf({ action: 'status' }, { content: [{ type: 'text', text: '正文' }] })
  check('presentResult 标题用固定前缀 + action 人话', result.title === '插件崩溃守护 · 崩溃守护状态', result.title)
  check('presentResult 正文优先用宿主 content', JSON.stringify(result.content) === '[{"type":"text","text":"正文"}]', result.content)
  const fallback = presentResultOf({ action: 'status' }, { meta: { summary: '摘要兜底' } })
  check('无 content 时正文退化为 meta 摘要', JSON.stringify(fallback.content).includes('摘要兜底'), fallback.content)
  const empty = presentResultOf({ action: 'status' }, null)
  check('完全没有输出时给「（无输出）」而不是白屏', JSON.stringify(empty.content).includes('（无输出）'), empty.content)

  const meta = presentationMetaOf({ display: { summary: 'S', facts: [], sections: [], omitted: 0, ok: true } }) as Record<string, unknown>
  check('presentationMeta 把规范值摊平成宿主 meta', meta.summary === 'S' && meta.ok === true, meta)
  const legacy = presentationMetaOf({ summary: '旧值', lines: ['a', 'b'] }) as Record<string, any>
  check('旧规范值退化为摘要 + 明细分区', legacy.summary === '旧值' && Array.isArray(legacy.sections) && legacy.sections[0]?.lines.length === 2, legacy.sections)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)