import { scalarProblem, parseScalar } from './patch-scalar.ts'

/**
 * Document layer of the YAML subset: scan a patch document into structured
 * lines and validate it before anything is committed.
 *
 * ## Why validation exists at all
 *
 * Emission is valid by construction (see `patch-scalar.ts`), but the guard
 * appends to a file it does not own: it may already carry hand-written rows,
 * and the seam is where surprises live. So the append path checks the *whole*
 * resulting document first and rolls back on failure. A false positive here
 * costs a guard row; a false negative costs a boot.
 *
 * ## Why a scanner instead of a regex
 *
 * Deciding whether some `id:` is a **Loader row id** requires knowing its
 * parent key. `config.providers[].id` is also an `id`, but it is config data —
 * treating it as a row id produced a flood of false duplicates on the real
 * desktop profile (model names like `glm-5.3` were reported as duplicate rows).
 * So the scanner keeps an indentation-keyed stack and reasons about the actual
 * scope path.
 */

/** Result of {@link validatePatchText}. */
export interface PatchValidation {
  ok: boolean
  /** Human-readable reason when `ok === false`. */
  reason?: string
  /** 1-based line number the problem was found on. */
  line?: number
  /** Non-fatal findings (e.g. duplicate row ids) worth surfacing. */
  warnings: string[]
}

/** 一行 patch 的结构化视图。 */
export interface ScannedLine {
  /** 1-based 行号。 */
  line: number
  /** 缩进宽度（空格数）。 */
  indent: number
  /** 该行所在的 key 路径（不含本行的 key）。 */
  scope: string[]
  /** 本行的 key（`key: value` 或 `- key: value`）。 */
  key?: string
  /** 本行的原始值文本（未解析）。 */
  value?: string
  /** 本行是否是序列项（`- …`）。 */
  sequenceItem: boolean
  /** 非 undefined 表示该行不合法。 */
  problem?: string
}

/**
 * 把**折行的引号标量**先折叠成单行，再交给扫描器。
 *
 * ## 为什么必须做这一步（真机实测）
 *
 * 别的插件会用 YAML dumper 重写 `cordis.patch.yml`。js-yaml `dump()` 默认
 * `lineWidth: 80`，于是我们那条几百字符的 `!!js "…"` 会被折成 184–194 行：
 *
 * ```yaml
 *   disabled: !!js "(() => { try { const fs = … const
 *     profile = ctx.get('profileContext'); if (!profile || !profile.dir) return
 *     false; … })()"
 * ```
 *
 * 这在 YAML 里是**合法**的：双引号标量跨行时，换行折叠为一个空格
 * （实测 js-yaml 解析后 `disabled` 长度 712、无换行）。但逐行扫描的校验器
 * 只看第 184 行，会报 "double-quoted scalar is not terminated" —— 假阳性。
 *
 * 假阳性的代价不是"少报个错"，而是**守护行再也装不进去**：桌面 profile
 * 被重写一次，之后所有新装插件的守护行都会被校验拦下，静默失去保护。
 *
 * ## 实现约束
 *
 * 行号必须保持不变：折叠后的块只写回第一行，后续行置空。扫描器跳过空行但
 * 保留索引，因此其它错误的行号仍然准确。
 */
export function foldQuotedContinuations(text: string): string {
  const lines = text.split(/\r?\n/)
  const out = [...lines]
  // 只认「key: 引号值」与「key: !tag 引号值」两种形态。
  // 注意不能简单地用 `value[0] === '"'` 判断：真机里的形态是 `!!js "…"`，
  // 首个字符是 `!`。漏掉带标签的形态 = 这次修复完全没生效（实测教训）。
  const openable = /^[ \t]*(?:-[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*:[ \t]+(.*)$/
  const quotedShape = /^(?:![^\s]+[ \t]+)*(["'])/
  for (let i = 0; i < lines.length; i += 1) {
    const match = openable.exec(lines[i] as string)
    if (match === null) continue
    const value = (match[1] as string).trim()
    const shape = quotedShape.exec(value)
    if (shape === null) continue
    const quote = shape[1] as string
    // 引号在 value 内的偏移：从 shape 匹配位置的末尾往回推一个字符。
    const quoteOffset = (shape[0].length as number) - 1
    if (isQuoteTerminated(value.slice(quoteOffset), quote)) continue
    const parts: string[] = [value]
    let joined = value
    let closing = -1
    for (let j = i + 1; j < lines.length && j <= i + 400; j += 1) {
      const next = lines[j] as string
      if (next.trim() === '') break
      if (!/^[ \t]/.test(next)) break
      parts.push(next.trim())
      joined = parts.join(' ')
      if (isQuoteTerminated(joined.slice(quoteOffset), quote)) {
        closing = j
        break
      }
    }
    if (closing === -1) continue
    // 写回第一行（保留 key 前缀），后续行置空 —— 行号因此不变。
    const prefix = (lines[i] as string).slice(0, (lines[i] as string).indexOf(value))
    out[i] = `${prefix}${joined}`
    for (let k = i + 1; k <= closing; k += 1) out[k] = ''
    i = closing
  }
  return out.join('\n')
}

/** 该引号标量是否在同一行内收尾（含 `''` 转义与 `\"` 转义）。 */
function isQuoteTerminated(value: string, quote: string): boolean {
  let i = 1
  while (i < value.length) {
    const ch = value[i] as string
    if (quote === '"' && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        i += 2
        continue
      }
      return true
    }
    i += 1
  }
  return false
}

/** 扫描 patch 文档，产出每行的结构信息。 */
export function scanPatchLines(text: string): ScannedLine[] {
  const out: ScannedLine[] = []
  const lines = foldQuotedContinuations(text).split(/\r?\n/)
  /** key 栈：{ indent, key }，indent 是 key 所在行的缩进。 */
  const stack: Array<{ indent: number; key: string }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') continue
    if (line.trimStart().startsWith('#')) continue
    if (/^[ \t]*(---|\.\.\.|\[\])[ \t]*$/.test(line)) continue
    const indent = line.length - line.trimStart().length
    const indentText = line.slice(0, indent)
    if (indentText.includes('\t')) {
      out.push({ line: i + 1, indent, scope: [], sequenceItem: false, problem: 'YAML 缩进不允许使用制表符' })
      continue
    }
    let rest = line.trimStart()
    let sequenceItem = false
    if (rest === '-' || rest.startsWith('- ')) {
      sequenceItem = true
      rest = rest === '-' ? '' : rest.slice(2).trim()
    }
    // 本行的 key 路径：栈里所有缩进**小于**本行的 key。
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop()
    const scope = stack.map((entry) => entry.key)
    if (rest === '') {
      out.push({ line: i + 1, indent, scope, sequenceItem })
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t](.*))?$/.exec(rest)
    if (kv === null) {
      // 裸标量序列项，例如 "- codearts"。
      out.push({ line: i + 1, indent, scope, sequenceItem, value: rest, problem: scalarProblem(rest) })
      continue
    }
    const key = kv[1] as string
    const rawValue = kv[2]
    const value = rawValue === undefined ? undefined : rawValue.trim()
    const problem = value === undefined || value === '' ? undefined : scalarProblem(value)
    out.push({ line: i + 1, indent, scope, sequenceItem, key, value, problem })
    stack.push({ indent, key })
  }
  return out
}

/**
 * 这一行的 `id:` 是不是一个 **Loader 行 id**？
 *
 * 只有两种位置算：
 *  1. 文档顶层序列里（缩进 0 的 `- id:`）—— profile patch 覆盖既有行；
 *  2. `insert:` 列表的直接子项 —— 包自己声明的行。
 *
 * 其它任何深度的 `id:`（`config.providers[].id` 之类）都是**配置数据**，
 * 当成行 id 会制造假冲突。
 */
export function isLoaderRowId(line: ScannedLine): boolean {
  if (!line.sequenceItem || line.key !== 'id') return false
  if (line.indent === 0) return true
  return line.scope[line.scope.length - 1] === 'insert'
}

/**
 * Validate a whole profile patch document against the subset the loader uses.
 *
 * `ok === false` means "do not commit this text": the caller must keep the
 * previous content. A false NEGATIVE here (calling something invalid "ok") is
 * tolerable; a false POSITIVE (calling something valid "invalid") only costs us a
 * guard row, never a boot.
 */
export function validatePatchText(text: string): PatchValidation {
  const warnings: string[] = []
  const idsByRow = new Map<string, number>()
  for (const scanned of scanPatchLines(text)) {
    const { line, key, value, problem } = scanned
    if (problem !== undefined) {
      return { ok: false, reason: key === undefined ? problem : `字段 ${key} 的值不是合法 YAML：${problem}`, line, warnings }
    }
    if (value === undefined || key === undefined) continue
    if (!isLoaderRowId(scanned)) continue
    const id = parseScalar(value)
    if (id === undefined || id === '') continue
    const scoped = `${scanned.scope.join('/')}::${id}`
    const previous = idsByRow.get(scoped)
    if (previous !== undefined) {
      warnings.push(
        `重复的行 id ${JSON.stringify(id)}（第 ${previous} 行与第 ${line} 行）—— Loader 会因 duplicate loader entry id 抛错`,
      )
    } else {
      idsByRow.set(scoped, line)
    }
  }
  return { ok: true, warnings }
}

/* 标量层再导出：历史导入点是 `./patch.js`，拆分是实现细节，不该成为端口的破坏性变更。 */
export { yamlScalar, yamlDoubleQuoted, plainScalarProblem, parseScalar, scalarProblem } from './patch-scalar.ts'