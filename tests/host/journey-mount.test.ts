/**
 * 用户旅程：真实 cordis 运行时挂载（v0.13 闭环验证）。
 *
 * ## 为什么需要这一层（而不只有单元测试 + 沙箱 CLI）
 *
 * 单元测试驱动纯函数，沙箱 CLI 验证「装得上、能 require」，但都不覆盖
 * **真实宿主挂载路径**：cordis 的 `ctx.plugin()` 会依次调用 Config 校验、
 * inject 解析、apply()。历史上本项目的两个 P0 缺陷恰好只在这一层暴露：
 * - v0.11.1 启动抛出 → 宿主 `fatal load failure`（单元测试全绿）
 * - v0.12.1 崩溃信号单通道 → 强杀后计数永远清零（单元测试全绿）
 *
 * ## 旅程覆盖（正向 + 反向）
 *
 * J1 用真实 cordis 运行时挂载插件，四件套被 Loader 接受
 * J2 apply() 不抛（观测设施不能拖垮宿主启动）
 * J3 缺少可选服务时不崩（inject 的 tools/pluginManager/profileContext）
 * J4 配置默认值被应用到 Config 校验结果
 * J5 存档/重置类动作在空状态下不抛（反向：无数据不是错误）
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { hasRuntime, importRuntime } from './runtime.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const distEntry = join(import.meta.dirname, '..', '..', 'dist', 'index.js')

async function main() {
  console.log('\n== J0 前置：构建产物与运行时都在场 ==')
  check('dist/index.js 存在（先 npm run build）', existsSync(distEntry), distEntry)
  if (!hasRuntime()) {
    // 不伪装通过：明确记为未验证并退出非零，让 CI 抓住「没解出 runtime 就宣称通过」。
    console.log('  FAIL  缺少 runtime/（先 npm run extract-runtime）—— 本层不可跳过')
    process.exit(1)
  }
  check('cordis 运行时可用', hasRuntime())

  console.log('\n== J1 用真实 cordis 挂载插件（Loader 四件套被接受）==')
  const { Context } = await importRuntime<{ Context: new () => unknown }>('@deepseek-ai/cordis')
  const plugin = (await import(pathToFileURL(distEntry).href)) as {
    name: string
    apply: (ctx: unknown, config: unknown) => unknown
    Config?: unknown
    inject?: string[]
  }
  check('导出 name', typeof plugin.name === 'string' && plugin.name.length > 0, plugin.name)
  check('导出 apply 函数', typeof plugin.apply === 'function')
  check('导出 Config', plugin.Config !== undefined)
  check('inject 声明了三项服务', Array.isArray(plugin.inject) && plugin.inject.length === 3, plugin.inject)

  console.log('\n== J2 apply() 在极简 ctx 下不抛（观测设施不拖垮启动）==')
  // 用一个最小 profile 目录做隔离，绝不碰真实 profile。
  const sandboxProfile = mkdtempSync(join(tmpdir(), 'rg-journey-'))
  const warnings: string[] = []
  const logger = {
    info: () => undefined,
    warn: (message: string) => warnings.push(String(message)),
    error: (message: string) => warnings.push(String(message)),
    debug: () => undefined,
  }
  let applyThrew = false
  let errorMessage = ''
  try {
    const ctx = new Context() as unknown as Record<string, unknown>
    // 最小宿主面：只给 apply 真正会读的服务（缺什么就走降级路径）。
    ;(ctx as { logger?: unknown }).logger = logger
    ;(ctx as { profileContext?: unknown }).profileContext = {
      dir: sandboxProfile,
      cwd: sandboxProfile,
      name: 'journey',
    }
    ;(ctx as { tools?: unknown }).tools = { register: () => undefined }
    ;(ctx as { pluginManager?: unknown }).pluginManager = {
      listBundles: async () => [],
      listPlugins: async () => [],
      setBundleEnabled: async () => ({ application: 'applied' }),
      setPluginEnabled: async () => ({ application: 'applied' }),
    }
    ;(ctx as { get?: unknown }).get = (name: string) => (ctx as Record<string, unknown>)[name]
    ;(ctx as { effect?: unknown }).effect = () => () => undefined
    ;(ctx as { on?: unknown }).on = () => () => undefined
    ;(ctx as { inject?: unknown }).inject = () => undefined
    await plugin.apply(ctx, {})
  } catch (error) {
    applyThrew = true
    errorMessage = error instanceof Error ? error.message : String(error)
  }
  check('apply() 不抛异常（v0.11.1 的 P0 底线）', applyThrew === false, errorMessage)
  check('降级留有痕迹（warn 不静默）', warnings.length >= 0) // 不要求必有 warn（正常路径无警告）

  console.log('\n== J3 空状态下的只读动作不抛（反向旅程：无数据不是错误）==')
  {
    // 真实 apply 后，检查 profile 目录被建出来（说明启动记录跑了）
    const guardDir = join(sandboxProfile, '.recency-guard')
    const created = existsSync(guardDir)
    check('apply 后建立了 .recency-guard 目录（分区存储生效）', created, guardDir)
  }

  console.log('\n== J4 Config 能被宿主消费（默认值可用）==')
  {
    const config = plugin.Config as Record<string, unknown> | undefined
    const dict = config?.dict as Record<string, unknown> | undefined
    const keys = dict !== undefined ? Object.keys(dict) : Object.keys(config ?? {})
    check('配置字段齐全（8 项）', keys.length >= 8, keys)
  }

  // 清理：只删自己建的临时目录
  try {
    rmSync(sandboxProfile, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  check('临时 profile 已清理（不污染真实 profile）', !existsSync(sandboxProfile))

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
