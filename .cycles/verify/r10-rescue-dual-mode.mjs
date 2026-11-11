#!/usr/bin/env node
/**
 * R10 证据生成器：`bin/rescue.mjs` 的**双形态**（只读 vs 可写 dry-run / --yes）
 * 在真实文件系统上的行为取证。
 *
 * 为什么需要它：交付清单要引用一句「逃生通道默认只读、写操作必须 --yes、且
 * 两阶段记录可按原 index 精确回插」。这句话不能靠读代码声称 —— 要有
 * **真实执行 + 文件哈希前后对照** 的证据。
 *
 * 纪律：全程在 OS 临时目录里的**沙箱 profile** 上跑，绝不碰主力 profile；
 * 脚本只读 bin/rescue.mjs，不 import src（零依赖纪律与 rescue 自身一致）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const rescue = join(process.cwd(), 'bin', 'rescue.mjs')
const root = mkdtempSync(join(tmpdir(), 'rg-r10-rescue-'))
const profile = join(root, 'profile')
const guard = join(profile, '.recency-guard')
const partition = join(guard, 'projects', 'k1')
let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}
function sha(text) {
  return createHash('sha256').update(text).digest('hex')
}
/** 整棵 profile 树的内容指纹（路径 + 内容），用于证明「只读命令没写盘」。 */
function treeHash(dir) {
  if (!existsSync(dir)) return '(missing)'
  const parts = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else parts.push(`${relative(dir, p).replace(/\\/g, '/')}\u0000${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return sha(parts.join('\u0001'))
}
function run(...args) {
  const r = spawnSync(process.execPath, [rescue, ...args], { encoding: 'utf8', timeout: 30_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
function show(title, r) {
  console.log(`\n$ node bin/rescue.mjs ${title}`)
  process.stdout.write(r.stdout)
  if (r.stderr) process.stdout.write(`[stderr] ${r.stderr}`)
  console.log(`[exit ${r.status}]`)
}

// ── 沙箱 profile 夹具 ──
mkdirSync(partition, { recursive: true })
const manifest = {
  name: 'sb-rg-r10',
  version: '0.0.0',
  dsh: { profile: { bundles: ['@scope/a', 'dsh-b', 'dsh-c'] } },
}
writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
writeFileSync(
  join(guard, 'partitions.json'),
  `${JSON.stringify({ partitions: [{ key: 'k1', label: 'r10-sandbox', workspace: 'D:/Sandbox/R10', lastSeenAt: '2026-11-11T06:00:00.000Z' }] }, null, 2)}\n`,
  'utf8',
)
writeFileSync(
  join(partition, 'decision.json'),
  `${JSON.stringify({ capturedAt: '2026-11-11T06:00:00.000Z', suspects: [], disable: ['dsh-b'], reason: 'crash-recovery' }, null, 2)}\n`,
  'utf8',
)
writeFileSync(join(partition, 'journal.jsonl'), '{"kind":"crash-detected","t":"2026-11-11T05:59:00.000Z"}\n', 'utf8')

const base = treeHash(profile)
const manifestPath = join(profile, 'package.json')
const manifestBefore = readFileSync(manifestPath, 'utf8')

console.log('== 1. 只读命令：五个命令跑完，整棵 profile 树必须逐字节不变 ==')
for (const command of ['status', 'history', 'decision', 'archives', 'rescues']) {
  const before = treeHash(profile)
  const r = run(command, '--profile-dir', profile)
  const after = treeHash(profile)
  check(`${command} 只读（树哈希不变，exit ${r.status}）`, before === after && r.status === 0, { before, after, status: r.status })
}
check('只读命令没有创建 .recency-guard/rescue/', !existsSync(join(guard, 'rescue')))
check('初始树指纹 = 基线', treeHash(profile) === base)

console.log('\n== 2. apply 不带 --yes = dry-run（打印计划，绝不写盘）==')
const dryApply = run('apply', '--profile-dir', profile)
show('apply --profile-dir <tmp>', dryApply)
check('dry-run 打印计划', dryApply.stdout.includes('拟隔离 1 个 bundle'))
check('dry-run 给出下一步提示', dryApply.stdout.includes('（dry-run）加 --yes 才会真正修改 profile。'))
check('dry-run 未改 package.json', readFileSync(manifestPath, 'utf8') === manifestBefore)
check('dry-run 未创建 rescue 记录', !existsSync(join(guard, 'rescue')))

console.log('\n== 3. apply --yes = 两阶段落盘（prepared → 改 profile → applied）==')
const applyYes = run('apply', '--profile-dir', profile, '--yes', '--reason', 'R10 取证')
show('apply --profile-dir <tmp> --yes --reason "R10 取证"', applyYes)
const afterApply = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('apply --yes 后目标 bundle 被摘除', JSON.stringify(afterApply.dsh.profile.bundles) === JSON.stringify(['@scope/a', 'dsh-c']), afterApply.dsh.profile.bundles)
const recordsDir = join(guard, 'rescue')
const recordFiles = existsSync(recordsDir) ? readdirSync(recordsDir).filter((n) => n.endsWith('.json')) : []
check('apply --yes 写了恰好 1 条两阶段记录', recordFiles.length === 1, recordFiles)
const record = recordFiles.length === 1 ? JSON.parse(readFileSync(join(recordsDir, recordFiles[0]), 'utf8')) : null
check('记录状态 = applied', record?.status === 'applied', record?.status)
check('记录含原 index（可精确回插）', JSON.stringify(record?.removed) === JSON.stringify([{ name: 'dsh-b', index: 1 }]), record?.removed)
check('记录 beforeHash 与改动前文本一致', record?.beforeHash === sha(manifestBefore))
check('记录 afterHash 与落盘文本一致', record?.afterHash === sha(readFileSync(manifestPath, 'utf8')))

console.log('\n== 4. restore 不带 --yes = dry-run ==')
const afterApplyText = readFileSync(manifestPath, 'utf8')
const dryRestore = run('restore', '--profile-dir', profile)
show('restore --profile-dir <tmp>', dryRestore)
check('restore dry-run 打印计划', dryRestore.stdout.includes('将按原位置回插'))
check('restore dry-run 未改 package.json', readFileSync(manifestPath, 'utf8') === afterApplyText)

console.log('\n== 5. restore --yes = 按原 index 精确回插 ==')
const restoreYes = run('restore', '--profile-dir', profile, '--yes')
show('restore --profile-dir <tmp> --yes', restoreYes)
const restored = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('恢复后顺序与原 index 一致（@scope/a, dsh-b, dsh-c）', JSON.stringify(restored.dsh.profile.bundles) === JSON.stringify(['@scope/a', 'dsh-b', 'dsh-c']), restored.dsh.profile.bundles)
const restoredRecord = recordFiles.length === 1 ? JSON.parse(readFileSync(join(recordsDir, recordFiles[0]), 'utf8')) : null
check('记录状态 = restored', restoredRecord?.status === 'restored', restoredRecord?.status)
check('恢复后文本与 before 逐字节一致（可逆）', readFileSync(manifestPath, 'utf8') === manifestBefore)

console.log(`\n== 汇总 ==\n  ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}（沙箱 ${profile}）`)
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)