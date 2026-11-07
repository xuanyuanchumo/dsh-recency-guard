/**
 * 插件的**自描述与版本事实**（v0.10 cycle-5 从 index.ts 拆出）。
 *
 * 为什么独立成模块
 * ----------------
 * 1. **复杂度预算**：index.ts 承载着 apply() 与 Guard 类（崩溃恢复主线），
 *    版本/自描述是旁路事实 —— band-detector 按文件计分，旁路逻辑留在主线
 *    文件里会把主线顶过预算（实测 123 分 vs 预算 100）。
 * 2. **内聚**：这一族函数共享同一个关注点 ——「这个插件/宿主是什么版本、
 *    在哪里反馈」，它们都不碰守护状态、不碰 journal，与主线零耦合。
 * 3. **fail-soft 语义集中**：本族每个函数都遵循「读不到就 null/'unknown'，
 *    绝不让诊断信息拖垮守护」—— 把纪律写在一处，消费方（index/工具面）
 *    只管使用。
 */
import { createRequire } from 'node:module'

/** JSON 安全降级（快照/工具输出的兜底）。 */
export function safeJson(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

/**
 * Load an optional module by name.
 *
 * The runtime version is a detail, not a hard dependency, so this never
 * throws: a missing optional peer simply yields no version.
 */
export function optionalRequire(specifier: string): unknown {
  try {
    return createRequire(import.meta.url)(specifier)
  } catch {
    return undefined
  }
}

/** 宿主运行时版本（工具 status 的 `dsh` 行）。缺席 ⇒ 'unknown'（不是空串：显示层要区分「没有」与「空」）。 */
export function safeVersion(): string {
  try {
    // Resolved lazily: the module is only loaded when the version is asked
    // for, so an absent optional peer cannot break the plugin's startup.
    const mod = optionalRequire('@deepseek-ai/dsh-app-boot') as {
      getDshRuntimeVersion?: () => string
    }
    return typeof mod?.getDshRuntimeVersion === 'function' ? mod.getDshRuntimeVersion() : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 自描述包的投影（版本 + 反馈链接；全部可为 null = 诚实降级）。 */
export interface SelfPackage {
  version: string | null
  repositoryUrl: string | null
  issuesUrl: string | null
}

/**
 * 读插件自身的 package.json（诊断卡 v0.10 R12/R18）。
 *
 * 为什么不用 optionalRequire('.../package.json')：包名自引用在 pnpm 的
 * 符号链接布局下可能解析到 workspace 根的 package.json —— 用
 * `require.resolve` 拿到的是安装位置，而版本事实应该来自**自己**的清单。
 * dist/index.js 与 package.json 同目录树（files 里都带 dist/），一层
 * `..` 即到包根。读不到时返回空对象（版本/链接都 null，面板诚实降级）。
 */
export function readSelfPackage(): SelfPackage {
  const empty: SelfPackage = { version: null, repositoryUrl: null, issuesUrl: null }
  try {
    const require = createRequire(import.meta.url)
    // dist/index.js → dist → 包根；src/index.ts（测试直跑）→ src → 包根。
    const self = require.resolve('../package.json')
    const parsed = JSON.parse(require('node:fs').readFileSync(self, 'utf8')) as {
      version?: unknown
      repository?: { url?: unknown } | unknown
      bugs?: { url?: unknown } | unknown
    }
    return {
      version: typeof parsed.version === 'string' ? parsed.version : null,
      repositoryUrl: gitUrlOf(parsed.repository),
      issuesUrl: gitUrlOf(parsed.bugs) ?? (typeof parsed.bugs === 'string' ? parsed.bugs : null),
    }
  } catch {
    return empty
  }
}

/** 从 package.json 的 repository/bugs 字段提取 https 链接（git+ssh 形态归一为 https）。 */
function gitUrlOf(field: unknown): string | null {
  const raw =
    typeof field === 'string'
      ? field
      : typeof field === 'object' && field !== null && typeof (field as { url?: unknown }).url === 'string'
        ? (field as { url: string }).url
        : null
  if (raw === null || raw === '') return null
  // git+ssh（git@github.com:o/r.git）与 git+https 都归一到浏览器可开的 https。
  const https = raw.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
  return https.startsWith('https://') ? https : null
}

/** 读宿主运行时版本（v0.10 诊断卡）。宿主不提供该服务 ⇒ null，不猜。 */
export function readHostVersion(): string | null {
  try {
    const mod = optionalRequire('@deepseek-ai/dsh-app-boot') as { getDshRuntimeVersion?: () => unknown } | undefined
    const version = mod?.getDshRuntimeVersion?.()
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}
