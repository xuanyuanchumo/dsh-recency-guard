/**
 * 客户端半部 —— DSH 客户端模块系统的加载入口。
 *
 * 契约（逐行核验自 `@deepseek-ai/dsh-client-modules`）：
 *
 * - 客户端加载器按 `window.__ModuleLoader__.load({ id, factory })` 调
 *   `exports["./client"]`；`id` 必须等于**包名**。
 * - `factory(require)` 必须是**无副作用**的：模块体的副作用（样式注入也算）
 *   只能在 factory 闭包内、且只在**物化时**执行。因此本文件不在模块体
 *   注入样式，样式由 `apply` 在 `ctx.effect` 里注册。
 * - React 来自平台模块表（`require('react')`），**不得**自带 React 或 CDN 引入。
 * - `inject` 列的是**服务名**（'slots' / 'locale'），不是包名；包名顺序
 *   写在 package.json 的 `dsh.client.inject` 里。
 */
import { integratePanel, openPanel } from './index.ts'
import { installStyles } from './styles.ts'

export const name = 'dsh-recency-guard-client'

/** 客户端注入的服务。 */
export const inject = ['slots', 'locale']

/** 应用到客户端上下文。 */
export function apply(ctx: unknown): void {
  installStyles(ctx)
  integratePanel(ctx)
  // 供宿主工具驱动面板导航（agent 联动）。
  ;(ctx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect?.(
    () => openPanel(ctx),
    'recency-guard: panel navigation',
  )
}
