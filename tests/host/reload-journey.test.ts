/**
 * 热更新重载的用户旅程（v0.13 T11-20）。
 *
 * ## 为什么重载容易出事
 *
 * 宿主热更新插件时会在**同一个 pid 里**重新跑 `apply()`/`boot()`。此前
 * （v0.12.1 之前）守护把「bootMarker 残留」一律当成「上一轮崩溃」，于是：
 * - 装完新版 → 同 pid 又写一条启动记录 → 下次判定报「检测到另一个实例」；
 * - 用户去查一个根本不存在的第二进程（假归因）；
 * - 更糟：把热重载计成崩溃，误关插件。
 *
 * 修复是 `classifyAbnormalExit` 的 `self-reload` 分支（残留 pid == 本进程）。
 * 本旅程把它钉在四个**真实重载形态**上，并验证第二道防线：
 * 崩溃路径是同步的、不受重载影响。
 *
 * ## 旅程覆盖
 *
 * J1 同 pid 重入 ⇒ self-reload（不是崩溃、不是并发）
 * J2 同 pid 重入不计入 abnormalExitSeq（归零）
 * J3 不同 pid 且那个 pid 还活着 ⇒ concurrent（也不是崩溃）
 * J4 不同 pid 且已死 ⇒ abnormal（**是**崩溃，计数 +1）
 * J5 有哨兵时走既有通道（不重复计数）
 * J6 反复重载 N 次后计数仍为 0（不会累积成假崩溃）
 */
import { classifyAbnormalExit, assessConfidence } from '../../src/guard/recovery-policy.ts'
import { assessAbnormalExit } from '../../src/guard/abnormal-boot.ts'
import type { RecencyEntry } from '../../src/risk/recency.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const SELF = 4242

function classify(input: {
  sentinelPresent?: boolean
  stalePid?: number | null
  alive?: boolean
}): string {
  return classifyAbnormalExit({
    sentinelPresent: input.sentinelPresent ?? false,
    staleBootMarker: input.stalePid === null || input.stalePid === undefined ? null : { pid: input.stalePid },
    stalePidAlive: input.alive ?? false,
    currentPid: SELF,
  })
}

function main() {
  console.log('\n== J1 同 pid 重入 ⇒ self-reload ==')
  check('残留 pid == 本进程 ⇒ self-reload', classify({ stalePid: SELF }) === 'self-reload')
  check('self-reload 不是 abnormal', classify({ stalePid: SELF }) !== 'abnormal')
  check('self-reload 不是 concurrent（不做假归因）', classify({ stalePid: SELF }) !== 'concurrent')

  console.log('\n== J2 同 pid 重入不计入异常计数 ==')
  {
    const verdict = assessAbnormalExit(
      { sentinelPresent: false, staleMarker: { startedAt: new Date().toISOString(), pid: SELF }, currentPid: SELF },
      5, // 之前已经累计了 5 轮（模拟不相关的历史）
    )
    check('退出分类是 self-reload', verdict.exitClass === 'self-reload', verdict.exitClass)
    check('计数归零（不累积假崩溃）', verdict.nextSeq === 0, verdict.nextSeq)
    check('留痕说明了原因', verdict.selfReloadDetail !== null && verdict.selfReloadDetail.includes('重新加载'), verdict.selfReloadDetail)
    check('不产生 abnormal 详情（不乱记 crash-detected）', verdict.abnormalDetail === null)
  }

  console.log('\n== J3 不同 pid 且还活着 ⇒ concurrent ==')
  check('另一个实例在跑 ⇒ concurrent', classify({ stalePid: 9999, alive: true }) === 'concurrent')
  {
    // 必须注入 alive 探针：真实 pidAlive(9999) 在本机大概率是 false，
    // 那样这条会退化成 abnormal —— 测的就不是 concurrent 分支了。
    const verdict = assessAbnormalExit(
      {
        sentinelPresent: false,
        staleMarker: { startedAt: new Date().toISOString(), pid: 9999 },
        currentPid: SELF,
        alive: () => true,
      },
      3,
    )
    check('concurrent 不计数', verdict.nextSeq === 0, verdict.nextSeq)
    check('留痕说明「另一个实例仍在运行」', verdict.concurrentDetail?.includes('另一个实例') === true, verdict.concurrentDetail)
  }

  console.log('\n== J4 不同 pid 且已死 ⇒ abnormal（这才是真崩溃）==')
  check('残留 pid 已死 ⇒ abnormal', classify({ stalePid: 9999, alive: false }) === 'abnormal')
  {
    // 同样注入探针：不把「9999 在本机恰好不存在」当成平台事实来断言。
    const verdict = assessAbnormalExit(
      {
        sentinelPresent: false,
        staleMarker: { startedAt: new Date().toISOString(), pid: 9999 },
        currentPid: SELF,
        alive: () => false,
      },
      0,
    )
    check('abnormal 计数 +1', verdict.nextSeq === 1, verdict.nextSeq)
    check('abnormal 产生详情（进 journal 成为崩溃证据）', verdict.abnormalDetail !== null)
  }

  console.log('\n== J5 有哨兵 ⇒ 走既有通道，本通道不重复计数 ==')
  check('哨兵在场 ⇒ clean（既有通道已记）', classify({ sentinelPresent: true, stalePid: 9999, alive: false }) === 'clean')
  {
    const verdict = assessAbnormalExit(
      { sentinelPresent: true, staleMarker: { startedAt: new Date().toISOString(), pid: 9999 }, currentPid: SELF },
      2,
    )
    check('哨兵在场时计数归零（不重复记两笔）', verdict.nextSeq === 0, verdict.nextSeq)
    check('不产生 abnormal 详情', verdict.abnormalDetail === null)
  }

  console.log('\n== J6 反复重载 10 次后计数仍为 0 ==')
  {
    let seq = 0
    for (let i = 0; i < 10; i += 1) {
      const verdict = assessAbnormalExit(
        { sentinelPresent: false, staleMarker: { startedAt: new Date().toISOString(), pid: SELF }, currentPid: SELF },
        seq,
      )
      seq = verdict.nextSeq
    }
    check('10 次热重载后 abnormalExitSeq 仍为 0', seq === 0, seq)
  }

  console.log('\n== J7 重载后置信判定不受影响（不误关插件）==')
  {
    // 重载会写 journal note，不应把 streak 打断或伪造崩溃证据。
    const suspects: RecencyEntry[] = [
      { bundle: 'a-plugin', lastChangeAt: '2026-11-09T00:00:00.000Z', lastKind: 'install' },
      { bundle: 'b-plugin', lastChangeAt: '2026-11-08T00:00:00.000Z', lastKind: 'install' },
    ]
    // 无崩溃历史 ⇒ streak = 1 < confirmRounds(2) ⇒ 观察轮，不关插件。
    const verdict = assessConfidence([], suspects, { confirmRounds: 2 })
    check('无崩溃历史 ⇒ 观察轮（热重载不制造崩溃证据）', verdict.act === false, verdict)
    check('streak 从 1 起算', verdict.rounds === 1, verdict.rounds)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
