/**
 * 观测/分派模块直接单测（T15-04）：`decision-views` / `official-observe` / `tool-dispatch`。
 *
 * 为什么补这条：三者都是「旁路观测/分派」—— 失败必须降级而不是抛。
 * 但此前没有直接 import 的测试 ⇒ 这些 best-effort 分支从未进过变异池。
 *
 * 覆盖边界（不假装覆盖）：
 * - `official-observe` 用注入的 Store 窄接口，**不**覆盖真实 dsh 的 pluginManager
 *   事件源（那是宿主接线，需要真机）；
 * - `tool-dispatch` 用结构化 deps，**不**覆盖 action 表与工具 schema enum 的
 *   契约对账（那在 `tests/contract/capability.test.ts`）；
 * - `decision-views` 只驱动纯投影；Weibull 拟合的数值正确性属于 survival 模块的测试。
 */
import {
  buildCooccurrenceSample,
  buildDecisionSuspects,
  hazardShapeFromJournal,
  mergeCooccurrenceSample,
  projectCooccurrence,
  projectDecisionEvidence,
} from '../../src/host/guard/decision-views.js'
import {
  observationChanged,
  observationEvents,
  observeOfficialExperimental,
  pickOfficialExperimental,
} from '../../src/host/guard/official-observe.js'
import {
  dispatchToolAction,
  isMutatingAction,
  renderToolOutcome,
  TOOL_ACTIONS,
  type ToolDispatchDeps,
} from '../../src/host/surface/tool-dispatch.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n== decision-views：观测投影全部 best-effort ==')
{
  // 4 个崩溃时刻才够拟合（3 个间隔是两参数 Weibull 的下限）；不足 ⇒ undefined。
  const times = ['2026-11-11T00:00:00.000Z', '2026-11-11T00:10:00.000Z', '2026-11-11T00:20:00.000Z', '2026-11-11T00:30:00.000Z']
  const events = times.map((t, i) => ({ kind: 'crash-detected' as const, t, bundle: `dsh-${i}` }))
  const shape = hazardShapeFromJournal(events as never)
  check('4 个崩溃时刻能算出形态（或诚实 undefined）', shape === undefined || typeof shape.weibullShape === 'number', shape)
  check('不足 4 个时刻 ⇒ undefined（不硬拟合）', hazardShapeFromJournal(events.slice(0, 3) as never) === undefined)
  check('非崩溃事件被忽略', hazardShapeFromJournal([{ kind: 'note', t: times[0] }] as never) === undefined)
  // 时间戳 getter 抛异常 ⇒ 必须降级为 undefined，不能把异常冒到崩溃路径。
  const throwing = {
    kind: 'crash-detected',
    get t(): string {
      throw new Error('bad timestamp')
    },
  }
  let hazardThrew: unknown
  let hazard: unknown
  try {
    hazard = hazardShapeFromJournal([throwing] as never)
  } catch (error) {
    hazardThrew = error
  }
  check('事件读取抛错时降级为 undefined（不冒泡）', hazardThrew === undefined && hazard === undefined, hazardThrew)

  const emptyCooc = projectCooccurrence([])
  check('空共现样本 ⇒ 计数 0 且给出 label', emptyCooc.samples === 0 && typeof emptyCooc.label === 'string', emptyCooc)
  check('空共现样本不允许加权（诚实边界）', emptyCooc.mayWeight.allowed === false, emptyCooc.mayWeight)
  const poisoned = {
    get length(): number {
      throw new Error('poisoned')
    },
  }
  const failed = projectCooccurrence([poisoned] as never)
  check('共现投影抛错 ⇒ 显式不可判定（不是「无差异」）', failed.label === '共现样本读取失败，不可判定', failed.label)
  check('共现投影抛错 ⇒ 三个读数为 null', failed.activeHitRate === null && failed.inactiveHitRate === null && failed.hitRateDelta === null)

  const evidence = projectDecisionEvidence([])
  check('无嫌疑 ⇒ hasEvidence:false（不渲染零值）', evidence.hasEvidence === false && evidence.items.length === 0, evidence)

  const ranked = [{ bundle: 'dsh-a', lastChangeAt: 't', lastKind: 'install' as const }]
  const sample = buildCooccurrenceSample({ at: 't', officialActive: [], ranked: ranked as never, disabled: ['dsh-x'] })
  check('样本构造带 at/时间戳字段', typeof (sample as { at?: unknown }).at === 'string', sample)
  const merged = mergeCooccurrenceSample({ schemaVersion: 1, samples: [] }, sample, 200)
  check('样本并入后存储里多一条', merged.samples.length === 1, merged.samples.length)
  const suspects = buildDecisionSuspects(ranked as never, [] as never, [])
  check('决策 suspects 是数组（空事件时为空）', Array.isArray(suspects), suspects.length)
}

console.log('\n== official-observe：只观测不关闭，且失败降级 ==')
{
  const bundles = [
    { name: '@deepseek-ai/dsh-experimental-voice-input-bundle', version: '1.0.0', enabled: true },
    { name: '@deepseek-ai/dsh-base', version: '9.9.9', enabled: true },
    { name: 'dsh-experimental-third-party', version: '2.0.0', enabled: true },
    { name: '@deepseek-ai/dsh-experimental-off', version: '3.0.0', enabled: false },
  ]
  const picked = pickOfficialExperimental(bundles)
  check('只挑官方 scope + experimental 命名', picked.size === 2 && picked.has('@deepseek-ai/dsh-experimental-voice-input-bundle'), [...picked.keys()])
  check('非官方实验命名不进观测面', !picked.has('dsh-experimental-third-party'))
  check('enabled:false 被保留为 enabled=false', picked.get('@deepseek-ai/dsh-experimental-off')?.enabled === false)

  const prev = new Map([['a', { version: '1', enabled: true }]])
  check('集合大小变化 ⇒ changed', observationChanged(prev, new Map([...prev, ['b', { version: '1', enabled: true }]])))
  check('版本变化 ⇒ changed', observationChanged(prev, new Map([['a', { version: '2', enabled: true }]])))
  check('启用态变化 ⇒ changed', observationChanged(prev, new Map([['a', { version: '1', enabled: false }]])))
  check('完全一致 ⇒ 不变', !observationChanged(prev, new Map([['a', { version: '1', enabled: true }]])))

  const events = observationEvents(picked)
  check('每个组件一条 official-observe 事件', events.length === 2 && events.every((e) => e.kind === 'official-observe'), events.length)
  check('事件 detail 反映启用态', events.some((e) => e.detail === 'disabled') || events.every((e) => e.detail === 'enabled'), events.map((e) => e.detail))

  const logs: string[] = []
  const failingStore = {
    readObservationSnapshot: async () => new Map(),
    append: async () => {
      throw new Error('append boom')
    },
    writeObservationSnapshot: async () => {},
    writeVersionedBackup: async () => {},
  }
  let threw: unknown
  let result: { changed: boolean; count: number } | undefined
  try {
    result = await observeOfficialExperimental(bundles, failingStore as never, { versionedBackups: false, backupRetain: 3 }, (m) => logs.push(m))
  } catch (error) {
    threw = error
  }
  check('观测写失败不冒泡（best effort）', threw === undefined, threw)
  check('观测写失败仍报告 changed/count', result?.changed === true && result?.count === 2, result)
  check('观测写失败留下可诊断日志', logs.some((m) => m.includes('官方实验插件观测写入失败')), logs)

  const backupLogs: string[] = []
  const backupFailingStore = {
    readObservationSnapshot: async () => new Map(),
    append: async () => {},
    writeObservationSnapshot: async () => {},
    writeVersionedBackup: async () => {
      throw new Error('backup boom')
    },
  }
  let backupThrew: unknown
  try {
    await observeOfficialExperimental(bundles, backupFailingStore as never, { versionedBackups: true, backupRetain: 3 }, (m) => backupLogs.push(m))
  } catch (error) {
    backupThrew = error
  }
  check('状态备份写失败不冒泡', backupThrew === undefined, backupThrew)
  check('备份失败留下日志', backupLogs.some((m) => m.includes('状态备份失败')), backupLogs)

  const quietStore = {
    readObservationSnapshot: async () => pickOfficialExperimental(bundles),
    append: async () => {
      throw new Error('should not be called')
    },
    writeObservationSnapshot: async () => {},
    writeVersionedBackup: async () => {},
  }
  const quiet = await observeOfficialExperimental(bundles, quietStore as never, { versionedBackups: false, backupRetain: 3 })
  check('无变化 ⇒ 不写 journal（changed:false）', quiet.changed === false && quiet.count === 2, quiet)
}

console.log('\n== tool-dispatch：审计先落盘、失败不阻塞动作 ==')
{
  check('会改状态的 action 被标记为 mutating', ['recover', 'restore', 'reenable', 'archive'].every((a) => isMutatingAction(a)), [...['recover', 'restore', 'reenable', 'archive']].filter((a) => !isMutatingAction(a)))
  check('只读 action 不算 mutating', ['status', 'history', 'backups', 'archives'].every((a) => !isMutatingAction(a)))
  check('action 表覆盖工具 schema 的全部 action', ['status', 'history', 'recover', 'restore', 'reenable', 'backups', 'archive', 'archives'].every((a) => a in TOOL_ACTIONS), Object.keys(TOOL_ACTIONS))

  const order: string[] = []
  const deps: ToolDispatchDeps = {
    status: async () => ({ profile: 'p', dshVersion: '0.17.0', enabled: true, crashedLastRun: false, crashSeq: 0, stabilized: true, autoDisabled: [], suspectRanking: [], experimentalSuspects: [] }),
    recoverNow: async () => {
      order.push('recover')
      return { disabled: ['dsh-x'], note: 'ok' }
    },
    restore: async () => ({ reenabled: [], keptDisabled: [], note: 'ok' }),
    reenable: async (bundle: string) => ({ bundle, reenabled: true, hasConfigBackup: false }),
    archiveReset: async () => ({ archiveDir: '/a', count: 0, skipped: [] }),
    archives: async () => [],
    store: {
      readJournal: async () => [],
      listBackups: async () => [],
      listVersionedBackupBundles: async () => [],
      append: async () => {
        order.push('audit')
      },
    },
  }
  const statusOut = await dispatchToolAction(deps, 'status', {})
  check('status 分派返回 ToolOutcome（有 lines）', Array.isArray(statusOut.lines), statusOut)
  const recoverOut = await dispatchToolAction(deps, 'recover', { reason: '人工确认' })
  check('recover 分派成功', Array.isArray(recoverOut.lines), recoverOut)
  check('审计行先于动作（崩溃时也留得下证据）', order[0] === 'audit' && order[1] === 'recover', order)
  let unknownThrew: unknown
  try {
    await dispatchToolAction(deps, 'nope', {})
  } catch (error) {
    unknownThrew = error
  }
  check('未知 action 抛错（调用错误不是业务失败）', unknownThrew instanceof Error && String(unknownThrew.message).includes('未知操作'), unknownThrew)
  let bundleThrew: unknown
  try {
    await dispatchToolAction(deps, 'reenable', {})
  } catch (error) {
    bundleThrew = error
  }
  check('reenable 缺 bundle 抛错', bundleThrew instanceof Error && String(bundleThrew.message).includes('需要 bundle 参数'), bundleThrew)

  const auditFailing: ToolDispatchDeps = {
    ...deps,
    recoverNow: async () => ({ disabled: ['dsh-y'], note: 'still ran' }),
    store: {
      ...deps.store,
      append: async () => {
        throw new Error('audit boom')
      },
    },
  }
  let auditThrew: unknown
  let auditOut: Awaited<ReturnType<typeof dispatchToolAction>> | undefined
  try {
    auditOut = await dispatchToolAction(auditFailing, 'recover', {})
  } catch (error) {
    auditThrew = error
  }
  check('审计写失败不阻塞动作（观测设施无否决权）', auditThrew === undefined && Array.isArray(auditOut?.lines), auditThrew)
  check('renderToolOutcome 把 outcome 渲染成文本', typeof renderToolOutcome(statusOut) === 'string' && renderToolOutcome(statusOut).length > 0)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)