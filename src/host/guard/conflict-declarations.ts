import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { declaredDependenciesSync } from '../data/store.ts'

/**
 * 声明式冲突元数据 → 确定性 finding（T14-03，借鉴 compat-guardian 的分级纪律）。
 *
 * ## 为什么这一层存在
 *
 * 在此之前，本插件判断「谁该被关」只能靠**相关性**：最近谁被装过/更新过。
 * 那是概率性证据，必须累计 `confirmRounds` 轮才敢动手 —— 因为「刚装过」并不
 * 证明「它坏了」。但插件之间还有一类**硬事实**：插件 A 自己声明了
 * 「我与 B@x 冲突」「我需要 C 这个包」「我要求 DSH ≥ 0.2.2」。这类声明是
 * 作者写下的、可逐字引用的证据，不需要等第二轮崩溃。
 *
 * ## 三条纪律（缺一条就会变成猜）
 *
 * 1. **没有声明 ⇒ 不产生 finding**。缺字段、字段形状非法、版本范围不满足
 *    「可判定」的条件，一律沉默。`无声明` 与 `声明后冲突` 是两件事；
 *    把前者当后者会把所有老插件打成嫌疑。
 * 2. **每条 finding 必须能回指原文**：`source`（文件 + 行号）与
 *    `declaration`（声明值的逐字序列化）。面板/命令窗口要回答
 *    「凭什么关它」，靠的就是这两个字段，不是一句 LLM 式的解释。
 * 3. **版本判定只在能判定时说话**。`*`、`workspace:*`、无法解析的范围
 *    ⇒ `decidable:false` ⇒ 不产生 finding。诚实边界写进实现（见
 *    `satisfiesRange` 的注释）。
 *
 * ## 与 compat-guardian 的差别（只借纪律，不借语法糖）
 *
 * compat-guardian 把 finding 直接算成 quarantine 计划；本插件的 finding 只是
 * **决策输入之一**：它进 `assessConfidence` 的 deterministic 分支，隔离集合
 * 由 `quarantine-plan.ts` 的贪心循环产出（见该模块头注）。
 */

/** finding 的四个分类（与任务判据一一对应，不额外发明分类）。 */
export type FindingKind = 'declared-conflict' | 'duplicate-service' | 'dsh-version' | 'missing-dependency'

/** 严重度：error 进隔离计划，warning 只上屏（不单独触发关闭）。 */
export type FindingSeverity = 'warning' | 'error'

/** 声明所在位置（file + 1 基行号；行号 0 = 无法定位，诚实降级）。 */
export interface DeclarationSource {
  file: string
  line: number
}

/** 一个插件的 `dshCompat` 声明（字段全部可选 —— 无声明就是无）。 */
export interface CompatDeclaration {
  /** 需要同时启用的包（名 → 版本范围）。 */
  requires?: Record<string, string>
  /** 声明与哪些包冲突（名 → 版本范围）。 */
  conflicts?: Record<string, string>
  /** 提供的服务名（两个 provider 声明同一服务 = duplicate-service）。 */
  services?: string[]
  /** 提供的工具名（仅观测面，不参与冲突判定）。 */
  tools?: string[]
  /** 隔离时的候选排序权重（小 = 先被挑中）。 */
  priority?: number
  /** 要求的 DSH 版本范围。 */
  dsh?: string
}

/** 扫描到的一个第三方插件（声明为空也算「扫到了」，用于排序 fallback 的判据）。 */
export interface DeclaredPlugin {
  name: string
  version?: string
  /** `dshCompat` 声明所在文件（package.json 或 dsh-plugin.json）。 */
  source: DeclarationSource
  /** 该插件是否声明了 `dshCompat`（false ⇒ 任何 finding 都不该因它产生）。 */
  declared: boolean
  compat: CompatDeclaration
  /** 声明里出现的 peerDependencies（判定 dsh-version 的第二个来源）。 */
  peerDependencies?: Record<string, string>
  /**
   * 该插件的依赖边（`dependencies` 键 + `dshCompat.requires` 键的并集）。
   *
   * 供 `quarantine-plan.ts` 做**依赖联动停用**：关掉 X 时必须把「依赖 X」的
   * 插件一起关，否则 X 没了、Y 在 import 处抛错 —— 用户看到的是另一种崩溃。
   * 它可能包含不在 profile 里的包名（传递依赖），遍历时按「找不到就跳过」处理。
   */
  dependencies?: string[]
  /** 该插件是否在 profile patch 里被禁用（隔离候选排序用）。 */
  enabled: boolean
}

/** 一条确定性 finding。 */
export interface ConflictFinding {
  kind: FindingKind
  severity: FindingSeverity
  /** 涉及的插件（第一个是主责；declared-conflict 的第二项是对手）。 */
  plugins: string[]
  /** 人读事实（命令窗口直接显示，不含推断词）。 */
  message: string
  /** 声明出处（文件 + 行号）—— 回答「凭什么」。 */
  source: DeclarationSource
  /** 声明的逐字值（JSON 序列化），供对账与复核。 */
  declaration: string
}

/** `dshCompat` 在 package.json 里的字段名（兼容旧写法 `compat`）。 */
const COMPAT_KEYS = ['dshCompat', 'compat'] as const

/**
 * 读 profile 里全部第三方插件的声明（同步）。
 *
 * 崩溃路径（process exit 处理器）要用它，因此必须同步；代价是每个插件一次
 * `readFileSync` —— 插件数量是几十量级、文件是几 KB，几十毫秒内完成。
 *
 * @param profileDir profile 根目录（其 `node_modules/<name>/package.json`）
 * @param options.enabled 判定「插件当前是否启用」（默认全部 true：只读声明扫描
 *   时不该假装知道启用态，调用方有真值时再传）
 */
export function readDeclaredPluginsSync(
  profileDir: string,
  options: { enabled?: (name: string) => boolean } = {},
): DeclaredPlugin[] {
  const out: DeclaredPlugin[] = []
  for (const name of declaredDependenciesSync(profileDir)) {
    const dir = join(profileDir, 'node_modules', ...name.split('/'))
    const packageFile = join(dir, 'package.json')
    let manifest: Record<string, unknown> | null = null
    let text = ''
    try {
      text = readFileSync(packageFile, 'utf8')
      manifest = JSON.parse(text) as Record<string, unknown>
    } catch {
      // 装到一半（无 package.json）不是「已声明」：跳过，不猜。
      continue
    }
    const plugin = readOnePlugin(name, manifest, text, packageFile, dir, options.enabled?.(name) ?? true)
    if (plugin !== null) out.push(plugin)
  }
  return out
}

/**
 * 解析单个插件的声明。
 *
 * `dsh-plugin.json` 与 `package.json` 都可能带声明：前者是插件市场的清单形态，
 * 后者是 npm 包的标准位置。**两者都在时以 package.json 为准**（它是安装事实
 * 的权威来源，清单文件可能来自市场缓存），并在注释里登记这条优先级。
 */
function readOnePlugin(
  name: string,
  manifest: Record<string, unknown>,
  packageText: string,
  packageFile: string,
  dir: string,
  enabled: boolean,
): DeclaredPlugin | null {
  const version = typeof manifest.version === 'string' ? manifest.version : undefined
  const peers = asStringRecord(manifest.peerDependencies)
  const dependencies = dependencyEdges(manifest)

  const compatEntry = firstCompat(manifest)
  if (compatEntry !== null) {
    const compat = normalizeCompat(compatEntry.value)
    return {
      name,
      ...(version === undefined ? {} : { version }),
      source: { file: packageFile, line: locateKeyLine(packageText, [compatEntry.key]) },
      declared: true,
      compat,
      ...(peers === undefined ? {} : { peerDependencies: peers }),
      dependencies: union([...dependencies, ...Object.keys(compat.requires ?? {})]),
      enabled,
    }
  }

  // 次级来源：`dsh-plugin.json`（市场清单）。只取其中的 dshCompat/compat，
  // 不取 requires 之外的任何商业字段 —— 本模块不消费展示元数据。
  const pluginFile = join(dir, 'dsh-plugin.json')
  if (existsSync(pluginFile)) {
    try {
      const pluginText = readFileSync(pluginFile, 'utf8')
      const pluginManifest = JSON.parse(pluginText) as Record<string, unknown>
      const entry = firstCompat(pluginManifest)
      if (entry !== null) {
        return {
          name,
          ...(version === undefined ? {} : { version }),
          source: { file: pluginFile, line: locateKeyLine(pluginText, [entry.key]) },
          declared: true,
          compat: normalizeCompat(entry.value),
          ...(peers === undefined ? {} : { peerDependencies: peers }),
          dependencies: union([...dependencies, ...Object.keys(normalizeCompat(entry.value).requires ?? {})]),
          enabled,
        }
      }
    } catch {
      /* 清单损坏：当作未声明（不猜） */
    }
  }

  return {
    name,
    ...(version === undefined ? {} : { version }),
    source: { file: packageFile, line: 0 },
    declared: false,
    compat: {},
    ...(peers === undefined ? {} : { peerDependencies: peers }),
    dependencies,
    enabled,
  }
}

/** 声明的依赖边（`dependencies` 的键；peer 不算边 —— peer 缺失是警告不是加载失败）。 */
function dependencyEdges(manifest: Record<string, unknown>): string[] {
  const deps = manifest.dependencies
  if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) return []
  return Object.keys(deps as Record<string, unknown>)
}

/** 去重且保序（同一依赖同时出现在 requires 与 dependencies 里是常见形态）。 */
function union(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 找到第一个存在的 compat 字段（`dshCompat` 优先于旧写法 `compat`）。 */
function firstCompat(manifest: Record<string, unknown>): { key: string; value: unknown } | null {
  for (const key of COMPAT_KEYS) {
    if (manifest[key] !== undefined && manifest[key] !== null && typeof manifest[key] === 'object') {
      return { key, value: manifest[key] }
    }
  }
  return null
}

/**
 * 归一化声明对象。
 *
 * 形状非法的子字段**直接丢弃**（`requires` 是字符串、`services` 里有非字符串
 * ⇒ 该子字段视为未声明）。这与「非法元数据」finding 是两种处理：
 * 本项目不新造第五个分类，非法子字段静默降级 —— 它不构成确定性证据。
 */
function normalizeCompat(raw: unknown): CompatDeclaration {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const compat: CompatDeclaration = {}
  const requires = asStringRecord(obj.requires)
  if (requires !== undefined) compat.requires = requires
  const conflicts = asStringRecord(obj.conflicts)
  if (conflicts !== undefined) compat.conflicts = conflicts
  const services = asStringArray(obj.services)
  if (services !== undefined) compat.services = services
  const tools = asStringArray(obj.tools)
  if (tools !== undefined) compat.tools = tools
  if (typeof obj.priority === 'number' && Number.isFinite(obj.priority)) compat.priority = obj.priority
  if (typeof obj.dsh === 'string') compat.dsh = obj.dsh
  return compat
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

/**
 * 在 JSON 文本里定位一个键的行号（1 基）；找不到时返回 0（= 无法定位）。
 *
 * 为什么不用真正的 JSON 位置解析器：那需要一个带位置信息的解析器（几十行
 * 状态机）。这里只需要「声明在第几行」这种**人读**事实 —— 先定位父键
 * （`dshCompat`），再从它之后找子键，得到的是「该字段第一次出现的行」。
 * 诚实边界：同一字段在文件里出现多次时它指向第一处；行号 0 表示没找到，
 * 面板显示「位置未知」而不是伪造一个行号。
 */
export function locateKeyLine(text: string, keys: readonly string[]): number {
  let from = 0
  let line = 0
  for (const key of keys) {
    const needle = `"${key}"`
    const index = text.indexOf(needle, from)
    if (index < 0) return 0
    line = text.slice(0, index).split('\n').length
    from = index + needle.length
  }
  return line
}


/* ------------------------------------------------------------------------ *
 * 版本范围判定（只在能判定时说话）
 * ------------------------------------------------------------------------ */

export interface RangeVerdict {
  /** 是否满足。 */
  ok: boolean
  /** 是否**可判定**（无法解析的范围 ⇒ false ⇒ 调用方必须沉默）。 */
  decidable: boolean
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

/** 解析 `x.y.z`（忽略 prerelease 后缀）；不可解析返回 null。 */
function parseVersion(value: string | undefined): ParsedVersion | null {
  if (value === undefined) return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

/**
 * 判定 `version` 是否满足 `range`。
 *
 * 支持的范围语法（够用且可判定）：`*` / 精确 `1.2.3` / `^` / `~` / `>=` `>`
 * `<=` `<` `=` / 空格分隔的合取 / `||` 分隔的析取。
 *
 * **不支持即不可判定**（不是「不满足」）：`workspace:*`、`npm:` 别名、
 * `1.x`、`>=1 <2`（缺 minor 的简写）等。这类范围返回
 * `{ok:false, decidable:false}`，调用方据此**不产生 finding** ——
 * 把一个判不了的范围报成冲突，代价是关掉一个无辜插件。
 *
 * prerelease 语义**未实现**：`0.2.2-rc.1` 按 `0.2.2` 比较。诚实边界：
 * 带 prerelease 的边界判定可能偏差一个补丁号，但不会把 `0.2.1-rc.5` 判成
 * 不满足 `>=0.2.1`（本项目全部宿主版本都是 rc，这是刻意的取舍）。
 */
export function satisfiesRange(version: string | undefined, range: string | undefined): RangeVerdict {
  const parsed = parseVersion(version)
  if (parsed === null || typeof range !== 'string') return { ok: false, decidable: false }
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'latest') return { ok: true, decidable: true }
  if (trimmed.startsWith('workspace:') || trimmed.startsWith('npm:') || trimmed.startsWith('file:')) {
    return { ok: false, decidable: false }
  }
  const alternatives = trimmed.split('||')
  let anyDecidable = false
  for (const alternative of alternatives) {
    const verdict = satisfiesConjunction(parsed, alternative.trim())
    if (!verdict.decidable) return { ok: false, decidable: false }
    anyDecidable = true
    if (verdict.ok) return { ok: true, decidable: true }
  }
  return { ok: false, decidable: anyDecidable }
}

/** 一个析取支（空格分隔的合取）。 */
function satisfiesConjunction(version: ParsedVersion, range: string): RangeVerdict {
  const parts = range.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { ok: true, decidable: true }
  for (const part of parts) {
    const verdict = satisfiesComparator(version, part)
    if (!verdict.decidable) return verdict
    if (!verdict.ok) return { ok: false, decidable: true }
  }
  return { ok: true, decidable: true }
}

/** 单个比较器。 */
function satisfiesComparator(version: ParsedVersion, token: string): RangeVerdict {
  if (token === '*' || token === '') return { ok: true, decidable: true }
  const operator = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)
  if (operator === null) return { ok: false, decidable: false }
  const op = operator[1] ?? ''
  const target = parseVersion(operator[2])
  if (target === null) return { ok: false, decidable: false }
  switch (op) {
    case '':
    case '=':
      return { ok: compareVersions(version, target) === 0, decidable: true }
    case '>':
      return { ok: compareVersions(version, target) > 0, decidable: true }
    case '>=':
      return { ok: compareVersions(version, target) >= 0, decidable: true }
    case '<':
      return { ok: compareVersions(version, target) < 0, decidable: true }
    case '<=':
      return { ok: compareVersions(version, target) <= 0, decidable: true }
    case '~': {
      const upper = { major: target.major, minor: target.minor + 1, patch: 0 }
      return { ok: compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0, decidable: true }
    }
    case '^': {
      // npm 语义：major>0 时抬 major；0.x 抬 minor；0.0.x 锁死补丁号。
      const upper =
        target.major > 0
          ? { major: target.major + 1, minor: 0, patch: 0 }
          : target.minor > 0
            ? { major: 0, minor: target.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: target.patch + 1 }
      return { ok: compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0, decidable: true }
    }
    default:
      return { ok: false, decidable: false }
  }
}

