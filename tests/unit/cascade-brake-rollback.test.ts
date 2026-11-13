/**
 * 级联刹车 + 崩溃前回滚（v0.18 T16-12）—— 用户场景驱动。
 *
 * ## 场景（用户原话提炼）
 *
 * DSH + 桌面版下载插件后无法启动，安全模式/禁用/救援都试过还是崩溃；
 * 本插件的自动禁用会逐轮加深，**封顶后永远停在「关 N 个」**——用户拿到
 * 的是「越关越空的 profile」，而真正的问题插件被淹没。用户要求：
 * 出现崩溃循环场景后，重新使用本插件时要自动启用崩溃前的插件启动状态，
 * 有问题进行禁用（本插件要减少崩溃和崩溃后禁用重启的兜底）。
 *
 * ## 钉住的行为
 *
 * 1. **判据同源**：哨兵通道（assessConfidence + escalationExhausted）与
 *    异常终止通道（abnormalExitDecision）共用同一刹车判据 —— 两条通道
 *    各自写一套「到顶怎么办」迟早漂移。
 * 2. **升级语义**：第 confirmRounds 轮起逐级扩大（关 1、2、…、cap），
 *    升级步数用满（over ≥ cap）⇒ 刹车，act=false、targets=0、rollback=true。
 * 3. **回滚动作**（rollbackToPreCrash）：把 autoDisabled 里除头号嫌疑外的
 *    全部重新启用（恢复崩溃前启动状态），头号嫌疑保持关闭；失败者如实留
 *    在名单待重试（不谎报成功）。
 * 4. **确定性证据不回滚**：唯一嫌疑 / 声明命中时第 1 轮即行动，不受刹车
 *    影响（刹车只防「越关越空」，不防「证据确凿的精准隔离」）。
 * 5. **决策收敛**：回滚后决策文件的 disable 名单只剩头号嫌疑，守护行
 *    据此拦截，名单与实际启用状态一致。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abnormalExitDecision, assessConfidence, escalationExhausted } from '../../src/host/guard/recovery-policy.ts'
import { abnormalRecoveryVerdict } from '../../src/host/guard/abnormal-boot.ts'
import { rollbackToPreCrash } from '../../src/host/guard/recovery-actions.ts'
import type { RecencyEntry } from '../../src/host/risk/recency.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function entry(bundle: string): RecencyEntry {
  return { bundle, version: '1.0.0', lastChangeAt: '2026-01-01T00:00:00.000Z', lastKind: 'install' }
}

async function main(): Promise<void> {
  console.log('\n== 判据同源（escalationExhausted 与 abnormalExitDecision 等价）==')
  {
    // 刹车触发：seq >= confirmRounds + cap。seq=4（=2+2）⇒ 刹车；seq=3 不刹。
    check('escalationExhausted(3,2,2)=false（over=1 < cap）', escalationExhausted(3, 2, 2) === false)
    check('escalationExhausted(4,2,2)=true（over=2 ≥ cap）', escalationExhausted(4, 2, 2) === true)
    const d3 = abnormalExitDecision(3, 2, 2)
    check('abnormalExitDecision(3,2,2).rollback 与判据一致', d3.rollback === escalationExhausted(3, 2, 2))
    const d4 = abnormalExitDecision(4, 2, 2)
    check('abnormalExitDecision(4,2,2).rollback 与判据一致', d4.rollback === escalationExhausted(4, 2, 2))
  }

  console.log('\n== 异常终止通道的升级与刹车 ==')
  {
    const d2 = abnormalExitDecision(2, 2, 2)
    check('第 confirmRounds 轮：行动且关 1 个', d2.act === true && d2.targets === 1 && d2.rollback === false, d2)
    const d3 = abnormalExitDecision(3, 2, 2)
    check('再多一轮：关 2 个（到顶）', d3.act === true && d3.targets === 2 && d3.rollback === false, d3)
    const d5 = abnormalRecoveryVerdict(5, 2, 2, '@suspect/pkg')
    check('到顶后：act=false、targets=0、rollback=true', d5.act === false && d5.targets === 0 && d5.rollback === true, d5)
    check('回滚判定的人读标签点名「回滚」', d5.verdict.label.includes('回滚') && d5.verdict.rollback === true, d5.verdict)
    check('回滚判定保留头号嫌疑字段', d5.verdict.headSuspect === '@suspect/pkg', d5.verdict)
  }

  console.log('\n== 哨兵通道的级联刹车 ==')
  {
    const three = [entry('a'), entry('b'), entry('c')]
    // 无 maxAutoDisable ⇒ 旧调用方行为不变（不刹车）。
    const legacy = assessConfidence([], three, { confirmRounds: 2, crashSeq: 9 })
    check('不传 maxAutoDisable ⇒ 不刹车（旧行为不变）', legacy.rollback !== true, legacy)
    // 传 maxAutoDisable：crashSeq ≥ confirmRounds + cap ⇒ 刹车。
    const braked = assessConfidence([], three, { confirmRounds: 2, crashSeq: 6, maxAutoDisable: 2 })
    check('crashSeq 到顶 ⇒ 刹车且不行动', braked.rollback === true && braked.act === false, braked)
    check('刹车标签点名「级联刹车」', braked.label.includes('级联刹车'), braked.label)
    // 确定性证据（唯一嫌疑）不受刹车影响：证据确凿时不刹车。
    const deterministic = assessConfidence([], [entry('only')], { confirmRounds: 2, crashSeq: 9, maxAutoDisable: 2 })
    check('确定性证据（唯一嫌疑）不回滚', deterministic.act === true && deterministic.rollback !== true, deterministic)
  }

  console.log('\n== 回滚动作（rollbackToPreCrash）==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-rollback-'))
    try {
      const partition = join(profile, '.recency-guard', 'projects', 'part-a')
      mkdirSync(partition, { recursive: true })
      // 预置 state：3 个被关插件（头号嫌疑 c 在最后）。
      writeFileSync(
        join(partition, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          bootMarker: null,
          crashSeq: 5,
          autoDisabled: [
            { name: 'a', disabledAt: '2026-01-01T00:00:00.000Z', reason: 'auto-recency', crashSeq: 4 },
            { name: 'b', disabledAt: '2026-01-01T00:00:00.000Z', reason: 'auto-recency', crashSeq: 4 },
            { name: 'c', disabledAt: '2026-01-01T00:00:00.000Z', reason: 'auto-recency', crashSeq: 5 },
          ],
          stabilized: false,
          restored: [],
        }),
        'utf8',
      )

      // 记录插件管理器的调用事实：回滚必须真的调 setBundleEnabled(true)。
      const calls: Array<{ name: string; enabled: boolean }> = []
      const deps = {
        store: {
          readState: async () => JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8')),
          updateState: async (mutator: (s: { autoDisabled: Array<{ name: string }>; rollbackArmed?: boolean }) => unknown) => {
            const s = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8'))
            const next = mutator(s) as unknown as { autoDisabled: Array<{ name: string }>; rollbackArmed?: boolean }
            writeFileSync(join(partition, 'state.json'), JSON.stringify({ ...s, ...next }, null, 2), 'utf8')
          },
          append: async () => {},
          readBackup: async () => null,
        },
        pluginManager: {
          setBundleEnabled: async (name: string, enabled: boolean) => {
            calls.push({ name, enabled })
            return { application: 'applied' }
          },
          setPluginEnabled: async () => ({ application: 'applied' }),
        },
        suspectRows: async () => [],
        publishDecision: async () => {},
        transition: () => {},
        warn: () => {},
        toJson: (v: unknown) => v,
      }
      const result = await rollbackToPreCrash(deps as never, 'c')
      check('回滚启用除头号外的全部（a、b）', result.reenabled.length === 2 && result.reenabled.includes('a') && result.reenabled.includes('b'), result)
      check('头号嫌疑 c 保持关闭', result.keptDisabled.length === 1 && result.keptDisabled[0] === 'c', result)
      check('插件管理器收到启用调用且不含头号', calls.filter((c) => c.enabled).length === 2 && !calls.some((c) => c.name === 'c'), calls)
      // state 收敛：autoDisabled 只剩 c，回滚标记清除。
      const state = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8'))
      check('state.autoDisabled 收敛为仅头号嫌疑', state.autoDisabled.length === 1 && state.autoDisabled[0].name === 'c', state.autoDisabled)
      check('state.rollbackArmed 被清除', state.rollbackArmed === undefined, state)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 回滚的失败语义（不谎报成功）==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-rollback-fail-'))
    try {
      const partition = join(profile, '.recency-guard', 'projects', 'part-a')
      mkdirSync(partition, { recursive: true })
      writeFileSync(
        join(partition, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          bootMarker: null,
          crashSeq: 5,
          autoDisabled: [
            { name: 'a', disabledAt: '2026-01-01T00:00:00.000Z', reason: 'auto-recency', crashSeq: 5 },
            { name: 'b', disabledAt: '2026-01-01T00:00:00.000Z', reason: 'auto-recency', crashSeq: 5 },
          ],
          stabilized: false,
          restored: [],
        }),
        'utf8',
      )
      const deps = {
        store: {
          readState: async () => JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8')),
          updateState: async (mutator: (s: { autoDisabled: Array<{ name: string }>; rollbackArmed?: boolean }) => unknown) => {
            const s = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8'))
            const next = mutator(s) as unknown as { autoDisabled: Array<{ name: string }>; rollbackArmed?: boolean }
            writeFileSync(join(partition, 'state.json'), JSON.stringify({ ...s, ...next }, null, 2), 'utf8')
          },
          append: async () => {},
          readBackup: async () => null,
        },
        pluginManager: {
          // a 的管理器拒绝（未 applied）——必须如实留在名单，不谎报回滚成功。
          setBundleEnabled: async (name: string) => (name === 'a' ? { application: 'failed' } : { application: 'applied' }),
          setPluginEnabled: async () => ({ application: 'applied' }),
        },
        suspectRows: async () => [],
        publishDecision: async () => {},
        transition: () => {},
        warn: () => {},
        toJson: (v: unknown) => v,
      }
      const result = await rollbackToPreCrash(deps as never, 'b')
      check('管理器拒绝的插件如实留在失败名单', result.failed.length === 1 && result.failed[0] === 'a', result)
      check('成功回滚的（无：a 被拒、b 是头号）如实报告', result.reenabled.length === 0, result)
      check('头号嫌疑 b 与失败者 a 都留在关闭名单（note 如实）', result.keptDisabled.length === 2 && result.keptDisabled.includes('b') && result.keptDisabled.includes('a'), result)
      check('失败语义不谎报：note 点名未恢复项', result.note.includes('a'), result.note)
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
