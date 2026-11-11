/**
 * 工具输出的**显示层原语**（纯函数，零依赖）。
 *
 * 为什么单独成模块
 * ----------------
 * 「命令窗口显示问题」有三个彼此独立的根因，混在 formatter 里修会互相掩盖：
 *   1. **宽度**：终端/卡片按**视觉列**折行，而 JS 的 `length`/`padEnd` 数的是
 *      UTF-16 码元 —— 中文一行 60 个字符占 120 列，列对齐与折行全错位。
 *   2. **可信度**：插件名/错误信息来自第三方包，是不可信外部数据。它们会被
 *      直接拼进人读文本，而人读文本可能被 Markdown 解释 ⇒ 注入面。
 *   3. **有界性**：文本通道没有折叠能力，只能靠**上限 + 显式告知未展开项数**
 *      保证不长成一面墙（静默截断是缺陷，告知边界是诚实）。
 * 每个原语只解决其中一件，formatter 只负责组装。
 */

/**
 * 一行文本的最大**显示列**预算。
 *
 * 为什么是 118 而不是 200：`renderOutcome` 会在每条明细前加 2 空格缩进，
 * 118 + 2 = 120 落在常见的 120 列终端宽度内；而通用工具卡片本身还有
 * padding，120 是一个连窄面板也不横向溢出的保守值（>200 的裸行是实测破版线）。
 */
export const MAX_LINE_WIDTH = 118

/** 明细列表在文本层默认展示的条目上限（超出部分必须显式告知）。 */
export const DEFAULT_LIST_LIMIT = 8

/**
 * 零宽码点：它们**不占列**，但也不能从文本里删掉。
 *
 * 为什么要单独列出来（cycle-14 / R10 命令窗口回归实测）：
 * 此前只有「宽字符 = 2 列、其余 = 1 列」两档，于是
 * - 组合字符（`e` + U+0301）被算成 2 列，实际只占 1 列 ⇒ 中英混排里
 *   含重音/变音的名字会把整张表的右侧列推歪；
 * - 零宽空格 / ZWJ / BOM 被算成 1 列 ⇒ 段尾多出不可见的一格。
 * 这两类都**不能靠 `.length` 蒙对**（组合字符在 UTF-16 里就是一个码元），
 * 所以必须显式给 0。肤色修饰符放在这里（先于 emoji 宽域判定），否则
 * `👍🏽` 会被算成 4 列。
 */
function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // 组合用附加符号
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) || // 组合用附加符号扩展
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) || // 组合用附加符号补充
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) || // 组合用符号（含 keycap）
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) || // 组合用半记号
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // 变体选择符
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) || // 肤色修饰符
    codePoint === 0x200b || // 零宽空格
    codePoint === 0x200c || // 零宽不连接符
    codePoint === 0x200d || // 零宽连接符（ZWJ）
    codePoint === 0x200e ||
    codePoint === 0x200f || // 双向标记
    codePoint === 0x2060 || // word joiner
    codePoint === 0xfeff || // BOM / 零宽不换行空格
    codePoint === 0x00ad // 软连字符
  )
}

/**
 * 一个码点占多少个显示列。
 *
 * 为什么按码点而不是按 `.length`：代理对（emoji）在 `.length` 里算 2，
 * 但它只占 2 列 —— 恰好蒙对；而 CJK 在 `.length` 里算 1，实际占 2 列 ——
 * 错一半。列宽必须按**码点区间**判定，不能借用字符串长度。
 */
export function codePointWidth(codePoint: number): number {
  if (isZeroWidth(codePoint)) return 0
  const wide =
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // 韩文字母
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK 部首 / 标点
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // 假名 / CJK 兼容
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 统一表意
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // 彝文
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 谚文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容表意
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK 兼容形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角形式
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK 扩展 B+
  return wide ? 2 : 1
}

/**
 * 一段文本的显示列宽（**字形感知**）。
 *
 * ZWJ 序列（`👨‍👩‍👧`）与肤色修饰符是**一个**字形：连接符之后的码点不再
 * 累加宽度，否则一个家庭 emoji 会被算成 6 列，padWidth 会把整张表推歪。
 */
export function displayWidth(text: string): number {
  let width = 0
  let joined = false
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (codePoint === 0x200d) {
      joined = true
      continue
    }
    if (joined) {
      joined = false
      continue
    }
    width += codePointWidth(codePoint)
  }
  return width
}

/**
 * 不可信文本的中和结果。
 *
 * `removed` 计数是**诚实边界**的一部分：被剥掉的字符必须能被用户察觉
 * （否则「显示的名字」与「真实的包名」不同却无人知情）。
 */
export interface Sanitized {
  text: string
  removed: number
}

/**
 * 中和来自包生态的不可信文本（插件名 / 原因 / 错误详情 / 备注）。
 *
 * 为什么这样做（而不是仅靠前端转义）：
 * - 渲染前端不止一种（Web 卡片、CLI 日志行、灰度打印），任何一处忘记转义
 *   就是一处注入；在**生产侧**把危险字符消灭，所有消费侧同时安全。
 * - 只在中和有意义时才改动文本：正常包名（`@scope/pkg`）、版本号
 *   （`0.0.0-dev`）、时间戳经此函数**逐字节不变**，因此不会出现
 *   「修显示问题反而把正常输出改脏」的回归。
 *
 * 处理顺序（顺序本身有语义）：
 * 1. 先剥 C0/C1 控制字符与 DEL —— 终端里它们能改颜色/移动光标，是比
 *    Markdown 更直接的显示破坏（实测 bundle 名可携带 `\u001b[31m`）。
 * 2. 再剥 Unicode 双向控制符 —— 它们能重排显示顺序，让「看起来的名字」
 *    与真实名字不同（同形异义欺骗），属于安全而不只是显示问题。
 * 3. 把换行/制表折成空格：明细行契约是「一行一件事」，内嵌换行会让
 *    下游按行解析（缩进、表格、`lines` 计数）全部错位。
 * 4. 最后做**行内** Markdown 中和：`[`/`]` 先于 `(`/`)` 被转义 ⇒ 链接语法
 *    无法成立，因此括号**不需要**转义（转义它们会把 `(seq=1)` 这类正常
 *    输出改脏，属于过度中和）。
 *
 * **行首**结构符（`#`/`>`/`-`/`1.`）刻意不在这里处理：片段被安放的位置
 * （前面有没有 `dsh：` 前缀、缩进几个空格）只有组装行的人知道。对片段
 * 提前套用行首规则会把 `0.0.0-dev` 变成 `\0.0.0-dev` —— 实测踩到的假阳性。
 * 行首规则见 {@link escapeLineStart}，由 {@link toLines} 在**成行后**施加。
 *
 * 幂等：已转义的字符不再转义（见 {@link escapeMarkdown}），因此同一段文本
 * 经过两次中和不会变成 `\\\``。
 */
export function sanitizeText(input: unknown): Sanitized {
  const raw = typeof input === 'string' ? input : input === undefined || input === null ? '' : String(input)
  let removed = 0
  let text = ''
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0
    const isControl = cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
    const isBidi =
      (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f
    if (isControl || isBidi) {
      // 制表符/换行保留为分隔语义（折成空格），其余控制字符直接丢弃。
      removed += 1
      if (ch === '\t' || ch === '\n' || ch === '\r') text += ' '
      continue
    }
    text += ch
  }
  // 连续空白折成一个空格：明细行里出现多列空白只代表「原文本里换过行」，
  // 保留它会让人误以为有表格结构。
  text = text.replace(/\s{2,}/g, ' ')
  return escapeMarkdown(text, removed)
}

/**
 * 行首结构符中和：Markdown 只在**行首**把 `#`/`>`/`-` 当成结构。
 *
 * 为什么必须在成行后调用：同一个片段 `0.0.0-dev` 出现在行首时要防有序列表，
 * 出现在 `dsh：` 之后则完全无害 —— 提前对片段套用会制造假阳性（实测
 * `0.0.0-dev` 被写成 `\0.0.0-dev`）。
 *
 * 为什么**不**中和 `1.`：有序列表对本插件是**期望语义**（嫌疑排名就是
 * 1/2/3… 且严格递增，Markdown 重编号不会改变含义），中和它只会在纯文本
 * 前端留下一堆多余的 `\1.`。安全收益为零、可读性代价明确 ⇒ 不做。
 */
const LINE_START_ACTIVE = /^(\s*)([#>+\-*|])/

/** 行首结构符中和（幂等：已转义的行首不再叠加反斜杠）。 */
export function escapeLineStart(line: string): Sanitized {
  const lead = LINE_START_ACTIVE.exec(line)
  if (!lead || line[lead[1].length] === '\\') return { text: line, removed: 0 }
  const at = lead[1].length
  return { text: `${line.slice(0, at)}\\${line.slice(at)}`, removed: 1 }
}

/** Markdown 行内中和：只转义真正会改变渲染结构的字符。 */
function escapeMarkdown(text: string, seedRemoved = 0): Sanitized {
  let removed = seedRemoved
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    // 已转义（前一个输出字符是反斜杠）⇒ 原样通过，保证幂等。
    const alreadyEscaped = out.endsWith('\\') && !out.endsWith('\\\\')
    if (!alreadyEscaped) {
      if (ch === '`' || ch === '*' || ch === '_' || ch === '[' || ch === ']' || ch === '|' || ch === '~') {
        out += `\\${ch}`
        removed += 1
        continue
      }
      // `<` 只在像标签时才中和：`→`/`<path>` 这类正常文本不该被改脏。
      if (ch === '<' && /[a-zA-Z/!]/.test(text[i + 1] ?? '')) {
        out += '\\<'
        removed += 1
        continue
      }
    }
    out += ch
  }
  return { text: out, removed }
}

/**
 * 按显示列截断，末尾带省略标记。
 *
 * 与「静默截断」的区别：末尾的 `…` 让读者知道这里还有内容没显示，
 * 而不是把它误当成完整的值。
 */
export function clipWidth(text: string, max = MAX_LINE_WIDTH): string {
  if (displayWidth(text) <= max) return text
  const budget = Math.max(0, max - 1)
  let width = 0
  let out = ''
  // 与 displayWidth 同口径：ZWJ 之后的码点属于同一个字形，不单独计宽
  // （否则预算会在一个家庭 emoji 中间就耗尽，序列被硬断成两半）。
  let joined = false
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0
    const w = joined || codePoint === 0x200d ? 0 : codePointWidth(codePoint)
    joined = codePoint === 0x200d
    if (width + w > budget) break
    out += ch
    width += w
  }
  return `${out}…`
}

/**
 * 折行优先断点：空白、路径分隔符与中英文标点之后。
 *
 * 为什么必须包含 CJK 标点（`、`/`，`/`；`）：包名列表用 `、` 连接时
 * 整段没有任何空格，只按空白折行会**在包名中间硬断**（实测产出
 * `@third-party-sc` + `ope/plugin-…` 两行），读者无法复制也无法辨认。
 * 标点是语言层面的自然断点，浏览器亦在此处换行。
 */
const BREAK_AFTER = /[\s/·,:;|)】」》、，；）]/

/** 最后一个折行断点的**字符索引 + 1**；无断点返回 -1。 */
function lastBreakAfter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (BREAK_AFTER.test(text[i])) return i + 1
  }
  return -1
}

/**
 * 按显示列折行（CJK 感知，硬断兜底）。
 *
 * 为什么必须硬断：包名是一个不含空格的超长 token（`@scope/…-very-long-name`），
 * 只按空格折行对它完全无效 —— 那正是「长行不换行」故障的成因。
 *
 * 断点选择规则（这里踩过一次坑，规则写死）：
 * - 优先断在**最后一个可用断点**上，让 token 保持完整（否则会出现
 *   `@third-party-sc` + `ope/plugin-…` 这种无法复制辨认的裂行）。
 * - 只有当该断点太靠左（不足 `max * 0.6`）时才改为硬断：否则一个
 *   300 字符的无分隔 token 会把每行都折成两三个字，反而更难读。
 * 早先的实现把这两个分支的条件写反了（断点远时才用它），结果
 * 「有断点却硬断在 token 中间」—— 这正是本函数必须配单测的原因。
 */
export function wrapWidth(text: string, max = MAX_LINE_WIDTH): string[] {
  if (text.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  let width = 0
  let breakAt = -1
  // 与 displayWidth 同口径：ZWJ 序列只算第一次的宽度，避免预算把它拆开。
  let joined = false
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0
    const w = joined || codePoint === 0x200d ? 0 : codePointWidth(codePoint)
    joined = codePoint === 0x200d
    if (width + w > max && current.length > 0) {
      const useBreak = breakAt > 0 && displayWidth(current.slice(0, breakAt)) >= max * 0.6
      const cut = useBreak ? breakAt : current.length
      lines.push(current.slice(0, cut).trimEnd())
      // 断点后可能留下空白，裁掉它并重算剩余部分的断点（剩余文本里
      // 仍可能有我们尚未经过的断点，直接置 -1 会退化成硬断）。
      current = current.slice(cut).trimStart()
      width = displayWidth(current)
      breakAt = lastBreakAfter(current)
    }
    current += ch
    width += w
    if (BREAK_AFTER.test(ch)) breakAt = current.length
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/**
 * 把一段（可能超宽的）文本折成若干明细行，并保证每行不超过显示列预算。
 *
 * `indent` 会被计入预算 —— 缩进也算列宽，否则「加了缩进」正好把行推过阈值。
 *
 * 行首结构符中和在**这里**施加（成行后的唯一出口），因此消费者拿到的
 * `lines` 每一项都已经是「可以安全放进 Markdown 容器的一行」。
 */
export function toLines(text: string, indent = '', max = MAX_LINE_WIDTH): string[] {
  const budget = Math.max(20, max - displayWidth(indent))
  return wrapWidth(text, budget).map((line) => escapeLineStart(`${indent}${line}`).text)
}

/**
 * 折行 + **行数上限**：超长内容优先折行（不丢内容），只有折行后仍然过长
 * 才截断，并把「还有几行没显示」回报出来。
 *
 * 为什么两层而不是直接 `clipWidth`：直接按字符截断会让一段 300 字的错误
 * 信息在命令窗口只剩前 118 字 —— 那正是「截断丢失」。先折行能把绝大部分
 * 真实内容显示完整；上限只用于挡住病态输入（几十万字的错误栈），
 * 此时截断是必需的，但**必须被读者看见**（`droppedLines > 0`）。
 */
export interface BoundedLines {
  lines: string[]
  /** 因上限未显示的行数（0 = 全部显示）。 */
  droppedLines: number
}

/** 折行并按行数封顶。 */
export function toBoundedLines(text: string, indent = '', maxLines = 4): BoundedLines {
  const all = toLines(text, indent)
  if (all.length <= maxLines) return { lines: all, droppedLines: 0 }
  return { lines: all.slice(0, maxLines), droppedLines: all.length - maxLines }
}

/**
 * 有界折行的最终形态：必要时补一行**显式**的截断说明。
 *
 * 说明文案必须给出「完整内容在哪」，否则读者只能怀疑自己被喂了残缺信息
 * （「静默截断」与「已告知的截断」在用户那里是两种体验）。
 */
export function toBoundedLinesWithNote(text: string, indent: string, maxLines: number): string[] {
  const { lines, droppedLines } = toBoundedLines(text, indent, maxLines)
  if (droppedLines === 0) return lines
  return [...lines, ...toLines(`… 该条还有 ${droppedLines} 行未显示（完整内容见 data）`, indent)]
}

/**
 * 按显示列右填充。
 *
 * 为什么不用 `padEnd`：`'更新'.padEnd(14)` 在 JS 里补 12 个空格，
 * 但「更新」已占 4 列 ⇒ 实际列宽 16，后续列全部右移两格（实测错位）。
 */
export function padWidth(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

/**
 * 有界列表：展示前 `limit` 项，剩余项数**显式回报**而不是丢掉。
 *
 * 返回值里的 `omitted` 必须到达输出（`ToolOutcome.display.omitted`），
 * 否则「被省略」与「不存在」在用户眼里无法区分 —— 这正是静默截断的危害。
 */
export interface Bounded<T> {
  shown: T[]
  omitted: number
}

/** 取前 limit 项并回报省略数。 */
export function bounded<T>(items: readonly T[], limit = DEFAULT_LIST_LIMIT): Bounded<T> {
  if (limit <= 0 || items.length <= limit) return { shown: items.slice(0, Math.max(0, limit)), omitted: Math.max(0, items.length - limit) }
  return { shown: items.slice(0, limit), omitted: items.length - limit }
}

/**
 * 省略提示的统一文案（人类可读 + 给出扩大可见面的手段）。
 *
 * 「可折叠」在纯文本通道无法实现，能实现的诚实替代是：告诉用户
 * 还有多少、以及**怎么把它们取出来**（而不是假装已经看全）。
 */
export function omittedNote(omitted: number, hint: string): string {
  return `… 其余 ${omitted} 项未展开（${hint}）`
}

/**
 * 把文件系统路径转成显示形态：正斜杠 + 统一小写盘符。
 *
 * 为什么在显示层做：Windows 的反斜杠在 Markdown 里是转义符，一个长路径
 * 会把整行的其余字符样式污染；而仓库内已有 `normalizeWorkspace` 用正斜杠
 * 的先例（隔离分区键即由它算出），显示层跟随它让「文本里的路径」与
 * 「分区键对应的路径」看起来是同一个东西。
 */
export function displayPath(input: unknown): string {
  const sanitized = sanitizeText(input).text
  const slashed = sanitized.replace(/\\/g, '/')
  return slashed.replace(/^([a-zA-Z]):\//, (_m, drive: string) => `${drive.toLowerCase()}:/`)
}

/**
 * 时间戳的显示形态：`2026-11-06T04:05:06.789Z` → `2026-11-06 04:05:06`。
 *
 * 为什么保留到秒而丢掉时区与毫秒：命令窗口是给人扫视的，毫秒是噪声；
 * 但**截断到分钟会让同一分钟内的多次崩溃无法区分**，这正是排查恢复顺序时
 * 最需要的区分度。
 */
export function displayTime(input: unknown): string {
  const text = sanitizeText(input).text
  if (text.length === 0) return '?'
  return text.slice(0, 19).replace('T', ' ')
}
