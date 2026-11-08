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
 * 本轮图谱交互的**增量样式**（v0.11.5）。
 *
 * 为什么不并进 `styles.css`：那条文件本轮不在我的写入范围（与数据面同事
 * 并行改同一文件会互相覆盖）。分成两张表而不是「改一处拷一份」：
 * - `styles.css` 仍是既有样式的**唯一真相源**，这里只写新增的类；
 * - 两张表都带自己的 `id`，各自幂等 —— 热更新重复注入不会让样式无限增长
 *   （见 `applyStyle` 的同一条纪律）。
 * 纪律不变：只用 `--dsw-alias-*` / `--dsw-radius-*`，且每个 var() 带保守兜底。
 */
export const GRAPH_CSS = `
/* ---------- 小地图（Overview + 缩略导航） ---------- */
.rg-minimap-wrap {
  position: absolute;
  right: 10px;
  bottom: 10px;
  /* 压在「滤空提示」之上：那块提示是 inset:0 的整面覆盖层，若不给它更高
     层级，图被滤空时用户恰好最需要用的复位/切换入口会被遮住。 */
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1);
  /* 半透明：小地图是参照物，不能挡住它底下的边。 */
  opacity: 0.92;
}

.rg-minimap {
  display: block;
  cursor: crosshair;
  touch-action: none;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-2);
}

/* 视口框：全览态换成虚线 —— 「框铺满」与「框在局部」必须能一眼分辨，
   否则用户分不清「我已经看全了」和「控件出错了」。 */
.rg-minimap-view-all {
  stroke-dasharray: 3 3;
}

/* ---------- 搜索结果「省略 N 条」行 ---------- */
/* 展开入口与结果行之间必须看得出分界：否则它看起来像第 9 条结果，
   用户会去点一个不是节点的按钮。 */
.rg-search-omitted {
  border-top: 1px solid var(--dsw-alias-border-l1);
  margin-top: 2px;
  padding-top: 2px;
}

/* ---------- 过滤滤空的诚实提示 ---------- */
.rg-graph-filtered-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 16px;
  text-align: center;
  font-size: var(--dsw-font-xs-13, 13px);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  pointer-events: auto;
}

/* ---------- 仅读屏可见（鼠标捷径必须另有等价入口） ---------- */
.rg-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
`

/** 增量样式的元素 id（与主表同样幂等）。 */
export const GRAPH_STYLE_ELEMENT_ID = 'dsh-recency-guard-graph-styles'

/**
 * 安装样式。
 *
 * @param ctx 客户端上下文（提供 effect 以便卸载时移除样式）。
 */
export function installStyles(ctx: unknown): void {
  const effect = (ctx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect
  if (typeof effect !== 'function') {
    applyStyle(STYLE_ELEMENT_ID, PANEL_CSS)
    applyStyle(GRAPH_STYLE_ELEMENT_ID, GRAPH_CSS)
    return
  }
  effect(
    () => {
      const elements = [
        applyStyle(STYLE_ELEMENT_ID, PANEL_CSS),
        applyStyle(GRAPH_STYLE_ELEMENT_ID, GRAPH_CSS),
      ]
      return () => {
        for (const element of elements) element?.remove()
      }
    },
    'recency-guard: styles',
  )
}

/** 注入一张样式表（按 id 幂等）。返回注入的元素（已存在时返回 null）。 */
function applyStyle(id: string, text: string): HTMLStyleElement | null {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || typeof doc.createElement !== 'function') return null
  const existing = doc.getElementById(id)
  if (existing) return null
  const style = doc.createElement('style')
  style.id = id
  style.textContent = text
  const parent = doc.head ?? doc.body
  if (!parent) return null
  parent.appendChild(style)
  return style
}
