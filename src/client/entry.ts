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
 *
 * ## inject 为什么是空数组（0.5.0 沙箱实测教训）
 *
 * `dsh.client.inject` 声明的包必须**出现在宿主的 boot 图里**，否则本 entry
 * 物化失败（"a dynamic dependency that did not arrive" → entry failed）。
 * 此前声明的 conversation/locale 只在「带完整会话生态的宿主」的图里；
 * 最小 web 沙箱（dsh-base + dsh-web-app）没有它们，面板整块失效。
 * 本面板的 ctx.slots / ctx.locale 全部做了缺席跳过 + 内置字典回退
 * （见 index.ts 的 hasSlotsApi 与 i18n 的自持字典），依赖声明收紧为空集 ——
 * 有宿主服务就用，没有就诚实降级，这比「声明完美依赖」更符合插件契约。
 */
import { integratePanel, openPanel } from './index.ts'
import { integrateToolView } from './toolview/ToolViewIntegration.ts'
import { installStyles } from './styles.ts'

export const name = 'dsh-recency-guard-client'

/**
 * 客户端注入的 cordis ctx 服务名。
 *
 * 双层 inject 语义（对照官方 dsh-client-ui-plugin-manager）：
 * - 包级 `dsh.client.inject`（package.json）= **包依赖边**，决定 boot 图到达顺序；
 * - 模块级 `exports.inject` = **cordis ctx 服务名**，cordis 据此把服务挂到 apply
 *   收到的 ctx 上。ctx 是代理：读取**未声明**的服务属性会直接抛 —— 这就是
 * 0.5.0 沙箱里「slots-unavailable」的根因（声明空集后连 slots 都拿不到）。
 * slots/locale 是 loader 基建服务（client-modules 的 loader.ctx 自带），
 * 声明即解析；两者缺席时 integratePanel / i18n 已有诚实降级路径。
 */
export const inject = ['slots', 'locale']

/** 应用到客户端上下文。 */
export function apply(ctx: unknown): void {
  installStyles(ctx)
  integratePanel(ctx)
  // 命令窗口显示修复：注册 `tool.call.toolview` keyed slot。
  //
  // 为什么必须在这里注册：宿主侧的 `presentCall`/`presentResult` **不会**被
  // 内置 Web Client 消费 —— 没有这张卡片，工具调用在命令窗口里退化成
  // generic 行（参数 JSON + 原始文本）。这是「命令窗口显示问题」的根修复。
  //
  // 缺席即跳过：slots 服务不在时 integrateToolView 返回 null，不抛异常。
  integrateToolView(ctx)
  // 供宿主工具驱动面板导航（agent 联动）。
  // openPanel 的 ctx.layout 读取必须整段 try/catch：cordis ctx 是代理，访问
  // **未提供的服务属性本身就会抛**（不是返回 undefined）—— 0.5.0 沙箱实测，
  // 这一个未保护访问让整个 entry fiber 以 FAILED 收场（前端只显示 "failed"）。
  // 守护面板不依赖宿主 layout 也能工作（slots 是声明式注册），导航是尽力而为。
  try {
    ;(ctx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect?.(() => {
      try {
        openPanel(ctx)
      } catch {
        /* layout 服务缺席 ⇒ 不导航 */
      }
      return undefined
    }, 'recency-guard: panel navigation')
  } catch {
    /* effect 机制缺席 ⇒ 跳过导航 */
  }
}
