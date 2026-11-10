/**
 * 「安装不崩」契约 —— 可选 peer 不得用静态 import（v0.13 P0）。
 *
 * ## 这是真机缺陷，不是假想
 *
 * 沙箱实测（`sb-rg-c11`，只装插件本身、宿主未暴露可选 peer）：
 *
 * ```
 * Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
 *   imported from .../dist/index.js
 * Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools'
 *   imported from .../dist/index.js
 * ```
 *
 * 后果不是「功能降级」，而是**整个插件加载失败**。对守护插件尤其致命：
 * 它恰恰要在"宿主环境不完整"时还能加载，否则连"我降级了"都报告不出来。
 *
 * ## 这条门测什么
 *
 * 1. **结构门**：`package.json` 里标了 `optional: true` 的 peer，绝不能在
 *    产物里被静态 import（产物是可解析事实，源码写法会变、产物不会骗人）。
 * 2. **行为门**：在「可选 peer 全部不可解析」的模块上下文里加载产物，
 *    必须成功且四件套齐全。
 * 3. **降级诚实**：Config 降级为纯对象时仍是可枚举的（字段齐全），
 *    不是空对象 —— 否则宿主设置页会显示空表单而无从解释。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')
const pkgPath = join(projectRoot, 'package.json')
const distPath = join(projectRoot, 'dist', 'index.js')

/** 顶层静态 import 的包名（排除 node: 内置模块）。 */
function staticImportsOf(source: string): string[] {
  const out = new Set<string>()
  const re = /^import\s[^;]*?from\s+["']([^"']+)["']/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const spec = match[1] as string
    if (!spec.startsWith('node:')) out.add(spec)
  }
  return [...out]
}

async function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
    dependencies?: Record<string, string>
  }
  const source = readFileSync(distPath, 'utf8')

  console.log('\n== 结构门：optional peer 不得静态 import ==')
  {
    const optionalPeers = Object.keys(pkg.peerDependencies ?? {}).filter(
      (name) => pkg.peerDependenciesMeta?.[name]?.optional === true,
    )
    check('确实声明了 optional peer（防止本条空转）', optionalPeers.length > 0, optionalPeers)
    const staticImports = staticImportsOf(source)
    const violations = optionalPeers.filter((name) => staticImports.includes(name))
    check('没有 optional peer 被静态 import', violations.length === 0, { optionalPeers, violations, staticImports })
  }

  console.log('\n== 结构门：真实 dependency 允许静态 import ==')
  {
    const deps = Object.keys(pkg.dependencies ?? {})
    const staticImports = staticImportsOf(source)
    const used = deps.filter((name) => staticImports.includes(name))
    // atomic-write 是真实依赖（会随 npm install 装上），静态 import 是安全的。
    check('静态 import 的外部包都在 dependencies 里', staticImports.every((name) => deps.includes(name)), {
      staticImports,
      deps,
      used,
    })
  }

  console.log('\n== 行为门：极简 profile 里能加载 ==')
  {
    // 用沙箱 profile 的解析上下文（它**没有** schemastery / dsh-tools）。
    const sandboxPkg = join('C:', 'Users', '86156', '.dsh', 'profiles', 'sb-rg-c11', 'package.json')
    let resolvedPath: string | null = null
    try {
      const req = createRequire(sandboxPkg)
      resolvedPath = req.resolve('dsh-recency-guard')
    } catch {
      resolvedPath = null
    }
    if (resolvedPath === null) {
      // 沙箱不存在时不伪装通过：明确记账为「未验证」，并断言本地产物本身可加载。
      console.log('  NOTE  沙箱 sb-rg-c11 不可用，退化为本地产物加载断言（不当作通过沙箱门）')
      const mod = (await import(pathToFileURL(distPath).href)) as Record<string, unknown>
      check('本地产物四件套齐全', typeof mod.name === 'string' && typeof mod.apply === 'function' && mod.Config !== undefined)
    } else {
      const mod = (await import(pathToFileURL(resolvedPath).href)) as Record<string, unknown>
      check('沙箱产物可加载（缺可选 peer 也不崩）', typeof mod.apply === 'function')
      check('name 正确', mod.name === 'dsh-recency-guard', mod.name)
      check('inject 是数组', Array.isArray(mod.inject), mod.inject)
      check('Config 存在', mod.Config !== undefined && mod.Config !== null)
    }
  }

  console.log('\n== 降级诚实：Config 两种形态都要覆盖全部字段 ==')
  {
    const mod = (await import(pathToFileURL(distPath).href)) as { Config?: Record<string, unknown> }
    const config = mod.Config as Record<string, unknown> | undefined
    // schemastery 的 schema 是**可调用的构造器**（typeof === 'function'），
    // 纯对象降级才是 typeof === 'object'。两种都必须被接受。
    check('Config 存在且可被宿主消费（对象或可调用构造器）', config !== undefined && config !== null && (typeof config === 'object' || typeof config === 'function'), typeof config)
    // 两种形态（都是合法事实，检测它属于哪一种而不是假设一种）：
    // - schemastery 对象：字段在 `dict` 下，另有 type/meta（宿主能渲染表单）
    // - 纯对象降级：字段直接在顶层，每个是 {type, default, description}
    const dict = config?.dict as Record<string, unknown> | undefined
    const isSchemastery = dict !== undefined && typeof dict === 'object'
    const keys = isSchemastery ? Object.keys(dict) : Object.keys(config ?? {})
    console.log(`  NOTE  Config 形态：${isSchemastery ? 'schemastery（字段在 dict）' : '纯对象降级（字段在顶层）'}`)
    const expected = ['enabled', 'includeExperimental', 'maxAutoDisable', 'autoRestore', 'confirmRounds', 'versionedBackups', 'backupRetain', 'backupRoot']
    check('覆盖全部 8 个配置字段（两种形态都要）', expected.every((f) => keys.includes(f)), keys)
    if (!isSchemastery) {
      // 降级形态必须自带默认值，否则宿主拿不到可用配置。
      const sample = config?.enabled as { default?: unknown } | undefined
      check('降级形态字段带 defaultValue', sample?.default === true, sample)
    }
  }

  console.log('\n== 导出纪律：Loader 四件套之外不导出 ==')
  {
    const mod = (await import(pathToFileURL(distPath).href)) as Record<string, unknown>
    // 允许的导出面（与 tests/contract/capability.test.ts 同一纪律）。
    const allowed = new Set(['name', 'inject', 'Config', 'apply', 'default'])
    const extra = Object.keys(mod).filter((key) => !allowed.has(key))
    check('没有额外导出', extra.length === 0, extra)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

void main()
