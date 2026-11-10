/**
 * 工具展示投影 —— `presentCall` / `presentResult` / `presentationMeta` 的**纯函数体**。
 *
 * 为什么需要一个独立模块（而不是写在 `src/index.ts` 的注册处）
 * ----------------------------------------------------------
 * 1. **可重放**：宿主会在「实时流式」与「会话日志回放」两条路径上调用这些
 *    投影，二者共享同一份实现才可能得到同一张卡片。放注册处会让它们随
 *    fiber 生命周期变化，回放路径拿不到。
 * 2. **可测试**：纯函数可以对着真实 outcome 做单测（含超长/空/敌对输入），
 *    而不必启动 dsh。注册处是副作用面，测不了分支。
 * 3. **职责分离**：注册处只做「接线」，投影规则（标题怎么写、正文怎么截、
 *    没有 meta 怎么退化）在这里，改动不触碰宿主装载面。
 *
 * 为什么要显式声明 card 意图（而不是让 UI 猜）
 * -----------------------------------------
 * 不实现 `presentCall`/`presentResult` 时，UI 落到通用回退：待执行卡片把
 * **原始参数 JSON** 当正文、完成卡片把**原始 content** 当正文。于是用户在
 * 命令窗口看到的是「一串 JSON + 一坨文本」，既没有标题说明这是哪个工具、
 * 也没有状态语义。声明 `{ card: 'generic', title, kind }` 才能拿到
 * 有标题、有图标、可折叠的卡片（截图/样式见 dsh-client-ui-tool 的
 * `ToolDetails`：`_1h1PMq_title` / `_1h1PMq_lines` / `_1h1PMq_group`）。
 *
 * 全函数约定：这三个函数**绝不抛异常**。它们运行在展示路径上 ——
 * 展示失败不得把一次成功的工具调用变成失败调用（观测设施不拖垮主流程）。
 */

import type { Metric } from '../observe/observability.ts'
import { definedMetric } from '../observe/observability.ts'
import type { DisplayModel, JsonSafe, ToolOutcome } from './tool-render.ts'

/**
 * 显示层截断度量的形状。
 *
 * 为什么在这里复述 `Metric<number>` 的字段而不用 `Metric<number>` 本体：
 * `DisplayModel` 必须能赋给 `JsonSafe`，而 `JsonSafe` 的对象分支要求成员
 * 具备索引签名 —— TypeScript 只给**类型别名**隐式索引签名，`Metric` 是
 * interface，直接内嵌会让整个 `display` 编译失败。用同构别名既保住
 * 可序列化，又让「与 obs-math 契约一致」由下面的赋值检查钉住。
 */
export type TruncationMetric = {
  value: number | null
  defined: boolean
  label: string
  reason?: string
}

/**
 * 把「文本层省略了多少条明细」投影成 obs-math 形状的指标。
 *
 * 语义边界（对齐 observability.ts 的三条诚实边界）：
 * - 省略 **0 条是真值**（有数据且完整展示）⇒ `defined: true, value: 0`；
 *   这与「无法判定」的 `null` 必须区分。
 * - 因此本指标恒可判定，`defined` 恒为 true —— 它衡量的是**展示完整性**，
 *   而不是「有没有数据」。面板据此可以在 KPI 上显示「本次输出被折叠了多少」。
 *
 * 末尾的赋值是**契约漂移守卫**：obs-math 若改了 `Metric` 的字段，
 * 这一行会在 `tsc` 阶段失败，而不是在运行时静默丢字段。
 */
export function truncationMetric(omitted: number): TruncationMetric {
  const metric: Metric<number> = definedMetric(
    omitted,
    omitted === 0 ? '输出完整展示（0 条明细被折叠）' : `输出折叠 ${omitted} 条明细（完整事实见 data）`,
  )
  const guarded: TruncationMetric = metric
  return guarded
}

/** action → 卡片标题（人话，不是工具名）。 */
const ACTION_TITLE: Record<string, string> = {
  status: '崩溃守护状态',
  history: '安装/更新/崩溃日志',
  recover: '按最近更新执行恢复关闭',
  restore: '恢复非嫌疑插件',
  reenable: '重新启用插件',
  backups: '配置备份清单',
  archive: '归档重置',
  archives: '历史归档清单',
}

/** 工具展示的固定前缀：命令窗口里一眼能认出是哪个插件在说话。 */
const TOOL_TITLE = '插件崩溃守护'

/** 从（可能不合法的）参数里安全取出 action。 */
function actionOf(args: unknown): string {
  if (typeof args === 'object' && args !== null) {
    const action = (args as { action?: unknown }).action
    if (typeof action === 'string' && action.length > 0) return action
  }
  return 'unknown'
}

/** 待执行卡片：标题 + 图标语义 + 关键参数（不放整坨 JSON）。 */
export function titleForAction(action: string): string {
  return ACTION_TITLE[action] ?? `插件崩溃守护（${action}）`
}

/**
 * 待执行卡片的**关键参数摘要**。
 *
 * 为什么只挑关键参数而不是 `JSON.stringify(args)`：回退卡片把整坨 JSON
 * 塞进 `rawInput`，命令窗口第一眼是 `{"action":"history","limit":40}`；
 * 而人需要的是「在看日志，最多 40 条」。
 */
export function describeCallArgs(args: unknown): string {
  const action = actionOf(args)
  if (typeof args !== 'object' || args === null) return action
  const a = args as { bundle?: unknown; limit?: unknown; reason?: unknown }
  const parts: string[] = [action]
  if (typeof a.bundle === 'string' && a.bundle.length > 0) parts.push(`插件 ${a.bundle}`)
  if (typeof a.limit === 'number' && Number.isFinite(a.limit)) parts.push(`最多 ${a.limit} 条`)
  if (typeof a.reason === 'string' && a.reason.trim().length > 0) parts.push(`原因 ${a.reason.trim()}`)
  return parts.join(' · ')
}

/** `ToolCallView`（generic 分支）——直接复用宿主词汇。
 *
 * 为什么不再自己声明（v0.12 接线时改的）：此前这里的本地 `GenericCallView`
 * 与宿主 `@deepseek-ai/dsh-tools` 的导出类型**各自漂移**（宿主 content 是
 * `ContentBlock[]`，本地是 `string`），而函数没接线所以没人发现 ——
 * 「声明了第二真相源 + 不消费 = 必然漂移」的实证。类型 import 编译期即擦除，
 * 不引入运行面依赖（dsh-tools 是 optional peer）。
 */
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'

/**
 * `presentCall` 的实现体：待执行状态怎么显示。
 *
 * 纯且只依赖 args —— 宿主会在回放路径上重新调用它，依赖 value 会得到
 * 与实时不同的卡片（回放时还没有结果）。
 */
export function presentCallOf(args: unknown): ToolCallView {
  const action = actionOf(args)
  return {
    card: 'generic',
    title: titleForAction(action),
    kind: 'other',
    rawInput: describeCallArgs(args),
  }
}

/**
 * 从 `output.presentationMeta` 的**产物**重建显示模型。
 *
 * 为什么需要一个独立的读取器（而不是复用 `displayModelOf`）：
 * `displayModelOf` 面向的是**规范值**（`ToolOutcome`，模型字段嵌在 `.display` 下）；
 * 而宿主传给 `presentResult` 的是 `result.meta` —— 那正是 `presentationMeta`
 * 的返回值本身，字段**平铺在顶层**（title/ok/summary/facts/sections）。
 * 用 `displayModelOf` 读它会永远拿到 null：v0.12 接线时实测到这一点
 * （卡片标题退化成「（无输出）」），所以两个形状各有一个读取器，
 * 而不是让一个函数猜两种形状。
 *
 * 两种形状都试（先平铺后嵌套）：回放在旧版本写入的记录时 meta 可能缺字段，
 * 退化路径必须仍然给出有标题的卡片而不是空白。
 */
export function displayModelFromMeta(meta: unknown): DisplayModel | null {
  if (typeof meta !== 'object' || meta === null) return null
  const flat = meta as Partial<DisplayModel>
  if (typeof flat.summary === 'string') {
    return {
      title: typeof flat.title === 'string' ? flat.title : flat.summary,
      ok: flat.ok === true,
      summary: flat.summary,
      facts: Array.isArray(flat.facts) ? flat.facts : [],
      sections: Array.isArray(flat.sections) ? flat.sections : [],
      omitted: typeof flat.omitted === 'number' ? flat.omitted : 0,
      truncation: flat.truncation ?? truncationMetric(0),
    }
  }
  // 退化：meta 里嵌着规范值（宿主策略替换过投影时可能出现）。
  return displayModelOf((meta as { value?: unknown }).value ?? meta)
}

/** 安全读取 `presentationMeta` 落在 `result.meta` 上的显示模型。 */
export function displayModelOf(value: unknown): DisplayModel | null {
  if (typeof value !== 'object' || value === null) return null
  const display = (value as { display?: unknown }).display
  if (typeof display !== 'object' || display === null) return null
  const model = display as Partial<DisplayModel>
  if (typeof model.summary !== 'string') return null
  return {
    title: typeof model.title === 'string' ? model.title : model.summary,
    ok: model.ok === true,
    summary: model.summary,
    facts: Array.isArray(model.facts) ? model.facts : [],
    sections: Array.isArray(model.sections) ? model.sections : [],
    omitted: typeof model.omitted === 'number' ? model.omitted : 0,
    truncation: model.truncation ?? truncationMetric(0),
  }
}

/** 结果里携带的文本内容（`ContentBlock[]` → 拼成一个字符串）。 */
function textOf(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const content = (result as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    } else if (typeof block === 'string') {
      parts.push(block)
    }
  }
  return parts.join('\n')
}

/**
 * `presentResult` 的实现体：完成状态怎么显示。
 *
 * 正文取 `result.content`（宿主已经用它渲染过 `output.render` 的输出），
 * 但**标题**必须来自 `presentationMeta` 的摘要 —— 那是唯一能在回放路径上
 * 稳定复现的语义来源。`meta` 缺席（例如流水线失败绕过了投影）时退化为
 * 按 action 命名的标题 + 原始文本，仍然可用而不是白屏。
 *
 * `content` 的存在是给**没有展示能力的 UI** 的回退正文；有能力的 UI
 * （Web 卡片）会消费 `meta` 渲染折叠分区，因此这里不做额外截断 ——
 * 文本层已经在 `renderOutcome` 里有界。
 */
export function presentResultOf(args: unknown, result: unknown): ToolResultView {
  const action = actionOf(args)
  const model = displayModelFromMeta(safeMeta(result))
  const body = textOf(result)
  // content 的形状由宿主词汇决定（`ContentBlock[]`）：这里用判别类型取回，
  // 而不是自己声明一个 string —— 后者正是「本地类型漂移成 string」的那处。
  const content: Extract<ToolResultView, { card: 'generic' }>['content'] =
    body.length > 0 ? [{ type: 'text', text: body }] : [{ type: 'text', text: model?.summary ?? '（无输出）' }]
  return {
    card: 'generic',
    title: `${TOOL_TITLE} · ${titleForAction(action)}`,
    // 正文优先用宿主已经渲染好的 content（与命令窗口文本同源）；
    // 它缺席（流水线失败绕过 render）时才退化为摘要。
    content,
  }
}

/** `result.meta` 的安全读取（meta 由宿主填充，形状不受本插件控制）。 */
function safeMeta(result: unknown): JsonSafe | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const meta = (result as { meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return undefined
  return meta as JsonSafe
}

/**
 * `output.presentationMeta` 的实现体：规范值 → UI 卡片模型。
 *
 * 为什么再包一层而不是直接 `return value.display`：
 * 回放路径上 `value` 可能是**旧版本写入的规范值**（没有 `display` 字段），
 * 也可能被宿主策略替换。这里做形状降级：拿不到 `display` 就用
 * `summary/lines` 重组一个最小模型，保证卡片永远有标题和正文。
 */
export function presentationMetaOf(value: unknown): JsonSafe {
  const model = displayModelOf(value)
  if (model) {
    return {
      title: model.title,
      ok: model.ok,
      summary: model.summary,
      facts: model.facts,
      sections: model.sections,
      omitted: model.omitted,
      truncation: model.truncation,
    } as unknown as JsonSafe
  }
  // 降级：从旧规范值的最小公共面重建（summary 是 v0.4 起就有的字段）。
  const legacy = (typeof value === 'object' && value !== null ? value : {}) as Partial<ToolOutcome> & { lines?: unknown }
  const summary = typeof legacy.summary === 'string' ? legacy.summary : '（无法读取工具输出）'
  const lines = Array.isArray(legacy.lines) ? legacy.lines.filter((l): l is string => typeof l === 'string') : []
  return {
    title: summary,
    ok: legacy.ok === true,
    summary,
    facts: [],
    sections: lines.length > 0 ? [{ title: '明细', lines, collapsed: false, omitted: 0 }] : [],
    omitted: 0,
    truncation: truncationMetric(0),
  } as unknown as JsonSafe
}
