import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPatchRows, guardedRowText } from './patch.js'
import { guardExpression } from './decision.js'
import { isOfficial, isExperimentalName } from './recency.js'
import { readDeclaredDependencies } from './observations.js'

/**
 * 守护行的安装与维护。
 *
 * ## 机制回顾
 *
 * 预启动拦截靠 profile patch 里的守护行：
 *
 *     - id: <rowId>
 *       name: <bundleName>
 *       disabled: !!js "<表达式>"
 *
 * Loader 在导入该行模块**之前**求值表达式 ⇒ 表达式为 true 时，崩溃插件的
 * 代码根本不会被加载。
 *
 * ## 为什么要单独成模块
 *
 * 这件事有三重身份：
 * 1. **安装**（同步）：必须在任何插件能崩溃之前完成 —— 异步安装会输给崩溃；
 * 2. **寻址**：行 id 必须与插件自己声明的 id 一致，否则 patch 会被**静默跳过**
 *    （Loader 对找不到的行只 warn，不报错）—— 这是最容易踩且最难发现的坑；
 * 3. **幂等**：同一行不能被重复安装（重复 id 会抛错）。
 *
 * 它与「恢复流程」无关、与「状态机」无关，抽出后可以独立测试。
 */

/** 本插件自己的包名 —— 永远不是被守护对象。 */
export const GUARD_PACKAGE_NAME = 'dsh-recency-guard'

/** 一个可被守护的插件行。 */
export interface GuardableRow {
  /** patch 里的行 id（必须与插件声明的一致）。 */
  rowId: string
  /** 插件包名（决策文件里用的是它）。 */
  bundleName: string
  /** 是否为实验性命名。 */
  experimental: boolean
}

/**
 * 找出可被守护的插件行。
 *
 * 规则：
 * - 只看 **profile 声明的依赖**（用户装的插件），不看传递依赖；
 * - 排除官方包（`@deepseek-ai/*`）—— 守护机制绝不碰 harness 自身；
 * - 排除本插件自己 —— 关掉它等于关掉恢复机制；
 * - 只取**有自己 patch 的包**（有行可寻址）。
 */
export function findGuardableRows(profileDir: string): GuardableRow[] {
  const rows: GuardableRow[] = []
  for (const bundleName of readDeclaredDependencies(profileDir)) {
    if (isOfficial(bundleName)) continue
    if (bundleName === GUARD_PACKAGE_NAME) continue
    const bundleDir = join(profileDir, 'node_modules', ...bundleName.split('/'))
    const patchFile = resolveBundlePatch(bundleDir)
    if (patchFile === undefined) continue
    for (const row of readPatchRows(patchFile)) {
      rows.push({ rowId: row.id, bundleName, experimental: isExperimentalName(bundleName) })
      // 一个包只取第一行：它是该包的**代表行**，守护它即可代表整包。
      break
    }
  }
  return rows
}

/** 解析包的 `dsh.bundle.patch` 声明。 */
function resolveBundlePatch(bundleDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))
    const patch = manifest?.dsh?.bundle?.patch
    return typeof patch === 'string' ? join(bundleDir, patch) : undefined
  } catch {
    return undefined
  }
}

/** 安装结果。 */
export interface GuardInstallResult {
  /** 新装的行。 */
  added: GuardableRow[]
  /** 已存在（幂等跳过）的行。 */
  skipped: GuardableRow[]
}

/**
 * 安装守护行（**同步**）。
 *
 * 同步是硬要求：守护行必须在任何插件能崩溃之前就位。若这里改成异步，
 * 一次「装完就崩」的循环就会让守护行永远来不及安装 —— 而那正是最需要
 * 守护的时刻。
 */
export function installGuardedRows(profileDir: string, patchPath: string): GuardInstallResult {
  const added: GuardableRow[] = []
  const skipped: GuardableRow[] = []
  try {
    const existing = new Set(readPatchRows(patchPath).map((r) => r.id))
    const chunks: string[] = []
    for (const row of findGuardableRows(profileDir)) {
      if (existing.has(row.rowId)) {
        skipped.push(row)
        continue
      }
      chunks.push(guardedRowText(row.rowId, row.bundleName, guardExpression(row.bundleName)))
      existing.add(row.rowId)
      added.push(row)
    }
    if (chunks.length > 0) appendPatchText(patchPath, chunks.join('\n'))
  } catch {
    /* 守护行安装失败不该拖垮宿主启动 */
  }
  return { added, skipped }
}

/**
 * 往 profile patch 追加文本。
 *
 * 保留原文件全部内容（含注释）—— 用户的 patch 是他们的资产，不该被重写。
 */
export function appendPatchText(patchPath: string, text: string): void {
  let current = ''
  try {
    current = readFileSync(patchPath, 'utf8')
  } catch {
    current = '[]\n'
  }
  const trimmed = current.trimEnd()
  const body = trimmed === '[]' ? '' : trimmed
  const separator = body === '' ? '' : '\n'
  writeFileSync(patchPath, `${body}${separator}${text}\n`, 'utf8')
}

/** 守护行是否已经装好（用于状态自检）。 */
export function hasGuardedRows(patchPath: string): boolean {
  return readPatchRows(patchPath).length > 0
}

/** profile patch 是否存在。 */
export function patchExists(patchPath: string): boolean {
  return existsSync(patchPath)
}
