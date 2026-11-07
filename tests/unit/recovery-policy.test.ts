/**
 * 恢复决策的置信分级与两阶段对账回归（v0.9.0）。
 *
 * 被测对象是 `recovery-policy.ts` 的三个纯函数 —— 它们决定「要不要关
 * 一个无辜插件」与「半成品状态怎么对账」，是本插件里最不该出错的判定。
 * 夹具数据取自真实场景：多嫌疑连续复现、头号更换、唯一嫌疑、空名单。
 */
import { assessConfidence, environmentChanged, reconcilePrepared, type CrashHistoryEntry } from '../../src/recovery-policy.js'
import type { RecencyEntry } from '../../src/recency.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function entry(bundle: string, version = '1.0.0'): RecencyEntry {
  return { bundle, version, lastChangeAt: '2026-11-07T00:00:00.000Z', lastKind: 'update' }
}

function histAt(suspects: string[], exitCode = 1): CrashHistoryEntry {
  return { at: '2026-11-07T00:00:00.000Z', exitCode, suspects, runtimeVersion: '0.2.2-rc.1' }
}

function main() {
  console.log('\n== assessConfidence：判定表 ==')
  {
    const empty = assessConfidence([], [], {})
    check('no suspects ⇒ no action', !empty.act, empty)
    check('no suspects label explains why', empty.label.includes('没有嫌疑'), empty.label)

    const solo = assessConfidence([], [entry('dsh-ops')], { confirmRounds: 2 })
    check('single suspect ⇒ deterministic, act on round 1', solo.act && solo.evidence === 'deterministic' && solo.rounds === 1, solo)
    check('single suspect label names the bundle', solo.label.includes('dsh-ops'), solo.label)

    // 多嫌疑，无历史：第 1 轮观察
    const first = assessConfidence([], [entry('a'), entry('b')], { confirmRounds: 2 })
    check('multi suspects round 1 ⇒ observe only', !first.act && first.evidence === 'probabilistic', first)
    check('observe label carries streak', first.label.includes('1/2'), first.label)

    // 多嫌疑，历史里头号相同：streak 累计
    const h = [histAt(['a', 'b'])]
    const second = assessConfidence(h, [entry('a'), entry('b')], { confirmRounds: 2 })
    check('same head twice ⇒ act', second.act && second.rounds === 2, second)

    // 头号换了 ⇒ streak 重数（不算旧头号）
    const switched = assessConfidence([histAt(['a', 'b'])], [entry('b'), entry('a')], { confirmRounds: 2 })
    check('head switch ⇒ streak restarts', !switched.act && switched.rounds === 1, switched)

    // 历史头号断了再续：只数连续段
    const gap = [histAt(['a']), histAt(['x']), histAt(['a'])]
    const resumed = assessConfidence(gap, [entry('a'), entry('b')], { confirmRounds: 3 })
    check('broken streak counts only the trailing run', !resumed.act && resumed.rounds === 2, resumed)

    // confirmRounds=1 退化：任何一轮都动手（兼容旧行为）
    const eager = assessConfidence([], [entry('a'), entry('b')], { confirmRounds: 1 })
    check('confirmRounds=1 acts immediately (legacy parity)', eager.act && eager.required === 1, eager)
  }

  console.log('\n== environmentChanged：计数清零条件 ==')
  {
    const suspects = [entry('dsh-ops', '0.4.4'), entry('sage-mem')]
    check('same runtime & version ⇒ stable', !environmentChanged(histAt(['dsh-ops'], 1), '0.2.2-rc.1', suspects))
    const versionBump = [entry('dsh-ops', '0.5.0'), entry('sage-mem')]
    const withVersions = histAt(['dsh-ops'], 1)
    withVersions.suspectVersions = { 'dsh-ops': '0.4.4' }
    check('head plugin version changed ⇒ environment changed', environmentChanged(withVersions, '0.2.2-rc.1', versionBump))
    const rtBump = histAt(['dsh-ops'], 1)
    rtBump.runtimeVersion = '0.2.3'
    check('runtime changed ⇒ environment changed', environmentChanged(rtBump, '0.2.2-rc.1', suspects))
    check('no history ⇒ nothing changed', !environmentChanged(undefined, '0.2.2-rc.1', suspects))
    // 历史缺版本信息（旧 journal）⇒ 保守判定为「没变」：证据链不至于被误清
    const noVersion = histAt(['dsh-ops'], 1)
    delete (noVersion as Partial<CrashHistoryEntry>).runtimeVersion
    check('history without runtime info ⇒ conservatively stable', !environmentChanged(noVersion, '0.2.2-rc.1', suspects))
  }

  console.log('\n== reconcilePrepared：半成品对账 ==')
  {
    const prepared = [
      { bundle: 'disabled-already', preparedAt: '2026-11-07T00:00:00.000Z', crashSeq: 2 },
      { bundle: 'still-enabled', preparedAt: '2026-11-07T00:00:00.000Z', crashSeq: 2 },
      { bundle: 'uninstalled', preparedAt: '2026-11-07T00:00:00.000Z', crashSeq: 2 },
    ]
    const disk = new Map([
      ['disabled-already', false],
      ['still-enabled', true],
      // uninstalled 不在磁盘清单里
    ] as const)
    const rows = reconcilePrepared(prepared, disk)
    check('row per prepared entry', rows.length === 3, rows)
    check('actually disabled ⇒ confirmed', rows[0]?.outcome === 'confirmed', rows[0])
    check('still enabled ⇒ reverted', rows[1]?.outcome === 'reverted', rows[1])
    check('uninstalled ⇒ reverted (no disk record)', rows[2]?.outcome === 'reverted', rows[2])
    check('preparedAt/crashSeq carried through', rows.every((r) => r.preparedAt === prepared[0]?.preparedAt && r.crashSeq === 2), rows)
    check('empty prepared ⇒ empty report', reconcilePrepared([], disk).length === 0)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
