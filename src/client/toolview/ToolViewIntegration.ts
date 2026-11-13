import { createElement, type ReactElement } from 'react'
import { GuardToolCard, TOOLVIEW_CSS } from './GuardToolCard.tsx'

/**
 * `tool.call.toolview` 席位注册 —— **命令窗口显示问题的根修复**。
 *
 * ## 根因（官方契约核验）
 *
 * 宿主侧 `ctx.tools.register` 可以带 `presentCall` / `presentResult` /
 * `output.presentationMeta` 三条投影钩子。宿主侧（本插件
 * `src/host/surface/tool-presentation.ts`）把它们构造得很完整：有标题、
 * 有事实分区、有省略计数、有截断指标。
 *
 * **但内置 Web Client 不消费 `presentCall` / `presentResult`。**
 * 这两条钩子只服务于「有能力的 UI」（如 dsh-ops 自己的 TUI 面板）。
 * 落到内置 Web Client 时，工具调用退化为 generic 行 —— 用户在命令窗口
 * 看到的是参数 JSON + 原始文本，而不是一张有标题、有状态、有分区的卡片。
 *
 * 唯一能被内置 Client 消费的扩展点是 **`tool.call.toolview` keyed slot**：
 * 宿主会话面板挂载时，按**工具名**查表，命中就用我们注册的组件渲染该行。
 *
 * ## 契约
 *
 * - 席位名：`tool.call.toolview`；cardinality = `keyed`，scope = `session`。
 * - 注册项 `key` = **wire 工具名**（本插件是 `recency_guard`）。
 * - 组件 props = `ToolCallCommonProps`（toolName / cwd / callId / useDisclosure
 *   / openFile / loadImage / inspect）+ `ToolCallPhaseProps`（phase + block）。
 *
 * ## 纪律
 *
 * 1. **注册在 `ctx.slots.inject('tool.call.toolview', cb)` 里** —— 席位由宿主
 *    ToolCallTree 声明，只在会话面板挂载时存在；提前注册会撞「向未声明 slot 注册」。
 * 2. **幂等守卫**：先用 `slots.entries()` 反查已占用的 key，命中即跳过
 *    （热重载 / 双挂载的防线）。
 * 3. **单个注册失败不拖垮整批**：一个工具名注册失败不能让整个批次中断
 *    （inject 回调里抛错会杀死整个注册批次）。
 * 4. **注册计数用 getter**：inject 回调是宿主**延迟**调用的（ToolCallTree
 *    挂载时），`apply()` 返回瞬间注册数还是 0 —— 静态快照会永远停在 0，
 *    与 DOM 实际渲染的卡片数脱钩。getter 在读取时求值，永远是真实值。
 * 5. **样式单一样式真源**：CSS 唯一副本在 `GuardToolCard.tsx` 的
 *    `TOOLVIEW_CSS`（语义令牌版）—— 两份手写清单必然漂移。
 */

/** 样式元素 id（幂等去重）。 */
const CSS_ID = 'rg-toolview-css'

/** 本插件对外暴露的工具名（与 host 侧 `TOOL_SURFACE.name` 一致）。 */
export const TOOLVIEW_TOOL_NAME = 'recency_guard'

/** 客户端 slots 服务的最小形状。 */
interface SlotsApi {
  inject(slot: string, callback: () => void): (() => void) | void
  register(
    definition: { name: string; key?: string; id?: string; order?: number },
    render: (props?: unknown) => ReactElement,
  ): (() => void) | void
  /** 反查已注册项（幂等守卫用；老宿主可能没有这个方法）。 */
  entries?(slot: string): Array<{ key?: string }> | undefined
}

/** 遥测（挂到 `window.__RECENCY_GUARD_TOOLVIEW__` 供探针查）。 */
export interface ToolViewTelemetry {
  /** 已注册的工具卡片数（getter —— 读取时求值）。 */
  readonly count: number
  /** 缺席原因（slots 缺席 / 席位未声明）。 */
  skipped: string | null
  /** 最近的错误。 */
  error: string | null
  /** 是否已成功注册。 */
  registered: boolean
}

declare global {
  interface Window {
    __RECENCY_GUARD_TOOLVIEW__?: ToolViewTelemetry
  }
}

/** 注入样式（按 id 幂等）。 */
function injectCssOnce(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CSS_ID)) return
  const style = document.createElement('style')
  style.id = CSS_ID
  style.textContent = TOOLVIEW_CSS
  document.head.appendChild(style)
}

/**
 * 注册 `tool.call.toolview` 席位。
 *
 * @returns disposer 数组（卸载时逆序释放），或 null（slots 缺席）。
 */
export function integrateToolView(ctx: unknown): Array<() => void> | null {
  // 【cordis ctx 代理红线】未提供的服务属性，**读取本身就会抛**。
  let api: SlotsApi | null = null
  try {
    const slots = (ctx as { slots?: unknown }).slots
    if (slots && typeof (slots as SlotsApi).inject === 'function' && typeof (slots as SlotsApi).register === 'function') {
      api = slots as SlotsApi
    }
  } catch {
    api = null
  }

  const telemetry: ToolViewTelemetry = {
    get count(): number {
      return registered
    },
    skipped: null,
    error: null,
    registered: false,
  }
  let registered = 0

  try {
    if (typeof globalThis !== 'undefined') {
      ;(globalThis as { __RECENCY_GUARD_TOOLVIEW__?: ToolViewTelemetry }).__RECENCY_GUARD_TOOLVIEW__ = telemetry
    }
  } catch {
    /* 无 globalThis 可写（旧宿主）——忽略 */
  }

  if (api === null) {
    telemetry.skipped = 'slots-unavailable'
    return null
  }

  injectCssOnce()

  const disposers: Array<() => void> = []
  const slotsApi = api

  const doRegister = (): void => {
    // 幂等守卫：已注册的 key 直接跳过（热重载 / 双挂载）。
    let taken = new Set<string>()
    try {
      const existing = slotsApi.entries?.('tool.call.toolview') ?? []
      taken = new Set(existing.map((entry) => entry.key).filter((key): key is string => typeof key === 'string'))
    } catch {
      taken = new Set()
    }
    if (taken.has(TOOLVIEW_TOOL_NAME)) {
      telemetry.registered = true
      return
    }
    try {
      const reg = slotsApi.register(
        { name: 'tool.call.toolview', key: TOOLVIEW_TOOL_NAME },
        (props?: unknown) => createElement(GuardToolCard, (props ?? {}) as Record<string, unknown>),
      )
      if (typeof reg === 'function') disposers.push(reg)
      registered += 1
      telemetry.registered = true
      telemetry.error = null
    } catch (error) {
      // 单个注册失败不阻断其余；inject 回调里抛错会杀死整个注册批次。
      telemetry.error = error instanceof Error ? error.message : String(error)
    }
  }

  try {
    const injectDisposer = slotsApi.inject('tool.call.toolview', () => {
      doRegister()
    })
    if (typeof injectDisposer === 'function') disposers.push(injectDisposer)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 席位未声明（无会话面板）⇒ 静默降级，不崩。
    telemetry.skipped = message.includes('not declared') ? 'slot-not-declared' : message
  }

  const cleanups = disposers.filter((d): d is () => void => typeof d === 'function')
  return cleanups.length > 0 ? cleanups : null
}
