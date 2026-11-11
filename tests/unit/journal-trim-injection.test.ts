/**
 * journal 裁剪的失败分支（T15-02 未归因清零之一）。
 *
 * ## 为什么这条以前杀不死
 *
 * `trimJournalIfNeeded` 的 catch 是 IO 失败兜底，而 `readFile` 是**模块级静态
 * 导入**（ESM 绑定不可替换）⇒ 测试只能真去写坏磁盘才能覆盖，等于测环境。
 * 本轮把 `readText` 做成参数（`Store` 构造第 4 参 `io.readFile`），默认仍走
 * 真实 fs —— **生产行为逐位不变**，失败分支变得可注入。
 *
 * ## 断言（抄实现的失败语义原文）
 *
 * 读失败 ⇒ **不抛、journal 内容一行不少**（「best effort」与「静默丢证据」
 * 的分界就在这里）；正常读 ⇒ 仍会裁剪到上限。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOURNAL_MAX_LINES, Store } from '../../src/host/data/store.ts'
import { trimJournalFile } from '../../src/host/data/journal-io.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function journalLineCount(store: Store): number {
  return readFileSync(join(store.partitionPath, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).length
}

async function main(): Promise<void> {
  console.log('\n== 读失败 ⇒ 不抛、不截断（注入点覆盖 catch）==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-trim-fail-'))
    try {
      // 注入：裁剪时的读恒失败。默认（io 省略）走真实 fs，生产行为不变。
      const store = new Store(profile, 'part-a', undefined, {
        readFile: async () => {
          throw new Error('模拟磁盘读失败')
        },
      })
      await store.init()
      // 崩溃路径只追加（不 trim），先把文件压到上限之上。
      for (let i = 0; i < JOURNAL_MAX_LINES + 5; i += 1) store.appendSync({ kind: 'note', detail: `sync-${i}` })
      const before = journalLineCount(store)
      check('precondition: journal is above the cap', before === JOURNAL_MAX_LINES + 5, before)

      let threw: unknown = null
      try {
        // 异步 append 会触发 trim；trim 的读失败必须被吞掉。
        await store.append({ kind: 'note', detail: 'trigger-trim' })
      } catch (error) {
        threw = error
      }
      check('trim read failure is swallowed (append resolves)', threw === null, String(threw))
      check('journal is not truncated on failure', journalLineCount(store) === before + 1, journalLineCount(store))
      const records = store.readJournalSync(JOURNAL_MAX_LINES + 10)
      check('the appended event survives', records.some((r) => r.detail === 'trigger-trim'), records.slice(-2).map((r) => r.detail))
      check('the oldest events are not dropped either', records.some((r) => r.detail === 'sync-0'), records[0]?.detail)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 正常读 ⇒ 仍按上限裁剪（默认行为未被注入点改变）==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-trim-ok-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      for (let i = 0; i < JOURNAL_MAX_LINES + 5; i += 1) store.appendSync({ kind: 'note', detail: `sync-${i}` })
      await store.append({ kind: 'note', detail: 'trigger-trim' })
      const lines = journalLineCount(store)
      check('normal path trims down to the cap', lines <= JOURNAL_MAX_LINES, lines)
      const records = store.readJournalSync(JOURNAL_MAX_LINES)
      check('newest event survives the trim', records.some((r) => r.detail === 'trigger-trim'), records.slice(-2).map((r) => r.detail))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== journal-io 直接驱动：默认 readText 走真实 fs ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-trim-direct-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      for (let i = 0; i < JOURNAL_MAX_LINES + 3; i += 1) store.appendSync({ kind: 'note', detail: `sync-${i}` })
      await trimJournalFile(join(store.partitionPath, 'journal.jsonl'), (path) => readFile(path, 'utf8'))
      check('explicit real-fs read trims normally', journalLineCount(store) <= JOURNAL_MAX_LINES, journalLineCount(store))
      let threw: unknown = null
      try {
        await trimJournalFile(join(store.partitionPath, 'journal.jsonl'), async () => {
          throw new Error('x')
        })
      } catch (error) {
        threw = error
      }
      check('trimJournalFile never throws on read failure', threw === null, String(threw))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.log('  FAIL  harness crashed', String(error))
    process.exit(1)
  })