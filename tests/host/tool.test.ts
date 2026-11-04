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
    return { changed: true, application: 'applied' }
  },
  async setPluginEnabled() {
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

// output.render 把同一个规范值渲染成人读文本（双形态同源）。
const rendered = tool.output.render({ action: 'status' }, status)
check('render returns one text block', Array.isArray(rendered) && rendered.length === 1, rendered)
check(
  'render text is human-readable (not raw JSON)',
  typeof rendered[0]?.text === 'string' && rendered[0].text.includes('\n') && !rendered[0].text.trimStart().startsWith('{'),
  rendered[0]?.text?.slice(0, 80),
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

await rm(profileDir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL TOOL CHECKS PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
