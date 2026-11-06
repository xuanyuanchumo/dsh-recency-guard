import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPatchRows, readPatchRowsFromText, guardedRowText, validatePatchText, ensurePatchBackup } from './patch.js'
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
  /** 写入被校验拦下时的原因（此时 patch 文件未被修改）。 */
  blocked?: string
  /** 校验器给出的非致命提示（如重复行 id）。 */
  warnings?: string[]
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
    if (chunks.length > 0) {
      const result = appendPatchText(patchPath, chunks.join('\n'))
      if (!result.ok) {
        // 写入被拦下：patch 保持原样，profile 仍可启动。守护行缺失是可接受的退化，
        // 「把 profile 写崩」不是。added 必须回退，否则调用方会记录假的成功。
        return { added: [], skipped, blocked: result.reason, warnings: result.warnings }
      }
      return { added, skipped, warnings: result.warnings }
    }
    return { added, skipped }
  } catch {
    /* 守护行安装失败不该拖垮宿主启动 */
  }
  return { added, skipped }
}

/** 一次追加的结果。 */
export interface PatchAppendResult {
  ok: boolean
  /** 失败原因（`ok === false` 时存在）。 */
  reason?: string
  /** 校验器的非致命提示。 */
  warnings?: string[]
  /** 追加前的原文（回滚基准，也用于审计）。 */
  previous: string
  /** 实际落盘的全文；失败时等于 `previous`。 */
  next: string
}

/**
 * 往 profile patch 追加文本 —— **校验后提交**。
 *
 * 这里的三段式（备份 → 校验 → 原子落盘 → 回读复核 → 失败回滚）不是防御性
 * 编程的仪式感：v0.6.0 的崩溃是**追加了一段非法 YAML**造成的，而那次崩溃
 * 表现成「DSH 根本起不来」——守护插件把要守护的 profile 写死了。
 * 因此写入路径必须自证清白，任何一步不成立就保持原样。
 *
 * 保留原文件全部内容（含注释）—— 用户的 patch 是他们的资产，不该被重写。
 */
export function appendPatchText(patchPath: string, text: string): PatchAppendResult {
  let current = ''
  try {
    current = readFileSync(patchPath, 'utf8')
  } catch {
    current = ''
  }
  // 「空数组文档」不是只有裸 `[]` 一种形态：dsh 生成的 profile patch 是
  // **注释 + `[]`**（见真机 sb-rg-journey2 的实测）。只对整体 trimEnd()
  // 做严格等值比较会漏掉这种形态，追加守护行后文件变成
  // 「注释 + [] + - id: …」——YAML 解析直接报
  // "end of the stream or a document separator is expected"，profile 起不来。
  // 因此按**行**摘除裸空数组标记：注释保留（用户资产），空标记移除后
  // 追加的行成为顶层序列，注释与序列共存是合法 YAML。
  const body = current
    .split('\n')
    .filter((line) => line.trim() !== '[]')
    .join('\n')
    .trimEnd()
  const separator = body === '' ? '' : '\n'
  const next = `${body}${separator}${text}\n`

  // 重复行 id 是 Loader 级别的硬崩溃（duplicate loader entry id），
  // 所以它必须在**写入前**被拦下，而不是靠调用方记得去重。
  // 这条检查让 appendPatchText 自身就是幂等安全的。
  const existingIds = new Set(readPatchRowsFromText(current).map((r) => r.id))
  const clash = new Set<string>()
  for (const row of readPatchRowsFromText(text)) {
    if (existingIds.has(row.id)) clash.add(row.id)
  }
  if (clash.size > 0) {
    return {
      ok: false,
      reason: `行 id 已存在，拒绝重复追加：${[...clash].join(', ')}`,
      warnings: [],
      previous: current,
      next: current,
    }
  }

  const verdict = validatePatchText(next)
  if (!verdict.ok) {
    return {
      ok: false,
      reason: `${verdict.reason ?? 'YAML 校验未通过'}${verdict.line === undefined ? '' : `（第 ${verdict.line} 行）`}`,
      warnings: verdict.warnings,
      previous: current,
      next: current,
    }
  }

  ensurePatchBackup(patchPath, current)
  try {
    writeAtomic(patchPath, next)
  } catch (error) {
    return {
      ok: false,
      reason: `写入失败：${error instanceof Error ? error.message : String(error)}`,
      warnings: verdict.warnings,
      previous: current,
      next: current,
    }
  }

  // 回读复核：确认落盘的内容确实是我们算出来的那一份（截断、编码、
  // 并发覆盖都会在这里现形），不合格就把原文写回去。
  let landed = ''
  try {
    landed = readFileSync(patchPath, 'utf8')
  } catch {
    landed = ''
  }
  if (landed !== next) {
    const repaired = validatePatchText(landed).ok
    if (!repaired) {
      try {
        writeAtomic(patchPath, current)
      } catch {
        /* 连回滚都失败：至少把原文留在内存里返回给调用方 */
      }
      return {
        ok: false,
        reason: '落盘内容与预期不一致且不可解析，已回滚',
        warnings: verdict.warnings,
        previous: current,
        next: current,
      }
    }
  }
  return { ok: true, warnings: verdict.warnings, previous: current, next }
}

/**
 * 同目录临时文件 + rename —— 崩溃在写入中途时，patch 要么是旧的、要么是
 * 新的，绝不会是「半截」。同步 IO 是硬要求（见本模块顶部注释）。
 */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.rg-tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/** 守护行是否已经装好（用于状态自检）。 */
export function hasGuardedRows(patchPath: string): boolean {
  return readPatchRows(patchPath).length > 0
}

/** profile patch 是否存在。 */
export function patchExists(patchPath: string): boolean {
  return existsSync(patchPath)
}
