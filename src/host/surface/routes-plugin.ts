import { registerRoutes, type RouteContext } from './routes.ts'

/**
 * 路由面 —— **独立 cordis 子插件**。
 *
 * 为什么不把 `webServer` 放进主插件的 inject
 * ----------------------------------------
 * `webServer` 由 `@deepseek-ai/dsh-web-app` bundle 提供（desktop 有、headless 无）。
 * 若把它列为主插件的**硬依赖**，headless 下整条 fiber 会 pending，
 * 连不依赖它的工具、索引、状态机一并失效 —— 这是 dsh-anic cycle-74 的 P0 实测教训：
 *
 *   dsh: warning: 1 entry did not activate
 *   anic (dsh-anic): pending (waiting for service: webServer)
 *
 * 但也不能简单地把 `webServer` 从 inject 删掉：路由**确实硬依赖** webServer，
 * 直接删会丢掉「apply 时服务已就绪」的保证，路由可能抢在 webServer 就绪前注册
 * ⇒ **静默丢路由**，比 pending 更糟（无提示、无错误）。
 *
 * 拆成独立子插件是唯一同时满足两条的形态：
 * - cordis 对**本子插件**保留等待语义（缺席 ⇒ 只有它 pending）；
 * - 父插件立即激活；webServer 出现时子插件自动激活（cordis 组合语义）。
 *
 * 回落：宿主无 `ctx.plugin`（stub / 旧代）⇒ 直接注册，零行为变化。
 */

/** 路由面子插件。 */
export const recencyGuardRoutesPlugin = {
  name: 'dsh-recency-guard-routes',
  inject: ['webServer'],
  apply(ctx: unknown, config?: RouteContext): (() => void) | null {
    if (!config) return null
    const webServer = (ctx as { webServer?: unknown }).webServer
    if (!webServer || typeof (webServer as { register?: unknown }).register !== 'function') return null
    return registerRoutes(config, webServer as Parameters<typeof registerRoutes>[1])
  },
}

interface PluginCapable {
  plugin?: (p: unknown, config?: unknown) => unknown
}

/**
 * 接线路由面。
 *
 * @returns 注销函数（仅在回落路径下有值；子 fiber 路径由 cordis 托管）。
 */
export function wireRoutes(ctx: unknown, config: RouteContext): (() => void) | null | undefined {
  const c = ctx as PluginCapable
  if (typeof c.plugin === 'function') {
    c.plugin(recencyGuardRoutesPlugin, config)
    return undefined
  }
  const webServer = (ctx as { webServer?: unknown }).webServer
  if (!webServer || typeof (webServer as { register?: unknown }).register !== 'function') return null
  return registerRoutes(config, webServer as Parameters<typeof registerRoutes>[1])
}
