/**
 * 兜底纪律测试 —— 「文件不存在 / 内容损坏时，观测设施不能拖垮守护流程」。
 *
 * 为什么单独一个文件
 * -----------------
 * 变异测试（`scripts/mutation.mjs`，本轮 M4）第一次全量跑出的 27 个存活体里，
 * 有一大半是「删除 try/catch」—— 也就是说：**这些兜底从未被任何断言覆盖过**。
 * 它们恰恰是本项目最核心的崩溃路径纪律（CLAUDE.md：「守护行安装、启动记录、
 * 崩溃决策全部同步 IO（异步会输给崩溃）」「观测设施不拖垮守护流程」）。
 *
 * 一条「文件不存在 ⇒ 走兜底」的代码，只有真的构造出「文件不存在」才被验证；
 * 而既有测试都在**文件存在**的快乐路径上跑，所以变异体必然存活。
 * 这个文件就是来补这一刀的：**让每个兜底都有一个能杀死它的断言**。
 *
 * 判据不是「不抛异常」，而是「返回一个可用的默认值且语义正确」——
 * 只测「不抛」会放过「返回了空值是错的」这类缺陷。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 注意：一律用 `.js` 后缀（项目 ESM 惯例）。早期写成 `.ts` 会让
// scripts/mutation.mjs 的「直接 import 映射」漏掉本文件 —— 变异体的
// 测试归属判定按 `${module}.js` 匹配，`.ts` 写法让它成了「无直接测试」。
import { readPatchRows } from '../../src/host/adapters/patch/patch.ts'
import { readSentinel, SENTINEL_NAME } from '../../src/host/guard/sentinel.ts'
import { listArchives } from '../../src/host/data/archive.ts'
import { readDecision } from '../../src/host/guard/decision.ts'
import { readPartitionIndex, writePartitionIndex, emptyPartitionIndex } from '../../src/host/core/isolation.ts'
import { installGuardedRows } from '../../src/host/guard/guarded-rows.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'rg-fallback-'))
  try {
    // ─────────────────────────── patch 读取 ───────────────────────────
    console.log('\n== patch 读取：文件不存在 ⇒ 空行列表（不是抛异常）==')
    {
      const missing = join(root, 'no-such-patch.yml')
      const rows = readPatchRows(missing)
      check('缺失的 patch 文件返回空数组', Array.isArray(rows) && rows.length === 0, rows)
      check('缺失时不会抛异常（能拿到返回值即证明）', rows !== null && rows !== undefined)

      // 空文件名也要兜底（readFileSync('') 会 ENOENT）。
      const empty = readPatchRows('')
      check('空路径返回空数组而不是抛异常', Array.isArray(empty) && empty.length === 0, empty)

      // 存在但内容为空 ⇒ 同样空列表（这条走的是解析路径，不是兜底路径，
      // 但与缺失必须**结果一致**，否则「有没有文件」会成为两种语义）。
      const blank = join(root, 'blank.yml')
      writeFileSync(blank, '', 'utf8')
      check('空文件与缺失文件结果一致', readPatchRows(blank).length === 0)

      // 正常内容仍能被读出来（确认兜底没有把快乐路径也吞掉）。
      const good = join(root, 'good.yml')
      writeFileSync(good, '- id: a\n  name: dsh-a\n', 'utf8')
      const goodRows = readPatchRows(good)
      check('正常文件仍能被解析（兜底没有吞掉快乐路径）', goodRows.length === 1, goodRows)
    }

    // ─────────────────────────── sentinel 读取 ───────────────────────────
    console.log('\n== sentinel 读取：缺失 / 损坏 ⇒ null（绝不能假装「没崩过」以外的语义）==')
    {
      const dir = join(root, 'sentinel-missing')
      mkdirSync(dir, { recursive: true })
      check('哨兵文件缺失 ⇒ null', readSentinel(dir) === null)

      // 损坏的 JSON：这是「文件存在但内容不可解析」的独立分支，
      // 与「不存在」走同一 catch 但语义更强（写入被截断也能自愈）。
      const corruptDir = join(root, 'sentinel-corrupt')
      mkdirSync(corruptDir, { recursive: true })
      writeFileSync(join(corruptDir, 'crashed'), '{ not valid json', 'utf8')
      check('哨兵内容损坏 ⇒ null（不抛异常）', readSentinel(corruptDir) === null)

      // 正常哨兵必须能读出来 —— 否则「永远 null」会让崩溃通道整体失明，
      // 而所有测试仍会绿（这类「恒返回 null」的缺陷只有快乐路径断言能抓）。
      const okDir = join(root, 'sentinel-ok')
      mkdirSync(okDir, { recursive: true })
      // 文件名以源码常量 SENTINEL_NAME 为准（'crashed'），不靠字面量猜。
      writeFileSync(
        join(okDir, SENTINEL_NAME),
        JSON.stringify({ exitCode: 1, at: '2026-06-01T00:00:00.000Z', pid: 4321 }),
        'utf8',
      )
      const sentinel = readSentinel(okDir)
      check('正常哨兵能被读出', sentinel !== null, sentinel)
      check('哨兵保留 pid', sentinel?.pid === 4321, sentinel)
      check('哨兵保留 exitCode', sentinel?.exitCode === 1, sentinel)
    }

    // ─────────────────────────── 归档列表 ───────────────────────────
    console.log('\n== 归档列表：目录缺失 ⇒ 空列表 ==')
    {
      check('不存在的归档目录返回空数组', listArchives(join(root, 'no-archives')).length === 0)
      // 归档根存在但为空 ⇒ 同样空列表（两种情形结果一致）。
      const emptyRoot = join(root, 'empty-archives')
      mkdirSync(emptyRoot, { recursive: true })
      check('空归档目录返回空数组', listArchives(emptyRoot).length === 0)
    }

    // ─────────────────────── 决策文件读取 ───────────────────────
    console.log('\n== 决策文件：缺失 / 损坏 ⇒ null（崩溃通道不能因坏文件崩掉）==')
    {
      const storeDir = join(root, 'decision-missing')
      mkdirSync(storeDir, { recursive: true })
      check('决策文件缺失 ⇒ null', readDecision(storeDir) === null)

      const corruptDir = join(root, 'decision-corrupt')
      mkdirSync(corruptDir, { recursive: true })
      writeFileSync(join(corruptDir, 'decision.json'), '{ broken', 'utf8')
      check('决策文件损坏 ⇒ null（不抛异常）', readDecision(corruptDir) === null)

      // 正常决策文件必须能读 —— 钉住「不是恒 null」。
      const okDir = join(root, 'decision-ok')
      mkdirSync(okDir, { recursive: true })
      writeFileSync(
        join(okDir, 'decision.json'),
        JSON.stringify({ capturedAt: 'x', suspects: [], disable: ['dsh-bad'], reason: 'crash-recovery', crashSeq: 1 }),
        'utf8',
      )
      const decision = readDecision(okDir)
      check('正常决策文件能被读出', decision !== null, decision)
      check('决策文件保留 disable 名单', decision?.disable.includes('dsh-bad') === true, decision?.disable)
    }

    // ─────────────────────── 分区索引 ───────────────────────
    console.log('\n== 分区索引：missing / 损坏 ⇒ 空索引（多项目隔离不能因坏文件失忆）==')
    {
      const profileDir = join(root, 'profile-empty')
      mkdirSync(profileDir, { recursive: true })
      const index = readPartitionIndex(profileDir)
      check('分区索引缺失 ⇒ 空 partitions', Array.isArray(index.partitions) && index.partitions.length === 0, index)

      const corruptProfile = join(root, 'profile-corrupt')
      mkdirSync(corruptProfile, { recursive: true })
      writeFileSync(join(corruptProfile, 'partitions.json'), '[[[', 'utf8')
      const corruptIndex = readPartitionIndex(corruptProfile)
      check('分区索引损坏 ⇒ 空 partitions（不抛异常）', corruptIndex.partitions.length === 0, corruptIndex)
    }
    // ─────────────────────── 守护行安装的兜底 ───────────────────────
    console.log('\n== 守护行安装：失败时必须返回结构化结果，绝不抛（安装失败不能拖垮启动）==')
    {
      // 情形 1：profile 目录不存在 ⇒ `readDeclaredDependencies` 返回空 ⇒
      // 没有可守护行 ⇒ 走 `return { added: [], skipped }` 的**正常**出口。
      // 这不是兜底路径，但它同样必须「不抛、不谎报」——一并钉住。
      const badProfile = join(root, 'no-such-profile')
      const badPatch = join(root, 'no-such-dir', 'deep', 'cordis.patch.yml')
      const result = installGuardedRows(badProfile, badPatch)
      check('安装失败时返回结构化结果而不是抛异常', typeof result === 'object' && result !== null)
      check('安装失败时 added 为空（不谎报成功）', Array.isArray(result.added) && result.added.length === 0, result)
      check('安装失败时 skipped 仍是数组', Array.isArray(result.skipped), result)

      // 情形 2：**真正走到写盘**，但 patch 路径不可写 ⇒ 应走
      // `appendPatchText` 的失败分支（`blocked`）或 catch 兜底，
      // 两者都必须「不抛」。这条才覆盖 try 内部。
      //
      // 为什么要造 node_modules 结构：`findGuardableRows` 只遍历
      // 「已声明依赖 ∩ 有 dsh.bundle.patch 的非官方包」。没有这个夹具，
      // chunks 恒空，写盘代码**永远不会执行**——这也正是早期
      // 「删掉 try 测试仍全绿」的原因（我的第一版夹具是空的）。
      const profile = join(root, 'profile-with-bundle')
      const bundleDir = join(profile, 'node_modules', 'dsh-fake-bundle')
      mkdirSync(bundleDir, { recursive: true })
      writeFileSync(
        join(bundleDir, 'package.json'),
        JSON.stringify({ name: 'dsh-fake-bundle', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
        'utf8',
      )
      writeFileSync(join(bundleDir, 'cordis.patch.yml'), '- id: fake-row\n  name: dsh-fake-bundle\n', 'utf8')
      // 声明该依赖（readDeclaredDependencies 读的是 profile 的 package.json）。
      writeFileSync(
        join(profile, 'package.json'),
        JSON.stringify({ name: 'fake-profile', dependencies: { 'dsh-fake-bundle': '1.0.0' } }),
        'utf8',
      )
      // patch 路径指向一个**目录**（Node 写文件会 EISDIR）⇒ 必然失败。
      const unwritable = join(root, 'dir-as-patch')
      mkdirSync(unwritable, { recursive: true })
      const blocked = installGuardedRows(profile, unwritable)
      check('写盘失败时不抛异常（catch 或 blocked 分支兜住）', blocked !== undefined)
      check(
        '写盘失败时不谎报「已安装」',
        blocked.added.length === 0 || blocked.blocked !== undefined,
        blocked,
      )
    }

    // ─────────────────────── 分区索引写入兜底 ───────────────────────
    console.log('\n== 分区索引写入：失败是 best-effort（不抛、不影响守护）==')
    {
      // 目标 profile 目录不存在 ⇒ mkdirSync 的父级也不存在时会失败。
      // 正确行为：吞掉异常返回 void（索引丢失只失去分区可读性）。
      const index = emptyPartitionIndex()
      let threw = false
      try {
        writePartitionIndex(join(root, 'missing-profile-dir'), index)
      } catch {
        threw = true
      }
      check('写分区索引失败时不抛异常', threw === false)
      // 正常路径仍要能写（确认兜底没把功能吞掉）。
      const okProfile = join(root, 'ok-profile')
      mkdirSync(okProfile, { recursive: true })
      writePartitionIndex(okProfile, index)
      check('正常 profile 能写出索引并可读回', readPartitionIndex(okProfile).partitions.length === 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
