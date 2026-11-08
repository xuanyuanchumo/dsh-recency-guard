/**
 * Host 路由 —— 面板的数据面。
 *
 * 为什么走 HTTP 路由而不是 `@Remote`
 * ----------------------------------
 * `@Remote`（typert）面向的是「**模型/Agent** 调用宿主能力」，其调用面
 * 需要 Agent 身份与授权判定。面板是**用户界面**，调用方是浏览器里的
 * React 组件，没有 Agent 身份 —— 走 `@Remote` 会被授权层挡住。
 *
 * HTTP 路由（`ctx.webServer.register`）正是「宿主给浏览器提供只读数据面」
 * 的官方通道：dsh-anic 的 30+ 条 `/anic/api/*` 路由都是这个形态。
 *
 * 路由契约（逐行核验自 `@deepseek-ai/dsh-host-webserver`）
 * -------------------------------------------------------
 * - `register({ kind, path, handler })`：`kind` 为 `'exact'`（精确路径）
 *   或 `'prefix'`（前缀匹配）；**重复的 (kind, path) 会抛错**。
 * - `handler(req, res)` 是 **Node http 风格**（不是 Fetch API 的
 *   `(request) => Response`）—— 这是最容易写错的一处。
 * - 响应由 handler **完全拥有**：写完必须 `res.end()`。
 *
 * 路由纪律
 * --------
 * - **只读面优先**：读数据的路由一律 GET，且**不写任何状态**。
 * - **动作面显式**：会改变宿主行为的动作（归档重置、重新启用）单独成路由，
 *   路径带明确的动作名，不与读路由混用。
 * - **缺席即诚实**：拿不到数据时返回 `{ available: false, reason }`，
 *   而不是返回空数组假装「没有问题」。
 */

/** 路由上下文（宿主提供的能力）。 */
export interface RouteContext {
  /** profile 目录。 */
  profileDir: string
  /** 当前工作区（规范化路径）。 */
  workspace: string
  /** profile 名。 */
  profileName: string
  /** 当前工作区的分区键（判定「请求的分区就是当前分区」用）。 */
  projectKey: string
  /** 构造面板快照。 */
  snapshot: () => Promise<unknown>
  /** 构造指定分区的只读快照（v0.11：`?partition=` 的宿主侧实现）。 */
  snapshotPartition: (key: string) => Promise<unknown>
  /** 构造图谱数据。 */
  graph: () => Promise<unknown>
  /** 归档重置。 */
  archive: (reason: string) => Promise<unknown>
  /** 列出归档。 */
  archives: () => Promise<unknown>
  /** 重新启用插件。 */
  reenable: (bundle: string) => Promise<unknown>
  /** 恢复非嫌疑插件（v0.11：面板此前够不着这个工具动作）。 */
  restore: () => Promise<unknown>
  /** 手动触发一次恢复。 */
  recover: () => Promise<unknown>
  /** 项目隔离视图（分区列表 + 当前分区）。 */
  isolation: () => Promise<unknown>
  /** 生命周期步骤与迁移（进入/退出/耗时/失败原因）。 */
  lifecycle: () => Promise<unknown>
  /**
   * 当前写状态凭证（v0.12 乐观并发的比对基准）。
   *
   * 为什么单独一条回调而不是复用 `snapshot()`：快照要算指标、风险排名、
   * 能力图与马尔可夫矩阵（几十毫秒级），而核对只需要那枚哈希。
   * 动作路由在**每次** POST 上都要核对一次，用重投影换轻判定是错配。
   *
   * 声明为可选是诚实：回落路径（无 ctx.plugin 的直接注册形态）与测试桩
   * 都可能不提供它，缺席时核对跳过、动作照常执行 —— 乐观并发是**加强项**，
   * 不该成为动作的硬前提。
   */
  currentRevision?: () => Promise<string>
  /**
   * 注册回调 —— 路由**真的**注册成功时按能力名回报。
   *
   * 存在的理由：契约自检要的是「实际注册面」，而不是「我们以为会注册什么」。
   * 回调让注册处自己说话（含 webServer 缺席时的沉默，那也是事实）。
   */
  onRegister?: (exposedName: string) => void
  /**
   * 错误日志出口（v0.12 新增）。
   *
   * 为什么由父插件注入而不是这里 `console.error`：路由面是**独立子 fiber**，
   * 拿不到 `ctx.logger`；而 console.error 不进宿主的日志采集面（用户在
   * 「日志」视图里看不到，等于没报）。父插件把 logger 桥进来，
   * 路由注册失败才既响亮又可查。缺席时回落 console（测试环境无 logger）。
   */
  logError?: (message: string) => void
}

import { checkRevision } from './change-guard.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/recency-guard/api'

/**
 * 全部路由路径（**字面量**）。
 *
 * 为什么写死而不是到处用模板串：契约层要核对「清单声明的路径」与
 * 「实际注册的路径」逐字一致。模板串会让源码里查不到路径字面量，
 * 契约核对只能靠运行 —— 那就失去了这道门的意义。
 */
export const ROUTE_PATHS = {
  snapshot: '/recency-guard/api/snapshot',
  graph: '/recency-guard/api/graph',
  isolation: '/recency-guard/api/isolation',
  lifecycle: '/recency-guard/api/lifecycle',
  archives: '/recency-guard/api/archives',
  archive: '/recency-guard/api/action/archive',
  reenable: '/recency-guard/api/action/reenable',
  restore: '/recency-guard/api/action/restore',
  recover: '/recency-guard/api/action/recover',
} as const

/** 路由名（`ROUTE_PATHS` 的键）。 */
export type RouteName = keyof typeof ROUTE_PATHS

/**
 * 路由注册表 —— **注册真值**（不是投影）。
 *
 * `registerRoutes` 就是遍历这张表注册的，因此「实际注册了哪些路由」不需要
 * 靠人读代码回答；契约测试也能拿它跟能力清单双向比对（清单声明了路由面但
 * 表里没有 ⇒ 虚登；表里有而清单没声明 ⇒ 漏登）。
 *
 * `capability` 是承载该路由的能力 **id**（不是暴露名）：一个能力可以有多个
 * 对外名称（工具 action + 动作路由），用 id 关联才能表达这种多面性。
 */
export interface RouteSurfaceEntry {
  /** 承载的能力 id（见 capability-specs.ts）。 */
  capability: string
  /** 路由名（`ROUTE_PATHS` / handler 表的键）。 */
  name: RouteName
  /** 对外名称（清单里该能力的 `exposedAs` / `exposedAlsoAs` 之一）。 */
  exposedName: string
  /** 精确路径（字面量）。 */
  path: string
  /** HTTP 方法（读面 GET / 动作面 POST）。 */
  method: 'GET' | 'POST'
}

export const ROUTE_SURFACE: readonly RouteSurfaceEntry[] = [
  { capability: 'guard.present.panel', name: 'snapshot', exposedName: 'recency-guard.panel', path: ROUTE_PATHS.snapshot, method: 'GET' },
  { capability: 'guard.present.graph', name: 'graph', exposedName: 'recency-guard.graph', path: ROUTE_PATHS.graph, method: 'GET' },
  { capability: 'guard.govern.isolation', name: 'isolation', exposedName: 'recency-guard.isolation', path: ROUTE_PATHS.isolation, method: 'GET' },
  { capability: 'guard.observe.lifecycle', name: 'lifecycle', exposedName: 'recency-guard.lifecycle', path: ROUTE_PATHS.lifecycle, method: 'GET' },
  { capability: 'guard.govern.archive', name: 'archives', exposedName: 'recency-guard.archives', path: ROUTE_PATHS.archives, method: 'GET' },
  { capability: 'guard.govern.reset', name: 'archive', exposedName: 'recency-guard.reset', path: ROUTE_PATHS.archive, method: 'POST' },
  { capability: 'guard.recover.reenable', name: 'reenable', exposedName: 'recency-guard.reenable', path: ROUTE_PATHS.reenable, method: 'POST' },
  { capability: 'guard.recover.restore', name: 'restore', exposedName: 'recency-guard.restore', path: ROUTE_PATHS.restore, method: 'POST' },
  { capability: 'guard.recover.manual', name: 'recover', exposedName: 'recency-guard.recover', path: ROUTE_PATHS.recover, method: 'POST' },
] as const

/**
 * 一个 Web 路由的最小形状。
 *
 * 只声明用到的字段：`kind`、`path`、`handler`。
 * `handler` 收 Node 的 `req`/`res`，因此本模块**不依赖** DOM 类型，
 * 也不引入 `@types/node` 的 http 类型（避免把宿主类型拖进插件的编译面）。
 */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: NodeRequest, res: NodeResponse) => void | Promise<void>
}

/** 请求的最小形状（本模块只用到 method 与 url）。 */
export interface NodeRequest {
  method?: string
  url?: string
  on?: (event: string, listener: (chunk: unknown) => void) => void
  setEncoding?: (encoding: string) => void
}

/** 响应的最小形状。 */
export interface NodeResponse {
  writeHead: (status: number, headers?: Record<string, string>) => void
  end: (body?: string) => void
}

/** 路由注册器（宿主提供）。 */
interface WebServerLike {
  register(route: WebRouteLike): () => void
}

/**
 * 写 JSON 响应。
 *
 * 注意 `res.writeHead` 之后再 `res.end` —— Node 的顺序要求。
 */
function sendJson(res: NodeResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取请求体（宽容：读不到当作空对象，由调用方校验字段）。 */
async function readBody(req: NodeRequest): Promise<Record<string, unknown> | null> {
  try {
    if (typeof req.on !== 'function') return null
    const chunks: string[] = []
    await new Promise<void>((resolve, reject) => {
      req.on!('data', (chunk: unknown) => chunks.push(String(chunk)))
      req.on!('end', () => resolve())
      req.on!('error', (error: unknown) => reject(error))
    })
    const text = chunks.join('')
    if (text === '') return null
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 一个 handler：接收请求与响应。 */
type RouteHandler = (req: NodeRequest, res: NodeResponse) => void | Promise<void>

/**
 * 从请求 URL 里解析 `?partition=` 查询参数。
 *
 * 为什么必须在宿主侧实现（v0.11 P0）：客户端一直认真拼 `?partition=`
 * （client/api.ts 的 withPartition），但 read handler 从不读 url ——
 * 跨分区查看永远静默返回当前分区，靠客户端 mismatch 提示兜底。
 * 「隔离查看」是 isolation 能力的承诺（guard.govern.isolation），
 * 数据面不支持它，承诺就是假的。
 *
 * 解析用 URLSearchParams（ WHATWG 标准，Node 22 全局可用）：
 * - 只取**第一个** partition 参数（重复键取首见，与大多数框架一致）；
 * - 非法 UTF-8 由 URLSearchParams 自动容错（替换为 U+FFFD），不抛异常。
 */
function partitionOf(req: NodeRequest): string | undefined {
  const url = req.url ?? ''
  // 路由是精确匹配，url 可能带 query 也可能不带；没有 `?` 就没有参数。
  const qIndex = url.indexOf('?')
  if (qIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(qIndex + 1))
  const value = params.get('partition')
  return value === null || value === '' ? undefined : value
}

/**
 * 动作路由的**方法守卫**（v0.11 P0 安全修复）。
 *
 * 为什么必须有：此前 archive/reenable/recover 三个 handler 不检查
 * `req.method`，`GET /recency-guard/api/action/archive` 也会执行归档重置
 * —— readBody 读不到 GET 请求体就返回 null，reason 走默认值照常归档。
 * 浏览器预取、爬虫、用户误点链接都可能是 GET，一个破坏性动作不能把
 * 「请求方法」当建议。非 POST 一律 405（Method Not Allowed），
 * 并带 `allow: POST` 头 —— 这是 RFC 7231 对该语义的标准表达。
 */
function rejectWrongMethod(req: NodeRequest, res: NodeResponse): boolean {
  if ((req.method ?? 'GET').toUpperCase() === 'POST') return false
  res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, reason: `动作路由只接受 POST（收到 ${req.method ?? 'GET'}）` }))
  return true
}

/**
 * 乐观并发核对（v0.12）。
 *
 * 动作路由在**执行前**比对请求携带的 `expectedRevision` 与当前真值：
 * - body 没带 ⇒ 放行（agent 刚读过快照的主动路径）；
 * - 带了但不符 ⇒ 409 + 当前 revision，动作**不执行**。调用方据此重读快照，
 *   用新事实决定是否再按一次 —— 而不是按着一张 5 秒前的地图改宿主。
 *
 * 真值来自 `ctx.snapshot()`（面板轮询的同一份投影），所以「面板显示的
 * revision」与「宿主核对用的 revision」结构上同源，不可能各自漂移。
 *
 * @returns 是否已写出 409（true = 调用方应停止，不要继续执行动作）
 */
async function rejectStaleRevision(ctx: RouteContext, res: NodeResponse, body: Record<string, unknown> | null): Promise<boolean> {
  // 缺席即降级（本插件的一贯纪律：可选能力不在场不该让动作失效）。
  // 类型上 currentRevision 是必填的，但回落路径（宿主无 webServer 时的
  // 直接注册形态）与旧桩都可能不带它 —— 那种情况下跳过核对，
  // 而不是抛 "is not a function" 把动作打成 500。
  if (typeof ctx.currentRevision !== 'function') return false
  const check = checkRevision(await ctx.currentRevision(), body?.expectedRevision)
  if (check.ok) return false
  sendJson(
    res,
    {
      ok: false,
      conflict: 'stale-revision',
      reason: `状态已变化（面板快照的 revision=${check.expected}，当前=${check.current}），动作未执行。请重读快照后再决定。`,
      current: check.current,
    },
    409,
  )
  return true
}

/**
 * 各路由的 handler。
 *
 * 键必须覆盖 `ROUTE_SURFACE` 的每个 `name`（契约测试核对）—— handler 表与
 * 路由表分开，是为了让「注册了但没有 handler」在测试里响亮失败，而不是在
 * 运行时变成 404。
 */
function handlerTable(ctx: RouteContext): Record<RouteName, RouteHandler> {
  /**
   * 读面：拿不到数据时请假（`available:false`），不假装没问题。
   *
   * `?partition=` 语义（v0.11）：快照路由支持跨分区只读查看 —— 请求里带
   * partition 且 ≠ 当前分区时走 `snapshotPartition`；宿主侧不认这个参数的
   * 旧实现由客户端 mismatch 提示兜底（防御性双保险，契约不放宽）。
   * 其余读面（图谱/隔离/生命周期/归档）保持当前分区事实：图谱是能力清单
   * 的静态结构（无分区状态），其余路由的消费方从未拼过 partition 参数。
   */
  const read = (load: (partition: string | undefined) => Promise<unknown>): RouteHandler => async (req, res) => {
    try {
      sendJson(res, await load(partitionOf(req)))
    } catch (error) {
      sendJson(res, { available: false, reason: describe(error) }, 500)
    }
  }

  return {
    snapshot: read((partition) =>
      partition === undefined || partition === ctx.projectKey ? ctx.snapshot() : ctx.snapshotPartition(partition),
    ),
    graph: read(() => ctx.graph()),
    isolation: read(() => ctx.isolation()),
    lifecycle: read(() => ctx.lifecycle()),
    archives: read(() => ctx.archives()),
    archive: async (req, res) => {
      if (rejectWrongMethod(req, res)) return
      try {
        const body = await readBody(req)
        if (await rejectStaleRevision(ctx, res, body)) return
        const reason = typeof body?.reason === 'string' && body.reason.trim() !== '' ? body.reason : '手动归档重置'
        sendJson(res, await ctx.archive(reason))
      } catch (error) {
        sendJson(res, { ok: false, reason: describe(error) }, 500)
      }
    },
    reenable: async (req, res) => {
      if (rejectWrongMethod(req, res)) return
      try {
        const body = await readBody(req)
        const bundle = typeof body?.bundle === 'string' ? body.bundle : ''
        if (bundle === '') {
          sendJson(res, { ok: false, reason: '缺少 bundle 参数' }, 400)
          return
        }
        // 顺序是语义问题：400 = 这个请求本身不合法，409 = 请求合法但世界变了。
        // 参数不齐就先报 400，别让一个必错的请求去占用冲突判定。
        if (await rejectStaleRevision(ctx, res, body)) return
        sendJson(res, await ctx.reenable(bundle))
      } catch (error) {
        sendJson(res, { ok: false, reason: describe(error) }, 500)
      }
    },
    restore: async (req, res) => {
      if (rejectWrongMethod(req, res)) return
      try {
        const body = await readBody(req)
        if (await rejectStaleRevision(ctx, res, body)) return
        sendJson(res, await ctx.restore())
      } catch (error) {
        sendJson(res, { ok: false, reason: describe(error) }, 500)
      }
    },
    recover: async (req, res) => {
      if (rejectWrongMethod(req, res)) return
      try {
        const body = await readBody(req)
        if (await rejectStaleRevision(ctx, res, body)) return
        sendJson(res, await ctx.recover())
      } catch (error) {
        sendJson(res, { ok: false, reason: describe(error) }, 500)
      }
    },
  }
}

/**
 * 注册全部路由。
 *
 * **遍历 `ROUTE_SURFACE`**：注册面因此是数据（一张表）而不是散落的调用，
 * 「表里有、代码没注册」这种漏注册在结构上无法发生；反过来「代码注册了、
 * 表里没有」也不可能，因为注册只发生在这一处循环里。
 *
 * @returns 注销函数（dispose 时调用）
 */
export function registerRoutes(ctx: RouteContext, webServer: WebServerLike): () => void {
  const disposers: Array<() => void> = []
  const handlers = handlerTable(ctx)
  // 日志出口：优先用父插件桥进来的宿主 logger（进采集面、用户在日志视图可查），
  // 缺席时回落 console —— 测试里没桩 logger 也要能看见失败。
  const reportError = (message: string): void => {
    const line = `[recency-guard] ${message}`
    if (typeof ctx.logError === 'function') {
      try {
        ctx.logError(message)
        return
      } catch {
        /* 日志出口自身失败不拖垮注册：回落到 console */
      }
    }
    console.error(line)
  }

  const add = (route: WebRouteLike): void => {
    try {
      disposers.push(webServer.register(route))
    } catch (error) {
      // 路由注册失败不应拖垮插件主体（宿主可能没有 webServer，
      // 或路径已被占用）。失败必须**响亮**：写进宿主日志而不是静默，
      // 也不写 console.error —— 那条通道不进宿主日志采集（v0.12 修正）。
      reportError(`路由注册失败 ${route.path}: ${String(error)}`)
    }
  }

  for (const entry of ROUTE_SURFACE) {
    const handler = handlers[entry.name]
    if (typeof handler !== 'function') {
      // 路由表与 handler 表不一致：宁可少注册一条并响亮报错，
      // 也不要注册一个到不了实现的路径（那只会变成 404 或 500）。
      reportError(`路由 ${entry.name} 没有 handler，跳过注册`)
      continue
    }
    add({ kind: 'exact', path: entry.path, handler })
    // 注册成功才回报（回调本身出错不影响注册结果）。
    try {
      ctx.onRegister?.(entry.exposedName)
    } catch {
      /* 观测回调失败不拖垮注册 */
    }
  }

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* 注销失败不影响其它路由 */
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
