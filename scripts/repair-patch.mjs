#!/usr/bin/env node
/**
 * repair-patch —— 修复被「未加引号的 scoped 包名」污染的 profile patch。
 *
 * ## 为什么需要它
 *
 * v0.6.0 的守护行写入器把包名以 plain scalar 形式写进 YAML：
 *
 *     - id: ui-task-board
 *       name: @linxin666/dsh-client-ui-task-board     ← @ 是保留指示符
 *
 * YAML 里 `@` 不允许作为 plain scalar 首字符，于是**整份文档不可解析**。
 * 真机 `~/.dsh/profiles/desktop/cordis.patch.yml` 就是这样被写坏的：
 * js-yaml 报 `bad indentation of a mapping entry (185:9)`，整个 profile
 * patch 层静默失效（守护行、禁用开关、config 覆盖全部不生效）。
 *
 * 修复动作是**最小且可逆**的：只给那些会改变 YAML 含义的 plain scalar 加引号，
 * 其余内容（注释、缩进、行序、空行）一个字节都不动。
 *
 * ## 用法
 *
 *     node --import tsx scripts/repair-patch.mjs <profile 目录或 patch 文件> [--dry-run]
 *     npm run repair-patch -- "C:\Users\me\.dsh\profiles\desktop" --dry-run
 *
 * 退出码：0 = 修好了或本来就没事；1 = 校验不过、已回滚（文件未被修改）。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { plainScalarProblem, validatePatchText, yamlScalar } from '../src/host/adapters/patch.ts'

const PATCH_FILE_NAME = 'cordis.patch.yml'

/** 解析命令行。 */
function parseArgs(argv) {
  const positional = []
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') dryRun = true
    else if (arg === '--help' || arg === '-h') positional.push('--help')
    else positional.push(arg)
  }
  return { target: positional[0], dryRun, help: positional.includes('--help') }
}

function usage() {
  console.log(`
repair-patch —— 修复 profile patch 里非法的 plain scalar（如未加引号的 @scoped 包名）

用法：
  node --import tsx scripts/repair-patch.mjs <profile 目录 | cordis.patch.yml> [--dry-run]

说明：
  备份写到 <patch>.bak-<时间戳>；--dry-run 只报告不落盘。
  修复后会用与运行时同一个校验器复核；不通过则回滚，退出码 1。
`)
}

/**
 * 找出所有「值以保留指示符开头」的 key: value 行。
 *
 * 只处理单行 `key: value` 形态；带 `!` 标签（`!!js "..."`）、流式集合
 * （`[...]`/`{...}`）、块标量（`|`/`>`）的行原样放过 —— 它们本来就是合法形态，
 * 强行加引号反而会改变语义。
 */
function findOffenders(text) {
  const lines = text.split(/\r?\n/)
  const offenders = []
  const kv = /^([ \t]*(?:-[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*:[ \t]+)(\S.*?)([ \t]*)$/
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const m = kv.exec(line)
    if (m === null) continue
    const [, prefix, value, trailing] = m
    if (value.startsWith("'") || value.startsWith('"')) continue
    if (value.startsWith('!') || value.startsWith('[') || value.startsWith('{')) continue
    if (value.startsWith('|') || value.startsWith('>') || value.startsWith('&') || value.startsWith('*')) continue
    const problem = plainScalarProblem(value)
    if (problem === undefined) continue
    offenders.push({ line: i + 1, prefix, value, trailing, problem })
  }
  return offenders
}

/** 应用修复：只替换 offender 行的值部分。 */
function applyFixes(text, offenders) {
  const lines = text.split(/\r?\n/)
  for (const o of offenders) {
    lines[o.line - 1] = `${o.prefix}${yamlScalar(o.value)}${o.trailing}`
  }
  return lines.join('\n')
}

function main() {
  const { target, dryRun, help } = parseArgs(process.argv.slice(2))
  if (help || target === undefined) {
    usage()
    process.exit(help ? 0 : 1)
  }

  const resolved = resolve(target)
  if (!existsSync(resolved)) {
    console.error(`找不到目标：${resolved}`)
    process.exit(1)
  }
  const patchPath = statSync(resolved).isDirectory() ? join(resolved, PATCH_FILE_NAME) : resolved
  if (!existsSync(patchPath)) {
    console.error(`找不到 patch 文件：${patchPath}`)
    process.exit(1)
  }

  const original = readFileSync(patchPath, 'utf8')
  console.log(`目标：${patchPath}`)

  const before = validatePatchText(original)
  const offenders = findOffenders(original)
  console.log(`现状：${before.ok ? '校验通过' : `校验失败 —— ${before.reason}（第 ${before.line} 行）`}`)
  console.log(`待修复行：${offenders.length}`)
  for (const o of offenders.slice(0, 50)) {
    console.log(`  L${o.line}: ${o.value}   →   ${yamlScalar(o.value)}`)
    console.log(`        (${o.problem})`)
  }
  if (offenders.length > 50) console.log(`  …以及另外 ${offenders.length - 50} 行`)

  if (offenders.length === 0) {
    console.log(before.ok ? '无需修复。' : '没有可自动修复的行，但仍不合法 —— 请人工检查。')
    process.exit(before.ok ? 0 : 1)
  }

  const repaired = applyFixes(original, offenders)
  const after = validatePatchText(repaired)
  console.log(`修复后校验：${after.ok ? '通过' : `失败 —— ${after.reason}（第 ${after.line} 行）`}`)
  if (after.warnings.length > 0) for (const w of after.warnings) console.log(`  警告：${w}`)
  if (!after.ok) {
    console.error('修复未能使文档合法，已放弃（文件未修改）。')
    process.exit(1)
  }

  if (dryRun) {
    console.log('--dry-run：未写入任何内容。')
    process.exit(0)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${patchPath}.bak-${stamp}`
  copyFileSync(patchPath, backup)
  console.log(`备份：${backup}`)
  writeFileSync(patchPath, repaired, 'utf8')

  // 回读复核：确认落盘内容真的合法，否则用备份还原。
  const landed = readFileSync(patchPath, 'utf8')
  const landedVerdict = validatePatchText(landed)
  if (!landedVerdict.ok) {
    copyFileSync(backup, patchPath)
    console.error(`落盘内容校验失败（${landedVerdict.reason}），已从备份还原。`)
    process.exit(1)
  }
  console.log(`完成：修复 ${offenders.length} 行，文档现已合法。`)
  console.log(`原文件目录：${dirname(patchPath)}`)
}

main()
