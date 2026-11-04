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
  /** 构造面板快照。 */
  snapshot: () => Promise<unknown>
  /** 构造图谱数据。 */
  graph: () => Promise<unknown>
  /** 归档重置。 */
  archive: (reason: string) => Promise<unknown>
  /** 列出归档。 */
  archives: () => Promise<unknown>
  /** 重新启用插件。 */
  reenable: (bundle: string) => Promise<unknown>
  /** 手动触发一次恢复。 */
  recover: () => Promise<unknown>
}

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
  archives: '/recency-guard/api/archives',
  archive: '/recency-guard/api/action/archive',
  reenable: '/recency-guard/api/action/reenable',
  recover: '/recency-guard/api/action/recover',
} as const

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

/**
 * 注册全部路由。
 *
 * @returns 注销函数（dispose 时调用）
 */
export function registerRoutes(ctx: RouteContext, webServer: WebServerLike): () => void {
  const disposers: Array<() => void> = []

  const add = (route: WebRouteLike): void => {
    try {
      disposers.push(webServer.register(route))
    } catch (error) {
      // 路由注册失败不应拖垮插件主体（宿主可能没有 webServer，
      // 或路径已被占用）。失败必须**响亮**：写进日志而不是静默。
      console.error(`[recency-guard] 路由注册失败 ${route.path}:`, error)
    }
  }

  // —— 读面 ——
  add({
    kind: 'exact',
    path: ROUTE_PATHS.snapshot,
    handler: async (_req, res) => {
      try {
        sendJson(res, await ctx.snapshot())
      } catch (error) {
        sendJson(res, { available: false, reason: describe(error) }, 500)
      }
    },
  })

  add({
    kind: 'exact',
    path: ROUTE_PATHS.graph,
    handler: async (_req, res) => {
      try {
        sendJson(res, await ctx.graph())
      } catch (error) {
        sendJson(res, { available: false, reason: describe(error) }, 500)
      }
    },
  })

  add({
    kind: 'exact',
    path: ROUTE_PATHS.archives,
    handler: async (_req, res) => {
      try {
        sendJson(res, await ctx.archives())
      } catch (error) {
        sendJson(res, { available: false, reason: describe(error) }, 500)
      }
    },
  })

  // —— 动作面（改变宿主行为，路径显式带动作名）——
  add({
    kind: 'exact',
    path: ROUTE_PATHS.archive,
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const reason = typeof body?.reason === 'string' && body.reason.trim() !== '' ? body.reason : '手动归档重置'
        sendJson(res, await ctx.archive(reason))
      } catch (error) {
        sendJson(res, { ok: false, reason: describe(error) }, 500)
      }
    },
  })

  add({
    kind: 'exact',
    path: ROUTE_PATHS.reenable,
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const bundle = typeof body?.bundle === 'string' ? body.bundle : ''
        if (bundle === '') {
          sendJson(res, { ok: false, reason: '缺少 bundle 参数' }, 400)
          return
        }
        sendJson(res, await ctx.reenable(bundle))
      } catch (error) {
        sendJson(res, { ok: false, reason: describe(error) }, 500)
      }
    },
  })

  add({
    kind: 'exact',
    path: ROUTE_PATHS.recover,
    handler: async (_req, res) => {
      try {
        sendJson(res, await ctx.recover())
      } catch (error) {
        sendJson(res, { ok: false, reason: describe(error) }, 500)
      }
    },
  })

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
