import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 产物新鲜度 —— **「我跑的到底是哪份代码」的白盒事实**。
 *
 * ## 问题根因
 *
 * 本插件的安装形态是 `link:`（开发）/ `file:`（沙箱）/ npm 包（发布），
 * 三种形态都可能出现 **「src 改了、dist 没重建」** 的状态：
 *
 * - 开发态改了 `src/**` 但忘了 `npm run build` ⇒ 宿主跑的是**上一版产物**；
 * - `link:` 挂载时改源码即刻可见，但 `dist/` 是构建期产物，不会自动更新；
 * - 发布态 tarball 里根本没有 `src/`，只有 `dist/`。
 *
 * 这种状态的危险之处在于**它不报错**：插件照常加载、工具照常注册、
 * 面板照常出数 —— 只有行为是旧的。用户会以为「改了没生效」，
 * 开发者会以为「代码有问题」，而真相是**产物是旧的**。
 *
 * ## 判据（可复核，不是猜）
 *
 * 1. **构建指纹**：`dist/index.js` + `dist/client.js` 的 sha256 组合成 16 hex。
 *    两个产物缺一 ⇒ 指纹为 `null`（**不伪造指纹** —— 报一个假指纹比不报更坏）。
 * 2. **新鲜度**：最新 `src/**` 的 mtime > 产物的构建时刻 ⇒ `stale = true`。
 *    比较用**严格大于**：同一毫秒内完成的改动不算 stale（避免毫秒级抖动误报）。
 * 3. **来源版本**：读自身 `package.json` 的 `version` —— 与产物里的版本对不上时，
 *    说明产物是**另一个版本**构建的（比 stale 更严重：跨版本混跑）。
 *
 * ## 诚实边界
 *
 * - 发布态（tarball 无 `src/`）⇒ `stale` 恒为 false，**不是**「检查失败」：
 *   没有源可比，就是无法判定 stale，这个「无法判定」必须与「判定为不 stale」区分开。
 * - 读不到文件 ⇒ 对应字段为 `null`，并在 `reason` 里说明。
 */

/** 产物新鲜度的判定结果。 */
export interface BuildFreshness {
  /**
   * 产物是否比源码旧。
   *
   * `true` = 确认 stale（源码更新）；`false` = 确认不 stale；
   * `null` = **无法判定**（无 src/ 可比，或产物缺失）。
   */
  stale: boolean | null
  /** 构建指纹（16 hex）。产物缺失时为 null（不伪造）。 */
  revision: string | null
  /** 产物构建时刻（ISO）。取两个产物里**较早**的那个（保守）。 */
  builtAt: string | null
  /** 最新源码修改时刻（ISO）。无 src/ 时为 null。 */
  newestSourceAt: string | null
  /** 源码与产物的差值（毫秒）。无法判定时为 null。 */
  driftMs: number | null
  /** 产物里记录的插件版本（从 dist 的版本常量读取）。 */
  builtVersion: string | null
  /** 无法判定时的原因（可读）。 */
  reason: string | null
}

/** 参与新鲜度比对的源码目录（相对插件根）。 */
const SOURCE_DIRS = ['src'] as const

/** 参与指纹的产物文件（相对插件根）。 */
const ARTIFACTS = ['dist/index.js', 'dist/client.js'] as const

/** 忽略的目录/文件（构建产物自身、依赖、临时目录）。 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'runtime',
  '.git',
  '.tmp',
  '.cycles',
  '.dsh',
  '.codegraph-visualizer',
])

/** 递归收集源码文件（返回 mtime 最新的那个）。 */
function newestSourceMtime(root: string): { file: string; mtimeMs: number } | null {
  let newest: { file: string; mtimeMs: number } | null = null
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_SEGMENTS.has(entry)) continue
      const full = join(dir, entry)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!stat.isFile()) continue
      if (!/\.(ts|tsx|css|json)$/.test(entry)) continue
      if (newest === null || stat.mtimeMs > newest.mtimeMs) {
        newest = { file: full, mtimeMs: stat.mtimeMs }
      }
    }
  }
  for (const dir of SOURCE_DIRS) {
    walk(join(root, dir))
  }
  return newest
}

/** 读文件的 sha256（读不到返回 null）。 */
function sha256Of(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 从**包清单**读版本号。
 *
 * 为什么不从 `dist/` 里正则捞版本：产物里到处是形如 `0.9.0` 的字符串
 * （依赖版本、协议版本、测试夹具里的假版本），正则会捞到**第一个**匹配的
 * —— 实测捞到 `0.9.0`，而插件真实版本是 `0.18.1`。那是**假事实**，
 * 比没有事实更坏（用户会以为装了旧版）。
 *
 * 真相源是 `package.json` 的 `version`（发布流程保证它与产物同版本，
 * 见 docs/agents/conventions.md §6「版本同步纪律」）。
 */
function versionFromManifest(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * 找到插件根目录。
 *
 * 为什么要「向上找」而不是写死 `'..'`：`require.resolve('../package.json')`
 * 隐含「本文件在包根下一层」—— 源码形态 `src/core/x.ts` 与产物形态
 * `dist/index.js` 的层级不同，写死任一个都会让另一边静默降级。
 * 判据：向上找到的 `package.json` 的 `name` 与本包一致。
 */
export function findPluginRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json')
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
      if (parsed.name === 'dsh-recency-guard') return dir
    } catch {
      /* 不是包根或读不到：继续向上 */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 计算产物新鲜度。
 *
 * @param pluginRoot 插件根目录（默认从本文件位置向上找）。
 */
export function computeBuildFreshness(pluginRoot?: string): BuildFreshness {
  const root = pluginRoot ?? findPluginRoot(process.cwd())
  if (root === null) {
    return {
      stale: null,
      revision: null,
      builtAt: null,
      newestSourceAt: null,
      driftMs: null,
      builtVersion: null,
      reason: '未找到插件根目录（package.json 的 name 与本包不匹配）',
    }
  }

  // 指纹：两个产物的 sha256 组合。缺任一 ⇒ 不伪造指纹。
  const hashes: string[] = []
  const builtVersion = versionFromManifest(root)
  let oldestArtifactMs = Number.POSITIVE_INFINITY
  let missingArtifact = false
  for (const relative of ARTIFACTS) {
    const full = join(root, relative)
    const hash = sha256Of(full)
    if (hash === null) {
      missingArtifact = true
      continue
    }
    hashes.push(`${relative}:${hash}`)
    try {
      const stat = statSync(full)
      // 取**较早**的构建时刻（保守：任一产物旧就算旧）。
      if (stat.mtimeMs < oldestArtifactMs) oldestArtifactMs = stat.mtimeMs
    } catch {
      /* 已由 sha256Of 判定存在，这里读 mtime 失败极罕见 */
    }
  }

  const revision =
    hashes.length === ARTIFACTS.length
      ? createHash('sha256').update(hashes.join('|')).digest('hex').slice(0, 16)
      : null

  const source = newestSourceMtime(root)
  if (source === null) {
    // 无可比对的源码 ⇒ **无法判定**，不是「判定为不旧」。
    //
    // 为什么这么严：发布形态（tarball 只有 dist/）走这条路。若这里报
    // `stale: false`，面板会显示「产物与源码一致」—— 而真相是「没有源码
    // 可比」。那是把「无法判定」显示成「正常」的假绿（CLAUDE.md 里的
    // 「指标不可判定时为 null」同一条纪律）。
    return {
      stale: null,
      revision,
      builtAt: Number.isFinite(oldestArtifactMs) ? new Date(oldestArtifactMs).toISOString() : null,
      newestSourceAt: null,
      driftMs: null,
      builtVersion,
      reason: '无可比对的源码（发布形态只有 dist/）—— 无法判定是否过期',
    }
  }

  if (missingArtifact || !Number.isFinite(oldestArtifactMs)) {
    return {
      stale: null,
      revision,
      builtAt: null,
      newestSourceAt: new Date(source.mtimeMs).toISOString(),
      driftMs: null,
      builtVersion,
      reason: '产物缺失（dist/index.js 或 dist/client.js 读不到）—— 无法判定是否过期',
    }
  }

  const driftMs = source.mtimeMs - oldestArtifactMs
  return {
    // 严格大于：同毫秒的改动不算 stale。
    stale: driftMs > 0,
    revision,
    builtAt: new Date(oldestArtifactMs).toISOString(),
    newestSourceAt: new Date(source.mtimeMs).toISOString(),
    driftMs,
    builtVersion,
    reason: null,
  }
}

/**
 * 新鲜度的**一句话**结论（给面板与工具输出用）。
 *
 * 为什么要文字版：数值（driftMs）需要用户自己解读，而面板卡片位有限。
 * 三个状态严格区分：
 * - 过期 ⇒ 明确告诉用户「重建产物」，并给出漂移时长；
 * - 正常 ⇒ 一句话确认；
 * - 无法判定 ⇒ 说明**为什么**无法判定（不是笼统的「未知」）。
 */
export function freshnessVerdict(freshness: BuildFreshness): {
  level: 'stale' | 'ok' | 'unknown'
  text: string
} {
  if (freshness.stale === true) {
    const minutes = freshness.driftMs === null ? null : Math.round(freshness.driftMs / 60000)
    const drift = minutes === null ? '' : `（源码比产物新 ${minutes} 分钟）`
    return { level: 'stale', text: `产物已过期${drift}，请重新构建（npm run build）` }
  }
  if (freshness.stale === false) {
    return { level: 'ok', text: '产物与源码一致' }
  }
  return { level: 'unknown', text: freshness.reason ?? '无法判定产物新鲜度' }
}
