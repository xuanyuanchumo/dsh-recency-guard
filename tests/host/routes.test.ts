/**
 * routes.ts 的 HTTP 行为测试 —— 补上「注册面有对账、HTTP 行为零测试」的
 * 审计盲区（cycle-6 P0）。钉死的高危不变式：
 *
 * 1. **动作路由方法守卫**：GET 打到动作路由必须 405，绝不触发归档。
 * 2. **partition 查询**：`?partition=` 走跨分区快照；未知分区 404 语义。
 * 3. **读面请假**：loader 抛错时 `{available:false}` 而不是假数据。
 * 4. **reenable 参数校验**：缺 bundle 400。
 *
 * 为什么不起真 HTTP 服务器：registerRoutes 只依赖 `register()` 与
 * Node 风格 req/res —— 用桩对象直接调用 handler，断言 writeHead/end
 * 的调用序列。这样测试同时钉住「handler 完全拥有响应」的契约。
 */
import { registerRoutes, ROUTE_PATHS, type RouteContext, type NodeRequest, type NodeResponse } from '../../src/routes.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 桩响应：记录 writeHead/end 调用。 */
function stubResponse(): NodeResponse & { status: number | null; body: string; headers: Record<string, string> } {
  const record = { status: null as number | null, body: '', headers: {} as Record<string, string> }
  return {
    ...record,
    get status() {
      return record.status
    },
    get body() {
      return record.body
    },
    get headers() {
      return record.headers
    },
    writeHead(status: number, headers?: Record<string, string>) {
      record.status = status
      record.headers = headers ?? {}
    },
    end(body?: string) {
      record.body = body ?? ''
    },
  } as never
}

/** 桩请求。 */
function stubRequest(method: string, url = '/x', bodyChunks: string[] = []): NodeRequest {
  return {
    method,
    url,
    on(event: string, listener: (chunk: unknown) => void) {
      if (event === 'data') bodyChunks.forEach((c) => listener(c))
      if (event === 'end') listener(null)
    },
    setEncoding() {},
  }
}

async function main() {
  console.log('\n== 路由注册面 ==')
  const registered: Array<{ path: string; handler: (req: NodeRequest, res: NodeResponse) => void | Promise<void> }> = []
  const ctx: RouteContext = {
    profileDir: '/tmp/profile',
    workspace: '/tmp/workspace',
    profileName: 'test',
    projectKey: 'abc123',
    snapshot: async () => ({ at: 'T', stage: 'monitoring' }),
    snapshotPartition: async (key: string) => {
      if (key === 'other') return { at: 'T', stage: 'idle', projectKey: 'other' }
      return { available: false, reason: `未知分区 ${key}` }
    },
    graph: async () => ({ nodes: [], edges: [] }),
    archive: async (reason: string) => ({ ok: true, reason }),
    archives: async () => ({ archives: [] }),
    reenable: async (bundle: string) => ({ ok: true, bundle }),
    restore: async () => ({ reenabled: [] }),
    recover: async () => ({ disabled: [] }),
    isolation: async () => ({ current: null, others: [] }),
    lifecycle: async () => ({ stage: 'monitoring' }),
  }
  const webServer = {
    register(route: { path: string; handler: (req: NodeRequest, res: NodeResponse) => void | Promise<void> }) {
      registered.push({ path: route.path, handler: route.handler })
      return () => {}
    },
  }
  registerRoutes(ctx, webServer)
  const byPath = new Map(registered.map((r) => [r.path, r.handler]))
  check('9 条路由全部注册（v0.11 +restore）', registered.length === 9, registered.map((r) => r.path))
  check('restore 路由已注册', byPath.has(ROUTE_PATHS.restore))

  console.log('\n== 动作路由方法守卫（P0）==')
  {
    const res = stubResponse()
    await byPath.get(ROUTE_PATHS.archive)!(stubRequest('GET', ROUTE_PATHS.archive), res)
    check('GET 打到 archive 是 405', res.status === 405, res.status)
    check('405 带 allow: POST 头', res.headers.allow === 'POST', res.headers)
    check('GET 未触发归档（响应体是错误说明）', res.body.includes('只接受 POST'), res.body)
  }
  {
    const res = stubResponse()
    await byPath.get(ROUTE_PATHS.recover)!(stubRequest('GET', ROUTE_PATHS.recover), res)
    check('GET 打到 recover 也是 405', res.status === 405)
  }
  {
    const res = stubResponse()
    await byPath.get(ROUTE_PATHS.archive)!(stubRequest('POST', ROUTE_PATHS.archive, ['{"reason":"测试"}']), res)
    check('POST archive 正常执行', res.status === 200 && res.body.includes('"ok":true'), res.body)
  }

  console.log('\n== partition 查询（P0）==')
  {
    const res = stubResponse()
    await byPath.get(ROUTE_PATHS.snapshot)!(stubRequest('GET', `${ROUTE_PATHS.snapshot}?partition=other`), res)
    check('?partition=other 返回对方分区快照', res.status === 200 && res.body.includes('"other"'), res.body)
  }
  {
    const res = stubResponse()
    await byPath.get(ROUTE_PATHS.snapshot)!(stubRequest('GET', `${ROUTE_PATHS.snapshot}?partition=ghost`), res)
    check('未知分区是 available:false（不假绿）', res.status === 200 && res.body.includes('available":false'), res.body)
  }
  {
    const res = stubResponse()
    await byPath.get(ROUTE_PATHS.snapshot)!(stubRequest('GET', ROUTE_PATHS.snapshot), res)
    check('无参数返回当前分区快照', res.status === 200 && res.body.includes('"stage":"monitoring"'))
  }

  console.log('\n== 参数校验与请假语义 ==')
  {
    const res = stubResponse()
    await byPath.get(ROUTE_PATHS.reenable)!(stubRequest('POST', ROUTE_PATHS.reenable, ['{}']), res)
    check('reenable 缺 bundle 是 400', res.status === 400, res.status)
  }
  {
    const failing = {
      ...ctx,
      snapshot: async () => {
        throw new Error('磁盘炸了')
      },
    } as RouteContext
    const byPathFail = new Map<string, (req: NodeRequest, res: NodeResponse) => Promise<void>>()
    registerRoutes(failing, {
      register(route) {
        byPathFail.set(route.path, route.handler as never)
        return () => {}
      },
    })
    const res = stubResponse()
    await byPathFail.get(ROUTE_PATHS.snapshot)! (stubRequest('GET', ROUTE_PATHS.snapshot), res)
    check('loader 抛错 ⇒ available:false（请假，不假绿）', res.status === 500 && res.body.includes('磁盘炸了'), res.body)
  }

  console.log(failures === 0 ? '\nroutes 全部通过\n' : `\n${failures} 个断言失败\n`)
  if (failures > 0) process.exit(1)
}

await main()
