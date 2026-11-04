import { createElement, type ReactElement } from 'react'
import { GuardPanel } from './GuardPanel.tsx'
import { GuardPanelIcon } from './GuardPanelIcon.ts'
import { registerDictionaries, t } from './i18n.ts'
import { fetchSnapshot, fetchGraph, postAction } from './api.ts'
import type { PanelSnapshot } from '../../src/snapshot.ts'
import type { GraphData } from '../../src/graph-data.ts'

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

  if (!hasSlotsApi((ctx as { slots?: unknown })?.slots)) {
    telemetry.skipped = 'slots-absent'
    return
  }
  const api = (ctx as { slots: unknown }).slots as SlotsApi

  // 文案字典（缺席 locale 服务时退回内置字典）。
  const locale = (ctx as { locale?: LocaleApi }).locale
  if (locale && typeof locale.register === 'function') {
    try {
      const dispose = locale.register(NAMESPACE, registerDictionaries())
      ;(ctx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect?.(
        () => dispose,
        'recency-guard: dictionaries',
      )
    } catch (error) {
      telemetry.error = error instanceof Error ? error.message : String(error)
    }
  }

  let registrationDisposer: (() => void) | null = null

  const doRegister = (): void => {
    if (telemetry.registered) return
    try {
      // 中央面板：根作用域的 keyed 席位，自己的 key。
      const panelRegistration = api.register(
        { name: 'main', key: PANEL_ID, order: 20, label: () => t('panel.title'), locale: NAMESPACE },
        () => createElement(GuardPanel, { fetchSnapshot, fetchGraph, postAction }),
      )
      // 侧栏图标：id 必须与 main 的 key 一致。
      const iconRegistration = api.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel.title'), locale: NAMESPACE },
        () => createElement(GuardPanelIcon),
      )
      const disposers = [panelRegistration, iconRegistration].filter(
        (d): d is () => void => typeof d === 'function',
      )
      registrationDisposer = () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            /* 注销失败不影响其它注册 */
          }
        }
      }
      telemetry.registered = true
    } catch (error) {
      // 重复 id 会走到这里（而不是静默覆盖）—— 这是唯一的错误通道。
      telemetry.error = error instanceof Error ? error.message : String(error)
    }
  }

  telemetry.unregister = (): void => {
    if (registrationDisposer === null) return
    registrationDisposer()
    registrationDisposer = null
    telemetry.registered = false
  }
  telemetry.reregister = (): void => {
    if (!telemetry.registered) doRegister()
  }

  // 席位由宿主其它插件声明 ⇒ 注册必须放在 inject 回调里。
  try {
    api.inject('main', doRegister)
    api.inject('sidebar.panellist', doRegister)
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
