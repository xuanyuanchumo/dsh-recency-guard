/**
 * journal 合并对拍（T16-03 配套）—— 零依赖 rescue vs 宿主 journal-io。
 *
 * ## 为什么需要这条契约
 *
 * TD-5 轮转改造让 journal 变成「活动文件 + journal.<epoch>.jsonl 多段」。
 * `bin/rescue.mjs` 按零依赖纪律必须**自带**一份合并读取（宿主起不来时
 * node_modules 可能损坏，逃生通道不能 import 宿主模块）；没有对拍的
 * 双实现必然漂移 —— v0.15 的宽度双实现就漂移过一次（组合字符/ZWJ）。
 *
 * 本测试用**同一份磁盘语料**（真实文件布局：轮转段 + 活动 + 撕裂尾行）
 * 分别喂两份实现，断言解析出的记录集合一致，并钉住正确值
 * （两份一起错时「相等」也会成立，必须显式期望挡住）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMergedJournalSync } from '../../src/host/data/journal-io.ts'
import { rescueReadJournalForParity } from '../../bin/rescue.mjs'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function recordSignature(r: { kind?: unknown; detail?: unknown; t?: unknown }): string {
  return `${String(r.kind)}|${String(r.detail)}|${String(r.t)}`
}

/** 构造一份「轮转段 ×2 + 活动文件（含撕裂尾行）」的真实布局。 */
function makeJournalLayout(dir: string, now: string): void {
  mkdirSync(dir, { recursive: true })
  const old = Array.from({ length: 3 }, (_, i) => JSON.stringify({ kind: 'note', detail: `old-${i}`, t: now }))
  const mid = Array.from({ length: 3 }, (_, i) => JSON.stringify({ kind: 'install', detail: `pkg-${i}`, t: now }))
  const active = [
    JSON.stringify({ kind: 'crash-detected', detail: 'crash-1', t: now }),
    JSON.stringify({ kind: 'note', detail: 'tail', t: now }),
    '{"kind":"torn","detail":', // 崩溃截断的半行，两份实现都必须容忍
  ]
  writeFileSync(join(dir, 'journal.1700000000000.jsonl'), `${old.join('\n')}\n`, 'utf8')
  writeFileSync(join(dir, 'journal.1700000001000.jsonl'), `${mid.join('\n')}\n`, 'utf8')
  writeFileSync(join(dir, 'journal.jsonl'), `${active.join('\n')}\n`, 'utf8')
}

function main(): void {
  const profile = mkdtempSync(join(tmpdir(), 'rg-journal-parity-'))
  try {
    const dir = join(profile, 'part-a')
    makeJournalLayout(dir, '2026-11-13T00:00:00.000Z')

    // 两份实现同 limit：rescue 的 readJournal 语义是「最后 N 条」。
    const host = readMergedJournalSync(dir, 100).map(recordSignature)
    const rescue = rescueReadJournalForParity(dir, 100).map(recordSignature)

    check('both implementations parse the same record count', host.length === rescue.length, { host: host.length, rescue: rescue.length })
    check('expected total: 8 intact lines (torn tail skipped)', host.length === 8, host.length)
    check('host order matches rescue order', host.every((v, i) => v === rescue[i]), { host, rescue })

    // 正确值（防「一致地错」）：跨文件顺序 = epoch 升序 + 活动文件最后。
    check('oldest segment comes first', host[0] === 'note|old-0|2026-11-13T00:00:00.000Z', host[0])
    check('active-file crash line is last intact record', host[host.length - 1] === 'note|tail|2026-11-13T00:00:00.000Z', host[host.length - 1])
    check('torn tail line skipped by host', host.every((s) => !s.includes('torn')))
    check('torn tail line skipped by rescue', rescue.every((s) => !s.includes('torn')))

    // limit 语义对拍：两份实现都取「合并后的最后 N 条原始行」——撕裂行
    // 占窗口名额但解析时跳过（与单文件时代的 parseJournalLines 语义一致，
    // 这正是「当前行为=正确行为」要显式钉住的地方）。
    const hostTail = readMergedJournalSync(dir, 4).map(recordSignature)
    const rescueTail = rescueReadJournalForParity(dir, 4).map(recordSignature)
    check('limit=4 window counts raw lines incl torn (host)', hostTail.length === 3 && hostTail[0] === 'install|pkg-2|2026-11-13T00:00:00.000Z', hostTail)
    check('limit=4 agrees between implementations', hostTail.every((v, i) => v === rescueTail[i]), rescueTail)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
