import { createElement, type ReactElement } from 'react'
import { GuardPanel } from './panel/GuardPanel.tsx'
import { GuardPanelIcon } from './panel/GuardPanelIcon.ts'
import { registerDictionaries, t } from './i18n/i18n.ts'
import { fetchSnapshot, fetchGraph, fetchArchives, postAction } from './api/api.ts'
import type { PanelSnapshot } from '../host/surface/snapshot.ts'
import type { GraphData } from '../shared/graph-contract.ts'

/**
 * 客户端入口 —— 管理面板 + 可交互图谱。
 *
 * ## 席位选择（为什么不是 `conversation.view`）
 *
 * `conversation.view` 是**会话作用域**（session scope）的席位：它只在会话
 * 面板挂载时存在，且语义是「会话内部的视图切换」。而守护面板要回答的是
 * 「这个 profile / 这个工作区整体怎么样」—— 它**不依附于任何会话**。
 *
 * 因此采用 PluginManager 的形态：**`main`（keyed，根作用域）+ `sidebar.panellist`
 * （list，根作用域）**：
 * - `main` 以自己的 key 占据中央面板位，根作用域 ⇒ 不需要会话；
 * - `sidebar.panellist` 提供侧栏图标，id 必须与 `main` 的 key 一致
 *   （侧栏据此把图标与中央面板对应起来）。
 *
 * ## 纪律
 *
 * 1. **工厂无副作用**：样式注册、定时器、监听都在 `apply` 里做，模块体只声明。
 * 2. **注册即效果**：所有注册返回 disposer，随 fiber 卸载而撤销。
 * 3. **缺席即跳过**：`ctx.slots` 不存在就跳过并记录原因，不抛异常。
 * 4. **文案走字典**：所有可见文字经 `t()`，不在组件里硬编码。
 */

/** 面板的 key（`main` 的 cell key 与 `sidebar.panellist` 的 id 必须一致）。 */
export const PANEL_ID = 'recency-guard'

/** locale 命名空间。 */
export const NAMESPACE = 'recencyGuard'

/** 客户端服务的最小形状。 */
interface SlotsApi {
  inject(key: string, callback: () => void): (() => void) | void
  register(options: SlotDefinition, component: () => ReactElement): (() => void) | void
}

interface SlotDefinition {
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  locale?: string
}

interface LocaleApi {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

interface LayoutApi {
  selectPanel(panelId: string | null): void
}

function hasSlotsApi(value: unknown): value is SlotsApi {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SlotsApi>
  return typeof candidate.inject === 'function' && typeof candidate.register === 'function'
}

/**
 * 遥测 —— 面板的可见可查状态。
 *
 * 暴露在 `window.__RECENCY_GUARD__` 上：面板是否注册、为什么跳过、
 * 最近一次拉取的结果与错误，都是**可核对的事实**而不是猜测。
 */
export interface PanelTelemetry {
  registered: boolean
  skipped: string | null
  error: string | null
  lastSnapshotAt: string | null
  lastGraphNodes: number
  lastGraphEdges: number
  unregister: () => void
  reregister: () => void
}

declare global {
  interface Window {
    __RECENCY_GUARD__?: PanelTelemetry
  }
}

/** 注册管理面板与侧栏图标。 */
export function integratePanel(ctx: unknown): void {
  const telemetry: PanelTelemetry = {
    registered: false,
    skipped: null,
    error: null,
    lastSnapshotAt: null,
    lastGraphNodes: 0,
    lastGraphEdges: 0,
    unregister: () => {},
    reregister: () => {},
  }
  if (typeof window !== 'undefined') window.__RECENCY_GUARD__ = telemetry

  // 【cordis ctx 代理红线】未提供的服务属性，**读取本身就会抛**（不是返回
  // undefined）—— 0.5.0 沙箱实测，这一处未保护访问让 entry fiber FAILED。
  // 因此 slots/locale 的存在性检测必须整段 try/catch，缺席即诚实降级。
  let slotsApi: SlotsApi | null = null
  let localeApi: LocaleApi | null = null
  try {
    const slots = (ctx as { slots?: unknown }).slots
    if (hasSlotsApi(slots)) slotsApi = slots as SlotsApi
  } catch {
    telemetry.skipped = 'slots-unavailable'
  }
  try {
    const locale = (ctx as { locale?: unknown }).locale
    if (locale && typeof (locale as LocaleApi).register === 'function') localeApi = locale as LocaleApi
  } catch {
    /* locale 服务缺席 ⇒ 用内置字典 */
  }

  if (slotsApi === null) {
    telemetry.skipped = telemetry.skipped ?? 'slots-absent'
    return
  }
  const api = slotsApi

  // 文案字典（缺席 locale 服务时退回内置字典）。
  if (localeApi) {
    try {
      const dispose = localeApi.register(NAMESPACE, registerDictionaries())
      ;(ctx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect?.(
        () => dispose,
        'recency-guard: dictionaries',
      )
    } catch (error) {
      telemetry.error = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 注册一次面板席位（幂等）。
   *
   * 契约对照（0.5.0 沙箱实测 + 官方 dsh-client-ui-plugin-manager 逐行核验）：
   * `ctx.slots.inject(slot, callback)` 的 callback 是**生成器函数** —— 宿主
   * 逐条 `yield` 注册项并在卸载时执行剩余 yield 的 disposer。传普通函数在
   * 宿主调用 `.next()` 时抛错，整个 entry 以 failed 收场（面板全灭）。
   *
   * 幂等用**同步标志**（attempted）而不是 registered：宿主会为每个 inject 声明
   * 各调一次回调（main 与 sidebar.panellist 各一次），且注册是同步完成的 ——
   * 若等 register 成功后才置位，两次回调交错时会把同一个 key 注册两遍
   * （keyed slot 直接抛 duplicate）。attempted 在生成器第一次被拉起时就置位。
   */
  let attempted = false
  const registerOnce = function* (): Generator<unknown, void, void> {
    if (attempted) return
    attempted = true
    // register 的异常必须就地捕获并写 telemetry：生成器里抛错会沿 cordis
    // effect 协议把整个 entry fiber 打成 FAILED（面板全灭）—— 而注册失败
    // 只是「面板缺席」，不该拖垮宿主会话（0.5.0 沙箱实测：一次 register
    // 契约不匹配让 entry failed，且前端只显示 "failed" 无细节）。
    try {
      const panelRegistration = api.register(
        { name: 'main', key: PANEL_ID, order: 20, label: () => t('panel.title'), locale: NAMESPACE },
        () => createElement(GuardPanel, { fetchSnapshot, fetchGraph, fetchArchives, postAction }),
      )
      if (typeof panelRegistration === 'function') yield panelRegistration
      // 侧栏图标：id 必须与 main 的 key 一致。
      const iconRegistration = api.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel.title'), locale: NAMESPACE },
        () => createElement(GuardPanelIcon),
      )
      if (typeof iconRegistration === 'function') yield iconRegistration
      telemetry.registered = true
    } catch (error) {
      telemetry.error = error instanceof Error ? error.message : String(error)
    }
  }

  const registerOncePlain = (): void => {
    // 回退形态：老宿主的 slots.inject 只接受普通函数 —— 消费生成器直到耗尽。
    try {
      for (const _step of registerOnce()) {
        /* 逐条消费 yield 的 disposer；宿主托管不了就丢弃（会话生命周期兜底） */
        void _step
      }
    } catch (error) {
      telemetry.error = error instanceof Error ? error.message : String(error)
    }
  }

  telemetry.unregister = (): void => {
    if (!telemetry.registered) return
    // 生成器形态下注册项的 disposer 由宿主托管；这里只复位遥测。
    telemetry.registered = false
    attempted = false
  }
  telemetry.reregister = (): void => {
    if (!telemetry.registered) registerOncePlain()
  }

  // 席位由宿主其它插件声明 ⇒ 注册必须放在 inject 回调里。
  // 两种 slot 的回调形态不同（对照官方 plugin-manager）：
  // - "main" 是 keyed 席位 ⇒ 生成器（yield 每条注册的 disposer）；
  // - "sidebar.panellist" 是 list 席位 ⇒ **普通函数**直接返回 register 的 disposer。
  //
  // panellist 的声明表由 sidebar 包**渲染时**写入（renderSlot），且宿主在声明
  // epoch 变化时会**反复调用**本回调 —— 所以这里每次被调都要尝试注册：
  // 「not declared」意味着 sidebar 还没渲染（声明表未就绪），等下一次 epoch
  // 变化即可；「duplicate key」意味着已经注册过，静默吞掉（幂等）。
  // attempted 只防同一 epoch 内的重复调用；声明驱动的重注册是宿主契约。
  let panelDisposer: (() => void) | null = null
  const registerSidebar = (): (() => void) | undefined => {
    try {
      const iconRegistration = api.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel.title'), locale: NAMESPACE },
        () => createElement(GuardPanelIcon),
      )
      telemetry.registered = true
      telemetry.error = null
      panelDisposer = typeof iconRegistration === 'function' ? iconRegistration : null
      return panelDisposer ?? undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 已注册过（epoch 重放）⇒ 幂等成功；未声明（sidebar 未渲染）⇒ 等下次回调。
      if (message.includes('already has an entry')) {
        telemetry.registered = true
        telemetry.error = null
        return undefined
      }
      if (!message.includes('not declared')) telemetry.error = message
      return undefined
    }
  }
  try {
    api.inject('main', registerOnce)
    api.inject('sidebar.panellist', () => {
      if (panelDisposer !== null) return undefined
      return registerSidebar()
    })
  } catch (error) {
    telemetry.error = error instanceof Error ? error.message : String(error)
  }
}

/** 供宿主工具驱动面板导航（保留给未来的 agent 联动）。 */
export function openPanel(ctx: unknown): void {
  const layout = (ctx as { layout?: LayoutApi }).layout
  if (layout && typeof layout.selectPanel === 'function') {
    try {
      layout.selectPanel(PANEL_ID)
    } catch {
      /* 面板尚未注册 ⇒ 忽略 */
    }
  }
}

export type { PanelSnapshot, GraphData }
