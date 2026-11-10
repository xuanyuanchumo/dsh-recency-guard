/**
 * 恢复决策的置信分级与两阶段对账回归（v0.9.0）。
 *
 * 被测对象是 `recovery-policy.ts` 的三个纯函数 —— 它们决定「要不要关
 * 一个无辜插件」与「半成品状态怎么对账」，是本插件里最不该出错的判定。
 * 夹具数据取自真实场景：多嫌疑连续复现、头号更换、唯一嫌疑、空名单。
 */
import { assessConfidence, environmentChanged, reconcilePrepared, classifyAbnormalExit, abnormalExitDecision, shouldRestoreAfterBoot, type CrashHistoryEntry } from '../../src/host/guard/recovery-policy.ts'
import type { RecencyEntry } from '../../src/host/risk/recency.ts'

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

    // v0.11.1 紧急修复回归：启动检测记录（嫌疑为空）不得打断连续计数。
    // 实测场景：每次启动先写「上次运行以退出码 1 结束」（无 suspects），
    // 随后崩溃决策写带 suspects 的记录 —— 历史末尾总是空记录，streak 恒 1。
    const mixed = [histAt(['a', 'b']), histAt([]), histAt([])]
    const afterStartup = assessConfidence(mixed, [entry('a'), entry('b')], { confirmRounds: 2 })
    check('suspect-less startup records do not reset the streak', afterStartup.act && afterStartup.rounds === 2, afterStartup)

    // 兜底升级（v0.11.1）：连续 3 次崩溃即使计数仍为 1/2 也强制行动。
    const escalated = assessConfidence([], [entry('a'), entry('b')], { confirmRounds: 2, crashSeq: 3 })
    check('crashSeq >= 3 escalates to act (safety net)', escalated.act && escalated.rounds === 1, escalated)
    check('escalation label explains the safety net', escalated.label.includes('兜底升级'), escalated.label)
    const stillObserving = assessConfidence([], [entry('a'), entry('b')], { confirmRounds: 2, crashSeq: 2 })
    check('crashSeq=2 keeps observing (below threshold)', !stillObserving.act, stillObserving)
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

  // ---------- v0.12.1 异常终止通道（哨兵盲区） ----------
  // P0 缺口（用户旅程实测）：SIGKILL / OOM / 断电 / 原生崩溃**不运行**
  // process.on('exit') ⇒ 没有哨兵 ⇒ 每一轮都被当成「干净启动」，
  // crashSeq 永远归零 ⇒ 崩溃循环失去逐级升级的依据。
  // 修法沿用 v0.9 的概率性分级：累计 confirmRounds 轮才动手，
  // 因为「bootMarker 残留」同样可由用户主动杀进程/关机产生。
  {
    const self = 999
    const alive = { sentinelPresent: false, staleBootMarker: { pid: 1234 }, stalePidAlive: true, currentPid: self }
    const dead = { sentinelPresent: false, staleBootMarker: { pid: 1234 }, stalePidAlive: false, currentPid: self }
    const clean = { sentinelPresent: false, staleBootMarker: null, stalePidAlive: false, currentPid: self }
    const withSentinel = { sentinelPresent: true, staleBootMarker: { pid: 1234 }, stalePidAlive: false, currentPid: self }
    const sameProc = { sentinelPresent: false, staleBootMarker: { pid: self }, stalePidAlive: true, currentPid: self }

    check('classifyAbnormalExit: 无残留标记 ⇒ clean', classifyAbnormalExit(clean) === 'clean')
    check('classifyAbnormalExit: 标记残留 + pid 已死 ⇒ abnormal', classifyAbnormalExit(dead) === 'abnormal')
    // 并发实例（桌面 + web 同 profile 同时开）不是崩溃：误判会关掉无辜插件。
    check('classifyAbnormalExit: 标记残留但 pid 活着 ⇒ concurrent（不计崩溃）', classifyAbnormalExit(alive) === 'concurrent')
    // 有哨兵时走既有通道，本通道必须归零，否则一次崩溃记两笔、升级翻倍。
    check('classifyAbnormalExit: 哨兵在场 ⇒ clean（不与既有通道重复计数）', classifyAbnormalExit(withSentinel) === 'clean')
    // 同进程重入 boot（热重载/HMR）：实测形态 —— 装完新版后同一 pid 又写启动记录。
    // 必须与 concurrent 分开，否则会报「检测到另一个实例」这种假归因。
    check('classifyAbnormalExit: 标记 pid == 本进程 ⇒ self-reload（热重载不是并发实例）', classifyAbnormalExit(sameProc) === 'self-reload')

    // shouldRestoreAfterBoot：二阶缺陷的机器门（上一轮若是异常终止，绝不能恢复）
    check('shouldRestoreAfterBoot: 无隔离记录 ⇒ 不恢复', shouldRestoreAfterBoot({ recovering: false, exitClass: 'clean' }) === false)
    check('shouldRestoreAfterBoot: 干净退出 + 有隔离 ⇒ 恢复（崩溃已过）', shouldRestoreAfterBoot({ recovering: true, exitClass: 'clean' }) === true)
    // 关键：异常终止同样「没有哨兵」，若沿用旧条件 recovering && !crashedLastRun 会恢复，
    // 等于亲手拆掉刚建立的隔离 ⇒ 崩溃循环原地复活。
    check('shouldRestoreAfterBoot: 上一轮异常终止 ⇒ **不**恢复', shouldRestoreAfterBoot({ recovering: true, exitClass: 'abnormal' }) === false)
    check('shouldRestoreAfterBoot: 并发实例 ⇒ 不恢复（语义不明不冒险）', shouldRestoreAfterBoot({ recovering: true, exitClass: 'concurrent' }) === false)
    check('shouldRestoreAfterBoot: 热重载 ⇒ 不恢复（同上）', shouldRestoreAfterBoot({ recovering: true, exitClass: 'self-reload' }) === false)

    // 阈值语义：第 1 轮只观察（残留标记可能是人为杀进程），到 confirmRounds 才动手。
    const d1 = abnormalExitDecision(1, 2, 2)
    check('abnormalExitDecision: 第 1 轮不动手（概率性证据）', d1.act === false && d1.targets === 0, d1)
    const d2 = abnormalExitDecision(2, 2, 2)
    check('abnormalExitDecision: 达阈值即行动且关 1 个', d2.act === true && d2.targets === 1, d2)
    // 逐级扩大与哨兵通道同形（+1 轮多关 1 个），封顶 maxAutoDisable。
    const d3 = abnormalExitDecision(3, 2, 2)
    check('abnormalExitDecision: 再多一轮关 2 个', d3.act === true && d3.targets === 2, d3)
    const d9 = abnormalExitDecision(9, 2, 2)
    check('abnormalExitDecision: 封顶 maxAutoDisable（不无限扩大隔离面）', d9.targets === 2, d9)
    const dZero = abnormalExitDecision(0, 2, 2)
    check('abnormalExitDecision: 计数 0 不动手', dZero.act === false && dZero.rounds === 0, dZero)
    // confirmRounds=1 的极端配置必须「一轮即行动」，而不是永不行动。
    const dOnce = abnormalExitDecision(1, 1, 2)
    check('abnormalExitDecision: confirmRounds=1 时一轮即行动', dOnce.act === true && dOnce.targets === 1, dOnce)
    // 非法阈值（0/负）不能把门变成「永不行动」或「无限关闭」。
    const dBad = abnormalExitDecision(1, 0, 0)
    check('abnormalExitDecision: 非法阈值被钳制（required≥1、targets≥1）', dBad.required === 1 && dBad.act === true && dBad.targets === 1, dBad)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
