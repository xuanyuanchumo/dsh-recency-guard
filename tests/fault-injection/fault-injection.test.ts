/**
 * E4.2 故障注入：注入坏插件，跑守护矩阵，断言检出率 100%（研究文档 07 §5.2）。
 *
 * ## 判据（先想清楚再动手）
 *
 * 「检出」不是「日志里有报错」，而是守护自己在**真实宿主启动路径**上产出了
 * 崩溃证据并据此决策。两条通道的语义不同，断言必须分开写：
 *
 * | 通道 | 触发形态 | 证据 |
 * |---|---|---|
 * | 哨兵 | 进程以非零码退出（exit 处理器会跑） | `crashed.consumed`、crash-detected(exitCode=1)、crashSeq≥1、decision.disable 含坏 bundle |
 * | 残留标记 + pidAlive | 进程没跑到 exit 处理器（SIGKILL/OOM/原生崩溃） | crash-detected(exitCode=null, signal=unobserved)、abnormalExitSeq≥1、lastRecoveryVerdict.evidence=probabilistic |
 *
 * 反向用例的要求更硬：好插件、以及**entry 级 apply 抛错（宿主自隔离，只是
 * warning）**都不许产生任何崩溃证据。没有这一半，「全部报错即检出」的假实现
 * 也能拿满分。
 *
 * ## 为什么要真跑子进程 + 真启动策略
 *
 * 本项目实测过两种假阳性，都在这层被堵死：
 * 1. 「夹具的顶层代码根本没被 import」—— 所以每个夹具第一行写 beacon，检测侧
 *    先断言 beacon 存在，证明注入真的发生过；
 * 2. 「entry 级失败被当成崩溃」—— 所以致命性交给真实 `dsh-app-boot`：
 *    required entry 失败 ⇒ StartupError + exit 1；普通 entry 失败 ⇒ warning。
 *    同一个夹具（apply throw / 缺失依赖）在两种 entry id 下分别充当正向与反向用例。
 *
 * ## 隔离（07 §5.4 硬要求）
 *
 * 每个用例一个 `mkdtemp` 目录，全部读写限制在里面；测试结束删除。绝不碰
 * `~/.dsh/profiles/**`（本文件里根本不存在指向它的路径）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  bootNotes,
  createSandbox,
  crashEvents,
  FAULT_CASES,
  readArtifacts,
  runtimeReadiness,
  sandboxRoot,
  spawnTsx,
  waitForFile,
  type FaultCase,
  type GuardArtifacts,
  type Sandbox,
} from './harness.ts'
import { pidAlive } from '../../src/sentinel.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail, null, 0))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface InjectionOutcome {
  code: number | null
  signal: string | null
  ready: boolean
  timedOut: boolean
  stdout: string
  stderr: string
  report: Record<string, unknown> | null
}

/** 注入轮：起子进程跑真实宿主启动；kill 形态由父进程 SIGKILL。 */
async function inject(testCase: FaultCase, sandbox: Sandbox): Promise<InjectionOutcome> {
  const { child, done } = spawnTsx(join(import.meta.dirname, 'boot-child.ts'), {
    FI_PROFILE: sandbox.dir,
    FI_WORKSPACE: sandbox.workspace,
    FI_GUARD_SPEC: sandbox.guardSpec,
    FI_BAD_SPEC: sandbox.badSpec,
    FI_ENTRY_ID: testCase.entryId,
    FI_MODE: testCase.mode,
    FI_READY_FILE: sandbox.readyFile,
    FI_ARMED_FILE: sandbox.armedFile,
    FI_REPORT_FILE: sandbox.reportFile,
    FI_BEACON_FILE: sandbox.beaconFile,
  })

  let ready = false
  if (testCase.mode === 'kill') {
    ready = await waitForFile(sandbox.armedFile, 20_000)
    const pid = child.pid ?? -1
    child.kill('SIGKILL')
    const result = await done
    // 等 pid 真的消失再进检测轮：否则残留标记会被判成 concurrent（另一个实例还开着），
    // 那是正确的第二通道语义，但会让「强杀」用例测到别的分支。
    for (let i = 0; i < 100 && pid > 0 && pidAlive(pid); i += 1) await sleep(20)
    return { ...result, ready, report: readReport(sandbox) }
  }

  const result = await done
  ready = existsSync(sandbox.readyFile)
  return { ...result, ready, report: readReport(sandbox) }
}

function readReport(sandbox: Sandbox): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(sandbox.reportFile, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 检测轮：崩溃之后的新进程启动（判定「上一轮怎么死的」）。 */
async function detect(sandbox: Sandbox): Promise<{ code: number | null; stdout: string; stderr: string; done: string | null }> {
  // 重试一次即可越过「崩溃留下的失效锁未满 5 秒年龄阈值」的窗口：
  // 实测崩溃恰好发生在状态写期间时，恢复启动的首次 updateState 会等满 3s 后
  // 超时并重试一次，期间 bootMarker 写不进去 ⇒ 子进程自报 boot-not-observed。
  // 这是被测系统的既有降级行为（不是测试要掩盖的失败），但重试能让断言继续
  // 校验「检测事实本身」，而不是被一次瞬时锁竞争卡住。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(6000)
    try {
      rmSync(sandbox.detectDoneFile, { force: true })
    } catch {
      /* 上一次没有产物 */
    }
    const { done } = spawnTsx(join(import.meta.dirname, 'detect-child.ts'), {
      FI_PROFILE: sandbox.dir,
      FI_WORKSPACE: sandbox.workspace,
      FI_GUARD_SPEC: sandbox.guardSpec,
      FI_DETECT_DONE: sandbox.detectDoneFile,
    })
    const result = await done
    let marker: string | null = null
    try {
      marker = readFileSync(sandbox.detectDoneFile, 'utf8')
    } catch {
      marker = null
    }
    if (result.code === 0 && marker !== null && marker !== 'boot-not-observed') {
      return { code: result.code, stdout: result.stdout, stderr: result.stderr, done: marker }
    }
    if (attempt === 2) return { code: result.code, stdout: result.stdout, stderr: result.stderr, done: marker }
  }
  // 循环必然在上面 return；这里只是让类型收敛。
  return { code: null, stdout: '', stderr: '', done: null }
}

/** 守护产物的完整判据；返回命中/未命中与逐条理由（不吞掉差异）。 */
function judge(testCase: FaultCase, artifacts: GuardArtifacts): { detected: boolean; reasons: string[] } {
  const reasons: string[] = []
  const state = artifacts.state ?? {}
  const autoDisabled = Array.isArray(state.autoDisabled) ? (state.autoDisabled as Array<Record<string, unknown>>) : []
  const disable = Array.isArray(artifacts.decision?.disable) ? (artifacts.decision!.disable as string[]) : []
  const crashes = crashEvents(artifacts.journal)

  if (testCase.channel === 'sentinel') {
    if (artifacts.sentinelConsumed?.exitCode !== 1) reasons.push('哨兵未落盘/退出码不是 1')
    if (!crashes.some((e) => e.exitCode === 1)) reasons.push('journal 无 crash-detected(exitCode=1)')
    if (typeof state.crashSeq !== 'number' || state.crashSeq < 1) reasons.push(`crashSeq=${String(state.crashSeq)}`)
    if (!crashes.some((e) => Array.isArray(e.suspects) && (e.suspects as string[]).includes(testCase.bundle)))
      reasons.push('crash-detected.suspects 不含注入的 bundle')
    if (!disable.includes(testCase.bundle)) reasons.push(`decision.disable=${JSON.stringify(disable)}`)
    if (!autoDisabled.some((d) => d.name === testCase.bundle)) reasons.push('state.autoDisabled 不含注入的 bundle')
    return { detected: reasons.length === 0, reasons }
  }

  if (testCase.channel === 'abnormal') {
    if (artifacts.sentinelPresent) reasons.push('哨兵存在（强杀不该留下哨兵）')
    if (artifacts.sentinelConsumed !== null) reasons.push('存在 crashed.consumed（说明走了哨兵通道，不是第二通道）')
    if (!crashes.some((e) => e.exitCode === null && e.signal === 'unobserved')) reasons.push('journal 无 crash-detected(exitCode=null, signal=unobserved)')
    if (typeof state.abnormalExitSeq !== 'number' || state.abnormalExitSeq < 1)
      reasons.push(`abnormalExitSeq=${String(state.abnormalExitSeq)}`)
    const verdict = state.lastRecoveryVerdict as Record<string, unknown> | undefined
    if (verdict?.evidence !== 'probabilistic') reasons.push(`lastRecoveryVerdict.evidence=${String(verdict?.evidence)}`)
    return { detected: reasons.length === 0, reasons }
  }

  // 反向：任何崩溃证据都算误判。
  if (crashes.length > 0) reasons.push(`出现 ${crashes.length} 条 crash-detected（好插件/自隔离失败不得判崩溃）`)
  if (state.crashSeq !== 0) reasons.push(`crashSeq=${String(state.crashSeq)}`)
  if ((state.abnormalExitSeq ?? 0) !== 0) reasons.push(`abnormalExitSeq=${String(state.abnormalExitSeq)}`)
  if (state.bootMarker !== null && state.bootMarker !== undefined) reasons.push('bootMarker 未清（干净退出应清掉）')
  if (artifacts.sentinelPresent) reasons.push('存在未消费的 crashed 哨兵')
  if (disable.length > 0) reasons.push(`decision.disable=${JSON.stringify(disable)}`)
  return { detected: false, reasons }
}

async function main() {
  console.log('\n== E4.2 故障注入（真实 cordis Loader + dsh-app-boot 启动策略）==')
  const readiness = runtimeReadiness()
  if (!readiness.ready) {
    // 诚实跳过：明确写出「未评估」与原因，绝不伪装成通过。
    console.log(`\n  SKIP  本层未评估（不是 PASS）：${readiness.reason}`)
    console.log('        先 `npm run extract-runtime` 再跑：npx tsx tests/fault-injection/fault-injection.test.ts')
    console.log('        （默认退出码 1，把「没验证」暴露给 CI；FI_ALLOW_SKIP=1 才允许 0）\n')
    process.exit(process.env.FI_ALLOW_SKIP === '1' ? 0 : 1)
  }
  check(readiness.reason, true)

  const results: Array<{ testCase: FaultCase; detected: boolean; reasons: string[]; out: InjectionOutcome; sandbox: Sandbox }> = []
  let reverseClean = 0

  const only = process.env.FI_ONLY
  for (const testCase of FAULT_CASES.filter((c) => !only || c.id.includes(only))) {
    const sandbox = createSandbox(testCase)
    // 结构隔离断言：沙箱必须在 .tmp 下（不是 ~/.dsh/profiles）。
    check(
      `[${testCase.id}] 沙箱在项目 .tmp 内（不碰主力 profile）`,
      resolve(sandbox.dir).startsWith(resolve(sandboxRoot) + sep),
      sandbox.dir,
    )

    console.log(`\n-- ${testCase.id} --`)
    console.log(`   ${testCase.why}`)

    let ok = true
    const fail = (name: string, detail?: unknown) => {
      ok = false
      check(`[${testCase.id}] ${name}`, false, detail)
    }

    const out = await inject(testCase, sandbox)

    // 注入真的发生了：夹具的顶层代码被 import 过（防「夹具从未加载」假阳性）。
    check(`[${testCase.id}] 注入探针落盘（fixture 真的被 import）`, existsSync(sandbox.beaconFile), sandbox.beaconFile)
    check(`[${testCase.id}] 守护启动信号（bootMarker 已写）`, out.ready, { code: out.code, stderr: out.stderr.slice(-400) })

    // 退出形态必须与用例声明的形态一致 —— 否则「检出」是别的死法换来的。
    if (testCase.mode === 'fatal') {
      check(`[${testCase.id}] 宿主 fatal 退出码 1`, out.code === 1 && out.signal === null && !out.timedOut, {
        code: out.code,
        signal: out.signal,
        report: out.report,
        stderr: out.stderr.slice(-500),
      })
      if (testCase.id === 'apply-throw-required' || testCase.id === 'missing-dep-required') {
        check(
          `[${testCase.id}] 致命性来自 dsh-app-boot 的启动策略（audit 抛 StartupError）`,
          out.report?.phase === 'audit-threw',
          out.report,
        )
      }
      if (testCase.id === 'async-throw-after-apply') {
        // 夹具在 apply 成功后异步抛错：脚本不该写 audit-threw/仍然活着 的报告。
        check(
          `[${testCase.id}] 死亡来自异步 throw（不是脚本自己抛的）`,
          out.report === null,
          out.report,
        )
      }
    } else if (testCase.mode === 'kill') {
      check(`[${testCase.id}] SIGKILL 生效（无退出码）`, out.code === null, { code: out.code, signal: out.signal })
      check(`[${testCase.id}] 强杀前已完成一次正常启动`, out.report?.phase === 'ready-for-kill', out.report)
    } else {
      check(`[${testCase.id}] 宿主存活并干净退出（退出码 0）`, out.code === 0 && !out.timedOut, {
        code: out.code,
        report: out.report,
        stderr: out.stderr.slice(-500),
      })
      check(`[${testCase.id}] 脚本确认「活过了启动」`, out.report?.phase === 'survived', out.report)
      // 自隔离语义：entry 级失败留下 FAILED(3) / fiber 缺失，而进程照常启动。
      const entries = Array.isArray(out.report?.entries) ? (out.report!.entries as Array<Record<string, unknown>>) : []
      const injected = entries.find((e) => e.id === testCase.entryId)
      if (testCase.id === 'apply-throw-optional') {
        check(`[${testCase.id}] 自隔离：entry 状态 FAILED(3) 但宿主未崩`, injected?.state === 3, entries)
      } else if (testCase.id === 'missing-dep-optional') {
        check(`[${testCase.id}] 自隔离：import 失败 entry 无 fiber（未激活）但宿主未崩`, injected?.state === null, entries)
      } else {
        check(`[${testCase.id}] 好插件 entry 正常 ACTIVE(2)`, injected?.state === 2, entries)
      }
    }

    // 检测轮：新进程启动，读取上一轮的死亡事实。
    const detection = await detect(sandbox)
    check(`[${testCase.id}] 检测轮启动完成`, detection.code === 0 && detection.done !== null, {
      code: detection.code,
      done: detection.done,
      stdout: detection.stdout.slice(-800),
      stderr: detection.stderr.slice(-400),
    })

    const artifacts = readArtifacts(sandbox.dir)
    check(`[${testCase.id}] 守护分区目录存在`, artifacts.partitionDir !== null, sandbox.dir)
    // 两次启动各留一条启动 note：证明「注入轮」和「检测轮」都真的被守护记录过。
    check(`[${testCase.id}] journal 记录了两轮启动`, bootNotes(artifacts.journal).length >= 2, bootNotes(artifacts.journal).length)

    const verdict = judge(testCase, artifacts)
    results.push({ testCase, detected: verdict.detected, reasons: verdict.reasons, out, sandbox })

    if (testCase.expectDetected) {
      check(`[${testCase.id}] 守护检出（${testCase.channel} 通道）`, verdict.detected, verdict.reasons)
    } else {
      if (verdict.detected) {
        ok = false
        check(`[${testCase.id}] 好插件/自隔离失败被误判为崩溃`, false, verdict.reasons)
      }
      else reverseClean += 1
      check(`[${testCase.id}] 无误判（无任何崩溃证据）`, verdict.reasons.length === 0, verdict.reasons)
    }

    // 清理：只在用例通过时删沙箱；失败则保留现场供人取证。
    if (ok) {
      try {
        rmSync(sandbox.dir, { recursive: true, force: true })
        check(`[${testCase.id}] 临时沙箱已清理`, !existsSync(sandbox.dir))
      } catch (error) {
        check(`[${testCase.id}] 临时沙箱已清理`, false, String(error))
      }
    } else {
      console.log(`  INFO  保留失败现场：${sandbox.dir}`)
    }
  }

  // ---------- 汇总：检出率是硬指标，不允许「大部分通过」 ----------
  const crashCases = results.filter((r) => r.testCase.expectDetected)
  const reverseCases = results.filter((r) => !r.testCase.expectDetected)
  const detectedCount = crashCases.filter((r) => r.detected).length
  const rate = crashCases.length === 0 ? 0 : (detectedCount / crashCases.length) * 100

  console.log('\n== 汇总 ==')
  console.log(`  注入的坏插件类别：`)
  for (const r of crashCases) console.log(`    - ${r.testCase.id}（${r.testCase.channel} 通道）：${r.detected ? '检出' : '未检出'}`)
  console.log(`  检出率：${detectedCount}/${crashCases.length} = ${rate.toFixed(0)}%（判据 100%）`)
  console.log(`  反向用例：${reverseClean}/${reverseCases.length} 无误判`)
  check('检出率 100%（E4.2 判据）', detectedCount === crashCases.length, { detectedCount, total: crashCases.length })
  check('反向用例全部不误判', reverseClean === reverseCases.length, { reverseClean, total: reverseCases.length })

  // 每条通道都必须真被覆盖到（防止全靠哨兵一条腿交差）。
  if (only === undefined) {
    check('哨兵通道有检出个案', crashCases.some((r) => r.testCase.channel === 'sentinel' && r.detected))
    check('异常终止通道有检出个案', crashCases.some((r) => r.testCase.channel === 'abnormal' && r.detected))
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()