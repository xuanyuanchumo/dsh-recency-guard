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
 *
 * ## 为什么不能固定写 `'../package.json'`（v0.15 功能域重构后修复）
 *
 * 那个相对路径隐含一个假设：**本文件位于包根下一层**。
 * - 产物形态 `dist/index.js` ⇒ `dist/..` = 包根 ✓
 * - 重构前的源码形态 `src/self-describe.ts` ⇒ `src/..` = 包根 ✓
 * - 重构后的源码形态 `src/core/self-describe.ts` ⇒ `src/core/..` = **src/** ✗
 *
 * 第三种形态下 `require.resolve('../package.json')` 直接抛，版本与反馈链接
 * 全部降级为 null —— 而测试是直跑源码的，于是面板诊断卡在测试里永远空白。
 * 修法不是再写死一个 `'../../package.json'`（那会让产物形态又坏掉），
 * 而是**从当前目录向上找，直到找到 name 与本包一致的 package.json**：
 * 两种形态都对，且不依赖「我在第几层」。
 */
export function readSelfPackage(): SelfPackage {
  const empty: SelfPackage = { version: null, repositoryUrl: null, issuesUrl: null }
  try {
    const require = createRequire(import.meta.url)
    const readFileSync = require('node:fs').readFileSync as (path: string, encoding: string) => string
    const parsed = findSelfManifest(readFileSync)
    if (parsed === null) return empty
    return {
      version: typeof parsed.version === 'string' ? parsed.version : null,
      repositoryUrl: gitUrlOf(parsed.repository),
      issuesUrl: gitUrlOf(parsed.bugs) ?? (typeof parsed.bugs === 'string' ? parsed.bugs : null),
    }
  } catch {
    return empty
  }
}

/** 本包的包名 —— 用来在向上查找时确认「找到的是自己，不是别人的清单」。 */
const SELF_PACKAGE_NAME = 'dsh-recency-guard'

/**
 * 从当前文件所在目录向上逐级查找**本包**的 package.json。
 *
 * 判据是 `name === SELF_PACKAGE_NAME`：只按「有 package.json」查找会在
 * 单仓（workspace）布局下命中父级仓库的清单，把别人的版本当成自己的。
 */
function findSelfManifest(
  readFileSync: (path: string, encoding: string) => string,
): { version?: unknown; repository?: { url?: unknown } | unknown; bugs?: { url?: unknown } | unknown } | null {
  let directory = import.meta.dirname
  // 上限 6 层：正常包形态最深是 `dist/` 或 `src/<domain>/`，6 层足够且能防止
  // 异常布局下无限向上（走到盘符根时 dirname 会返回自己，必须靠计数兜底）。
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = `${directory}/package.json`.replace(/\\/g, '/')
    try {
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown; repository?: unknown; bugs?: unknown }
      if (parsed.name === SELF_PACKAGE_NAME) {
        return parsed as { version?: unknown; repository?: { url?: unknown } | unknown; bugs?: { url?: unknown } | unknown }
      }
    } catch {
      /* 该层没有 package.json 或不可解析 —— 继续向上 */
    }
    const parent = `${directory}/..`
    directory = parent
  }
  return null
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
