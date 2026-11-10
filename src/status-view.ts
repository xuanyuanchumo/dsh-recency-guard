/**
 * `status` 工具输出的**投影**（v0.13 从 index.ts 抽出以控复杂度）。
 *
 * ## 为什么单独成模块
 *
 * `status` 是「把磁盘事实摊平成命令窗口可读的形状」—— 纯投影，无控制流改变。
 * 但它的字段数随版本单调增长（v0.9 判定 / v0.10 版本与反馈 / v0.13 因子与共现），
 * 每次新增都往 index.ts 里加一处分支式构造，把它推到了 116（预算 100）。
 *
 * 抽出来之后：
 * - index.ts 只负责**取数**（读状态、算排名、读生命周期）；
 * - 本模块负责**定型**（字段取舍、诚实边界文案、切片上限）；
 * - 投影可被单测直接驱动（输入是窄接口，不需要 Guard 实例）。
 *
 * ## 纪律
 *
 * 1. **数据层不截断**：`suspectRanking` 给全量，切片（`lifecycle.steps.slice(-12)`）
 *    只用于「步骤流」这类有界观测面，且必须在文档里说清是窗口而非全量。
 * 2. **诚实边界**：旧版决策文件没有 `evidence` ⇒ `hasEvidence:false`，
 *    绝不把缺失渲染成 0。
 */

import type { GuardState } from './store.js'
import type { RecencyEntry } from './recency.js'
import type { CooccurrenceView, DecisionEvidenceView } from './decision-views.js'

/**
 * 生命周期视图（由 StageMachine 投影而来）。
 *
 * 字段用宽松类型（`string` / `readonly unknown[]`）而不是 `GuardStage` / `StepSpan[]`：
 * `lifecycleView()` 是宿主侧投影函数，它的返回类型本来就比内部状态机宽。
 * 在这里收窄会强迫投影函数改签名 —— 那是为一个纯展示模块去改数据源，
 * 方向反了。渲染层只需要「有 stage / 有 steps 可切片」。
 */
export interface LifecycleView {
  stage: string
  stabilityScore: number
  steps: readonly unknown[]
  openSteps: readonly string[]
  rejected: readonly unknown[]
  transitions: readonly unknown[]
}

/** status 投影所需的全部输入（窄接口，便于测试）。 */
export interface StatusInput {
  profile: string
  workspace: string
  projectKey: string
  dshVersion: string
  /** 插件自身版本；`null` = 自描述读取失败（诚实降级，不伪造版本号）。 */
  pluginVersion: string | null | undefined
  /** 问题反馈链接；`null` = 未在 package.json 登记（面板/命令窗口据此隐藏按钮，不放死链）。 */
  issuesUrl: string | null | undefined
  enabled: boolean
  state: GuardState
  ranked: readonly RecencyEntry[]
  experimentalSuspects: readonly string[]
  decisionFile: string
  decisionEvidence: DecisionEvidenceView
  cooccurrence: CooccurrenceView
  lifecycle: LifecycleView
  configEditorAvailable: boolean
}

/**
 * 构造 status 输出（纯函数）。
 *
 * `steps` 只保留最近 12 步、`rejected` 最近 5 条 —— 这是**窗口**不是全量。
 * `suspectRanking` 则保持全量：显示层截断是渲染策略，不该伪装成数据
 * （v0.8.1 修过的「报 N 只列 5」同族缺陷）。
 */
export function buildStatusOutput(input: StatusInput): Record<string, unknown> {
  const { state, lifecycle } = input
  return {
    profile: input.profile,
    // 命令窗口的隔离归因 —— 这次守护是哪个项目的事实。
    workspace: input.workspace,
    projectKey: input.projectKey,
    dshVersion: input.dshVersion,
    // 反馈入口：命令窗口往往是排障现场，那时用户不会想到去面板找按钮。
    pluginVersion: input.pluginVersion,
    issuesUrl: input.issuesUrl,
    enabled: input.enabled,
    crashedLastRun: state.crashedRun === true,
    lastBootMarker: state.bootMarker,
    lastExitCode: state.lastExitCode,
    crashSeq: state.crashSeq,
    autoDisabled: state.autoDisabled,
    stabilized: state.stabilized,
    restored: state.restored,
    decisionFile: input.decisionFile,
    // 恢复判定白盒：undefined = 本分区还没有崩溃决策发生过。
    lastRecoveryVerdict: state.lastRecoveryVerdict,
    suspectRanking: input.ranked,
    suspectTotal: input.ranked.length,
    experimentalSuspects: input.experimentalSuspects,
    decisionEvidence: input.decisionEvidence,
    cooccurrence: input.cooccurrence,
    lifecycle: {
      stage: lifecycle.stage,
      stabilityScore: lifecycle.stabilityScore,
      steps: lifecycle.steps.slice(-12),
      openSteps: lifecycle.openSteps,
      rejectedTransitions: lifecycle.rejected.slice(-5),
      lastTransition: lifecycle.transitions[lifecycle.transitions.length - 1] ?? null,
    },
    configEditorAvailable: input.configEditorAvailable,
  }
}
