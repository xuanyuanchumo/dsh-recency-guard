/**
 * revision 同源性的端到端回归（v0.12 / T10-06-E2E）。
 *
 * ## 为什么单独成文件而不是塞进 tool.test.ts
 *
 * tool.test.ts 测的是**工具面**（execute 的规范值与显示投影），本文件测的是
 * **面板 ↔ 动作路由之间的那条线**：面板从 `/snapshot` 拿到凭证，动作请求带它
 * 回来核对。这条线的失败形态不是「某处算错」，而是**两处各自装配** ——
 * 将来有人给 revisionFacts 加一个字段而只改一侧，后果不是「少核对一项」，
 * 而是**每一次动作都被 409 拦下**（面板发出去的凭证永远核对不过）：
 * 一个可选加强项变成整体失效，用户端表现为「按钮全废」。
 *
 * 所以这里断言的不是「两处各自正确」，而是「两处的输出**相等**」，
 * 并且走的都是真实代码（Guard + registerRoutes + 真实 cordis Context），
 * 不是把 RouteContext 桩成一个常量。
 *
 * ## 三道断言的方向性
 *
 * 1. 快照 revision 与 409 回传的 current 相等 ⇒ 两条路径同源（漂移门）；
 * 2. 带快照凭证的动作**成功** ⇒ 真实旅程可用（否则 1 相等也可能是两边都算错）；
 * 3. 带错误凭证 ⇒ 409 **且状态未变** ⇒ 冲突时真的没执行（否则门是装饰）。
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
const { ROUTE_PATHS } = await import('../../src/host/surface/routes.ts')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const profileDir = await mkdtemp(join(tmpdir(), 'recency-revision-'))
await mkdir(join(profileDir, 'node_modules', 'dsh-third-party'), { recursive: true })
await writeFile(
  join(profileDir, 'node_modules', 'dsh-third-party', 'package.json'),
  JSON.stringify({ name: 'dsh-third-party', version: '2.0.0' }),
  'utf8',
)
await writeFile(
  join(profileDir, 'package.json'),
  JSON.stringify({ name: 'dsh-profile-test', dependencies: { 'dsh-third-party': '2.0.0' } }),
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
    return [{ name: '@deepseek-ai/dsh-base', installed: true, enabled: true, official: true, version: '1.0.0' },
      { name: 'dsh-third-party', installed: true, enabled: true, version: '2.0.0' }]
  },
  async listPlugins() {
    return [{ entryId: 'entry-third-party', moduleName: 'dsh-third-party', enabled: true, patchId: 'third-party' }]
  },
  async setBundleEnabled() {
    return { changed: true, application: 'applied' }
  },
  async setPluginEnabled() {
    return { changed: true, application: 'applied' }
  },
})
ctx.provide('tools', { register() {} })

/** 捕获注册出来的路由（真实 registerRoutes 的产物，不是手写 handler）。 */
const byPath = new Map<string, (req: any, res: any) => Promise<void>>()
ctx.provide('webServer', {
  register(route: { path: string; handler: any }) {
    byPath.set(route.path, route.handler)
    return () => {}
  },
})

apply(ctx, Config({}))

// 等一条 effect 周期，让路由子 fiber 完成注册（真实 cordis 是异步调度的）。
await new Promise((resolve) => setTimeout(resolve, 50))

console.log('\n== 路由面可达 ==')
check('snapshot 路由已注册', byPath.has(ROUTE_PATHS.snapshot), [...byPath.keys()])
check('restore 动作路由已注册', byPath.has(ROUTE_PATHS.restore))

/** 用桩 req/res 打一次真实 handler。 */
async function call(
  path: string,
  opts: { method?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number | null; json: any }> {
  const chunks: string[] = []
  const req = {
    method: opts.method ?? 'GET',
    url: path,
    on(event: string, listener: (chunk: unknown) => void) {
      if (event === 'data' && opts.body !== undefined) listener(JSON.stringify(opts.body))
      if (event === 'end') listener(null)
    },
    setEncoding() {},
  }
  const res = {
    status: null as number | null,
    writeHead(status: number) {
      res.status = status
    },
    end(body?: string) {
      if (typeof body === 'string') chunks.push(body)
    },
  }
  await byPath.get(path)!(req, res)
  return { status: res.status, json: chunks.length > 0 ? JSON.parse(chunks.join('')) : null }
}

console.log('\n== 同源（漂移门）==')
const snapshot = await call(ROUTE_PATHS.snapshot)
check('快照返回 200', snapshot.status === 200, snapshot.status)
const panelRevision = snapshot.json?.revision
check(
  '快照带 12 位 hex 凭证（面板据此发起动作）',
  typeof panelRevision === 'string' && /^[0-9a-f]{12}$/.test(panelRevision),
  panelRevision,
)

// 故意带一个错凭证，从 409 的 `current` 里取回**动作路径**算出的那枚。
const stale = await call(ROUTE_PATHS.restore, { method: 'POST', body: { expectedRevision: 'wrong0000000' } })
check('错凭证被 409 拦下', stale.status === 409, stale.status)
const routeRevision = stale.json?.current
check(
  '面板凭证与动作路由凭证**相等**（两处装配同源，加字段漏改一侧会在此处响亮失败）',
  routeRevision === panelRevision,
  { panelRevision, routeRevision },
)

console.log('\n== 真实旅程可用（带快照凭证的动作必须成功）==')
const ok = await call(ROUTE_PATHS.restore, { method: 'POST', body: { expectedRevision: panelRevision } })
check(
  '带快照凭证的 restore 执行成功（相等但两边都算错的话这条会红）',
  ok.status === 200 && ok.json !== null,
  { status: ok.status, body: JSON.stringify(ok.json).slice(0, 160) },
)

console.log('\n== 冲突时确实没执行 ==')
// reenable 需要 bundle；先用一个会改变 state 的动作验证「未执行」：
// 错误凭证打 recover ⇒ 409 ⇒ journal 不应新增审计行（审计行写在动作之前，
// 所以「没有审计行」等价于「动作没被发起」）。
const beforeJournal = await call(ROUTE_PATHS.snapshot)
const conflict = await call(ROUTE_PATHS.recover, { method: 'POST', body: { expectedRevision: 'stale1111111' } })
check('recover 错凭证 409', conflict.status === 409, conflict.status)
check('409 响应体不含执行结果（ok 不为 true）', conflict.json?.ok !== true, conflict.json)
const afterJournal = await call(ROUTE_PATHS.snapshot)
check(
  '409 之后凭证未变（没有任何写状态发生）',
  afterJournal.json?.revision === beforeJournal.json?.revision,
  { before: beforeJournal.json?.revision, after: afterJournal.json?.revision },
)

console.log('\n== 不带凭证仍放行（agent 主动修复路径）==')
const bare = await call(ROUTE_PATHS.restore, { method: 'POST', body: {} })
check('不带 expectedRevision 时动作执行', bare.status === 200, bare.status)

await rm(profileDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nrevision 同源性 全部通过\n' : `\n${failures} 个断言失败\n`)
if (failures > 0) process.exit(1)
