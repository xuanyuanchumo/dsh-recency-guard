/**
 * `tool.call.toolview` 卡片的数据抽取层 —— **纯函数，零 React 依赖**。
 *
 * ## 为什么要有这一层（命令窗口显示问题的根因）
 *
 * 宿主侧（`src/host/surface/tool-presentation.ts`）已经精心构造了
 * `presentCall` / `presentResult` / `output.presentationMeta` 三条投影：
 * 有标题、有事实分区、有省略计数、有截断指标。
 *
 * **但内置 Web Client 不消费它们** —— 这是官方契约的既定事实
 * （kb `site/reference/cookbook/adding-a-tool.md`：「内置 Web Client 不消费
 * `presentCall`/`presentResult`」）。宿主侧的投影只在**有能力的 UI**
 * （如 dsh-ops 自己的 TUI 面板）里才被渲染；落到内置 Web Client 时，
 * 工具调用会退化成 generic 行 —— 用户在命令窗口看到的是
 * 「一串参数 JSON + 一坨原始文本」，而不是有标题、有状态、有分区的卡片。
 *
 * 修复路径是**客户端注册一个 keyed slot**：`tool.call.toolview`。
 * 宿主会话面板挂载时按工具名（key）查表，命中就用我们的组件渲染那一行。
 *
 * ## 为什么把抽取逻辑单独成模块
 *
 * 1. **可测**：wire block 的形状由宿主控制（且会演进）。防御式取值必须能对着
 *    敌对输入（null / 数组 / 缺字段 / 非字符串）做单测，而不是只能靠真机看。
 * 2. **可复放**：卡片在 `preparing` / `start` / `result` 三个阶段各自渲染，
 *    抽取逻辑必须对同一份 block 给出一致结论。
 * 3. **不引 React**：本模块被单测直接 import；引入 React 会让纯逻辑测试
 *    依赖 React 运行时。
 *
 * ## 诚实边界
 *
 * - **拿不到就是拿不到**：wire block 里没有的字段一律显示为「未提供」，
 *   绝不臆造 exit code / 耗时。
 * - **meta 是事实，不是日志**：宿主的 `result.meta` 承载 host 侧
 *   `presentationMeta` 落下的字段（facts / sections / omitted / truncation），
 *   卡片按它渲染分区，而不是重新解析正文猜结构。
 */

/** 卡片渲染三阶段（与宿主 `ToolCallPhaseProps.phase` 同名）。 */
export type ToolViewPhase = 'preparing' | 'start' | 'result'

/** 一个「事实」条目（来自 host 侧 presentationMeta.facts）。 */
export interface ToolViewFact {
  label: string
  value: string
}

/** 一个「分区」条目（来自 host 侧 presentationMeta.sections）。 */
export interface ToolViewSection {
  title: string
  lines: string[]
  /** 该分区是否默认折叠（host 侧已经决定，这里只转述）。 */
  collapsed: boolean
  /** 该分区被省略的行数（0 = 完整）。 */
  omitted: number
}

/** 卡片渲染所需的全部事实。 */
export interface ToolViewModel {
  phase: ToolViewPhase
  /** 工具名（来自 props.toolName）。 */
  toolName: string
  /** 卡片标题（host 侧给的最好；否则按 action 推导；再否则退化为工具名）。 */
  title: string
  /** 是否成功（host 侧 `presentationMeta.ok`）。 */
  ok: boolean
  /** 一句话摘要。 */
  summary: string
  /** 关键事实。 */
  facts: ToolViewFact[]
  /** 明细分区。 */
  sections: ToolViewSection[]
  /** 正文文本（result 阶段）。 */
  output: string
  /** 本次调用被省略的总行数（0 = 完整展示，是真值不是「未知」）。 */
  omitted: number
  /** 结果是否出错（宿主标记的 isError）。 */
  isError: boolean
  /** 退出码（宿主提供才有；undefined = 未提供，不臆造）。 */
  exitCode: number | undefined
  /** 耗时毫秒（宿主提供才有）。 */
  durationMs: number | undefined
  /** 工作目录（宿主提供才有）。 */
  cwd: string | undefined
  /** 参数摘要（start 阶段）。 */
  argsSummary: string
  /** 是否处于「准备中」——此时没有任何可读事实。 */
  pending: boolean
}

/** 安全取字符串。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 安全取数字（NaN / Infinity 不是有效数值）。 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 从 action 参数派生人类可读的摘要。
 *
 * 为什么不让卡片自己懂工具参数：卡片的职责是**展示**，参数语义属于
 * host 侧。这里只做「键值对安全摊平」的通用降级 —— 拿不到语义时
 * 至少让人看见「调了哪个 action、传了什么」。
 */
export function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const source = args as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (typeof value === 'string') {
      parts.push(`${key}=${value}`)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${key}=${value}`)
    } else if (typeof value === 'boolean') {
      parts.push(`${key}=${value ? 'true' : 'false'}`)
    }
  }
  return parts.join(' · ')
}

/**
 * 从 host 侧 `presentationMeta` 抽取事实与分区。
 *
 * meta 的形状由 host 侧 `presentationMetaOf()` 决定（平铺：`title/ok/summary/
 * facts/sections/omitted/truncation`），但回放路径上可能读到旧版本写的 meta
 * —— 因此每一项都独立做形状校验，缺就退化为空数组，**不抛异常**
 * （展示路径抛错会把一次成功的工具调用变成失败调用）。
 */
export function extractMetaFacts(meta: unknown): {
  facts: ToolViewFact[]
  sections: ToolViewSection[]
  omitted: number
  title: string
  summary: string
  ok: boolean
} {
  const empty = { facts: [] as ToolViewFact[], sections: [] as ToolViewSection[], omitted: 0, title: '', summary: '', ok: true }
  if (typeof meta !== 'object' || meta === null) return empty
  const source = meta as Record<string, unknown>

  const facts: ToolViewFact[] = []
  if (Array.isArray(source.facts)) {
    for (const item of source.facts) {
      if (typeof item !== 'object' || item === null) continue
      const pair = item as Record<string, unknown>
      const label = str(pair.label)
      const value = str(pair.value)
      // 两项都空的 fact 没有信息量 —— 不占位。
      if (label === '' && value === '') continue
      facts.push({ label: label === '' ? '—' : label, value })
    }
  }

  const sections: ToolViewSection[] = []
  if (Array.isArray(source.sections)) {
    for (const item of source.sections) {
      if (typeof item !== 'object' || item === null) continue
      const sec = item as Record<string, unknown>
      const lines = Array.isArray(sec.lines)
        ? sec.lines.filter((line): line is string => typeof line === 'string')
        : []
      const title = str(sec.title)
      // 空分区（无标题且无行）不渲染 —— 否则卡片里出现一堆空折叠块。
      if (title === '' && lines.length === 0) continue
      sections.push({
        title: title === '' ? '明细' : title,
        lines,
        collapsed: sec.collapsed === true,
        omitted: num(sec.omitted) ?? 0,
      })
    }
  }

  return {
    facts,
    sections,
    omitted: num(source.omitted) ?? 0,
    title: str(source.title),
    summary: str(source.summary),
    ok: source.ok !== false,
  }
}

/**
 * 从 result block 里提取正文文本。
 *
 * `content` 是宿主的 `ContentBlock[]` —— 拼接其中 `type === 'text'` 的块。
 * 形状由宿主控制 ⇒ 逐块校验，坏块跳过而不是让整段渲染失败。
 */
export function extractOutputText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const cell = item as { type?: unknown; text?: unknown }
    if (cell.type === 'text') {
      const text = str(cell.text)
      if (text !== '') parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * 从 wire props 构造卡片模型。
 *
 * @param props 宿主注入的 `tool.call.toolview` owner props：
 *   `ToolCallCommonProps`（useDisclosure/callId/toolName/cwd/home/openFile/
 *   loadImage/inspect）+ `ToolCallPhaseProps`（phase + block）。
 */
export function buildToolViewModel(props: unknown): ToolViewModel {
  const source = (typeof props === 'object' && props !== null ? props : {}) as Record<string, unknown>
  const toolName = str(source.toolName)
  const cwd = str(source.cwd) || undefined
  const phaseRaw = str(source.phase)
  const phase: ToolViewPhase =
    phaseRaw === 'preparing' || phaseRaw === 'start' || phaseRaw === 'result' ? phaseRaw : 'result'
  const block = (typeof source.block === 'object' && source.block !== null ? source.block : {}) as Record<string, unknown>

  if (phase === 'preparing') {
    return {
      phase,
      toolName,
      title: toolName,
      ok: true,
      summary: '',
      facts: [],
      sections: [],
      output: '',
      omitted: 0,
      isError: false,
      exitCode: undefined,
      durationMs: undefined,
      cwd,
      argsSummary: '',
      pending: true,
    }
  }

  const meta = (typeof block.meta === 'object' && block.meta !== null ? block.meta : {}) as Record<string, unknown>
  const metaFacts = extractMetaFacts(meta)

  if (phase === 'start') {
    const args = block.arguments ?? block.args
    return {
      phase,
      toolName,
      title: toolName,
      ok: true,
      summary: '',
      facts: [],
      sections: [],
      output: '',
      omitted: 0,
      isError: false,
      exitCode: undefined,
      durationMs: undefined,
      cwd,
      argsSummary: summarizeArgs(args),
      pending: false,
    }
  }

  // result 阶段：meta 优先（host 侧落下的持久事实），正文从 content 拼。
  const output = extractOutputText(block)
  const exitCode = num(meta.exitCode) ?? num(block.exitCode)
  const durationMs = num(meta.durationMs) ?? num(block.durationMs)

  return {
    phase,
    toolName,
    // 标题优先取 host 给的（它知道 action 语义），其次工具名。
    title: metaFacts.title !== '' ? metaFacts.title : toolName,
    ok: metaFacts.ok,
    summary: metaFacts.summary,
    facts: metaFacts.facts,
    sections: metaFacts.sections,
    output,
    omitted: metaFacts.omitted,
    isError: block.isError === true,
    exitCode,
    durationMs,
    cwd,
    argsSummary: '',
    pending: false,
  }
}
