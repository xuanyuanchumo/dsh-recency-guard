/**
 * 启动时的「上一轮怎么死的」判定与留痕（v0.12.1 从 index.ts 抽出）。
 *
 * ## 为什么单独成模块
 *
 * 这段逻辑有三个身份，留在 `boot()` 里只会让本来就偏长的启动路径更难读
 * （实测把 index.ts 热点推到 117，越过复杂度预算 100）：
 * 1. **信号源**：哨兵通道 + 残留 bootMarker 通道两条，判定见
 *    `recovery-policy.classifyAbnormalExit`；
 * 2. **留痕**：三种结局各写一条 journal（crash-detected / note），
 *    文案要能让人直接看懂「上次是怎么死的」；
 * 3. **计数**：只有 abnormal 累加，其余归零 —— 且必须随启动一起落盘，
 *    否则崩溃路径上（进程随即死亡）这个计数会丢。
 *
 * 抽出后 `boot()` 只负责编排（读状态 → 调这里 → 按结果分支），
 * 而这里的每一步都能被单测直接驱动。
 */

import { classifyAbnormalExit, abnormalExitDecision, type AbnormalExitClass } from './recovery-policy.ts'
import { pidAlive } from './sentinel.ts'

/** 判定所需的事实（全部来自磁盘 + 当前进程）。 */
export interface AbnormalExitInput {
  /** 哨兵是否在场（上一轮 exit 处理器跑到了）。 */
  sentinelPresent: boolean
  /** 状态里残留的 bootMarker（null = 干净退出）。 */
  staleMarker: { startedAt: string; pid: number } | null
  /** 当前进程 pid。 */
  currentPid: number
  /** 探测某个 pid 是否存活（默认 pidAlive；注入便于测试）。 */
  alive?: (pid: number) => boolean
}

/** 判定结果（纯数据，调用方据此分流）。 */
export interface AbnormalExitVerdict {
  /** 四种结局之一。 */
  exitClass: AbnormalExitClass
  /** 本轮之后的连续异常终止计数（abnormal 累加，其余归零）。 */
  nextSeq: number
  /** 上一轮存活时长（毫秒；无标记时 0）。 */
  ageMs: number
  /** 命中 abnormal 时的人读说明（其余情形为 null）。 */
  abnormalDetail: string | null
  /** 命中 concurrent 时的人读说明。 */
  concurrentDetail: string | null
  /** 命中 self-reload 时的人读说明（热重载不是并发实例，必须分开归因）。 */
  selfReloadDetail: string | null
}

/**
 * 判定上一轮的退出方式。
 *
 * 纯函数（只调注入的 alive 探针，不读盘不写盘）⇒ 四条分支都能被单测逐一驱动，
 * 不必等真机崩溃循环来暴露。
 */
export function assessAbnormalExit(input: AbnormalExitInput, previousSeq = 0, now = Date.now()): AbnormalExitVerdict {
  const alive = input.alive ?? pidAlive
  const marker = input.staleMarker
  const exitClass = classifyAbnormalExit({
    sentinelPresent: input.sentinelPresent,
    staleBootMarker: marker,
    // pid 存活复核：残留标记不携带死因，「另一个实例还开着」不是崩溃。
    stalePidAlive: marker === null ? false : alive(marker.pid),
    currentPid: input.currentPid,
  })
  const ageMs = marker === null ? 0 : Math.max(0, now - Date.parse(marker.startedAt))
  const nextSeq = exitClass === 'abnormal' ? Math.max(0, previousSeq) + 1 : 0
  const ageText = marker === null ? '?' : `${marker.startedAt}（约 ${Math.round(ageMs / 1000)}s 前）`
  return {
    exitClass,
    nextSeq,
    ageMs,
    // 记成 crash-detected 而不是新 kind：journal 的 kind 是跨层词汇表
    // （store / observations 的 FlowAction / 流动映射 / 面板着色四处），
    // 漏改任一处这条事实就在事件流里静默消失。退出码缺席写在 detail 里。
    abnormalDetail:
      exitClass === 'abnormal'
        ? `上次运行未留下退出码（哨兵缺席）—— 强杀/OOM/断电/原生崩溃之一；` +
          `启动于 ${ageText}，pid ${marker?.pid ?? '?'} 已不存在，连续异常终止 ${nextSeq} 轮`
        : null,
    concurrentDetail:
      exitClass === 'concurrent'
        ? `检测到同 profile 的另一个实例仍在运行（pid ${marker?.pid}）—— 不计为异常终止`
        : null,
    // 这条分支存在的意义是**防假归因** —— 实测：装完新版后同一 pid 又写了
    // 一条启动记录，若归到 concurrent 就会报「检测到另一个实例」，
    // 用户会去查一个根本不存在的第二个进程。
    selfReloadDetail:
      exitClass === 'self-reload' ? `同一进程内重新加载守护（pid ${input.currentPid}）—— 不计为异常终止` : null,
  }
}

/**
 * 一次异常终止判定的可观察结果（写进 state.lastRecoveryVerdict）。
 *
 * `rollback` 是可选字段（v0.18 T16-12）：旧版本 state 没有该字段时读方
 * 按「非回滚」处理，不构造假值 —— 与既有的「缺省 = 没有记录」纪律一致。
 */
export interface AbnormalRecoveryVerdict {
  at: string
  crashSeq: number
  evidence: 'probabilistic'
  rounds: number
  required: number
  act: boolean
  label: string
  headSuspect: string | null
  /** v0.18：true = 本轮触发级联刹车，应回滚到崩溃前启动状态（不新增禁用）。 */
  rollback?: boolean
}

/**
 * 按累计轮数给出「观察 / 行动 / 回滚」的判定，并投影成人读标签。
 *
 * 与哨兵通道共用 `abnormalExitDecision` 的阈值语义（第 1 轮观察、达
 * confirmRounds 才动手、逐级扩大并封顶、封顶后级联刹车回滚），区别只在于
 * 证据性质是概率性的。
 */
export function abnormalRecoveryVerdict(
  nextSeq: number,
  confirmRounds: number,
  maxAutoDisable: number,
  headSuspect: string | null,
  now = Date.now(),
): { act: boolean; targets: number; verdict: AbnormalRecoveryVerdict; rollback: boolean; detail: string } {
  const decision = abnormalExitDecision(nextSeq, confirmRounds, maxAutoDisable)
  const rollback = decision.rollback
  return {
    act: decision.act,
    targets: decision.targets,
    rollback,
    verdict: {
      at: new Date(now).toISOString(),
      crashSeq: nextSeq,
      evidence: 'probabilistic',
      rounds: decision.rounds,
      required: decision.required,
      act: decision.act,
      label: rollback
        ? `异常终止累计 ${decision.rounds} 轮，禁用已到顶 ⇒ 回滚到崩溃前启动状态（保留头号嫌疑）`
        : decision.act
          ? `异常终止累计 ${decision.rounds} 轮 ⇒ 关闭 ${decision.targets} 个`
          : `异常终止观察中（${decision.rounds}/${decision.required} 轮）`,
      headSuspect,
      ...(rollback ? { rollback: true } : {}),
    },
    detail: rollback
      ? `异常终止判定：连续 ${decision.rounds}/${decision.required} 轮，已连续 ${maxAutoDisable} 轮禁用未生效 ⇒ 级联刹车，回滚到崩溃前启动状态（仅保留头号嫌疑 ${headSuspect ?? '无'} 关闭）`
      : decision.act
        ? `异常终止判定：连续 ${decision.rounds}/${decision.required} 轮 ⇒ 行动，本轮关闭 ${decision.targets} 个（头号嫌疑 ${headSuspect ?? '无'}）`
        : `异常终止判定：观察中 ${decision.rounds}/${decision.required} 轮（残留标记也可能是人为杀进程，不动手）`,
  }
}

/**
 * 启动时要不要宣布「崩溃已过」的人读原因（v0.12.1）。
 *
 * 单独成函数而不是内联三元套三元：这段文案是**归因**，四种结局要说成
 * 四件不同的事（崩溃 / 异常终止 / 并发实例 / 热重载）。嵌套三元既难读，
 * 又容易在新增分支时静默落进错误的兜底文案 —— 那正是「假归因」的来源。
 */
export function holdReason(input: { crashedLastRun: boolean; exitClass: AbnormalExitClass; abnormalSeqNext: number }): string {
  switch (input.exitClass) {
    case 'abnormal':
      return `上一轮异常终止（连续 ${input.abnormalSeqNext} 轮）`
    case 'concurrent':
      return '同 profile 存在另一个运行中的实例'
    case 'self-reload':
      return '守护在同一进程内重载'
    default:
      return input.crashedLastRun ? '上次崩溃后启动' : '上一轮未正常退出'
  }
}
