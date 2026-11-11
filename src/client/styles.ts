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

/* ---------- 面板分组标题（v0.16 信息架构） ---------- */
/* 分组标题横跨整行：网格是 auto-fit 的，若只占一列会把下一张卡片挤到
   标题右边 —— 读起来像「标题是卡片的一部分」。 */
.rg-group-title {
  grid-column: 1 / -1;
  margin: 10px 0 0;
  padding: 0 2px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: var(--dsw-font-s-15, 15px);
  font-weight: var(--dsw-font-s-15-font-weight, 600);
  color: var(--dsw-alias-label-primary);
}
.rg-group-title:first-child {
  margin-top: 0;
}

/* 降级提示：与普通 notice 区分（虚线边框 = 「这里缺了一块」，不是警告色） */
.rg-notice-degraded {
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-secondary);
}

/* ---------- 错误边界（组件抛错不白屏） ---------- */
.rg-error-boundary {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1);
}
.rg-error-summary {
  max-height: 220px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: var(--dsw-font-xs-13, 13px);
  /* 长栈行必须可换行：横向溢出会把「复制」按钮推出可视区（窄屏尤其） */
  white-space: pre-wrap;
  word-break: break-word;
}
.rg-error-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* ---------- 图例三组（类型 / 边语义 / 语义色） ---------- */
/* 组之间用竖线分隔而不是只靠间距：三个维度各自是独立开关，混成一片会让
   用户以为「关掉一个 = 关掉整组」。 */
.rg-legend-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.rg-legend-group + .rg-legend-group {
  padding-left: 8px;
  border-left: 1px solid var(--dsw-alias-border-l1);
}
.rg-legend-line {
  width: 16px;
  height: 8px;
  color: var(--dsw-alias-label-secondary);
  flex: none;
}
.rg-legend-edge {
  font-variant-numeric: tabular-nums;
}

/* 关联范围的实际跳数读数（档位是文案，跳数是事实） */
.rg-graph-depth {
  font-size: var(--dsw-font-xs-13, 13px);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}

/* ---------- 长文本的展开出口 ---------- */
.rg-graph-longtext {
  margin-top: 6px;
  font-size: var(--dsw-font-xs-13, 13px);
  color: var(--dsw-alias-label-secondary);
}
.rg-graph-longtext > summary {
  cursor: pointer;
}
.rg-graph-longtext-full {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 窄屏（<640px 由面板 data-form 表达）：图例与工具栏一律换行，
   绝不出现横向滚动条 —— 横向溢出会把右侧的按钮移出可达区域。 */
.rg-panel[data-form='narrow'] .rg-graph-toolbar {
  flex-wrap: wrap;
  gap: 6px;
}
.rg-panel[data-form='narrow'] .rg-graph-legend {
  flex-wrap: wrap;
  min-width: 0;
}
.rg-panel[data-form='narrow'] .rg-graph {
  min-width: 0;
  overflow-x: hidden;
}

/* ---------- 图谱 polish（v0.16：真机截图后的视觉收口） ---------- */

/* 适配被可读下界钳制：状态栏如实说明，避免「适配后仍看不全」被当成故障。 */
.rg-graph-fitnote {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-state-warn-primary);
  white-space: nowrap;
}

/* 放大视图：高度由内联 70vh 提供；给动画一个收敛边界，避免展开时抖动。 */
.rg-graph-viewport[data-expanded='true'] {
  min-height: 320px;
}

/* 搜索候选层改为**文档流内**下拉，而不是绝对定位盖住图例：
   绝对定位在工具栏换行时会把「类型/边语义/语义色」图例整块遮住，
   用户点不到开关。流内展开会让工具栏变高，但不遮挡任何控件。 */
.rg-graph-search {
  display: flex;
  flex: 1 1 240px;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 180px;
}
.rg-graph-search .rg-search-results {
  position: static;
  flex-basis: 100%;
  width: 100%;
  min-width: 0;
  max-height: 180px;
  margin-top: 4px;
  box-shadow: none;
}

/* 节点文字底衬（halo）由 SVG 的 paint-order 实现；这里只保证文字不被
   节点背景色以外的填充干扰（stroke 颜色在组件里显式给主题背景色）。 */
.rg-graph-node-label,
.rg-graph-node-detail {
  paint-order: stroke;
}

/* ---------- 卡片头部：标题不许被挤成竖排（v0.16 真机回归） ---------- */
/* 真机：右列卡片标题按单字换行（「数/据/流」）。根因是 flex 行里标题
   没有 min-width:0 / nowrap，可收缩到 CJK 的 min-content（一个字宽），
   于是每个字各占一行。修复三件套：标题 nowrap + ellipsis、右侧操作
   固定宽度、提示文字可收缩但保底。 */
.rg-card-head {
  min-width: 0;
}
.rg-card-title {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* CJK 标题不在字间断行；空间不足交给 ellipsis（title 属性保留全称）。 */
  word-break: keep-all;
  overflow-wrap: normal;
}
.rg-card-head-hint {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 42%;
}
.rg-card-expand,
.rg-card-chevron {
  flex: 0 0 auto;
}

/* 轮询间隔徽标（操作区）：比按钮弱、但不用滚到页脚就能读到。 */
.rg-poll-chip {
  align-self: center;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-full, 999px);
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}

/* 数据流 / 预警卡：内容必须完整可读（v0.16 数据流第 4 步、v0.17 预警卡
   CUSUM 说明行两次被固定 240px body 裁掉）。这两张卡内容长度有限且用户
   必须读全，因此按内容伸展；仍保留 max-height + **显式** overflow-y:auto
   （超出时滚动条可见，不是静默裁切）。 */
.rg-card-body:has(.rg-dataflow),
.rg-card[data-card-id='preventive'] .rg-card-body {
  height: auto;
  max-height: 360px;
  overflow-y: auto;
}

/* 减少动态效果：节点拖动、布局过渡与图例都不得播放动画。 */
@media (prefers-reduced-motion: reduce) {
  .rg-graph-node,
  .rg-graph-toolbar,
  .rg-graph-legend,
  .rg-graph-longtext {
    transition: none !important;
    animation: none !important;
  }
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
