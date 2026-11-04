/**
 * 样式注册 —— 把面板样式注入宿主文档。
 *
 * 纪律（承 `references/ui-plugin.md`）：
 * - **不在模块体注入**：模块体的副作用会在工厂被 require 时就执行，
 *   而工厂必须无副作用。样式注入放在 `apply` 里。
 * - **不写 `document.body`**：宿主管理自己的 DOM 树；插件只在自己的
 *   组件里渲染。样式表是唯一例外（它不是 DOM 结构，是全局资源）。
 * - **幂等**：同一插件可能被多次物化（热更新），重复注入同一份样式
 *   会让样式表无限增长。用 `id` 去重。
 *
 * ## 样式的唯一真相源
 *
 * `styles.css` 是唯一样式来源；构建时由 esbuild 的 `text` loader 内联进
 * 产物（`import css from './styles.css'`）。这样：
 * - 运行时零 IO（不需要读文件、没有路径假设）；
 * - 不存在「CSS 在两处各写一份」的漂移。
 */

import css from './styles.css'

/** 样式元素的 id（用于幂等去重）。 */
export const STYLE_ELEMENT_ID = 'dsh-recency-guard-styles'

/** 面板样式表（构建期内联）。 */
export const PANEL_CSS = css

/**
 * 安装样式。
 *
 * @param ctx 客户端上下文（提供 effect 以便卸载时移除样式）。
 */
export function installStyles(ctx: unknown): void {
  const effect = (ctx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect
  if (typeof effect !== 'function') {
    applyStyle()
    return
  }
  effect(
    () => {
      const element = applyStyle()
      return () => {
        element?.remove()
      }
    },
    'recency-guard: styles',
  )
}

/** 注入样式表（幂等）。返回注入的元素（已存在时返回 null）。 */
function applyStyle(): HTMLStyleElement | null {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || typeof doc.createElement !== 'function') return null
  const existing = doc.getElementById(STYLE_ELEMENT_ID)
  if (existing) return null
  const style = doc.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = PANEL_CSS
  const parent = doc.head ?? doc.body
  if (!parent) return null
  parent.appendChild(style)
  return style
}
