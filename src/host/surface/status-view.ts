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

import type { GuardState } from '../data/store.ts'
import type { RecencyEntry } from '../risk/recency.ts'
import type { CooccurrenceView, DecisionEvidenceView } from '../guard/decision-views.ts'

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
  /**
   * 贝叶斯并行读数（v0.14 / M2）。
   *
   * 为什么命令窗口也要给：排障现场常在命令窗口，若只有面板能看到
   * 第二套读数，用户会以为系统只有一张黑盒结论（07 §2.3 要求「两套并列」）。
   */
  bayes: readonly BayesView[]
  /**
   * 误伤校准读数（v0.14 / M1）。
   *
   * `null` = 该分区没有自动关闭记录（不是「误伤率 0」）。
   */
  calibration: CalibrationView | null
  lifecycle: LifecycleView
  configEditorAvailable: boolean
}

/** 单个插件的贝叶斯读数投影（命令窗口形态）。 */
export interface BayesView {
  bundle: string
  /** 样本不足时为 false —— 命令窗口据此显示「不可判定」而非一个数字。 */
  defined: boolean
  /** 可判定时的人类可读摘要，否则为不可判定原因。 */
  label: string
  /** 贝叶斯重排分（仅可判定时有值）。 */
  score: number | null
  /** 原 riskScore（并行保留，供用户对照两套读数）。 */
  riskScore: number | null
  /** 后验均值与 95% 区间（仅可判定时）。 */
  mean: number | null
  lower95: number | null
  upper95: number | null
}

/** 误伤校准投影（命令窗口形态）。 */
export interface CalibrationView {
  /** 误伤率读数（`null` = 样本不足，不可判定）。 */
  rate: number | null
  /** 分母：自动关闭次数。 */
  autoDisables: number
  /** 分子：用户主动放行次数。 */
  falsePositives: number
  /** 系统自动恢复次数（不算误伤，但要展示以解释差异）。 */
  systemRestored: number
  /**
   * 证据链缺口（v0.15 TD-1）：`restore` 声明恢复了某插件，但 journal 里
   * 找不到对应的 `enable` 记录。
   *
   * 为什么必须单独展示而不是并进 `unattributed`：后者是「用户开了一个
   * 守护没关过的插件」—— 那是**正常的用户行为**；前者是**记录本身损坏**
   * （事件被截断、手改 journal、跨轮清理）。把两者混在一个计数器里，
   * 面板会把「数据坏了」读成「用户在操作」，从而让误伤率悄悄失真。
   */
  unattributedRestores: number
  /** 校准前 / 后的确认轮数。 */
  base: number
  required: number
  /** 人话解释（为什么调整）。 */
  explanation: string
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
    bayes: input.bayes,
    calibration: input.calibration,
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
