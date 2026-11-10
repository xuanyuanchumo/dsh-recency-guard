#!/usr/bin/env node
/**
 * 变异测试工具（M4 / RQ4）—— 把「看起来绿」变成「可证伪地绿」。
 *
 * 为什么需要它
 * ------------
 * 本项目此前**手工**做变异自证（把缺陷写回源码 → 跑测试 → 断言恰有 N 条 FAIL）。
 * 手工变异有三个问题：
 *   1. 频率低 —— 只在有人记得的时候做，覆盖率随时间衰减；
 *   2. 不可度量 —— 没有「杀灭率」这个数字，无法判断测试体系是在变强还是变弱；
 *   3. 不可门禁 —— 没有退出码，G2 消费不了。
 * 本工具把它们变成一条可重复执行、可度量、可门禁的命令。
 *
 * 设计纪律（每条都有来历）
 * ------------------------
 * - **只变异纯函数层**：宿主/UI 接线文件（index.ts、client/**、routes*.ts）的变异
 *   要么引发大面积编译错误、要么运行极慢，都会把杀灭率污染成噪声（07 §5.4）。
 * - **安全第一**：变异体绝不能留在仓库里。所有写盘走 `restoreAll()`，
 *   由 try/finally + SIGINT/SIGTERM/uncaughtException/exit 四道闸口保证。
 * - **语法杀死单列**：变异把文件改成不可解析时，测试当然会失败，但那是
 *   「语法杀死」不是「断言杀死」—— 混在一起会让杀灭率虚高（07 §5.2 判据）。
 *
 * 用法
 * ----
 *   node scripts/mutation.mjs --dry-run                 # 只列计划，不执行
 *   node scripts/mutation.mjs --filter survival         # 限定文件（子串匹配）
 *   node scripts/mutation.mjs --max-mutants 20          # 限制规模（冒烟）
 *   node scripts/mutation.mjs --min-kill-rate 0.8       # 低于阈值非零退出（门禁）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const srcDir = join(projectRoot, 'src')
const testsDir = join(projectRoot, 'tests')
const reportPath = join(projectRoot, '.cycles', 'verify', 'mutation-report.md')

/**
 * 不参与变异的文件 —— 理由是「变异它测不出测试强度，只测出编译器脾气」。
 *
 * 这份名单是**显式**的，不是靠通配符一刀切：将来新增宿主接线文件时，
 * 如果忘了登记，它会进入变异池 —— 那种情况会立刻表现为大面积语法杀死，
 * 比悄悄漏测更容易被发现。
 */
const EXCLUDED_FILES = new Set([
  'index.ts', // 插件入口：四件套 + 大量 IO，变异几乎必然语法/导入失败
  'routes.ts', // 路由字面量：契约测试核对的是字面量文本，变异它测的是契约不是行为
  'routes-plugin.ts',
  'patch-scalar.ts', // 标量改写：与 patch-safety 强耦合，单独由源码门守护
])

/** 目录级排除（客户端层）。 */
const EXCLUDED_DIRS = [join(srcDir, 'client')]

/** 窗口平台下路径分隔符归一，供目录前缀比较。 */
function normalize(path) {
  return path.replace(/\\/g, '/')
}

/** 是否属于被排除的客户端层目录。 */
function isExcludedDir(path) {
  const normalized = normalize(path)
  return EXCLUDED_DIRS.some((dir) => normalized.startsWith(`${normalize(dir)}/`))
}

// ───────────────────────────── 参数解析 ─────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, filter: null, maxMutants: Infinity, minKillRate: null, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') args.dryRun = true
    else if (token === '--quiet') args.quiet = true
    else if (token === '--filter') args.filter = argv[++i] ?? null
    else if (token === '--max-mutants') args.maxMutants = Number(argv[++i] ?? Infinity)
    else if (token === '--min-kill-rate') args.minKillRate = Number(argv[++i] ?? NaN)
    else if (token === '--help' || token === '-h') {
      console.log(
        [
          '变异测试工具（M4）',
          '',
          '  --dry-run                 列出变异计划，不执行',
          '  --filter <substr>         只变异路径包含该子串的文件',
          '  --max-mutants <n>         最多执行 n 个变异体（冒烟/限时）',
          '  --min-kill-rate <0..1>    杀灭率低于阈值时非零退出（门禁用）',
          '  --quiet                   只输出汇总',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// ─────────────────────── 安全网：变异体绝不落盘 ───────────────────────

/**
 * 待恢复文件表。
 *
 * 键是绝对路径，值是**变异前的原始文本**。为什么不备份成 `.bak` 文件：
 * 备份文件本身会成为仓库噪音（而且中断时会残留），内存里存原文则天然
 * 没有残留问题 —— 进程死了文件系统上也没多出任何东西。
 */
const pending = new Map()

function restoreAll() {
  for (const [path, original] of pending) {
    try {
      writeFileSync(path, original, 'utf8')
    } catch {
      // 恢复失败不能静默吞掉：这是「仓库被污染」级别的故障。
      console.error(`[mutation] 严重：无法恢复 ${path}，请手工 git checkout -- 该文件`)
    }
  }
  pending.clear()
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreAll()
    console.error(`\n[mutation] 收到 ${signal}，已恢复全部变异体`)
    process.exit(130)
  })
}
process.on('uncaughtException', (error) => {
  restoreAll()
  console.error('[mutation] 未捕获异常，已恢复全部变异体：', error)
  process.exit(1)
})
process.on('exit', restoreAll)

function applyMutant(path, mutated) {
  if (!pending.has(path)) pending.set(path, readFileSync(path, 'utf8'))
  writeFileSync(path, mutated, 'utf8')
}

// ─────────────────────────── 变异子定义 ───────────────────────────

/**
 * 四个变异子，逐条对应 07 §5.2 E4.1 原文列举的四类高频缺陷。
 *
 * 每个生成器返回 `{ line, label, original, mutated }`：只改一处，
 * 这样「一条断言 FAIL」与「一个变异体」才能一一对应 —— 一次改多处时，
 * 杀死到底归功于哪条断言就说不清了。
 */

/** 工具：把绝对索引换算成 1 基行号（报告里要能点回源码）。 */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/**
 * 变异子 1：交换比较运算符方向。
 *
 * 只匹配**两侧都是简单标识符或数字**的比较，且排除尖括号泛型上下文
 * （`Array<T>`、`Map<K, V>`）—— 那些位置交换 `<` 与 `<=` 毫无意义，
 * 只会制造语法杀死，把杀灭率变成编译器噪声。
 */
function* comparisonMutants(text) {
  // 标识符**必须完整匹配**：用 `(?<![\w$])` 前界 + `(?![\w$])` 后界。
  // 早期版本只写了「前一个字符不是运算符」，于是 `length > 0` 会被从
  // 中间切开匹配成 `ength > 0` —— 生成一个看似合法、实则改了另一个
  // 标识符的变异体，杀死归因完全失真（实测踩到）。
  // 同时用 `[ \t]*` 而非 `\s*`：`\s` 跨行，会把 `i >\n return` 误认作比较。
  const pattern = /(?<![\w$.])([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)[ \t]*(<=|>=|<|>)[ \t]*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)(?![>=])/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const [whole, left, op, right] = match
    // 后界：右侧标识符必须真正结束（`length > 0` 而非 `length > 0foo`）。
    // 正则已用 `(?![>=])` 挡住 `>=`/`>>`，这里再确认右侧不是更长标识符的前缀。
    const after = text.slice(match.index + whole.length)
    if (/^[\w$]/.test(after)) continue
    // 泛型启发式：`Partial<SlotsApi>` / `Record<string, X>` 两侧都是类型名。
    // 判据是「任一侧首字母大写」—— 运行时的变量/常量在本项目里都是小写或
    // 全大写常量（`MAX`），而类型名一律 PascalCase，这个区分足够精确。
    if ((op === '<' || op === '>') && (/^[A-Z]/.test(right) || /^[A-Z]/.test(left))) continue
    // 排除 `=>` 与 `>>` 之类的残留形态（前/后断言已大部分拦住，这里兜底）。
    if (whole.includes('=>') || whole.includes('>>')) continue
    const swapped = op === '<' ? '<=' : op === '<=' ? '<' : op === '>' ? '>=' : '>'
    const mutatedWhole = whole.replace(op, swapped)
    yield {
      label: `比较方向 ${op} → ${swapped}（${left.trim()} ${swapped} ${right.trim()}）`,
      index: match.index,
      original: whole,
      mutated: mutatedWhole,
    }
  }
}

/**
 * 变异子 2：删除 try/catch 包裹，保留原 try 体。
 *
 * 为什么这是高价值变异：本项目的同步崩溃路径依赖 try 兜底（观测设施不能
 * 拖垮守护流程）。把 try 删掉后，任何一个本该被吞掉的异常都会冒到测试里 ——
 * 有断言就会杀死，没断言就存活（说明那条纪律其实没被测过）。
 */
function* tryCatchMutants(text) {
  const pattern = /\btry\s*\{/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length
    const bodyEnd = matchBrace(text, bodyStart - 1)
    if (bodyEnd < 0) continue
    // 紧随其后必须是 catch，否则这是 try/finally 而不是「吞异常」的那种写法。
    const tail = text.slice(bodyEnd + 1)
    const catchMatch = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(tail)
    if (!catchMatch) continue
    const catchBodyStart = bodyEnd + 1 + catchMatch[0].length
    const catchBodyEnd = matchBrace(text, catchBodyStart - 1)
    if (catchBodyEnd < 0) continue
    const body = text.slice(bodyStart, bodyEnd)
    const mutated = `${text.slice(0, match.index)}{\n${body}\n}${text.slice(catchBodyEnd + 1)}`
    yield {
      label: '删除 try/catch 兜底（保留 try 体）',
      index: match.index,
      original: text.slice(match.index, catchBodyEnd + 1),
      mutated: `{\n${body}\n}`,
    }
  }
}

/**
 * 计算「注释 + 字符串字面量」占据的字符区间。
 *
 * 为什么必须有这一步：本项目的文档密度极高（注释里写满了 `k < 0.9`、
 * `crashRate > 0.05` 这类阈值说明）。第一版工具不区分代码与注释，
 * 于是在**注释里**生成了 2 个变异体 —— 变异注释不改变任何行为，
 * 它们必然「存活」，把杀灭率从 100% 拉到 0%（实测：`src/survival.ts`）。
 * 这不是测试缺口，是工具缺陷 —— 等价变异体（equivalent mutant）必须
 * 在生成期剔除，否则这个指标会系统性地谎报。
 */
function inertRanges(text) {
  const ranges = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? text.length : end
      ranges.push([i, stop])
      i = stop
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      ranges.push([i, stop])
      i = stop
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') j += 2
        else if (text[j] === quote) break
        else j += 1
      }
      // 模板字符串可能跨行且含 `${}` 表达式 —— 整体视为惰性区间是保守的
      // 正确做法：宁可少生成几个变异体，也不生成改不动的变异体。
      ranges.push([i, Math.min(j + 1, text.length)])
      i = j + 1
      continue
    }
    i += 1
  }
  return ranges
}

/** 某个位置是否落在惰性区间（注释/字符串）内。 */
function isInert(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end)
}

/** 从 `{` 的位置找到配对的 `}`（跳过字符串与注释的朴素实现）。 */function matchBrace(text, openIndex) {
  if (text[openIndex] !== '{') return -1
  let depth = 0
  let quote = null
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      if (end < 0) break
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 变异子 3：翻转两阶段提交的 phase 字面量。
 *
 * `'prepared'` 与 `'quarantined'` 是本项目崩溃恢复的核心状态区分
 * （两阶段提交，崩溃后按磁盘对账）。把两者对调是最贴近真实缺陷的变异：
 * 如果测试没有钉住「未确认的 prepared 不能当 quarantined 用」，它就会存活。
 */
function* phaseMutants(text) {
  const pattern = /'prepared'|'quarantined'|"prepared"|"quarantined"/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const quote = match[0][0]
    const flipped = match[0].includes('prepared') ? 'quarantined' : 'prepared'
    yield {
      label: `phase 对调 ${match[0]} → ${quote}${flipped}${quote}`,
      index: match.index,
      original: match[0],
      mutated: `${quote}${flipped}${quote}`,
    }
  }
}

/**
 * 变异子 4：改指针文件路径。
 *
 * 指针文件（`.recency-guard/current.json`）是分区键与守护行表达式之间的桥
 * —— 表达式拿不到分区键，只能靠这个文件搭桥（CLAUDE.md 已登记为踩过的坑）。
 * 改掉路径后，读写两侧若各自硬编码、没有单一真相源，测试就会漏。
 */
function* pointerPathMutants(text) {
  const pattern = /'[^']*current\.json'|"[^"]*current\.json"/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    yield {
      label: '指针文件路径改名（current.json → current-mutated.json）',
      index: match.index,
      original: match[0],
      mutated: match[0].replace('current.json', 'current-mutated.json'),
    }
  }
}

const MUTATORS = [
  { id: 'comparison', generate: comparisonMutants },
  { id: 'try-catch', generate: tryCatchMutants },
  { id: 'phase', generate: phaseMutants },
  { id: 'pointer-path', generate: pointerPathMutants },
]

// ───────────────────────── 目标文件与测试映射 ─────────────────────────

/** 收集可变异源码文件（纯函数层）。 */
function collectSources() {
  const out = []
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    if (EXCLUDED_FILES.has(entry.name)) continue
    out.push(join(srcDir, entry.name))
  }
  // 客户端层**不进入变异池**：变异它跑的是浏览器适配代码 + 契约测试，
  // 杀死归因指向 import 关系而非行为断言，会把杀灭率变成噪声（07 §5.4）。
  return out.filter((path) => !isExcludedDir(path)).sort()
}

/** 收集全部测试文件。 */
function collectTests() {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.test.ts')) out.push(path)
    }
  }
  walk(testsDir)
  return out.sort()
}

/**
 * 把源码文件映射到「直接 import 它」的测试文件。
 *
 * 为什么只算**直接** import：间接覆盖（A → B → test）下，杀死可能归功于
 * B 的断言，这会让「A 的测试强度」这个结论失真。宁可报告「A 无直接测试」
 * —— 那本身就是有价值的缺口信号，而不是用一个漂亮数字掩盖它。
 */
function testsFor(sourcePath, testFiles) {
  const moduleName = basename(sourcePath, '.ts')
  const needle = `/${moduleName}.js`
  return testFiles.filter((test) => {
    let text
    try {
      text = readFileSync(test, 'utf8')
    } catch {
      return false
    }
    return text.includes(needle)
  })
}

/** 用 esbuild 校验语法（已经作为 devDependency 存在，不引入新依赖）。 */
let esbuildTransform = null
async function loadEsbuild() {
  if (esbuildTransform !== null) return esbuildTransform
  try {
    const esbuild = await import('esbuild')
    esbuildTransform = (code) => {
      try {
        esbuild.transformSync(code, { loader: 'ts' })
        return true
      } catch {
        return false
      }
    }
  } catch {
    // esbuild 不可用时退化为「不做语法判定」：宁可少一个标签，不假装能判定。
    esbuildTransform = () => true
  }
  return esbuildTransform
}

// ─────────────────────────────── 执行 ───────────────────────────────

/** 跑一组测试文件，返回是否全部通过。 */
function runTests(files) {
  const tsx = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  for (const file of files) {
    const result = spawnSync(process.execPath, [tsx, file], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: join(projectRoot, 'tsconfig.json') },
      timeout: 120_000,
    })
    if (result.status !== 0) return { passed: false, failedFile: file }
  }
  return { passed: true, failedFile: null }
}

async function main() {
  const sources = collectSources().filter((path) => {
    if (!args.filter) return true
    return relative(projectRoot, path).replace(/\\/g, '/').includes(args.filter)
  })
  const testFiles = collectTests()
  const checkSyntax = await loadEsbuild()

  // 1) 生成变异计划
  const plan = []
  const untested = []
  for (const source of sources) {
    const tests = testsFor(source, testFiles)
    if (tests.length === 0) {
      untested.push(relative(projectRoot, source).replace(/\\/g, '/'))
      continue
    }
    const text = readFileSync(source, 'utf8')
    const inert = inertRanges(text)
    // 每个文件每类变异子最多取 2 个，避免单个大文件垄断变异池。
    for (const mutator of MUTATORS) {
      let count = 0
      for (const mutant of mutator.generate(text)) {
        if (count >= 2) break
        // 落在注释/字符串里的变异体不改变行为 ⇒ 必然存活 ⇒ 必须剔除，
        // 否则杀灭率被等价变异体系统性拉低（实测 survival.ts 2/2 存活）。
        if (isInert(mutant.index, inert)) continue
        count += 1
        plan.push({
          source,
          tests,
          mutator: mutator.id,
          label: mutant.label,
          line: lineOf(text, mutant.index),
          original: mutant.original,
          mutated: mutant.mutated,
        })
      }
    }
  }

  const limited = plan.slice(0, args.maxMutants)

  if (args.dryRun) {
    console.log(`\n变异计划（${limited.length} 个变异体，来自 ${sources.length} 个源码文件）\n`)
    for (const item of limited) {
      const rel = relative(projectRoot, item.source).replace(/\\/g, '/')
      console.log(`  ${rel}:${item.line}  [${item.mutator}] ${item.label}`)
      console.log(`      测试 ${item.tests.length} 个：${item.tests.map((t) => relative(projectRoot, t).replace(/\\/g, '/')).join(', ')}`)
    }
    if (untested.length > 0) {
      console.log(`\n无直接测试的文件（${untested.length}，不进入变异池 —— 这本身是缺口信号）：`)
      for (const item of untested) console.log(`  ${item}`)
    }
    console.log('')
    return 0
  }

  // 2) 逐个执行
  console.log(`\n执行 ${limited.length} 个变异体（预算上限 ${args.maxMutants}）...\n`)
  const results = []
  for (const [index, item] of limited.entries()) {
    const originalText = readFileSync(item.source, 'utf8')
    // 用「首次出现位置」精确定位替换，避免全局 replace 误伤同形文本。
    const at = originalText.indexOf(item.original)
    if (at < 0) {
      results.push({ ...item, outcome: 'skipped', detail: '原文本已变化' })
      continue
    }
    const mutatedText = originalText.slice(0, at) + item.mutated + originalText.slice(at + item.original.length)
    const parseable = checkSyntax(mutatedText)

    let outcome
    let failedFile = null
    try {
      applyMutant(item.source, mutatedText)
      const run = runTests(item.tests)
      failedFile = run.failedFile
      outcome = run.passed ? 'survived' : 'killed'
    } finally {
      // 每个变异体跑完立刻恢复，不做「最后统一恢复」：
      // 中途被强杀时，残留的变异体数量从 N 降到 0~1。
      const original = pending.get(item.source)
      if (original !== undefined) {
        writeFileSync(item.source, original, 'utf8')
        pending.delete(item.source)
      }
    }

    const rel = relative(projectRoot, item.source).replace(/\\/g, '/')
    const mark = outcome === 'killed' ? (parseable ? 'KILL' : 'SYNT') : 'SURV'
    if (!args.quiet) {
      console.log(`  [${index + 1}/${limited.length}] ${mark}  ${rel}:${item.line}  ${item.label}`)
      if (failedFile && parseable) {
        console.log(`        ${outcome === 'killed' ? '杀死者' : ''}: ${relative(projectRoot, failedFile).replace(/\\/g, '/')}`)
      }
    }
    results.push({ ...item, outcome, parseable, failedFile })
  }

  restoreAll()

  // 3) 汇总
  const killed = results.filter((r) => r.outcome === 'killed')
  const syntaxKilled = killed.filter((r) => !r.parseable)
  const assertionKilled = killed.filter((r) => r.parseable)
  const survived = results.filter((r) => r.outcome === 'survived')
  const skipped = results.filter((r) => r.outcome === 'skipped')
  const total = results.length - skipped.length
  const killRate = total === 0 ? 0 : assertionKilled.length / total

  console.log('\n════════════ 变异测试汇总 ════════════')
  console.log(`  变异体总数      ${total}`)
  console.log(`  断言杀死        ${assertionKilled.length}`)
  console.log(`  语法杀死        ${syntaxKilled.length}   （不计入杀灭率 —— 那是编译器抓的，不是测试抓的）`)
  console.log(`  存活            ${survived.length}`)
  console.log(`  跳过            ${skipped.length}`)
  console.log(`  断言杀灭率      ${(killRate * 100).toFixed(1)}%  （${assertionKilled.length}/${total}）`)
  if (untested.length > 0) console.log(`  无直接测试文件  ${untested.length} 个`)

  if (survived.length > 0) {
    console.log('\n存活变异体（真实测试缺口）：')
    for (const item of survived) {
      const rel = relative(projectRoot, item.source).replace(/\\/g, '/')
      console.log(`  ${rel}:${item.line}  [${item.mutator}] ${item.label}`)
    }
  }

  // 4) 落盘报告（G2 消费）
  mkdirSync(dirname(reportPath), { recursive: true })
  const now = new Date().toISOString()
  const lines = [
    '# 变异测试报告（M4 / RQ4）',
    '',
    `**生成时间**：${now}`,
    `**命令**：\`node scripts/mutation.mjs${args.filter ? ` --filter ${args.filter}` : ''}${Number.isFinite(args.maxMutants) ? ` --max-mutants ${args.maxMutants}` : ''}\``,
    '',
    '## 1. 汇总',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 变异体总数 | ${total} |`,
    `| 断言杀死 | ${assertionKilled.length} |`,
    `| 语法杀死（不计入杀灭率） | ${syntaxKilled.length} |`,
    `| 存活 | ${survived.length} |`,
    `| **断言杀灭率** | **${(killRate * 100).toFixed(1)}%**（${assertionKilled.length}/${total}） |`,
    `| 无直接测试的源码文件 | ${untested.length} |`,
    '',
    '> 判定口径：只有「变异体可解析、且被断言抓住」才计入杀灭率。',
    '> 语法杀死说明变异把文件改坏了，测试失败不构成测试强度的证据（07 §5.2）。',
    '',
    '## 2. 断言杀死明细',
    '',
    '| 文件:行 | 变异子 | 变异 | 杀死者 |',
    '|---|---|---|---|',
    ...assertionKilled.map((r) => {
      const rel = relative(projectRoot, r.source).replace(/\\/g, '/')
      const killer = r.failedFile ? relative(projectRoot, r.failedFile).replace(/\\/g, '/') : '—'
      return `| \`${rel}:${r.line}\` | ${r.mutator} | ${r.label} | \`${killer}\` |`
    }),
    '',
    '## 3. 存活变异体（测试缺口）',
    '',
    survived.length === 0 ? '无 —— 本轮所有可解析变异体都被断言抓住。' : '',
    ...survived.map((r) => {
      const rel = relative(projectRoot, r.source).replace(/\\/g, '/')
      return `- \`${rel}:${r.line}\` [${r.mutator}] ${r.label}`
    }),
    '',
    '## 4. 语法杀死明细',
    '',
    '> 这些变异体把源码改成了不可解析形态。它们不计入杀灭率，但值得记录 ——',
    '> 若某类变异子的语法杀死率长期偏高，说明该变异子的文本变换需要收窄。',
    '',
    syntaxKilled.length === 0 ? '无。' : '',
    ...syntaxKilled.map((r) => {
      const rel = relative(projectRoot, r.source).replace(/\\/g, '/')
      return `- \`${rel}:${r.line}\` [${r.mutator}] ${r.label}`
    }),
    '',
    '## 5. 无直接测试的源码文件',
    '',
    untested.length === 0 ? '无。' : '',
    ...untested.map((path) => `- \`${path}\``),
    '',
  ]
  writeFileSync(reportPath, `${lines.filter((l) => l !== '').join('\n')}\n`, 'utf8')
  console.log(`\n报告已写入 ${relative(projectRoot, reportPath).replace(/\\/g, '/')}`)

  // 5) 门禁退出码
  if (args.minKillRate !== null && Number.isFinite(args.minKillRate)) {
    if (killRate < args.minKillRate) {
      console.error(
        `\n[mutation] GATE FAILED: 断言杀灭率 ${(killRate * 100).toFixed(1)}% < 阈值 ${(args.minKillRate * 100).toFixed(1)}%`,
      )
      return 1
    }
    console.log(`\n[mutation] GATE PASSED: 断言杀灭率 ${(killRate * 100).toFixed(1)}% ≥ 阈值 ${(args.minKillRate * 100).toFixed(1)}%`)
  }
  return 0
}

main()
  .then((code) => {
    restoreAll()
    process.exit(code)
  })
  .catch((error) => {
    restoreAll()
    console.error('[mutation] 执行失败，已恢复全部变异体：', error)
    process.exit(1)
  })
