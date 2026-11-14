/**
 * `data/journal-io.ts` 的**解析容错**直接单测（cycle-15 / I 轮补）。
 *
 * 为什么补这条：`parseJournalLines` 逐行 `try { JSON.parse } catch { skip }`
 * 的兜底是「崩溃路径的证据链」底线 —— journal 的尾部半行是**正常现象**
 * （进程死在被截断的写中间）。删掉那层 catch 后，一条撕裂行会让整份 journal
 * 不可读（证据全丢），而不是只丢那一行。此前没有任何断言区分这两种行为，
 * 于是变异体存活。
 *
 * 判据来自模块头注释：「让一行残缺 JSON 使整份 journal 不可读，等于把守护者
 * 自己的证据链也弄丢了」。
 */
import { journalLines, parseJournalLines, parseJournalLinesDetailed, serializeJournal } from '../../src/host/data/journal-io.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const line = (obj: Record<string, unknown>) => JSON.stringify(obj)

console.log('\n== 撕裂尾行：跳过该行，不让整份读失败 ==')
{
  const raw = `${line({ kind: 'install', bundle: 'a', t: 't1' })}\n{ "kind": "update", "bun` // 末行被截断
  let threw: unknown
  let parsed: unknown[] | undefined
  try {
    parsed = parseJournalLines(raw, 10)
  } catch (error) {
    threw = error
  }
  check('撕裂尾行不让 parseJournalLines 抛异常', threw === undefined, threw)
  check('撕裂尾行被跳过（只剩 1 条完整事件）', parsed?.length === 1, parsed)
  check('保留的是完整的那一条', (parsed?.[0] as { bundle?: string })?.bundle === 'a', parsed)
}

console.log('\n== 中间行撕裂：只丢坏行，前后两条都保留 ==')
{
  const raw = [
    line({ kind: 'install', bundle: 'before', t: 't1' }),
    '{ "kind": "update", "bund',
    line({ kind: 'enable', bundle: 'after', t: 't3' }),
  ].join('\n')
  let threw: unknown
  let parsed: unknown[] | undefined
  try {
    parsed = parseJournalLines(raw, 10)
  } catch (error) {
    threw = error
  }
  check('中间行撕裂不抛', threw === undefined, threw)
  check('不是「遇错即停」：前后两条都在', parsed?.length === 2, parsed)
  const bundles = (parsed ?? []).map((e) => (e as { bundle?: string }).bundle)
  check('坏行只丢它自己（顺序保持）', JSON.stringify(bundles) === '["before","after"]', bundles)
}

console.log('\n== limit 语义：0 行 / 末尾 N 行 / 非有限 ==')
{
  const raw = [line({ kind: 'a' }), line({ kind: 'b' }), line({ kind: 'c' })].join('\n')
  check('limit=0 ⇒ 一行都不读（不是「全部」）', parseJournalLines(raw, 0).length === 0)
  const lastTwo = parseJournalLines(raw, 2)
  check('limit=2 ⇒ 取末尾两条', lastTwo.length === 2 && (lastTwo[0] as { kind?: string }).kind === 'b', lastTwo)
  check('limit 超过行数 ⇒ 全量', parseJournalLines(raw, 99).length === 3)
  check('非有限 limit ⇒ 按 0 处理', parseJournalLines(raw, Number.NaN).length === 0)
}

console.log('\n== journalLines / serializeJournal：分词与封顶 ==')
{
  check('journalLines 过滤空行', journalLines('a\n\nb\n').length === 2)
  check('serializeJournal 末尾带换行（追加语义的前提）', serializeJournal(['a', 'b']).endsWith('\n'))
}

console.log('\n== v0.20.0：坏行计数（degraded 白盒） ==')
{
  // 坏行不是「消失」，是「计数」：面板要能区分「时间线完整」与「缺了几行」。
  const good = (kind: string): string => JSON.stringify({ kind, t: '2026-11-14T00:00:00.000Z' })
  const raw = [good('a'), '{torn', good('b'), '{another-torn', good('c')].join('\n')
  const detailed = parseJournalLinesDetailed(raw, 10)
  check('详细版返回 3 条好记录', detailed.records.length === 3, detailed.records.length)
  check('详细版数出 2 条坏行', detailed.malformed === 2, detailed.malformed)
  check('好记录内容不受坏行影响', (detailed.records[0] as { kind?: string }).kind === 'a')
  // 旧签名包装：行为逐位不变（只有记录）。
  const legacy = parseJournalLines(raw, 10)
  check('旧签名仍返回纯记录数组', legacy.length === 3 && Array.isArray(legacy))
  // 全好文件 malformed=0（「0=完整」与「未知」在面板上是两态）。
  const clean = parseJournalLinesDetailed([good('x'), good('y')].join('\n'), 10)
  check('全好文件 malformed=0', clean.malformed === 0 && clean.records.length === 2)
  // limit 截尾后坏行计数只对读到的窗口生效。
  const windowed = parseJournalLinesDetailed(`${'{torn-head'}\n${good('a')}`, 1)
  check('limit 窗口外的坏行不计入', windowed.malformed === 0 && windowed.records.length === 1)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)