/**
 * journal 完整性：append-only 与「旧快照不得覆盖新证据」（T14-08 真机缺陷修复）。
 *
 * ## 这条测试来自一次实测复现（不是假想）
 *
 * `missing-dep-required` 故障注入用例约 **1/9** 概率失败，症状是
 * `crash-detected.suspects` 里没有注入的 bundle，而 `decision.disable` /
 * `state.autoDisabled` 都正确 —— 也就是说「关了谁」对，「为什么关」丢了。
 *
 * 根因：启动期 `recordChanges` 的**异步** `append()` 先读到一份不含崩溃事件的
 * 旧快照，随后进程崩溃、退出处理器**同步**写入 crash-detected，最后那个挂起
 * 的异步整写落地，把 journal 覆盖回旧快照。
 *
 * 修法是换结构而不是加锁：journal 用 `appendFile` 真追加（O(1)、无整文件替换），
 * 行数上限改由安全时机（异步路径 + 锁）裁剪。本文件钉住两条不变式：
 *
 * 1. **任何交错下都不丢行**：异步 append 与同步 appendSync 混跑，每一条事件的
 *    唯一标记都必须出现在最终 journal 里；
 * 2. **崩溃证据优先**：模拟「异步写先发起、崩溃证据后写」，两者都必须存活。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, JOURNAL_MAX_LINES } from '../../src/host/data/store.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  console.log('\n== 交错写：异步 append 与同步 appendSync 不得互相覆盖 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-journal-race-'))
    try {
      const store = new Store(profile, 'part-a')
      // 模型化真实时序：boot 的异步 append 先发起（不 await），
      // 随后崩溃处理器同步追加 crash-detected，最后才 await 那个异步写。
      const pending = store.append({ kind: 'note', detail: 'async-boot-event' })
      store.appendSync({ kind: 'crash-detected', detail: '第 1 次崩溃（退出码 1）', exitCode: 1, suspects: ['fi-missing-dep'] })
      await pending
      const records = store.readJournalSync(100)
      const crash = records.find((r) => r.kind === 'crash-detected')
      check('crash-detected survived the in-flight async append', crash !== undefined, records.map((r) => r.kind))
      check('crash evidence keeps its suspects list', JSON.stringify(crash?.suspects) === '["fi-missing-dep"]', crash)
      check('the async boot event also survived', records.some((r) => r.detail === 'async-boot-event'), records.map((r) => r.detail))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 交错写循环：40 组随机延迟，逐条核对 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-journal-loop-'))
    try {
      const store = new Store(profile, 'part-a')
      const ROUNDS = 40
      const pending: Array<Promise<void>> = []
      for (let i = 0; i < ROUNDS; i += 1) {
        // 交替「先异步后同步」与「先同步后异步」，并用 0/1ms 延迟打散时序。
        if (i % 2 === 0) {
          pending.push(store.append({ kind: 'note', detail: `async-${i}` }))
          store.appendSync({ kind: 'crash-detected', detail: `crash-${i}`, exitCode: 1 })
        } else {
          store.appendSync({ kind: 'crash-detected', detail: `crash-${i}`, exitCode: 1 })
          pending.push(store.append({ kind: 'note', detail: `async-${i}` }))
        }
        if (i % 5 === 0) await sleep(i % 2)
      }
      await Promise.all(pending)
      const records = store.readJournalSync(1000)
      const missingAsync = Array.from({ length: ROUNDS }, (_, i) => `async-${i}`).filter(
        (marker) => !records.some((r) => r.detail === marker),
      )
      const missingCrash = Array.from({ length: ROUNDS }, (_, i) => `crash-${i}`).filter(
        (marker) => !records.some((r) => r.detail === marker),
      )
      check(`no async event lost across ${ROUNDS} interleavings`, missingAsync.length === 0, missingAsync)
      check(`no crash event lost across ${ROUNDS} interleavings`, missingCrash.length === 0, missingCrash)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 行数上限仍在安全时机被轮转（v0.18 TD-5）==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-journal-cap-'))
    try {
      const store = new Store(profile, 'part-a')
      // 崩溃路径只追加（不轮转）：先压到超上限。
      for (let i = 0; i < JOURNAL_MAX_LINES + 25; i += 1) {
        store.appendSync({ kind: 'note', detail: `sync-${i}` })
      }
      // 断言崩溃路径没有偷偷轮转（否则「超过上限就搬走活动文件」会在
      // 崩溃路径上做 rename，而它只有同步 IO 预算做追加）。
      const activeFile = join(store.partitionPath, 'journal.jsonl')
      const syncLines = readFileSync(activeFile, 'utf8').split('\n').filter(Boolean)
      check('sync path never rotates (only appends)', syncLines.length === JOURNAL_MAX_LINES + 25, syncLines.length)

      // 异步路径负责轮转：一条 append 触发 trim（现为 rename 轮转）。
      await store.append({ kind: 'note', detail: 'trigger-trim' })
      // 轮转的不变式：活动文件回到上限内（rename 走后若尚无新写入则
      // 文件暂不存在 ⇒ 计 0 行），而**合并读取拿回全部事件** ——
      // 轮转不丢行，与裁剪的「丢最旧」不同。
      const lines = existsSync(activeFile) ? readFileSync(activeFile, 'utf8').split('\n').filter(Boolean) : []
      check('async path rotates active file back under the cap', lines.length <= JOURNAL_MAX_LINES, lines.length)
      const records = store.readJournalSync(JOURNAL_MAX_LINES + 40)
      check('newest event survives the rotation', records.some((r) => r.detail === 'trigger-trim'), records.slice(-3).map((r) => r.detail))
      check('oldest events are kept (rotation drops nothing)', records.some((r) => r.detail === 'sync-0'), records.slice(0, 2).map((r) => r.detail))
      check('merged read returns every event', records.length === JOURNAL_MAX_LINES + 26, records.length)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 尾部半行容错（崩溃可能截断一行） ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-journal-torn-'))
    try {
      const store = new Store(profile, 'part-a')
      store.appendSync({ kind: 'note', detail: 'good-line' })
      mkdirSync(store.partitionPath, { recursive: true })
      appendFileSync(join(store.partitionPath, 'journal.jsonl'), '{"kind":"note","detail":"tor', 'utf8')
      const records = store.readJournalSync(10)
      check('torn tail line is skipped, good line kept', records.length === 1 && records[0].detail === 'good-line', records)
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