/**
 * A minimal harness that mounts the plugin with fakes for the harness
 * services, so the tool's registration and its actions can be exercised
 * without an LLM provider or a full DSH boot.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importRuntime, hasRuntime } from './runtime.ts'

if (!hasRuntime()) {
  console.error('The extracted runtime is missing. Run: node scripts/extract-runtime.mjs')
  process.exit(1)
}

const { Context } = await importRuntime<{ Context: new () => any }>('@deepseek-ai/cordis')
const { apply, Config } = await import('../../src/index.ts')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const disabledBundles: string[] = []
const enabledBundles: string[] = []
/** v0.11.2 回归开关：管理器拒绝 enable 时，诚实的 reenable 必须报失败。 */
let failEnables = false
const pluginRows: Array<{
  entryId: string
  moduleName: string
  enabled: boolean
  patchId?: string
  readOnlyReason?: string
}> = [
  { entryId: 'entry-third-party', moduleName: 'dsh-third-party', enabled: true, patchId: 'third-party' },
  { entryId: 'entry-experimental', moduleName: 'dsh-experimental-thing', enabled: true, patchId: 'experimental' },
  {
    entryId: 'entry-official',
    moduleName: '@deepseek-ai/dsh-base',
    enabled: true,
    readOnlyReason: 'management-required',
  },
]

const bundles = [
  { name: '@deepseek-ai/dsh-base', installed: true, enabled: true, official: true, version: '1.0.0' },
  { name: 'dsh-third-party', installed: true, enabled: true, version: '2.0.0' },
  { name: 'dsh-experimental-thing', installed: true, enabled: true, version: '0.5.0' },
]

const profileDir = await mkdtemp(join(tmpdir(), 'recency-guard-tool-'))

// The recency ranking reads the profile's INSTALLED packages, so the
// temporary profile needs a node_modules with them.
await mkdir(join(profileDir, 'node_modules', 'dsh-third-party'), { recursive: true })
await mkdir(join(profileDir, 'node_modules', 'dsh-experimental-thing'), { recursive: true })
await writeFile(
  join(profileDir, 'node_modules', 'dsh-third-party', 'package.json'),
  JSON.stringify({ name: 'dsh-third-party', version: '2.0.0' }),
  'utf8',
)
await writeFile(
  join(profileDir, 'node_modules', 'dsh-experimental-thing', 'package.json'),
  JSON.stringify({ name: 'dsh-experimental-thing', version: '0.5.0' }),
  'utf8',
)
// The profile manifest declares them as the profile's own plugins.
await writeFile(
  join(profileDir, 'package.json'),
  JSON.stringify({
    name: 'dsh-profile-test',
    dependencies: { 'dsh-third-party': '2.0.0', 'dsh-experimental-thing': '0.5.0' },
  }),
  'utf8',
)

const ctx = new Context()
ctx.provide('profileContext', {
  name: 'test',
  dir: profileDir,
  patchPath: join(profileDir, 'cordis.patch.yml'),
})
ctx.provide('pluginManager', {
  async listBundles() {
    return bundles
  },
  async listPlugins() {
    return pluginRows
  },
  async setBundleEnabled(name: string, enabled: boolean) {
    ;(enabled ? enabledBundles : disabledBundles).push(name)
    if (enabled && failEnables) return { changed: false, application: 'failed' }
    return { changed: true, application: 'applied' }
  },
  async setPluginEnabled() {
    if (failEnables) return { changed: false, application: 'failed' }
    return { changed: true, application: 'applied' }
  },
})
ctx.provide('configEditor', {
  configuration() {
    return [
      { entry: { id: 'third-party', name: 'dsh-third-party' }, inherited: { a: 1 }, override: { b: 2 } },
      { entry: { id: 'experimental', name: 'dsh-experimental-thing' }, inherited: {}, override: {} },
    ]
  },
})

const tools = new Map<string, any>()
ctx.provide('tools', {
  register(tool: any) {
    tools.set(tool.name, tool)
  },
})

apply(ctx, Config({}))

check('the recency_guard tool is registered', tools.has('recency_guard'))
const tool = tools.get('recency_guard')
check('the tool has a description', typeof tool?.description === 'string' && tool.description.length > 0)
// The tool declares its parameters as a JSON Schema.
const schema = tool?.parameters ?? {}
const declaredActions: string[] = schema?.properties?.action?.enum ?? []
check(
  'the tool declares its actions',
  ['status', 'history', 'recover', 'restore', 'reenable', 'backups', 'archive', 'archives'].every((a) =>
    declaredActions.includes(a),
  ),
  declaredActions,
)
check('the action parameter is required', JSON.stringify(schema?.required) === '["action"]', schema?.required)
check(
  'the bundle and limit parameters are optional',
  schema?.properties?.bundle !== undefined && schema?.properties?.limit !== undefined,
  Object.keys(schema?.properties ?? {}),
)

const exec = { signal: new AbortController().signal }

// v0.4.0 起 execute 返回**规范 JSON 值**（不是字符串）：
// 结构化事实给模型，人读文本由 output.render 投影（会话命令窗口显示的是它）。
const status = (await tool.execute({ action: 'status' }, exec)) as any
check('status reports the profile', status.profile === 'test', status.profile)
check(
  'status ranks both third-party plugins as suspects',
  JSON.stringify(status.suspectRanking?.map((r: any) => r.bundle).sort()) ===
    JSON.stringify(['dsh-experimental-thing', 'dsh-third-party']),
  status.suspectRanking,
)
check(
  'status ranks the newest plugin first',
  status.suspectRanking?.[0]?.bundle === 'dsh-experimental-thing',
  status.suspectRanking,
)
check(
  'status does not rank the guard itself',
  !JSON.stringify(status.suspectRanking).includes('dsh-recency-guard'),
)
check(
  'status reports the experimental suspects',
  status.experimentalSuspects?.includes('dsh-experimental-thing'),
  status.experimentalSuspects,
)
check('status carries the action echo', status.action === 'status', status.action)
check('status is a business success', status.ok === true, status.ok)
check('status carries a human summary', typeof status.summary === 'string' && status.summary.length > 0, status.summary)
// v0.10 R18：命令窗口也带插件版本与反馈入口（排障现场直达 Issues）。
check('status reports the plugin version', typeof status.pluginVersion === 'string' && status.pluginVersion.length > 0, status.pluginVersion)
check('status reports the issues url', typeof status.issuesUrl === 'string' && status.issuesUrl.startsWith('https://'), status.issuesUrl)

// output.render 把同一个规范值渲染成人读文本（双形态同源）。
const rendered = tool.output.render({ action: 'status' }, status)
check('render returns one text block', Array.isArray(rendered) && rendered.length === 1, rendered)
check(
  'render text is human-readable (not raw JSON)',
  typeof rendered[0]?.text === 'string' && rendered[0].text.includes('\n') && !rendered[0].text.trimStart().startsWith('{'),
  rendered[0]?.text?.slice(0, 80),
)
check(
  'render text carries the feedback entry (R18)',
  typeof rendered[0]?.text === 'string' && rendered[0].text.includes(status.issuesUrl),
  rendered[0]?.text?.slice(-200),
)

const history = (await tool.execute({ action: 'history', limit: 5 }, exec)) as any
check('history returns the event list', Array.isArray(history.events), typeof history.events)

const recover = (await tool.execute({ action: 'recover' }, exec)) as any
check('recover disables one plugin on the first pass', recover.disabled.length === 1, recover.disabled)
check(
  'recover disables the most recent suspect',
  recover.disabled[0] === 'dsh-experimental-thing',
  recover.disabled,
)
check('recover calls the plugin manager', disabledBundles.includes('dsh-experimental-thing'), disabledBundles)

const reenable = (await tool.execute({ action: 'reenable', bundle: 'dsh-third-party' }, exec)) as any
check('reenable reports success', reenable.reenabled === true, reenable)
check('reenable calls the plugin manager', enabledBundles.includes('dsh-third-party'), enabledBundles)

// v0.11.2 白盒回归：管理器拒绝（application=failed，实测 HMR 嵌套事务）时，
// reenable 必须如实报 false —— 否则 state 记「已恢复」而插件实际仍关闭（假绿）。
failEnables = true
const refused = (await tool.execute({ action: 'reenable', bundle: 'dsh-experimental-thing' }, exec)) as any
check('reenable reports failure when the manager rejects', refused.reenabled === false, refused)
failEnables = false

const backups = (await tool.execute({ action: 'backups' }, exec)) as any
check('backups returns the list', Array.isArray(backups.backups), typeof backups.backups)

// v0.4.0 新增：归档重置的**工具入口**（此前只有 HTTP 路由，Agent 无法触达）。
const archivesBefore = (await tool.execute({ action: 'archives' }, exec)) as any
check('archives returns an array', Array.isArray(archivesBefore.archives), archivesBefore)
const archived = (await tool.execute({ action: 'archive', reason: 'host-test' }, exec)) as any
check('archive resets and reports the dir', typeof archived.archiveDir === 'string' && archived.ok === true, archived)
const archivesAfter = (await tool.execute({ action: 'archives' }, exec)) as any
check('archive shows up in the archives list', archivesAfter.archives.length === archivesBefore.archives.length + 1, {
  before: archivesBefore.archives.length,
  after: archivesAfter.archives.length,
})

try {
  await tool.execute({ action: 'nope' }, exec)
  check('an unknown action throws', false)
} catch {
  check('an unknown action throws', true)
}

try {
  await tool.execute({ action: 'reenable' }, exec)
  check('reenable without a bundle throws', false)
} catch {
  check('reenable without a bundle throws', true)
}

// ---------- v0.12 命令窗口显示回归（接线，而不是只有纯函数） ----------
// 踩过的坑：tool-presentation.ts 的三个投影函数**写好了却没接进 defineTool**，
// 于是纯函数单测全绿、宿主却仍落到通用回退（标题是裸工具名、正文是整坨参数
// JSON）。所以这道门必须断言「注册出来的工具对象上真的有这三个方法」，
// 并且走**宿主同一条数据流**：execute 的规范值 → presentationMeta → presentResult。
check('the tool wires presentCall', typeof tool?.presentCall === 'function')
check('the tool wires presentResult', typeof tool?.presentResult === 'function')
check('the tool wires output.presentationMeta', typeof tool?.output?.presentationMeta === 'function')

const callView = tool.presentCall({ action: 'history', limit: 40 })
check('presentCall returns a generic card', callView?.card === 'generic', callView)
check(
  'presentCall titles with the action in human words (not the bare tool name)',
  typeof callView?.title === 'string' && callView.title.includes('日志') && !/^recency_guard$/.test(callView.title),
  callView,
)
check(
  'presentCall summarizes args instead of dumping raw JSON',
  typeof callView?.rawInput === 'string' && callView.rawInput.includes('最多 40') && !callView.rawInput.includes('{'),
  callView?.rawInput,
)
// 宿主契约：args 不合法时 presentCall 必须回退（defineTool 内部 validate 后返回 undefined）。
check(
  'presentCall falls back on invalid args',
  tool.presentCall({ action: 'nope' }) === undefined,
  tool.presentCall({ action: 'nope' }),
)

// 全链路：规范值 → presentationMeta（宿主持久化在 tool/result 的 meta 上）→ presentResult。
const meta = tool.output.presentationMeta({ action: 'status' }, status)
check('presentationMeta projects a display model with a title', typeof meta?.title === 'string' && meta.title.length > 0, meta?.title)
check('presentationMeta carries facts and sections', Array.isArray(meta?.facts) && Array.isArray(meta?.sections))
check(
  'presentationMeta quantifies display completeness',
  meta?.truncation?.defined === true && typeof meta?.truncation?.value === 'number',
  meta?.truncation,
)
const resultView = tool.presentResult({ action: 'status' }, { isError: false, content: [{ type: 'text', text: 'x' }], meta })
check('presentResult returns a generic card', resultView?.card === 'generic', resultView?.card)
check(
  'presentResult title names the plugin and the action',
  typeof resultView?.title === 'string' && resultView.title.includes('插件崩溃守护') && resultView.title.includes('崩溃守护状态'),
  resultView?.title,
)
check(
  'presentResult content is host vocabulary (ContentBlock[]), not a raw string',
  Array.isArray(resultView?.content) && resultView.content[0]?.type === 'text' && typeof resultView.content[0]?.text === 'string',
  resultView?.content,
)
// meta 缺席（旧版本写入的回放记录）时仍要有标题有正文，不能白屏。
const legacyView = tool.presentResult({ action: 'status' }, { isError: false, content: [] })
check(
  'presentResult degrades honestly when meta is absent (replay of an old record)',
  typeof legacyView?.title === 'string' && legacyView.title.length > 0 && Array.isArray(legacyView?.content),
  legacyView,
)

// ---------- v0.12 L4 审计线回归 ----------
// L4 全自主 = 人类只在事后审计；审计线要能回答「谁、以什么理由、动了什么」。
// 钉死三点：写动作**先落审计行**（崩溃发生在中间时，理由已在盘上）、
// 读动作不产生审计噪声（面板轮询不该刷满 journal）、
// 审计行走 journal 的 note 通道（词汇表不扩容 ⇒ 既有事件流消费链全兼容）。
//
// 读 journal 用工具**自己的** history 动作，而不是再 import 一个 Store：
// 测试经由公开面取证，公开面坏了测试就红 —— 直接桩 Store 会让「history
// 读不到审计行」这类真缺陷被测不出来。
{
  const auditLines = async (limit: number): Promise<Array<Record<string, unknown>>> => {
    const outcome = (await tool.execute({ action: 'history', limit }, exec)) as {
      data?: { events?: unknown }
    }
    const events = Array.isArray(outcome.data?.events) ? (outcome.data.events as Array<Record<string, unknown>>) : []
    return events.filter((e) => String(e.detail ?? '').startsWith('审计 ·'))
  }

  const before = await auditLines(400)
  await tool.execute({ action: 'recover' }, exec)
  const after = await auditLines(400)
  check('mutating action writes exactly one audit line', after.length === before.length + 1, {
    before: before.length,
    after: after.length,
  })
  const last = after[after.length - 1] as { detail?: string; audit?: { actor?: string; action?: string } }
  check(
    'audit line carries actor=tool and action=recover as machine-readable data',
    last.audit?.actor === 'tool' && last.audit?.action === 'recover',
    last.audit,
  )
  check('audit detail is human readable', typeof last.detail === 'string' && last.detail.includes('tool/recover'), last.detail)

  // 读动作不产审计行：否则面板每 5s 一次轮询会把崩溃因果链冲掉。
  const readBefore = (await auditLines(500)).length
  await tool.execute({ action: 'status' }, exec)
  await tool.execute({ action: 'archives' }, exec)
  const readAfter = (await auditLines(500)).length
  check('read actions produce no audit noise', readAfter === readBefore, { readBefore, readAfter })
}

await rm(profileDir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL TOOL CHECKS PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
