#!/usr/bin/env node
/**
 * recency-guard rescue —— 宿主崩溃后的离线逃生通道（v0.9.0）。
 *
 * ## 为什么需要它
 *
 * 宿主起不来时，插件内的工具、路由、面板全部不可达 —— 而那正是最需要
 * 看到「上次崩溃是谁、守护做了什么」的时刻（cookie-guard 的
 * prune-cookies.mjs 实证了「插件只防不治，治靠宿主外脚本」的分工）。
 *
 * 本脚本**零依赖**（只用 node 内置模块），不启动宿主，直接读 profile
 * 目录下的守护产物：
 *
 *     node bin/rescue.mjs status  --profile-dir <profile目录> [--project <key|label>]
 *     node bin/rescue.mjs history --profile-dir <profile目录> [--limit 40]
 *     node bin/rescue.mjs decision --profile-dir <profile目录>
 *     node bin/rescue.mjs archives --profile-dir <profile目录>
 *
 * 只读：本脚本的**默认行为绝不写任何文件** —— 逃生通道的第一纪律是
 * 「别把现场弄乱」。写操作只在显式 `apply` / `restore` **且带 `--yes`** 时发生，
 * 并且是两阶段（见下），随时可以按原位置精确回插。
 *
 * ## 可写模式（T14-07）：为什么逃生通道需要写
 *
 * 宿主崩到起不来时，面板/工具/路由全部不可达 —— 而「把决策里那个插件从
 * profile 的 bundle 列表里摘掉」正是让宿主重新起来的手段。只读逃生通道
 * 在这种情况下只能告诉你「它坏了」，不能救。
 *
 * ## 两阶段 + 中断恢复（借鉴 compat-guardian，但按本插件的产物形态重写）
 *
 * 1. 写 **prepared 记录**（含 beforeHash / afterHash / 每个 bundle 的原 index）；
 * 2. 原子改 profile（临时文件 + rename）；
 * 3. 记录标 `applied`。
 *
 * 两步之间断电/被杀 ⇒ 下次 `restore --resume` 读到 `prepared` 记录，且
 * 当前 package.json 的哈希**等于 afterHash** ⇒ 说明第 2 步其实已完成，
 * 于是按中断后已生效处理、直接回插。若哈希仍等于 beforeHash ⇒ 第 2 步没发生，
 * 记录作废（不动 profile）。两条都以**哈希**判定，不靠人回忆。
 *
 * 回插按**原 index 升序**执行：一次只改一个位置，index 才不会互相挤位。
 *
 * 退出码：0 = 正常；1 = 参数错误；2 = 发现未恢复的崩溃状态（供脚本联动）；
 * 3 = 拒绝（现场已变 / 记录不可信）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const GUARD_DIR = '.recency-guard'

function fail(message, code = 1) {
  console.error(`rescue: ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--profile-dir') args.profileDir = argv[++i]
    else if (a === '--project') args.project = argv[++i]
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--bundle') args.bundle = argv[++i]
    else if (a === '--reason') args.reason = argv[++i]
    else if (a === '--id') args.id = argv[++i]
    else if (a === '--resume') args.resume = true
    else if (a === '--yes') args.yes = true
    else if (a === '--help' || a === '-h') args.help = true
    else args._.push(a)
  }
  return args
}

function usage() {
  console.log(`
recency-guard rescue —— 宿主崩溃后的离线守护产物查询与逃生操作

用法：
  node bin/rescue.mjs <command> --profile-dir <profile目录> [选项]

只读命令（默认，绝不写盘）：
  status    崩溃状态、守护决策、自动关闭名单
  history   journal 事件时间线（--limit N，默认 40）
  decision  预启动决策文件全文（守护行正在执行什么）
  archives  归档清单（带 manifest 摘要）
  rescues   两阶段 rescue 记录清单

可写命令（必须显式 --yes；不带只打印计划 = dry-run）：
  apply     把决策里的 disable 名单（或 --bundle）从 profile bundles 摘掉
  restore   按记录里的原 index 精确回插（支持中断后恢复）

选项：
  --profile-dir <dir>   profile 根目录（含 .recency-guard/）
  --project <key|label> 多项目 profile 时指定分区（默认取最近活跃的）
  --limit <n>           history 条数
  --bundle a,b          apply 的目标（默认取分区 decision.json 的 disable）
  --reason <text>       写入 rescue 记录的原因（可审计）
  --id <uuid>           restore 指定记录（默认取最新可回插的一条）
  --resume              restore 中断恢复（等价于默认的「最新可回插」）
  --yes                 真正落盘（缺省 = dry-run）
  -h, --help            显示本帮助

两阶段承诺：apply 先写 prepared 记录（含 beforeHash/afterHash/原 index），
再原子改 package.json，最后标 applied。任何一步被中断，restore --resume
按哈希判定「第二步是否已生效」，再按原 index 升序回插。

退出码：0 正常；1 参数错误；2 发现未恢复的崩溃状态；3 拒绝（现场已变）。
`)
}

/** 读分区目录：显式指定优先，否则取 lastSeenAt 最新的分区。 */
function pickPartition(guardDir, project) {
  const indexPath = join(guardDir, 'partitions.json')
  let partitions = []
  try {
    partitions = JSON.parse(readFileSync(indexPath, 'utf8')).partitions ?? []
  } catch {
    /* 没有索引：单分区形态，直接找 projects 下的唯一目录 */
  }
  let key
  if (project) {
    const hit = partitions.find((p) => p.key === project || p.label === project)
    if (hit === undefined) fail(`找不到分区 ${JSON.stringify(project)}（可用：${partitions.map((p) => p.label).join(', ') || '无索引'}）`)
    key = hit.key
  } else if (partitions.length > 0) {
    const sorted = [...partitions].sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    key = sorted[0].key
  } else {
    const projectsDir = join(guardDir, 'projects')
    if (!existsSync(projectsDir)) fail(`没有分区索引也没有 projects 目录：${projectsDir}`)
    key = readdirSync(projectsDir)[0]
  }
  const dir = join(guardDir, 'projects', key)
  if (!existsSync(dir)) fail(`分区目录不存在：${dir}`)
  const meta = partitions.find((p) => p.key === key)
  return { key, dir, label: meta?.label ?? key, workspace: meta?.workspace }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** journal 读取（容忍崩溃截断的尾行，与 store.ts 同一容错语义）。 */
function readJournal(partitionDir, limit) {
  const file = join(partitionDir, 'journal.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const take = Math.max(0, Math.min(limit, lines.length))
  const out = []
  for (const line of lines.slice(lines.length - take)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* torn tail line */
    }
  }
  return out
}

function fmtTime(iso) {
  return typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 19) : '?'
}

/**
 * 一个码点占多少终端显示列（v0.10 R10 命令窗口显示修复）。
 *
 * 为什么 rescue.mjs 自带一份而不是 import src/tool-text：本脚本的纪律是
 * **零依赖**（崩溃后 node_modules 可能正处于损坏状态，那正是要用逃生通道
 * 的时刻）。这里只实现 status/history 用到的列对齐所需的宽度判定，
 * 完整的折行/中和原语仍在 src/tool-text.ts（工具输出走那条路）。
 */
function codePointWidth(cp) {
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  return wide ? 2 : 1
}

/** 文本的显示列宽（CJK 全宽算 2 列；`length` 数的是码元，中文会错一半）。 */
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) width += codePointWidth(ch.codePointAt(0) ?? 0)
  return width
}

/** 按显示列右填充（`padEnd` 对 CJK 会少补空格 ⇒ 后续列错位，实测踩过）。 */
function padWidth(text, width) {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : String(text)
}

function cmdStatus(partition) {
  console.log(`分区：${partition.label}（${partition.key}）`)
  if (partition.workspace) console.log(`工作区：${partition.workspace}`)
  const state = readJsonSafe(join(partition.dir, 'state.json')) ?? {}
  const decision = readJsonSafe(join(partition.dir, 'decision.json'))
  const sentinelFile = join(partition.dir, 'sentinel.json')
  const sentinel = existsSync(sentinelFile) ? readJsonSafe(sentinelFile) : null

  // 键值对齐表（v0.10 R10）：键列按显示宽取齐，值列从同一列起 ——
  // 中文键（「崩溃计数」4 字 8 列）与英文值混排时 padEnd 会错位。
  const disabled = state.autoDisabled ?? []
  const rows = [
    ['崩溃计数', String(state.crashSeq ?? 0)],
    ['上次运行', state.crashedRun ? `崩溃（退出码 ${state.lastExitCode ?? '?'}）` : '干净退出'],
  ]
  if (state.bootMarker) {
    rows.push(['boot 标记', `${fmtTime(state.bootMarker.startedAt)} pid=${state.bootMarker.pid}（存在 = 进程没走干净退出）`])
  }
  rows.push(['保持关闭', disabled.length === 0 ? '无' : `${disabled.length} 个`])
  const keyWidth = Math.max(...rows.map(([key]) => displayWidth(key)))
  console.log('')
  for (const [key, value] of rows) console.log(`  ${padWidth(`${key}：`, keyWidth + 1)}${value}`)
  for (const d of disabled) {
    console.log(`    - ${d.name}（第 ${d.crashSeq} 次崩溃后关闭 @ ${fmtTime(d.disabledAt)}，原因 ${d.reason}）`)
  }
  if (decision) {
    console.log('')
    console.log(`决策文件：${decision.reason} · phase=${decision.phase ?? '（旧格式，无 phase）'} · captured ${fmtTime(decision.capturedAt)}`)
    console.log(`  disable（本轮被拦截）：${decision.disable.length === 0 ? '（空 = 全放行）' : decision.disable.join(', ')}`)
    console.log(`  嫌疑名单：${(decision.suspects ?? []).map((s) => s.bundle).join(', ') || '无'}`)
  }
  if (sentinel) console.log(`\n哨兵残留：退出码 ${sentinel.exitCode} @ ${fmtTime(sentinel.at)}（宿主没走到清理就死了）`)
  return state.crashedRun === true || state.crashSeq > 0 ? 2 : 0
}

function cmdHistory(partition, limit) {
  const events = readJournal(partition.dir, limit)
  console.log(`分区：${partition.label} · 最近 ${events.length} 条事件\n`)
  // kind 列固定显示宽：中文 subject 的宽度不再把时间/kind 列挤歪。
  const KIND_COL = 18
  for (const e of events) {
    const subject = e.bundle ?? e.detail ?? ''
    const kindCell = padWidth(String(e.kind), KIND_COL)
    console.log(`${fmtTime(e.t)}  ${kindCell} ${subject}${e.version ? ` v${e.version}` : ''}`)
  }
  return 0
}

function cmdDecision(partition) {
  const decision = readJsonSafe(join(partition.dir, 'decision.json'))
  if (decision === null) {
    console.log('没有决策文件 —— 守护行本轮全放行（或从未发布过决策）。')
    return 0
  }
  console.log(JSON.stringify(decision, null, 2))
  return 0
}

function cmdArchives(partition) {
  const root = join(partition.dir, 'archive')
  if (!existsSync(root)) {
    console.log('没有归档。')
    return 0
  }
  const names = readdirSync(root).sort()
  console.log(`分区：${partition.label} · ${names.length} 份归档\n`)
  for (const name of names) {
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    const manifest = readJsonSafe(join(dir, 'manifest.json'))
    const summary = manifest?.summary
    console.log(`- ${name}`)
    if (summary) {
      console.log(`  崩溃 ${summary.crashSeq ?? 0} 次 · 事件 ${summary.journalEvents ?? '?'} 条 · 关闭 ${(summary.autoDisabled ?? []).length || 0} 个`)
    }
    if (manifest?.reason) console.log(`  原因：${manifest.reason}`)
  }
  return 0
}

/* ------------------------------------------------------------------------ *
 * 可写逃生通道（T14-07）：apply / restore
 *
 * 设计取舍（与 compat-guardian 的差别）
 * ------------------------------------
 * 参考实现把「隔离」写进 `manifest.dsh.profile.bundles`；本插件的 profile 是
 * 同一个形态，但**默认不写**：`apply` 不带 `--yes` 只打印计划。
 * 理由：宿主起不来时人最容易慌张地乱改，先给一份「将会发生什么」比直接动
 * 文件更接近逃生通道的本分。
 *
 * 记录放 `<profile>/.recency-guard/rescue/<uuid>.json`（profile 级，不是分区级）：
 * 它改的是 profile 的 package.json，跨分区共用一份，放分区里会让另一个
 * 工作区看不到「profile 被谁改过」。
 * ------------------------------------------------------------------------ */

/** 记录目录（profile 级）。 */
function rescueDir(profileDir) {
  return join(profileDir, GUARD_DIR, 'rescue')
}

/** sha256（内置 crypto，零依赖）。 */
function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** 读文本（不存在 ⇒ undefined，与「空文件」区分）。 */
function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** 原子写（同目录临时文件 + rename；跨目录 rename 不保证原子）。 */
function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.rescue.tmp`
  writeFileSync(temporary, content, 'utf8')
  try {
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      /* 清理失败不改变主错误 */
    }
    throw error
  }
}

/** 读 profile 的 bundle 列表（不存在 ⇒ null，不猜）。 */
function readProfileBundleList(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  const text = readTextSafe(manifestPath)
  if (text === undefined) return null
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    return null
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return null
  return { manifestPath, text, manifest, bundles }
}

/** 目标 bundle：显式 --bundle 优先，否则取该分区决策文件里的 disable 名单。 */
function resolveTargets(args, profileDir, partition) {
  if (typeof args.bundle === 'string' && args.bundle.trim() !== '') {
    return args.bundle.split(',').map((x) => x.trim()).filter(Boolean)
  }
  const decision = readJsonSafe(join(partition.dir, 'decision.json'))
  const disable = Array.isArray(decision?.disable) ? decision.disable : []
  return disable.filter((x) => typeof x === 'string')
}

/** 列出 rescue 记录（新 → 旧）。 */
function listRescueRecords(profileDir) {
  const dir = rescueDir(profileDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ path: join(dir, name), record: readJsonSafe(join(dir, name)) }))
    .filter((entry) => entry.record !== null)
    .sort((a, b) => String(b.record.createdAt).localeCompare(String(a.record.createdAt)))
}

function cmdApply(args, profileDir, partition) {
  const state = readProfileBundleList(profileDir)
  if (state === null) fail(`profile 没有 dsh.profile.bundles（${join(profileDir, 'package.json')}）`, 3)
  const targets = resolveTargets(args, profileDir, partition)
  if (targets.length === 0) {
    console.log('没有要隔离的 bundle：决策文件里 disable 为空，且未指定 --bundle。')
    return 0
  }
  const removed = targets
    .map((name) => ({ name, version: undefined, index: state.bundles.indexOf(name) }))
    .filter((item) => item.index >= 0)
  const unknown = targets.filter((name) => !state.bundles.includes(name))
  if (removed.length === 0) {
    console.log(`指定的 bundle 都不在 profile 的 bundles 列表里：${targets.join(', ')}`)
    return 3
  }
  const selected = state.bundles.filter((name) => !targets.includes(name))
  const nextManifest = { ...state.manifest, dsh: { ...state.manifest.dsh, profile: { ...state.manifest.dsh.profile, bundles: selected } } }
  const after = `${JSON.stringify(nextManifest, null, 2)}\n`

  console.log(`拟隔离 ${removed.length} 个 bundle（原位置将被记录，可 restore 精确回插）：`)
  for (const item of removed) console.log(`  - ${item.name}（原 index ${item.index}）`)
  if (unknown.length > 0) console.log(`跳过（不在 bundles 列表）：${unknown.join(', ')}`)

  if (args.yes !== true) {
    // 默认只读：打印计划后退出，绝不写盘。
    console.log('\n（dry-run）加 --yes 才会真正修改 profile。')
    return 0
  }

  const record = {
    schemaVersion: 1,
    id: randomUUID(),
    directory: resolve(profileDir),
    createdAt: new Date().toISOString(),
    reason: typeof args.reason === 'string' ? args.reason : '离线逃生通道隔离',
    removed,
    before: state.text,
    beforeHash: digest(state.text),
    afterHash: digest(after),
    status: 'prepared',
  }
  const recordPath = join(rescueDir(profileDir), `${record.id}.json`)
  mkdirSync(rescueDir(profileDir), { recursive: true })
  // 一阶段：先把「我要做什么」落盘。此后任何时刻断电，重启都能从记录恢复。
  atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  // 二阶段：原子改 profile。
  atomicWrite(state.manifestPath, after)
  record.status = 'applied'
  atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`\n已隔离并通过两阶段记录：${record.id}`)
  console.log(`恢复：node bin/rescue.mjs restore --profile-dir <profile> --id ${record.id} --yes`)
  return 0
}

/** `requireFs` 已移除：mkdirSync 直接在顶层 import（上一版残留的占位实现）。 */

function cmdRestore(args, profileDir) {
  const state = readProfileBundleList(profileDir)
  if (state === null) fail(`profile 无效（没有 dsh.profile.bundles）：${join(profileDir, 'package.json')}`, 3)

  let chosen
  if (typeof args.id === 'string' && args.id !== '') {
    chosen = listRescueRecords(profileDir).find((entry) => entry.record.id === args.id)
    if (chosen === undefined) fail(`找不到 rescue 记录 ${args.id}`, 3)
  } else {
    // --resume / 默认：最新一条「可回插」的记录。
    chosen = listRescueRecords(profileDir).find((entry) => entry.record.status === 'applied' || entry.record.status === 'prepared')
    if (chosen === undefined) {
      console.log('没有可恢复的 rescue 记录。')
      return 0
    }
  }

  const { record } = chosen
  if (record.status === 'restored') {
    console.log(`记录 ${record.id} 已是 restored，无需重复恢复。`)
    return 0
  }
  if (record.directory !== resolve(profileDir)) fail('记录不属于这个 profile（directory 不一致）', 3)
  if (digest(record.before) !== record.beforeHash) fail('记录内容被篡改（before 与 beforeHash 不一致）', 3)
  const currentHash = digest(state.text)
  // 中断恢复判定：prepared + 当前哈希 == afterHash ⇒ 第二步其实已完成。
  const interruptedAfterWrite = record.status === 'prepared' && currentHash === record.afterHash
  if (record.status !== 'applied' && !interruptedAfterWrite) {
    fail(`记录状态 ${record.status} 且 profile 未被它修改过（哈希不匹配）—— 没有可恢复的内容`, 3)
  }

  const selected = [...state.bundles]
  // 按原 index 升序回插：一次只改一个位置，index 才不会互相挤位。
  for (const item of [...record.removed].sort((a, b) => a.index - b.index)) {
    if (selected.includes(item.name)) continue
    selected.splice(Math.min(item.index, selected.length), 0, item.name)
  }
  const restoredManifest = { ...state.manifest, dsh: { ...state.manifest.dsh, profile: { ...state.manifest.dsh.profile, bundles: selected } } }
  const nextText = `${JSON.stringify(restoredManifest, null, 2)}\n`

  console.log(`记录 ${record.id}（status=${record.status}${interruptedAfterWrite ? '，判定为中断后已生效' : ''}）`)
  console.log(`将按原位置回插 ${record.removed.length} 个 bundle：`)
  for (const item of [...record.removed].sort((a, b) => a.index - b.index)) console.log(`  + ${item.name} @ ${item.index}`)

  if (args.yes !== true) {
    console.log('\n（dry-run）加 --yes 才会真正修改 profile。')
    return 0
  }
  atomicWrite(state.manifestPath, nextText)
  record.status = 'restored'
  atomicWrite(chosen.path, `${JSON.stringify(record, null, 2)}\n`)
  console.log('\n已恢复。')
  return 0
}

function cmdRescueList(profileDir) {
  const records = listRescueRecords(profileDir)
  if (records.length === 0) {
    console.log('没有 rescue 记录。')
    return 0
  }
  console.log(`rescue 记录（${records.length} 条，新 → 旧）\n`)
  for (const { record } of records) {
    console.log(`- ${record.id}  ${record.status}  ${fmtTime(record.createdAt)}`)
    console.log(`  ${record.removed.map((x) => `${x.name}@${x.index}`).join(', ')}`)
  }
  return 0
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0) {
    usage()
    process.exit(args.help ? 0 : 1)
  }
  const command = args._[0]
  if (!args.profileDir) fail('缺少 --profile-dir <profile 目录>')
  const profileDir = resolve(args.profileDir)
  const guardDir = join(profileDir, GUARD_DIR)
  if (!existsSync(guardDir)) fail(`守护目录不存在：${guardDir}（这个 profile 装过 dsh-recency-guard 吗？）`)
  const partition = pickPartition(guardDir, args.project)
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 40
  let code
  switch (command) {
    case 'status': code = cmdStatus(partition); break
    case 'history': code = cmdHistory(partition, limit); break
    case 'decision': code = cmdDecision(partition); break
    case 'archives': code = cmdArchives(partition); break
    case 'rescues': code = cmdRescueList(profileDir); break
    case 'apply': code = cmdApply(args, profileDir, partition); break
    case 'restore': code = cmdRestore(args, profileDir); break
    default:
      fail(`未知命令 ${JSON.stringify(command)}（可用：status / history / decision / archives / rescues / apply / restore）`)
  }
  process.exit(code)
}

main()
