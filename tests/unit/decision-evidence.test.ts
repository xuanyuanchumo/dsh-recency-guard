/**
 * 决策因子快照（v0.13 方向③）的回归。
 *
 * 为什么只测纯函数：`decisionSuspects` 是**纯函数**（输入决定输出，无 IO），
 * 它的正确性由这组断言钉住；真正把它接到决策写入路径的「接线」由
 * `tests/host/tool.test.ts` 的决策断言覆盖（两条写入路径都要经过它）。
 *
 * 覆盖的不变式：
 * 1. 确定性——同输入 + 同 `now` ⇒ 逐字节相同（快照契约的前提）
 * 2. 分解一致性——`factors` 三项之和 ≈ `risk`
 * 3. 排序与证据同位——`rank` 与输入顺序一致
 * 4. streak 语义——跳过空嫌疑历史、头号变化即断
 * 5. 变更计数只数 install/update
 * 6. `riskScore` 重构后行为不变（对照旧公式）
 */
import { decisionSuspects, streakOf, rankForDecision } from '../../src/guard/decision-evidence.js'
import { riskScore, riskFactors, RISK_WEIGHTS } from '../../src/core/lifecycle.js'
import type { RecencyEntry } from '../../src/risk/recency.js'
import type { JournalRecord } from '../../src/data/store.js'
import type { CrashHistoryEntry } from '../../src/guard/recovery-policy.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function entry(bundle: string, lastChangeAt: string, source: 'journal' | 'mtime' = 'journal'): RecencyEntry {
  return { bundle, lastChangeAt, lastKind: 'install', source }
}

function event(kind: JournalRecord['kind'], bundle: string, t = '2026-11-01T00:00:00.000Z'): JournalRecord {
  return { kind, bundle, t }
}

function history(...suspects: string[][]): CrashHistoryEntry[] {
  return suspects.map((s, i) => ({
    at: `2026-11-0${i + 1}T00:00:00.000Z`,
    exitCode: 1,
    suspects: s,
  }))
}

const NOW = Date.parse('2026-11-10T00:00:00.000Z')

/** 证据在 `evidence` 内层——`DecisionSuspect` 的形状是 `{bundle, ..., evidence}`。 */
function ev(e: { evidence?: { rank: number; risk: number; factors: { recency: number; experimental: number; crashFrequency: number }; streak: number; changeCount: number; source?: string } }) {
  return e.evidence!
}

function main() {
  console.log('\n== decisionSuspects：确定性与排序 ==')
  const ranked = [entry('a-plugin', '2026-11-09T00:00:00.000Z'), entry('b-plugin', '2026-11-08T00:00:00.000Z')]
  const events: JournalRecord[] = []
  const one = decisionSuspects(ranked, events, [], NOW)
  const two = decisionSuspects(ranked, events, [], NOW)
  check('同输入 + 同 now ⇒ 逐字节相同', JSON.stringify(one) === JSON.stringify(two))
  check('rank 1 基且与输入顺序一致', ev(one[0]).rank === 1 && ev(one[1]).rank === 2, one.map((e) => ev(e).rank))
  check('bundle/version/lastChangeAt 在外层（决策行只读这些）', one[0].bundle === 'a-plugin' && one[0].lastChangeAt === '2026-11-09T00:00:00.000Z')
  check('source 在 evidence 内层透传', ev(one[0]).source === 'journal' && ev(one[1]).source === 'journal', ev(one[0]))

  console.log('\n== 分解一致性 ==')
  for (const e of one) {
    const f = ev(e).factors
    const sum = f.recency + f.experimental + f.crashFrequency
    check(`${e.bundle}: factors 三项之和 ≈ risk`, Math.abs(sum - ev(e).risk) < 1e-4, { sum, risk: ev(e).risk, factors: f })
  }

  console.log('\n== riskScore 重构后行为不变（对照旧公式） ==')
  const sample = {
    bundle: 'x',
    lastChangeAt: '2026-11-08T00:00:00.000Z',
    experimental: true,
    suspectHits: 2,
    observations: 4,
  }
  const old =
    RISK_WEIGHTS.recency * Math.pow(0.5, (NOW - Date.parse(sample.lastChangeAt)) / 3_600_000 / 72) +
    RISK_WEIGHTS.experimental * 1 +
    RISK_WEIGHTS.crashFrequency * (2 / 4)
  const expected = Math.round(Math.min(1, Math.max(0, old)) * 10000) / 10000
  check('riskScore 与旧公式逐位一致', riskScore(sample, NOW) === expected, { got: riskScore(sample, NOW), expected })
  const fs = riskFactors(sample, NOW)
  check('riskFactors 三项之和 === 旧公式（未取整前）', Math.abs(fs.recency + fs.experimental + fs.crashFrequency - old) < 1e-9, { fs, old })

  console.log('\n== streak 语义 ==')
  check('非头号嫌疑 streak = 0', streakOf('b-plugin', false, []) === 0)
  check('头号嫌疑首轮 streak = 1', streakOf('a-plugin', true, []) === 1)
  check('连续同头号累加', streakOf('a-plugin', true, history(['a-plugin'], ['a-plugin'], ['a-plugin'])) === 4)
  check('头号变化即断（最近一条历史头号不同 ⇒ 只记本轮）', streakOf('a-plugin', true, history(['a-plugin'], ['a-plugin'], ['b-plugin'])) === 1)
  check('头号变化后更早的同号不计入（中断后不再回溯）', streakOf('a-plugin', true, history(['a-plugin'], ['b-plugin'], ['a-plugin'])) === 2)
  check('空嫌疑历史被跳过（启动检测事件不是崩溃证据）', streakOf('a-plugin', true, history([], ['a-plugin'], ['a-plugin'])) === 3)

  console.log('\n== 变更计数只数 install/update ==')
  const withEvents = decisionSuspects(
    ranked,
    [
      event('install', 'a-plugin'),
      event('update', 'a-plugin'),
      event('install', 'b-plugin'),
      event('disable', 'a-plugin'), // disable 不算「变更」
      event('note', 'a-plugin'),
    ],
    [],
    NOW,
  )
  check('a-plugin 的 changeCount = 2（install+update）', ev(withEvents[0]).changeCount === 2, ev(withEvents[0]).changeCount)
  check('b-plugin 的 changeCount = 1', ev(withEvents[1]).changeCount === 1, ev(withEvents[1]).changeCount)

  console.log('\n== 崩溃历史驱动 streak 进入快照 ==')
  const withHistory = decisionSuspects(ranked, events, history(['a-plugin'], ['a-plugin']), NOW)
  check('头号嫌疑 streak = 3（含本轮）', ev(withHistory[0]).streak === 3, ev(withHistory[0]).streak)
  check('非头号嫌疑 streak = 0', ev(withHistory[1]).streak === 0, ev(withHistory[1]).streak)

  console.log('\n== rankForDecision：排序口径统一 ==')
  {
    // A：1 小时前更新（recency 第一），但非实验性 → risk 低
    // B：3 天前更新（recency 第二），但实验性 → risk 高
    const a = entry('a-plugin', '2026-11-09T23:00:00.000Z')
    const b = entry('b-beta-plugin', '2026-11-07T00:00:00.000Z')
    const recencyOrder = [a, b] // rankByRecency：A 在前
    const decisionOrder = rankForDecision(recencyOrder, [], NOW)
    check('多嫌疑时按 riskScore 重排（B 实验性优先于 A 新近性）', decisionOrder[0]?.bundle === 'b-beta-plugin', decisionOrder.map((e) => e.bundle))
    check('重排不改变候选集合（只是顺序）', decisionOrder.length === 2 && decisionOrder.some((e) => e.bundle === 'a-plugin'))
  }
  {
    // 单嫌疑（确定性证据）：顺序无关，保持原序
    const single = [entry('only-one', '2026-11-09T00:00:00.000Z')]
    check('单嫌疑保持原序（确定性证据零行为变化）', rankForDecision(single, [], NOW)[0]?.bundle === 'only-one')
  }
  {
    // 并列：同 risk 时按时间戳降序，再按包名字典序（确定性兜底）
    const x = entry('x-plugin', '2026-11-09T00:00:00.000Z')
    const y = entry('y-plugin', '2026-11-09T00:00:00.000Z')
    const tied = rankForDecision([y, x], [], NOW)
    check('同 risk + 同时间戳 ⇒ 包名字典序兜底', tied[0]?.bundle === 'x-plugin', tied.map((e) => e.bundle))
  }
  {
    // 确定性：同输入同 now ⇒ 同顺序
    const ranked = [entry('a-plugin', '2026-11-09T00:00:00.000Z'), entry('b-beta', '2026-11-08T00:00:00.000Z')]
    const o1 = rankForDecision(ranked, [], NOW).map((e) => e.bundle)
    const o2 = rankForDecision(ranked, [], NOW).map((e) => e.bundle)
    check('rankForDecision 确定性', JSON.stringify(o1) === JSON.stringify(o2), { o1, o2 })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
