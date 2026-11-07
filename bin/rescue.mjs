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
 * 只读：本脚本绝不写任何文件 —— 逃生通道的第一纪律是「别把现场弄乱」。
 * 写操作（归档/恢复）留给宿主活着时的工具与面板。
 *
 * 退出码：0 = 正常；1 = 参数错误；2 = 发现未恢复的崩溃状态（供脚本联动）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
    else if (a === '--help' || a === '-h') args.help = true
    else args._.push(a)
  }
  return args
}

function usage() {
  console.log(`
recency-guard rescue —— 宿主崩溃后的离线守护产物查询（只读）

用法：
  node bin/rescue.mjs <command> --profile-dir <profile目录> [选项]

命令：
  status    崩溃状态、守护决策、自动关闭名单
  history   journal 事件时间线（--limit N，默认 40）
  decision  预启动决策文件全文（守护行正在执行什么）
  archives  归档清单（带 manifest 摘要）

选项：
  --profile-dir <dir>   profile 根目录（含 .recency-guard/）
  --project <key|label> 多项目 profile 时指定分区（默认取最近活跃的）
  --limit <n>           history 条数

退出码：0 正常；1 参数错误；2 发现未恢复的崩溃状态。
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

function cmdStatus(partition) {
  console.log(`分区：${partition.label}（${partition.key}）`)
  if (partition.workspace) console.log(`工作区：${partition.workspace}`)
  const state = readJsonSafe(join(partition.dir, 'state.json')) ?? {}
  const decision = readJsonSafe(join(partition.dir, 'decision.json'))
  const sentinelFile = join(partition.dir, 'sentinel.json')
  const sentinel = existsSync(sentinelFile) ? readJsonSafe(sentinelFile) : null

  console.log('')
  console.log(`崩溃计数：${state.crashSeq ?? 0}`)
  console.log(`上次运行：${state.crashedRun ? `崩溃（退出码 ${state.lastExitCode ?? '?'}）` : '干净退出'}`)
  if (state.bootMarker) console.log(`boot 标记：${fmtTime(state.bootMarker.startedAt)} pid=${state.bootMarker.pid}（存在 = 进程没走干净退出）`)
  const disabled = state.autoDisabled ?? []
  console.log(`保持关闭：${disabled.length === 0 ? '无' : ''}`)
  for (const d of disabled) console.log(`  - ${d.name}（第 ${d.crashSeq} 次崩溃后关闭 @ ${fmtTime(d.disabledAt)}，原因 ${d.reason}）`)
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
  for (const e of events) {
    const subject = e.bundle ?? e.detail ?? ''
    console.log(`${fmtTime(e.t)}  ${String(e.kind).padEnd(17)} ${subject}${e.version ? ` v${e.version}` : ''}`)
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

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0) {
    usage()
    process.exit(args.help ? 0 : 1)
  }
  const command = args._[0]
  if (!args.profileDir) fail('缺少 --profile-dir <profile 目录>')
  const guardDir = resolve(args.profileDir, GUARD_DIR)
  if (!existsSync(guardDir)) fail(`守护目录不存在：${guardDir}（这个 profile 装过 dsh-recency-guard 吗？）`)
  const partition = pickPartition(guardDir, args.project)
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 40
  let code
  switch (command) {
    case 'status': code = cmdStatus(partition); break
    case 'history': code = cmdHistory(partition, limit); break
    case 'decision': code = cmdDecision(partition); break
    case 'archives': code = cmdArchives(partition); break
    default:
      fail(`未知命令 ${JSON.stringify(command)}（可用：status / history / decision / archives）`)
  }
  process.exit(code)
}

main()
