/**
 * 工具输出 —— 规范值、人读文本与 UI 卡片的**同源三分投影**。
 *
 * 为什么要三分投影（dsh-plugin-dev-kb cookbook「adding-a-tool」L74/L93）
 * ----------------------------------------------------------------
 * `execute` 返回**规范 JSON 值**（模型消费、可快照回放）；`output.render`
 * 把同一个值渲染成**人读文本**（命令窗口/会话显示）；`output.presentationMeta`
 * 投影成**UI 卡片模型**（可折叠分组、键值事实）。此前本插件把裸
 * `JSON.stringify` 直接丢给模型 —— 会话里的命令窗口因此满屏转义与引号。
 * v0.7 又修了一层：文本虽是人读的，但**没有分层、没有上限、没有宽度约束**，
 * 于是长路径/多插件时命令窗口出现超宽裸行与看不到头的明细（见
 * `.tmp/repro-display.ts` 的实测：单行最宽 378 显示列、13 行里 12 行 >200 列）。
 *
 * 三条不变量（由 `buildOutcome` 强制，formatter 无法绕过）
 * ------------------------------------------------------
 * 1. **单行**：`lines` 的每一项都是完整的一行（无 `\n`），下游按行解析
 *    （缩进/表格/计数）才不会错位。
 * 2. **有界**：每行不超过 `MAX_LINE_WIDTH` 显示列；列表超限只展示前若干项，
 *    并通过 `display.omitted` 与文案**显式回报被省略的数量**。
 *    静默截断是缺陷，告知边界是诚实 —— 全量事实始终在 `data` 里。
 * 3. **可信降级**：不可信文本先经 `sanitizeText`（剥控制字符/双向符、
 *    转义 Markdown 活动字符），正常包名逐字节不变。
 *
 * 分层结构：摘要行 → 事实行 → 分区（`▼` 标题 + 明细）→ 省略提示。
 * 纯文本通道无法真正折叠，因此「可折叠」由 `presentationMeta` 的
 * `sections[].collapsed` 表达给有折叠能力的 UI；文本层退化为
 * 「上限 + 显式省略计数」，这是能同时满足两种消费端的唯一诚实形态。
 */

import {
  DEFAULT_LIST_LIMIT,
  bounded,
  displayPath,
  displayTime,
  omittedNote,
  sanitizeText,
  toBoundedLinesWithNote,
  toLines,
} from './tool-text.js'
import { truncationMetric, type TruncationMetric } from './tool-presentation.js'

/**
 * JSON 可序列化值 —— 与宿主 dsh-tools 的 `JsonValue` 定义逐字一致。
 *
 * 为什么自己再声明一份：宿主的类型不从此包导出，而 defineTool 的
 * `execute` 契约要求返回 `Record<string, JsonValue>`。结构化复制
 * （结构相同即可赋值）让两份定义保持兼容；契约测试钉住这个一致性。
 */
export type JsonSafe = null | boolean | number | string | JsonSafe[] | { [key: string]: JsonSafe }

/**
 * 一个可折叠明细分区。
 *
 * 用 `type` 而非 `interface`：TypeScript 只给对象字面量类型隐式索引签名，
 * interface 没有 —— 用 interface 会让 `display` 无法赋给 `JsonSafe`
 * （ToolOutcome 的索引签名要求所有成员都是 JsonSafe）。
 */
export type DisplaySection = {
  /** 分区标题（已中和）。 */
  title: string
  /** 明细行（每项单行、已中和、已按列宽折行）。 */
  lines: string[]
  /** 明细是否可默认折叠（交给有折叠能力的 UI）。 */
  collapsed: boolean
  /** 本分区被省略的条目数（0 = 全部展示）。 */
  omitted: number
}

/** 键值事实（对齐 UI 卡片的 `fields`/`<dl>` 槽：标签与值分列，长值可换行）。 */
export type DisplayFact = { key: string; value: string }

/** UI 卡片模型（`presentationMeta` 的投影结果；只含小体积、可重放的字段）。 */
export type DisplayModel = {
  title: string
  ok: boolean
  summary: string
  facts: DisplayFact[]
  sections: DisplaySection[]
  /** 全模型被省略的条目总数（0 = 命令窗口里看到的就是全部）。 */
  omitted: number
  /**
   * 显示完整性的量化读数（obs-math 的 `Metric` 形状）。
   *
   * 为什么把它放进卡片模型而不是另起一个观测通道：面板要能回答
   * 「我刚才看到的输出是全部吗」—— 这是**展示层自己的**指标，
   * 与崩溃率同属 KPI 语义，用同一种 `{value, defined, label}` 形状
   * 才能进同一个 KPI 条而不需要面板写特例。
   */
  truncation: TruncationMetric
}

/** 工具执行结果（规范形态：JSON 可序列化）。 */
export interface ToolOutcome {
  /** 触发的 action（回显，便于多步会话中对账）。 */
  action: string
  /** 业务是否成功（业务失败不是异常 —— 异常留给真正的调用错误）。 */
  ok: boolean
  /** 一行摘要（命令窗口第一眼）。 */
  summary: string
  /**
   * 人读明细行（不含摘要）。
   *
   * v0.7 起它是 `display.sections` 的**派生物**而不是手写数组 ——
   * 手写两份必然漂移（「文本说 A、卡片说 B」）；派生让同源成为结构事实。
   */
  lines: string[]
  /** 结构化数据（与文本同源；模型按此取数）。 */
  data: Record<string, JsonSafe>
  /** 分层显示模型（UI 卡片消费；文本通道由 `renderOutcome` 平铺它）。 */
  display: DisplayModel
  /**
   * 索引签名：让 ToolOutcome 满足宿主的 `Record<string, JsonValue>`
   * execute 返回契约（没有它，defineTool 的类型检查会拒绝本接口）。
   */
  [key: string]: JsonSafe
}

/** formatter 的输入形态：标题 + 事实 + 分区（由 buildOutcome 施加不变量）。 */
interface SectionInput {
  title: string
  items: string[]
  /** 展示上限（超出部分计入 omitted）。默认 DEFAULT_LIST_LIMIT。 */
  limit?: number
  /** 无条目时展示的说明（空态不能是「什么都没有」）。 */
  empty?: string
  collapsed?: boolean
  /**
   * 调用方**已经自行截断**的条目数。
   *
   * 为什么需要这个口子：归档清单的「条目」是一份归档、而一个条目会展开成
   * 多行，按行截断会让「共 6 份」下只显示 5 份 —— 计数单位与用户认知
   * （份）不一致。由调用方按份截断、把省略数交回这里，指标才与语义一致。
   */
  extraOmitted?: number
}

/** formatter 组装用的草稿。 */
interface OutcomeDraft {
  action: string
  ok: boolean
  summary: string
  facts?: Array<[string, string]>
  sections?: SectionInput[]
}

/** 分区标题的视觉标记：`── 标题 ──`（纯文本可辨识，不依赖 Markdown 强调）。 */
const SECTION_MARK = '──'
/** 分区的明细缩进（4 空格 = 表格里一层列表的视觉层级）。 */
const ITEM_INDENT = '    '
/** 分区标题的缩进。 */
const TITLE_INDENT = '  '
/** 事实/摘要行的缩进。 */
const LINE_INDENT = '  '
/**
 * 单条明细的折行上限。
 *
 * 为什么是 4：真实明细（包名 + 状态 + 时刻）折行后是 1~2 行；4 行足够容纳
 * 一条完整的错误信息而不丢内容，又能在病态输入（几十万字的错误栈）下
 * 把单条明细限制在屏幕内。超出部分由 `toBoundedLinesWithNote` 显式报数。
 */
const MAX_ITEM_LINES = 4
/** 单个事实值的折行上限。 */
const MAX_FACT_LINES = 3

/**
 * 组装规范 outcome 并强制三条不变量。
 *
 * 为什么把不变量放在**唯一出口**而不是各 formatter 里：新增 action 时
 * 只要走这个出口就自动安全；把「记得消毒/记得限宽」交给每个 formatter 的
 * 记性，就是下一个显示缺陷的温床。
 */
function buildOutcome(draft: OutcomeDraft, data: Record<string, JsonSafe>): ToolOutcome {
  let omittedTotal = 0
  const facts: DisplayFact[] = (draft.facts ?? []).map(([key, value]) => ({
    // 事实值**不做字符截断**：卡片可以对长值自然换行（`_1h1PMq_field dd`
    // 带 `overflow-wrap:anywhere`），提前截断只会让 UI 能力被白白浪费。
    key: sanitizeText(key).text,
    value: sanitizeText(value).text,
  }))

  const sections: DisplaySection[] = (draft.sections ?? []).map((section) => {
    const title = sanitizeText(section.title).text
    const limit = section.limit ?? DEFAULT_LIST_LIMIT
    if (section.items.length === 0) {
      // 空态：必须解释「为什么是空的」，否则用户无法区分「没问题」与「没读到」。
      const empty = sanitizeText(section.empty ?? '（无条目）').text
      return { title, lines: toLines(empty, ITEM_INDENT), collapsed: section.collapsed ?? false, omitted: 0 }
    }
    const { shown, omitted } = bounded(section.items, limit)
    const extra = section.extraOmitted ?? 0
    omittedTotal += omitted + extra
    const lines: string[] = []
    for (const item of shown) {
      lines.push(...toBoundedLinesWithNote(sanitizeText(item).text, ITEM_INDENT, MAX_ITEM_LINES))
    }
    if (omitted > 0) {
      lines.push(...toLines(omittedNote(omitted, `完整数据见 data；可用 limit 参数扩大`), ITEM_INDENT))
    }
    if (extra > 0) {
      lines.push(...toLines(omittedNote(extra, `完整数据见 data`), ITEM_INDENT))
    }
    return { title, lines, collapsed: section.collapsed ?? false, omitted: omitted + extra }
  })

  const summary = sanitizeText(draft.summary).text
  const display: DisplayModel = {
    title: `${draft.ok ? '✔' : '✘'} ${summary}`,
    ok: draft.ok,
    summary,
    facts,
    sections,
    omitted: omittedTotal,
    truncation: truncationMetric(omittedTotal),
  }
  // lines 是 sections 的派生视图：单行不变量由 toLines/toBoundedLinesWithNote
  // 保证，这里只负责摊平，从而「文本说 A、卡片说 B」在结构上不可能发生。
  const lines = sections.flatMap((section) => [
    `${TITLE_INDENT}${SECTION_MARK} ${section.title} ${SECTION_MARK}`,
    ...section.lines,
  ])
  // data 必须**摊平到顶层**（`ok()` 的契约就是这样写的，v0.4.0 起
  // `execute` 返回的规范值里 `status.profile` / `status.suspectRanking`
  // 一直是顶层字段）。v0.7 重构 display 模型时漏掉了这一步，宿主层测试
  // 直接以 `status.profile === undefined` 报出来 —— 注释与实现漂移的典型。
  // 摊平在前、规范字段在后：data 里即便出现同名键，也不会顶掉 action/ok/
  // summary/lines/data/display 这些**结构字段**。
  return {
    ...data,
    action: draft.action,
    ok: draft.ok,
    summary,
    lines,
    data,
    display,
  }
}

/** 构造一个成功结果（data 摊平到顶层供模型直取，同时保留在 data 下便于遍历）。 */
function ok(action: string, summary: string, draft: Omit<OutcomeDraft, 'action' | 'ok' | 'summary'>, data: Record<string, JsonSafe>): ToolOutcome {
  return buildOutcome({ action, ok: true, summary, ...draft }, data)
}

/** 事实行 + 分区标题行 + 明细行 → 命令窗口文本。 */
export function renderOutcome(outcome: ToolOutcome): string {
  const model = outcome.display
  const head = `${outcome.ok ? '✔' : '✘'} ${model?.summary ?? outcome.summary}`
  const body: string[] = []
  for (const fact of model?.facts ?? []) {
    // 键值合成一行（文本通道没有 <dl> 分列能力，用全角冒号做弱分隔），
    // 再按列宽折行：长值折行而不是被砍掉。
    body.push(...toBoundedLinesWithNote(`${fact.key}：${fact.value}`, LINE_INDENT, MAX_FACT_LINES))
  }
  for (const section of model?.sections ?? []) {
    body.push(`${TITLE_INDENT}${SECTION_MARK} ${section.title} ${SECTION_MARK}`)
    body.push(...section.lines)
  }
  // 没有 display（旧规范值回放 / 外部构造的 outcome）时退化为原始 lines，
  // 保证 render 是**全函数**：任何输入都渲染出东西，不抛异常。
  if (body.length === 0 && outcome.lines.length > 0) {
    for (const line of outcome.lines) {
      body.push(...toBoundedLinesWithNote(sanitizeText(line).text, LINE_INDENT, MAX_FACT_LINES))
    }
  }
  return [head, ...body].join('\n')
}

/* ---------- 各 action 的投影（纯函数：同一输入必得同一文本） ---------- */

interface StatusLike {
  profile: string
  dshVersion: string
  enabled: boolean
  crashedLastRun: boolean
  crashSeq: number
  stabilized: boolean
  autoDisabled: Array<{ name: string; reason: string; crashSeq: number; disabledAt: string }>
  suspectRanking: Array<{ bundle: string; lastChangeAt: string; lastKind: string }>
  experimentalSuspects: string[]
  /** 最近恢复判定（v0.9.1；undefined = 本分区没有崩溃决策发生过）。 */
  lastRecoveryVerdict?: {
    at: string
    crashSeq: number
    evidence: 'deterministic' | 'probabilistic'
    rounds: number
    required: number
    act: boolean
    label: string
    headSuspect: string | null
  }
  /** 当前工作区（规范化路径；缺失时省略该行 —— 旧数据诚实降级）。 */
  workspace?: string
  /** 分区键（与 workspace 成对出现）。 */
  projectKey?: string
  /** 插件自身版本（v0.10 R18；缺失时省略该行）。 */
  pluginVersion?: string | null
  /** 问题反馈链接（v0.10 R18；缺失时省略该行 —— 不放死链）。 */
  issuesUrl?: string | null
  /**
   * 决策因子证据（v0.13 方向③；缺失时整段省略 —— 旧调用方诚实降级）。
   *
   * `hasEvidence=false` 表示决策文件来自旧版本、未记录因子分解。
   * 此时**不渲染一排 0**：0 会被读成「零风险」，而真相是「没有记录」。
   */
  decisionEvidence?: {
    hasEvidence: boolean
    items: Array<{
      rank: number
      bundle: string
      risk: number
      factors: { recency: number; experimental: number; crashFrequency: number }
      streak: number
      changeCount: number
      source: string | null
    }>
  }
}

/** status：崩溃状态 + 嫌疑排名的摘要。 */
export function formatStatus(s: StatusLike): ToolOutcome {
  const facts: Array<[string, string]> = [
    ['profile', s.profile],
    ['dsh', s.dshVersion],
    ['守护', s.enabled ? '开启（崩溃后自动关闭嫌疑插件）' : '仅记录（不关闭任何插件）'],
  ]
  // cycle-4 T03：命令窗口里必须能确认「这次守护是哪个项目的事实」——
  // 隔离归因是分区机制可观测性的最低要求（否则多项目并存时无法对账）。
  if (typeof s.workspace === 'string' && s.workspace.length > 0) {
    // projectKey 与 workspace 一样是可选输入：工作区在档但分区键缺算时
    // 显示占位符而不是崩溃（cycle-4 举他评估：tsc --noUnusedLocals
    // 严格空值 TS18048 抓到 s.projectKey 未判空）。
    const partition = typeof s.projectKey === 'string' ? s.projectKey.slice(0, 8) : '未知'
    facts.push(['工作区', displayPath(s.workspace)])
    facts.push(['分区', partition])
  }
  // 恢复判定（v0.9.1）：命令窗口里直接回答「这次崩溃为什么关/没关插件」。
  if (s.lastRecoveryVerdict !== undefined) {
    const v = s.lastRecoveryVerdict
    facts.push([v.act ? '恢复判定（已行动）' : '恢复判定（观察中）', v.label])
    facts.push(['判定轮次', v.rounds + '/' + v.required])
  }
  // 反馈入口（v0.10 R18）：工具面也带一条 Issues 指引 —— 命令窗口往往是
  // 排障现场，那时用户不会想到去面板找反馈按钮。
  if (s.pluginVersion !== undefined && s.pluginVersion !== null) {
    facts.push(['插件版本', s.pluginVersion])
  }
  if (s.issuesUrl !== undefined && s.issuesUrl !== null && s.issuesUrl !== '') {
    facts.push(['问题反馈', s.issuesUrl])
  }

  const runState = s.crashedLastRun
    ? `上次运行崩溃（第 ${s.crashSeq} 次），已自动关闭嫌疑插件`
    : s.stabilized
      ? '上次崩溃已恢复，当前稳定'
      : '未检测到上次崩溃'

  const sections: SectionInput[] = []
  if (s.autoDisabled.length > 0) {
    sections.push({
      title: `保持关闭（共 ${s.autoDisabled.length} 个）`,
      items: s.autoDisabled.map((d) => `${d.name}（第 ${d.crashSeq} 次崩溃后关闭）`),
      empty: '没有保持关闭的插件',
    })
  } else {
    sections.push({
      title: '保持关闭',
      items: [],
      // 空态说明「没有」而不是留白：留白与「渲染失败」无法区分。
      empty: '没有保持关闭的插件（当前无需关闭任何插件）',
    })
  }
  sections.push({
    // v0.8.1：显示层截断改为显式声明 —— 标题报全量，尾行报省略数，
    // limit 折叠到 15（命令窗口可承受，不再是「报 10 只列 5」的静默缺失）。
    // 完整数据在 data.suspectRanking，模型与面板不再被文本通道限制。
    title: `嫌疑排名（最近更新优先，共 ${s.suspectRanking.length} 个）`,
    items: s.suspectRanking.map((r, index) => `${index + 1}. ${r.bundle} · ${r.lastKind} @ ${displayTime(r.lastChangeAt)}`),
    limit: 15,
    empty: '当前没有第三方/实验性嫌疑插件',
  })
  sections.push({
    title: `实验性命名（共 ${s.experimentalSuspects.length} 个）`,
    items: s.experimentalSuspects,
    limit: 12,
    empty: '没有 experimental/beta 命名的插件',
  })

  // 决策因子（v0.13 方向③）：回答「为什么是它被选中」。
  // 旧版决策文件没有 evidence ⇒ 用 empty 文案说明「未记录」，绝不列 0。
  const evidence = s.decisionEvidence
  if (evidence !== undefined) {
    if (!evidence.hasEvidence) {
      sections.push({
        title: '决策因子',
        items: [],
        empty: '该决策来自旧版本，未记录因子分解（不显示零值以免误读为零风险）',
      })
    } else if (evidence.items.length > 0) {
      // 数值兜底：`render` 是**全函数**（任何输入都渲染出东西、不抛）。
      // 畸形条目（缺 factors / 非数字 risk）会让 `.toFixed` 抛异常，
      // 而渲染异常会吞掉整张卡片 —— 观测设施不能因为一条坏数据而不显示。
      const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      sections.push({
        title: `决策因子（共 ${evidence.items.length} 个，三因子加权和 = 风险）`,
        items: evidence.items.map((item) => {
          const f = (item.factors ?? {}) as Record<string, unknown>
          return (
            `#${num(item.rank)} ${String(item.bundle ?? '（未知）')} · 风险 ${num(item.risk).toFixed(3)} = ` +
            `新近 ${num(f.recency).toFixed(2)} + 实验 ${num(f.experimental).toFixed(2)} + ` +
            `历史 ${num(f.crashFrequency).toFixed(2)} · 连续 ${num(item.streak)} 轮 · 变更 ${num(item.changeCount)} 次` +
            (item.source == null ? '' : ` · 来源 ${String(item.source)}`)
          )
        }),
        limit: 12,
        empty: '当前决策未记录任何嫌疑',
      })
    }
  }

  return ok('status', s.crashedLastRun ? `上次运行崩溃，已进入第 ${s.crashSeq} 轮恢复` : '守护正常，无待处理崩溃', { facts, sections }, {
    ...s,
    // 运行状态也要进结构化数据：面板/模型此前只能从 crashSeq 反推这句话，
    // 反推逻辑重复三处就是三处漂移点。
    runState,
  } as unknown as Record<string, JsonSafe>)
}

/**
 * history：事件日志的时间线。
 *
 * 为什么默认展示 20 条而不是全部：`limit` 默认 40，全量渲染实测 3936 字符、
 * 41 行（复现脚本数据），命令窗口一次滚动看不到头。展示 20 条 + 显式
 * 省略计数，既不淹没有效信息，也不隐藏「还有更多」。
 */
export function formatHistory(events: JsonSafe[]): ToolOutcome {
  const items = events.map((event) => {
    const e = event as { t?: string; kind?: string; bundle?: string; detail?: string }
    const subject = e.bundle ?? e.detail ?? '（无主体）'
    // 用分隔符而不是 padEnd 对齐：kind 可能是中文（`更新` 占 4 列而
    // `.length` 是 2），按码元补齐必然错位；改用固定分隔符后长度无关。
    return `${displayTime(e.t)} · ${e.kind ?? '?'} · ${subject}`
  })
  return ok(
    'history',
    `共 ${events.length} 条事件`,
    {
      sections: [
        {
          title: `事件时间线（最近 ${Math.min(items.length, 20)} 条）`,
          items,
          limit: 20,
          empty: '还没有事件记录 —— 本插件在安装/更新/崩溃时才开始写 journal',
        },
      ],
    },
    { events },
  )
}

/**
 * recover：本次自动关闭了哪些嫌疑插件。
 *
 * 去重：note 由 guard 生成，内容常常与 disabled 列表是同一句话
 * （实测 `recover(none)` 输出「没有可关闭的嫌疑插件」两遍）。同一事实
 * 显示两次会让用户以为发生了两件事。
 */
export function formatRecover(r: { disabled: string[]; note: string }): ToolOutcome {
  const items = r.disabled.map((b) => `已关闭 ${b}`)
  const note = r.note.trim()
  const duplicate = note.length > 0 && (items.includes(note) || (r.disabled.length === 0 && items.length === 0))
  return ok(
    'recover',
    `已按最近更新关闭 ${r.disabled.length} 个嫌疑插件`,
    {
      facts: duplicate ? [] : [['说明', note]],
      sections: [
        {
          title: `本次关闭（共 ${r.disabled.length} 个）`,
          items,
          empty: '没有可关闭的嫌疑插件 —— 当前没有符合条件的第三方/实验性插件',
        },
      ],
    },
    { ...r },
  )
}

/** restore：恢复（重新启用）与保持关闭的名单。 */
export function formatRestore(r: { reenabled: string[]; keptDisabled: string[]; note: string }): ToolOutcome {
  return ok(
    'restore',
    `恢复 ${r.reenabled.length} 个，保持关闭 ${r.keptDisabled.length} 个`,
    {
      facts: r.note.trim().length > 0 ? [['说明', r.note]] : [],
      sections: [
        {
          title: `已恢复（共 ${r.reenabled.length} 个）`,
          items: r.reenabled,
          empty: '没有需要恢复的插件',
        },
        {
          title: `保持关闭（首要嫌疑，共 ${r.keptDisabled.length} 个）`,
          items: r.keptDisabled,
          empty: '没有保持关闭的插件',
        },
      ],
    },
    { ...r },
  )
}

/** reenable：单个插件的手动恢复。 */
export function formatReenable(r: { bundle: string; reenabled: boolean; hasConfigBackup: boolean }): ToolOutcome {
  return ok(
    'reenable',
    `${r.bundle} ${r.reenabled ? '已重新启用' : '未能启用'}`,
    {
      facts: [['配置备份', r.hasConfigBackup ? '存在（可在需要时对照）' : '无（该插件此前未被自动关闭过）']],
      sections: r.reenabled
        ? []
        : [
            {
              title: '下一步',
              items: ['确认插件未被守护行挡住：查看 profile 的 cordis.patch.yml', '确认该包仍在 node_modules 中'],
            },
          ],
    },
    { ...r },
  )
}

/** backups：配置备份清单（最近一份 + 每插件时间线）。 */
export function formatBackups(list: JsonSafe[], timelines?: JsonSafe[]): ToolOutcome {
  const items = list.map((b) => {
    const entry = b as { bundle?: string; writtenAt?: string }
    return `${entry.bundle ?? '?'} · ${displayTime(entry.writtenAt)}`
  })
  const sections: SectionInput[] = [
    {
      title: '备份清单（最近一份）',
      items,
      limit: 12,
      empty: '没有配置备份 —— 从未自动关闭过插件，或备份已被清理',
    },
  ]
  // 时间线备份（v0.8 备份增强）：按插件列出保留了几版、最新版本是什么。
  // 缺席（旧宿主/未启用）时不渲染这个区，而不是渲染一个假空态 ——
  // 「没启用」与「启用了但没备份」是两件事。
  if (Array.isArray(timelines)) {
    const timelineItems = timelines.map((t) => {
      const row = t as { bundle?: string; count?: number; latestVersion?: string; latestAt?: string }
      const latest = row.latestVersion ? `最新 ${row.latestVersion}` : '版本未知'
      const at = row.latestAt ? displayTime(row.latestAt) : ''
      return `${row.bundle ?? '?'} · ${row.count ?? 0} 份 · ${latest}${at ? ` · ${at}` : ''}`
    })
    sections.push({
      title: '更新时间线（每插件保留多版）',
      items: timelineItems,
      limit: 12,
      empty: '没有时间线备份 —— 尚未有插件更新，或 versionedBackups 未开启',
    })
  }
  // JsonSafe 的 number 收窄：JsonSafe 联合类型里 number 与 string 同在，
  // 直接当 number 用会被类型系统拦下（实测 TS2365/TS18047）。
  const total = (timelines ?? []).reduce((n: number, t) => n + (Number((t as { count?: number }).count) || 0), 0)
  return ok(
    'backups',
    timelines
      ? `共 ${list.length} 份最近备份 · ${timelines.length} 个插件的时间线（${total} 份）`
      : `共 ${list.length} 份配置备份`,
    { sections },
    { backups: list, ...(timelines ? { timelines } : {}) },
  )
}

/** archive：归档重置（归档不删证据，但不继承旧结论）。 */
export function formatArchive(r: { ok?: boolean; archiveDir?: string; count?: number; manifest?: JsonSafe }): ToolOutcome {
  const count = typeof r.count === 'number' ? r.count : 0
  const facts: Array<[string, string]> = []
  // 缺席即诚实：拿不到归档目录时不能显示裸 `?`（无法与「目录名就是 ?」区分），
  // 也不声称「manifest 已留档」—— 没搬到东西就没有 manifest 可留。
  if (typeof r.archiveDir === 'string' && r.archiveDir.length > 0) facts.push(['归档目录', displayPath(r.archiveDir)])
  else facts.push(['归档目录', '未返回（本次没有产生归档目录）'])
  facts.push(['搬走产物', `${count} 项`])
  facts.push(['留档', count > 0 ? 'manifest 已写入归档目录' : '没有产物可留档'])
  return ok(
    'archive',
    '归档重置完成，守护将以最新事实重新开始',
    {
      facts,
      sections: [
        {
          title: '重置效果',
          items: ['崩溃计数已归零', '下次启动按最新事实重新推导嫌疑', '归档不删证据：旧产物仍在归档目录内'],
        },
      ],
    },
    { ...r, count },
  )
}

/**
 * archives：历史归档清单。
 *
 * cycle-4 T02：每份归档带 **manifest 摘要**（崩溃次数/被关插件/事件数）——
 * 这是「举他对照基线」的消费面：对照另一工作区时不只看到「归过档」，
 * 还能看到那次归档时的关键事实。摘要缺失（旧归档）诚实降级为不显示。
 *
 * v0.7 修：此前每条归档是**一个含内嵌 `\n` 的数组元素**，导致
 * `lines` 的「一项 = 一行」契约被破坏（复现脚本实测 6 份归档 = 13 行而
 * `lines.length` 只有 7），缩进也由元素自带而非 renderOutcome 施加。
 * 现在每条归档贡献两行独立项，契约与缩进都由出口统一保证。
 */
export function formatArchives(r: {
  archives?: Array<{
    dir: string
    archivedAt: string
    reason: string
    count: number
    summary?: { crashSeq: number; autoDisabled: string[]; journalEvents: number }
  }>
}): ToolOutcome {
  const archives = Array.isArray(r.archives) ? r.archives : []
  // 按「份」截断而不是按行：一个条目展开成 2 行，若交给通用的按行上限，
  // 「共 6 份」会出现只显示 5 份而省略数报 2 的错位（单位与认知不一致）。
  const { shown, omitted } = bounded(archives, 4)
  const items: string[] = []
  for (const a of shown) {
    items.push(`${displayPath(a.dir)} · ${a.reason} · ${displayTime(a.archivedAt)} · 搬走 ${a.count} 项`)
    if (a.summary) {
      const parts = [`崩溃 ${a.summary.crashSeq} 次`, `事件 ${a.summary.journalEvents} 条`]
      if (a.summary.autoDisabled.length > 0) {
        // 内嵌名单也要有界：一份归档曾关过几十个插件时，一个无界列表会
        // 把摘要行撑成上百列（复现脚本实测 345 列）。保留前 3 个 + 显式总数。
        const names = a.summary.autoDisabled
        const head = names.slice(0, 3).join('、')
        const more = names.length > 3 ? ` 等 ${names.length} 个` : ''
        parts.push(`曾关 ${head}${more}`)
      }
      items.push(`摘要：${parts.join(' · ')}`)
    } else {
      // 旧归档没有摘要字段：说明「没有」而不是留白（留白与渲染失败同形）。
      items.push('摘要：该归档未记录摘要（归档时尚未写入 manifest 摘要）')
    }
  }
  return ok(
    'archives',
    `共 ${archives.length} 份归档`,
    {
      sections: [
        {
          title: `归档清单（共 ${archives.length} 份）`,
          items,
          limit: items.length,
          extraOmitted: omitted,
          empty: '还没有归档 —— 归档在每次 archive 重置时产生',
        },
      ],
    },
    { ...r },
  )
}
