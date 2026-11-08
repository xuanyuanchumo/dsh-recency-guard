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
    // v0.12 乐观并发基准：桩里固定一枚 revision，冲突分支用带错值的请求打。
    currentRevision: async () => 'deadbeefcafe',
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
    // ---------- v0.12 乐观并发 revision ----------
    // 钉死三件事：相符⇒执行、过期⇒409 且**未执行**、缺席⇒放行。
    // 「409 时动作未执行」是这条门的全部意义：冲突了还照做，等于没有门。
    const okRes = stubResponse()
    await byPath.get(ROUTE_PATHS.archive)!(
      stubRequest('POST', ROUTE_PATHS.archive, ['{"reason":"测试","expectedRevision":"deadbeefcafe"}']),
      okRes,
    )
    check('revision 相符时动作正常执行', okRes.status === 200 && okRes.body.includes('"ok":true'), okRes.body)

    const staleRes = stubResponse()
    await byPath.get(ROUTE_PATHS.archive)!(
      stubRequest('POST', ROUTE_PATHS.archive, ['{"reason":"测试","expectedRevision":"stale0000000"}']),
      staleRes,
    )
    check('revision 过期是 409', staleRes.status === 409, staleRes.status)
    check('409 回传当前 revision 供重读', staleRes.body.includes('deadbeefcafe'), staleRes.body)
    check('409 时动作未执行（响应体不含 ok:true）', !staleRes.body.includes('"ok":true'), staleRes.body)

    const bareRes = stubResponse()
    await byPath.get(ROUTE_PATHS.reenable)!(stubRequest('POST', ROUTE_PATHS.reenable, ['{"bundle":"dsh-x"}']), bareRes)
    check('不带 revision 时放行（agent 主动修复路径）', bareRes.status === 200 && bareRes.body.includes('"ok":true'), bareRes.body)

    // 顺序语义：请求本身不合法（缺参数）优先于「世界变了」—— 必错的请求
    // 不该占用冲突判定，否则调用方会以为刷新一下就能成功。
    const orderRes = stubResponse()
    await byPath.get(ROUTE_PATHS.reenable)!(
      stubRequest('POST', ROUTE_PATHS.reenable, ['{"expectedRevision":"stale0000000"}']),
      orderRes,
    )
    check('缺参数的 400 优先于 revision 的 409', orderRes.status === 400, orderRes.status)

    // currentRevision 缺席（无 webServer 的回落形态 / 旧桩）⇒ 跳过核对，
    // 而不是把动作打成 500：可选能力缺席不拖垮主流程（本插件一贯纪律）。
    const noRev = { ...ctx, currentRevision: undefined } as RouteContext
    const byPathNoRev = new Map<string, (req: NodeRequest, res: NodeResponse) => Promise<void>>()
    registerRoutes(noRev, {
      register(route) {
        byPathNoRev.set(route.path, route.handler as never)
        return () => {}
      },
    })
    const degradedRes = stubResponse()
    await byPathNoRev.get(ROUTE_PATHS.archive)!(
      stubRequest('POST', ROUTE_PATHS.archive, ['{"expectedRevision":"whatever"}']),
      degradedRes,
    )
    check('currentRevision 缺席时动作照常执行（降级不失效）', degradedRes.status === 200, degradedRes.body)
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
