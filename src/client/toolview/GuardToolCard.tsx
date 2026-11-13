import { createElement, type ReactElement } from 'react'
import { t } from '../i18n/i18n.ts'
import { buildToolViewModel, type ToolViewModel } from './toolview-model.ts'

/**
 * `tool.call.toolview` 卡片 —— 让 `recency_guard` 在**命令窗口**里有卡片可看。
 *
 * ## 为什么必须有这个组件
 *
 * 宿主侧的 `presentCall` / `presentResult` 投影**不会**被内置 Web Client 渲染
 * （官方契约：内置 Web Client 不消费这两个钩子）。没有这张卡片时，
 * `recency_guard` 的调用在命令窗口里退化成 generic 行：参数 JSON + 原始正文。
 *
 * ## 纪律
 *
 * 1. **稳定 function component**：模块作用域声明，不在渲染期内联。
 *    React 把变化的组件类型当作另一个组件，会卸载并重挂整棵子树。
 * 2. **不接收 Cordis context、不导入 service 类、不读 React context**：
 *    组件只吃宿主注入的 props。
 * 3. **绝不抛异常**：展示路径抛错会把一次成功的工具调用变成失败调用。
 *    所有取值经 `buildToolViewModel` 的防御式解析。
 * 4. **诚实空态**：拿不到的事实显示「未提供」，不臆造 exit code / 耗时。
 * 5. **CSS 走语义令牌**：只用 `--dsw-alias-*` / `--dsw-radius-*`，每处 var() 带兜底。
 */

/** 卡片样式（语义令牌版，与面板同风格）。 */
export const TOOLVIEW_CSS = `
.rg-toolview-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-family, inherit);
  font-size: var(--dsw-font-xs-13, 13px);
  line-height: var(--dsw-font-s-14-line-height, 20px);
  min-width: 0;
}
.rg-toolview-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.rg-toolview-title {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
  /* 长 action 名不许把右侧的状态徽标挤出可视区。 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: keep-all;
}
.rg-toolview-badge {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--dsw-radius-full, 999px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.22));
  font-size: var(--dsw-font-xxxs-11, 11px);
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, inherit);
}
.rg-toolview-badge[data-tone='ok'] {
  color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, inherit));
  border-color: var(--dsw-alias-state-success-primary, transparent);
}
.rg-toolview-badge[data-tone='bad'] {
  color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary, inherit));
  border-color: var(--dsw-alias-state-error-primary, transparent);
}
.rg-toolview-summary {
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: var(--dsw-font-xxxs-11, 11px);
  word-break: break-word;
}
.rg-toolview-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0;
  font-size: var(--dsw-font-xxxs-11, 11px);
}
.rg-toolview-facts dt {
  color: var(--dsw-alias-label-tertiary, inherit);
  white-space: nowrap;
}
.rg-toolview-facts dd {
  margin: 0;
  color: var(--dsw-alias-label-primary, inherit);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}
.rg-toolview-output {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: var(--dsw-font-xxxs-11, 11px);
  white-space: pre-wrap;
  word-break: break-word;
  /* 有界但可见：超出的部分滚动，而不是静默裁掉。 */
  max-height: 320px;
  overflow: auto;
}
.rg-toolview-output[data-tone='bad'] {
  color: var(--dsw-alias-state-error-primary, inherit);
}
.rg-toolview-sections {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rg-toolview-section {
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  border-radius: var(--dsw-radius-xs, 4px);
  padding: 4px 8px;
}
.rg-toolview-section > summary {
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: var(--dsw-font-xxxs-11, 11px);
}
.rg-toolview-lines {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: var(--dsw-font-xxxs-11, 11px);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.rg-toolview-lines li {
  padding: 1px 0;
}
.rg-toolview-omitted {
  margin-top: 2px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, inherit);
}
.rg-toolview-pending {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-style: italic;
  font-size: var(--dsw-font-xxxs-11, 11px);
}
.rg-toolview-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, inherit);
}
`

/**
 * 把模型渲染成卡片。
 *
 * 分区默认折叠与否由 **host 侧** 决定（`presentationMeta.sections[].collapsed`）——
 * 卡片不重新决定：那会形成第二真相源（两边各写一套折叠策略，必然漂移）。
 */
function renderCard(model: ToolViewModel): ReactElement {
  const children: Array<ReactElement | null> = []

  // 头部：标题 + 状态徽标。
  const badges: Array<ReactElement> = []
  if (model.phase === 'result') {
    if (model.exitCode !== undefined) {
      badges.push(
        createElement(
          'span',
          { key: 'exit', className: 'rg-toolview-badge', 'data-tone': model.exitCode === 0 ? 'ok' : 'bad' },
          `exit ${model.exitCode}`,
        ),
      )
    } else if (model.ok) {
      badges.push(createElement('span', { key: 'ok', className: 'rg-toolview-badge', 'data-tone': 'ok' }, t('toolview.ok')))
    }
    if (model.omitted > 0) {
      badges.push(
        createElement('span', { key: 'omitted', className: 'rg-toolview-badge' }, t('toolview.omitted', { n: model.omitted })),
      )
    }
  }
  children.push(
    createElement(
      'div',
      { key: 'head', className: 'rg-toolview-head' },
      createElement('span', { key: 'title', className: 'rg-toolview-title', title: model.title }, model.title),
      ...badges,
    ),
  )

  if (model.pending) {
    children.push(
      createElement('div', { key: 'pending', className: 'rg-toolview-pending' }, t('toolview.preparing')),
    )
    return createElement('div', { className: 'rg-toolview-card', 'data-rg-toolview': model.toolName }, ...children)
  }

  if (model.argsSummary !== '') {
    children.push(
      createElement(
        'div',
        { key: 'args', className: 'rg-toolview-summary' },
        `${model.argsSummary}${model.cwd ? ` · ${model.cwd}` : ''}`,
      ),
    )
  }

  if (model.summary !== '') {
    children.push(createElement('div', { key: 'summary', className: 'rg-toolview-summary' }, model.summary))
  }

  // 事实分区（host 侧 facts）。
  if (model.facts.length > 0) {
    const items: Array<ReactElement> = []
    for (const fact of model.facts) {
      items.push(createElement('dt', { key: `k-${fact.label}` }, fact.label))
      items.push(createElement('dd', { key: `v-${fact.label}` }, fact.value))
    }
    children.push(createElement('dl', { key: 'facts', className: 'rg-toolview-facts' }, ...items))
  }

  // 明细分区（host 侧 sections；折叠态由 host 决定）。
  if (model.sections.length > 0) {
    const sections: Array<ReactElement> = []
    for (const [index, section] of model.sections.entries()) {
      const lines = section.lines.map((line, lineIndex) =>
        createElement('li', { key: `l-${index}-${lineIndex}` }, line),
      )
      const inner: Array<ReactElement> = [createElement('ul', { key: 'lines', className: 'rg-toolview-lines' }, ...lines)]
      if (section.omitted > 0) {
        inner.push(
          createElement(
            'div',
            { key: 'om', className: 'rg-toolview-omitted' },
            t('toolview.sectionOmitted', { n: section.omitted }),
          ),
        )
      }
      sections.push(
        createElement(
          'details',
          {
            key: `s-${index}`,
            className: 'rg-toolview-section',
            // 默认展开与否 = host 侧的说法。
            open: section.collapsed !== true,
          },
          createElement('summary', { key: 'sum' }, section.title),
          ...inner,
        ),
      )
    }
    children.push(createElement('div', { key: 'sections', className: 'rg-toolview-sections' }, ...sections))
  }

  // 正文。
  if (model.output !== '') {
    children.push(
      createElement(
        'pre',
        { key: 'output', className: 'rg-toolview-output', 'data-tone': model.isError ? 'bad' : 'normal' },
        model.output,
      ),
    )
  }

  // 底部元信息：耗时 / 工作目录 / 未提供的事实。
  const meta: Array<ReactElement> = []
  if (model.durationMs !== undefined) {
    meta.push(createElement('span', { key: 'dur' }, `${Math.round(model.durationMs)}ms`))
  }
  if (model.cwd !== undefined) {
    meta.push(createElement('span', { key: 'cwd' }, model.cwd))
  }
  if (model.phase === 'result' && model.exitCode === undefined && model.durationMs === undefined) {
    meta.push(createElement('span', { key: 'na' }, t('toolview.noMeta')))
  }
  if (meta.length > 0) {
    children.push(createElement('div', { key: 'meta', className: 'rg-toolview-meta' }, ...meta))
  }

  return createElement('div', { className: 'rg-toolview-card', 'data-rg-toolview': model.toolName }, ...children)
}

/**
 * 卡片组件（稳定 function component，模块作用域声明）。
 *
 * 导出而不是内联：React 每次渲染收到新函数类型会卸载并重挂整棵子树
 * （kb `extra/defensive-patterns/client-components.zh.md`）。
 */
export function GuardToolCard(props: Record<string, unknown>): ReactElement {
  let model: ToolViewModel
  try {
    model = buildToolViewModel(props)
  } catch {
    // 抽取层理论上不抛（全部防御式）；真抛了也要有卡片，而不是让会话崩。
    model = buildToolViewModel({ toolName: 'recency_guard', phase: 'preparing' })
  }
  return renderCard(model)
}
