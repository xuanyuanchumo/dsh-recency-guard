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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOURNAL_MAX_LINES, Store } from '../../src/host/data/store.ts'
import { readMergedJournalSync, trimJournalFile } from '../../src/host/data/journal-io.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function journalLineCount(store: Store): number {
  // 轮转后活动文件可能不存在（全部轮走且尚未有新写入）⇒ 视为 0 行。
  const active = join(store.partitionPath, 'journal.jsonl')
  if (!existsSync(active)) return 0
  return readFileSync(active, 'utf8').split('\n').filter(Boolean).length
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

  console.log('\n== 正常读 ⇒ 轮转生效且**零丢行**（v0.18 TD-5 结构根治）==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-trim-ok-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      const total = JOURNAL_MAX_LINES + 5
      for (let i = 0; i < total; i += 1) store.appendSync({ kind: 'note', detail: `sync-${i}` })
      await store.append({ kind: 'note', detail: 'trigger-trim' })
      // 轮转后的不变式**不是「活动文件 ≤ 上限」**（那是裁剪的形状），
      // 而是「合并读取能拿回全部事件」——轮转把最旧段搬进
      // journal.<epoch>.jsonl，证据一行不少。
      const records = store.readJournalSync(total + 10)
      check('rotation keeps every event readable', records.length === total + 1, records.length)
      check('oldest event survives rotation', records.some((r) => r.detail === 'sync-0'))
      check('newest event survives rotation', records[records.length - 1]?.detail === 'trigger-trim', records.slice(-2).map((r) => r.detail))
      // 活动文件确实变小了（否则轮转没有发生，测试就成了假绿）。
      const activeLines = journalLineCount(store)
      check('active file rotated (shrank below total)', activeLines < total, activeLines)
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
      const dir = join(store.partitionPath)
      for (let i = 0; i < JOURNAL_MAX_LINES + 3; i += 1) store.appendSync({ kind: 'note', detail: `sync-${i}` })
      await trimJournalFile(dir, (path) => readFile(path, 'utf8'))
      // 轮转语义：活动文件变小、轮转文件出现、合并读取拿回全部。
      const rotatedNames = existsSync(dir) ? readdirSync(dir).filter((n) => /^journal\.\d+\.jsonl$/.test(n)) : []
      check('rotation produced a rotated file', rotatedNames.length >= 1, rotatedNames)
      const merged = readMergedJournalSync(dir, JOURNAL_MAX_LINES + 10)
      check('merged read recovers all events after direct rotation', merged.length === JOURNAL_MAX_LINES + 3, merged.length)
      let threw: unknown = null
      try {
        await trimJournalFile(dir, async () => {
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

  console.log('\n== 交错不丢行（TD-5 原残余窗口的结构性消灭）==')
  {
    // 旧实现的风险：裁剪「读最新→写回」窗口里的一次同步追加被覆盖。
    // 轮转实现里 rename 不读不写内容 ⇒ 崩溃路径 appendSync 与轮转的
    // 任何交错都只有两种落点（轮走 / 落新文件），合并读取都在。
    const profile = mkdtempSync(join(tmpdir(), 'rg-trim-race-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      const total = JOURNAL_MAX_LINES + 2
      for (let i = 0; i < total; i += 1) store.appendSync({ kind: 'note', detail: `sync-${i}` })
      // 模拟「崩溃事件恰好在轮转决策后到达」：直接在超限文件上先追加一条
      // 同步事件，再触发轮转。
      store.appendSync({ kind: 'crash-detected', detail: 'race-crash' })
      await store.append({ kind: 'note', detail: 'trigger-rotation' })
      const merged = store.readJournalSync(total + 20)
      check('sync crash event survives rotation interleaving', merged.some((r) => r.kind === 'crash-detected' && r.detail === 'race-crash'), merged.filter((r) => r.kind === 'crash-detected').length)
      check('every appended line survives', merged.length === total + 2, { expected: total + 2, got: merged.length })
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