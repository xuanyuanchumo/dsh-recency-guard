/**
 * 崩溃状态对账（T14-08 真机缺陷修复）。
 *
 * ## 现场（实测产物，不是推断）
 *
 * `apply-throw-required` 偶发失败时，`decision.json` 的 `disable` 有坏插件、
 * journal 有 `crash-detected.suspects`，但 `state.json` 是 `crashSeq=0` +
 * `autoDisabled=[]`。原因是崩溃处理器（同步写）与启动期最后一个
 * `updateState`（异步、挂锁）交叠：锁只能串行化遵守锁的写者，锁不住
 * 退出处理器的同步写，于是后者落地后被旧快照覆盖。
 *
 * 修法：**以决策文件为真相**，下一次带哨兵的启动把丢失的投影补回来
 * （幂等、只在哨兵在场且决策是 crash-recovery 时生效）。
 *
 * ## 断言纪律
 *
 * 原因字符串抄被测实现的原文（`terminatedBy` 之外不再猜近义词）；
 * 每条不补账的情形都单独断言 —— 补账条件放宽比不补账更危险：
 * 它会无中生有地制造一次「自动关闭」记录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type GuardState, type PrebootDecision } from '../../src/host/data/store.ts'
import { reconcileCrashedState } from '../../src/host/guard/state-reconcile.ts'
import { runBootOrchestration } from '../../src/host/guard/boot-orchestration.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function stateOf(overrides: Partial<GuardState> = {}): GuardState {
  return { bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [], ...overrides }
}

function decisionOf(overrides: Partial<PrebootDecision> = {}): PrebootDecision {
  return {
    capturedAt: '2026-11-11T00:00:00.000Z',
    suspects: [],
    disable: ['fi-apply-throw'],
    reason: 'crash-recovery',
    crashSeq: 1,
    ...overrides,
  }
}

async function main(): Promise<void> {
  console.log('\n== 纯函数：补账判据 ==')
  {
    // 命中：哨兵在、决策是 crash-recovery、state 丢了投影。
    const hit = reconcileCrashedState(stateOf(), decisionOf(), true, '2026-11-11T01:00:00.000Z')
    check('lost projection is reconciled', hit.patch !== null, hit)
    check('crashSeq is restored to at least 1', hit.patch?.crashSeq === 1, hit.patch)
    check('the disabled bundle is re-added', JSON.stringify(hit.patch?.autoDisabled.map((d) => d.name)) === '["fi-apply-throw"]', hit.patch)
    check('the restored entry keeps the crash reason', hit.patch?.autoDisabled[0]?.reason === 'auto-recency', hit.patch?.autoDisabled[0])
    check('detail names the missing bundle', (hit.detail ?? '').includes('fi-apply-throw'), hit.detail)

    // 不补：state 已经一致（幂等）。
    const already = reconcileCrashedState(
      stateOf({ crashSeq: 1, autoDisabled: [{ name: 'fi-apply-throw', disabledAt: 't', reason: 'auto-recency', crashSeq: 1 }] }),
      decisionOf(),
      true,
    )
    check('consistent state needs no reconcile (idempotent)', already.patch === null, already)

    // 不补：没有哨兵（上一轮可能干净退出，决策来自恢复流程）。
    check('no sentinel ⇒ no reconcile', reconcileCrashedState(stateOf(), decisionOf(), false).patch === null)
    // 不补：决策不是崩溃恢复发布的。
    check('reason=none ⇒ no reconcile', reconcileCrashedState(stateOf(), decisionOf({ reason: 'none' }), true).patch === null)
    // 不补：disable 为空（观察轮本来就不关人）。
    check('empty disable ⇒ no reconcile', reconcileCrashedState(stateOf(), decisionOf({ disable: [] }), true).patch === null)
    // 不补：决策文件缺失/损坏。
    check('missing decision ⇒ no reconcile', reconcileCrashedState(stateOf(), null, true).patch === null)

    // 只丢计数、投影还在 ⇒ 只补计数（不重复添加条目）。
    const onlySeq = reconcileCrashedState(
      stateOf({ crashSeq: 0, autoDisabled: [{ name: 'fi-apply-throw', disabledAt: 't', reason: 'auto-recency', crashSeq: 1 }] }),
      decisionOf(),
      true,
    )
    check('lost counter alone is repaired', onlySeq.patch?.crashSeq === 1, onlySeq.patch)
    check('existing entries are not duplicated', onlySeq.patch?.autoDisabled.length === 1, onlySeq.patch)
  }

  console.log('\n== 集成：带哨兵的启动会补回投影并留痕 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-reconcile-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      // 现场：哨兵在、决策有 disable、state 已被旧快照覆盖。
      await store.writeState(stateOf())
      store.writeDecisionSync(decisionOf())
      mkdirSync(store.partitionPath, { recursive: true })
      writeFileSync(join(store.partitionPath, 'crashed'), JSON.stringify({ at: 't', exitCode: 1, pid: 424242 }), 'utf8')

      await runBootOrchestration({
        store,
        profileDir: profile,
        workspace: 'D:/ws',
        machine: { transition: () => true },
        warn: () => undefined,
        reconcilePrepared: () => undefined,
        recordChanges: async () => undefined,
        observeOfficialExperimental: async () => undefined,
        scheduleAutoRestore: () => undefined,
        applyAbnormalRecovery: async () => undefined,
      })

      const repaired = await store.readState()
      check('boot repairs the lost crashSeq', repaired.crashSeq >= 1, repaired.crashSeq)
      check('boot repairs the lost autoDisabled', repaired.autoDisabled.some((d) => d.name === 'fi-apply-throw'), repaired.autoDisabled)
      check(
        'boot journals why it repaired (audit trail)',
        store.readJournalSync(100).some((e) => e.kind === 'note' && String(e.detail ?? '').startsWith('状态对账：')),
        store.readJournalSync(100).map((e) => e.detail),
      )
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 反向：没有哨兵时不补账（不得无中生有一次关闭） ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-reconcile-clean-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      await store.writeState(stateOf())
      store.writeDecisionSync(decisionOf())
      await runBootOrchestration({
        store,
        profileDir: profile,
        workspace: 'D:/ws',
        machine: { transition: () => true },
        warn: () => undefined,
        reconcilePrepared: () => undefined,
        recordChanges: async () => undefined,
        observeOfficialExperimental: async () => undefined,
        scheduleAutoRestore: () => undefined,
        applyAbnormalRecovery: async () => undefined,
      })
      const after = await store.readState()
      check('clean boot does not resurrect a disabled bundle', after.autoDisabled.length === 0, after.autoDisabled)
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