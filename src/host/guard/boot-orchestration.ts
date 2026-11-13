import type { Store } from '../data/store.ts'
import type { GuardStage } from '../core/lifecycle.ts'
import { readSentinel, clearSentinel } from './sentinel.ts'
import { assessAbnormalExit, holdReason } from './abnormal-boot.ts'
import { abnormalExitEvents } from './boot-notes.ts'
import { shouldRestoreAfterBoot } from './recovery-policy.ts'
import { reconcileCrashedState } from './state-reconcile.ts'
import { readPartitionIndex, registerPartition, writePartitionIndexLocked, type PartitionIndex } from '../core/isolation.ts'
import { describeError } from '../risk/recency.ts'

/**
 * 启动编排（T14-05，从 index.ts 纯提取）。
 *
 * ## 为什么单独成文件
 *
 * `bootInner()` 是「按上一轮的死亡形态分流」的密集分支段（哨兵 / 异常终止 /
 * 并发 / 干净启动四种结局，每条都有自己的一套处理与文案），而 `index.ts`
 * 是组合根 —— 复杂度预算按文件计分，组合根不该为这段内部分支付费。
 *
 * ## 提取纪律：纯搬家，不改语义
 *
 * 判据顺序是**语义**，不是风格：crashedLastRun（哨兵在）> exitClass==='abnormal'
 * > recovering（名单里有关闭记录）> 干净启动。顺序一换，
 * 「关了嫌疑插件 → 又死一次（无哨兵）」会被读成「崩溃已过」⇒ 把刚建立的隔离
 * 亲手拆掉（v0.12.1 修过的二阶缺陷）。
 *
 * ## 依赖用窄接口注入
 *
 * 本模块不认识 Guard：它只要求「能读写存储、能迁移状态机、能记日志」。
 * 这样它可以在没有 Guard 实例的情况下被单测驱动（构造 5 个回调即可）。
 */
export interface BootOrchestrationDeps {
  store: Store
  profileDir: string
  workspace: string
  /** 状态机的最小面（白盒迁移由调用方负责记录）。 */
  machine: { transition(stage: GuardStage, reason: string): unknown }
  /** 日志出口（失败时也不能抛）。 */
  warn: (message: string) => void
  /** 两阶段记录对账（reconcilePreparedOnBoot）。 */
  reconcilePrepared: () => void
  /** 变更检测（install/update/remove 事实）。 */
  recordChanges: () => Promise<void>
  /** 官方实验插件观测（只记录不关闭）。 */
  observeOfficialExperimental: () => Promise<void>
  /** 延后自动恢复（时序约束在 Guard 里，见 scheduleAutoRestore）。 */
  scheduleAutoRestore: () => void
  /** 异常终止累计到阈值后的恢复（复用 recover 通道）。 */
  applyAbnormalRecovery: (abnormalSeqNext: number) => Promise<void>
  /**
   * 级联刹车回滚（v0.18 T16-12）：消费 state.rollbackArmed 标记，把被
   * 自动禁用的插件恢复到崩溃前状态（仅保留头号嫌疑）。由崩溃路径置位、
   * 启动路径执行 —— 崩溃路径只有同步 IO 预算，回滚要调插件管理器的
   * 异步接口，只能延后到下一轮启动。
   */
  executeRollback: () => Promise<void>
  /**
   * 分区索引的加锁提交（默认就是 `writePartitionIndexLocked`）。
   *
   * 为什么留一个可选注入点：它是启动路径上**唯一的 IO 失败兜底**分支
   * （失败只 warn + 留 degraded 证据，不能让宿主起不来）。不注入就只能靠
   * 真把磁盘写坏才能覆盖这条分支，而那样做测的是环境不是契约。
   * 缺省时行为与直接调用导入实现**逐位一致**。
   */
  commitPartitionIndex?: (profileDir: string, index: PartitionIndex) => Promise<void>
}

/**
 * 执行启动编排。
 *
 * 失败不在这里吞：外层 `boot()` 负责「降级留痕 + 绝不外抛」，因为
 * 「boot 失败不能让宿主起不来」这条纪律属于组合根，而不是这段分流逻辑。
 */
export async function runBootOrchestration(deps: BootOrchestrationDeps): Promise<void> {
  await deps.store.init()
  // 分区索引的加锁幂等提交（T14-05，收口 TD-4）。
  //
  // `apply()` 是同步的，那里只能做「原子写 + 写前并集」——它把丢条目的窗口
  // 从整个 RMW 周期压到「读最新 → rename」之间，但没有消除。启动到这里
  // 已经有 await，于是用跨进程文件锁再提交一次：合并幂等（同 key 覆盖、
  // 新 key 追加），所以重复提交不放大事实；而所有并发实例只要都经过这里，
  // 就不会再出现实测见过的「4 个子进程 → 索引里只剩 2 个」。
  try {
    const { index: currentIndex } = registerPartition(readPartitionIndex(deps.profileDir), deps.workspace)
    const commit = deps.commitPartitionIndex ?? writePartitionIndexLocked
    await commit(deps.profileDir, currentIndex)
  } catch (err) {
    deps.warn(`[recency-guard] 分区索引加锁提交失败（保留同步写的结果）：${describeError(err)}`)
    // 降级必须留**可复核**证据：只进 logger 的失败在重启后不可查，
    // 而「分区索引丢了」会让人在排障时怀疑隔离机制而不是这条写失败。
    deps.store.appendSync({
      kind: 'note',
      detail: `[recency-guard] 分区索引加锁提交失败（保留同步写的结果）：${describeError(err)}`,
      degraded: true,
    })
  }

  const state = await deps.store.readState()
  const sentinel = readSentinel(deps.store.partitionPath)
  if (sentinel) clearSentinel(deps.store.partitionPath)
  // 哨兵在场 ⇒ 上一轮崩了：本次是恢复轮，它发布的决策不许被覆盖。
  const crashedLastRun = sentinel !== null

  // ---------- 崩溃状态对账（T14-08 真机缺陷修复） ----------
  // 崩溃处理器是同步写，锁不住它；启动期那个「干净启动清零」的 updateState
  // 若挂在锁里等写回，会在崩溃写之后落地，把 crashSeq/autoDisabled 覆盖回旧值。
  // 决策文件是权威（它决定下次启动拦谁），所以这里按它补账 —— 幂等。
  const reconciled = reconcileCrashedState(state, deps.store.readDecisionSync(), crashedLastRun)
  if (reconciled.patch !== null) {
    state.crashSeq = reconciled.patch.crashSeq
    state.autoDisabled = reconciled.patch.autoDisabled
    await deps.store.updateState((s) => ({ ...s, ...reconciled.patch }))
    deps.store.appendSync({ kind: 'note', detail: reconciled.detail })
    deps.warn(`[recency-guard] ${reconciled.detail}`)
  }

  // ---------- 第二条检测通道：哨兵缺席的异常终止（v0.12.1） ----------
  // 判定集中在 abnormal-boot.ts：四种结局 + 留痕文案 + 计数。这里只做分流。
  const abnormal = assessAbnormalExit(
    {
      sentinelPresent: sentinel !== null,
      staleMarker: state.bootMarker,
      currentPid: process.pid,
    },
    state.abnormalExitSeq ?? 0,
  )
  const abnormalSeqNext = abnormal.nextSeq
  // 分流留痕由 boot-notes.ts 决定 kind 与文案（if/else 移出启动主线）。
  for (const event of abnormalExitEvents(abnormal)) deps.store.appendSync(event)
  const exitClass = abnormal.exitClass

  // 两阶段对账（v0.9.0）：上一轮可能留下 prepared 记录（崩溃打断或正常
  // 退出没走到升级）。按磁盘现状归类：autoDisabled 里有 = 关闭已走到
  // pluginManager ⇒ confirmed；不在 ⇒ reverted（证据链保留）。
  deps.reconcilePrepared()

  // 崩溃恢复已在崩溃那一轮发布过决策并记录了被关的插件。
  const recovering = state.autoDisabled.length > 0

  // ---------- 级联刹车回滚（v0.18 T16-12） ----------
  // 崩溃路径置了 rollbackArmed ⇒ 本轮启动先把被误伤的插件放回来，
  // 只保留头号嫌疑。**必须在恢复分支之前执行**：否则下面
  // shouldRestoreAfterBoot / recovering 的分支会把「待回滚」误读为
  // 「正常恢复中」，跳过回滚动作。
  if (state.rollbackArmed) {
    deps.store.appendSync({
      kind: 'note',
      detail: `[recency-guard] 启动检测到级联刹车回滚标记（上一轮升级到顶）⇒ 执行回滚到崩溃前启动状态`,
    })
    await deps.executeRollback()
  }

  // 状态机迁移（白盒透明：每次迁移都带原因与时刻）。
  if (crashedLastRun) {
    deps.machine.transition('crashed', `上次运行以退出码 ${sentinel?.exitCode ?? '未知'} 结束`)
  } else {
    deps.machine.transition('monitoring', '启动时未发现上次崩溃')
  }

  await deps.store.updateState((s) => ({
    ...s,
    bootMarker: { startedAt: new Date().toISOString(), pid: process.pid },
    crashedRun: false,
    lastExitCode: undefined,
    // 计数随每轮启动重写：abnormal 累加，clean/concurrent 归零。
    // 不在别处清零 ⇒ 「计数从哪来」只有一条路径可查。
    abnormalExitSeq: abnormalSeqNext,
  }))

  try {
    await deps.recordChanges()
  } catch (err) {
    const message = `[recency-guard] 记录插件变更失败：${describeError(err)}`
    deps.warn(message)
    // 同上：静默吞错会让「变更检测失效」变成不可查的暗面 —— 而它决定
    // 嫌疑排名的输入。落一条 note 并打上 `degraded` 机器可读标记。
    deps.store.appendSync({ kind: 'note', detail: message, degraded: true })
  }

  // 官方实验插件观测（只记录不关闭）：与 recordChanges 同级 try/catch ——
  // 观测通道失效不能影响变更记录与恢复主流程。
  try {
    await deps.observeOfficialExperimental()
  } catch (err) {
    const message = `[recency-guard] 官方实验插件观测失败：${describeError(err)}`
    deps.warn(message)
    deps.store.appendSync({ kind: 'note', detail: message, degraded: true })
  }

  // ---------- 恢复/升级的分支（v0.12.1 重排） ----------
  // 判据顺序是语义问题，不是风格问题：
  //   crashedLastRun（哨兵在）> exitClass==='abnormal'（标记残留且 pid 已死）
  //   > recovering（名单里有被关的插件）> 干净启动。
  // 「上一轮是否活过了启动」只能由**上一轮的退出方式**回答；此前用
  // `!crashedLastRun` 当「活过了」的代理，在哨兵通道下成立（没哨兵=干净退出），
  // 但新增通道之后不再成立：异常终止同样没有哨兵。若沿用旧条件，
  // 「关了嫌疑插件 → 又死一次（无哨兵）」会被读成「崩溃已过」而把插件
  // 全部恢复 —— 那等于把刚建立的隔离亲手拆掉，正是崩溃循环最需要的反面。
  if (shouldRestoreAfterBoot({ recovering, exitClass }) && !crashedLastRun) {
    // 宿主带着嫌疑插件关闭活过了启动 ⇒ 崩溃已过。恢复除首要嫌疑外的全部，
    // 首要嫌疑保持关闭直到人确认。
    deps.warn(`[recency-guard] 上次崩溃已通过阻止加载 ${state.autoDisabled.map((d) => d.name).join(', ')} 恢复。`)
    deps.scheduleAutoRestore()
  } else if (recovering) {
    // 仍在崩溃循环里（哨兵在 / 上一轮异常终止 / 并发实例语义不明）：
    // 决策保持原样，恢复会把嫌疑插件重新放进来、把崩溃直接带回来。
    deps.warn(`[recency-guard] ${holdReason({ crashedLastRun, exitClass, abnormalSeqNext })}，保持嫌疑插件关闭。`)
  } else if (exitClass === 'abnormal') {
    await deps.applyAbnormalRecovery(abnormalSeqNext)
  } else {
    // 干净启动：崩溃计数归零 —— 但**只在它没被本轮崩溃改过时**。
    //
    // 为什么是 CAS 而不是无条件写 0（T14-08 真机缺陷修复）：boot 是异步的，
    // 它的 `updateState` 可能在**崩溃之后**才拿到执行权（进程退出时挂起的
    // 锁等待/线程池写入可能仍然落地）。那时无条件写 0 会把退出处理器刚写下的
    // `crashSeq=1` 抹掉 —— 实测表现就是 「关了插件但 crashSeq=0」，
    // 下一轮判定失去升级依据，崩溃循环回到「永远关 0 个」。
    // 用「与本轮启动时读到的一致就归零」把这条竞态封死：只有仍是本次启动的
    // 初始值时才能归零，任何更晚的崩溃计数都不会被覆盖。
    await deps.store.updateState((s) => (s.crashSeq === state.crashSeq ? { ...s, crashSeq: 0 } : s))
  }
}