/**
 * 客户端视图类型 —— 修正宿主契约里「声明为必有、运行时可空/可缺」的字段。
 *
 * ## 为什么需要它（v0.16 真机崩溃的根因）
 *
 * 宿主 `PanelSnapshot` 把 `stabilityScore` / `metrics` / `capability` 等
 * 声明为非空，但宿主有两条真实产出路径会发 null 或直接省略：
 *
 * - `partition-snapshot.ts`（跨分区只读视图）明确降级运行时字段：
 *   `stabilityScore: null`、`metrics: null`、`capability: null`、
 *   `markov: null`，且**整段省略** `decisionSuspects` / `calibration` /
 *   `bayes` / `cooccurrence`（只读视图不承诺这些事实）；
 * - `Metric<T>.defined === true` **不等于**子字段非空：`intervals.value.cv`
 *   在「间隔样本 < 2」时是 null（宿主类型本身就这么声明）。
 *
 * 类型若照抄宿主，客户端 `.toFixed(...)` 会在真机上把面板整块打进错误边界。
 * 这里用「类型层放宽 + 渲染层诚实降级」修契约漂移，而不是在宿主侧写一个
 * 假 0（不可判定 ≠ 零，这是本仓库最忌讳的假绿）。
 *
 * ## 纪律
 *
 * 只 import **类型**（`import type`），不 import 宿主运行时模块 ——
 * `tests/contract/client-host-boundary.test.ts` 守护这条边界。
 */
import type { PanelSnapshot } from '../../host/surface/snapshot.ts'

/**
 * 面板实际消费的快照形状。
 *
 * 保留宿主其余字段的类型（不复制契约），只把已在宿主侧被证明可空/可缺的
 * 字段放宽。新增字段若将来也会为 null，应在这里显式放宽 —— 它是客户端
 * 的唯一「可空清单」，也是契约测试核对的锚点。
 */
export type PanelSnapshotView = Omit<
  PanelSnapshot,
  | 'stabilityScore'
  | 'metrics'
  | 'capability'
  | 'graphConnectivity'
  | 'markov'
  | 'decisionSuspects'
  | 'calibration'
  | 'bayes'
  | 'cooccurrence'
  | 'preventive'
  | 'steps'
  | 'revision'
> & {
  /** 稳定性评分 ∈ [0,1]；跨分区视图 / 无样本时为 null。 */
  stabilityScore: number | null
  /** 量化指标；跨分区视图不提供运行时指标时为 null。 */
  metrics: PanelSnapshot['metrics'] | null
  /** 能力矩阵；跨分区视图无法还原时为 null。 */
  capability: PanelSnapshot['capability'] | null
  /** 图谱连通性；与 capability 同源，可空。 */
  graphConnectivity: PanelSnapshot['graphConnectivity'] | null
  /** 转移矩阵；跨分区视图不提供（依赖本进程的迁移历史）。 */
  markov: PanelSnapshot['markov'] | null
  /** 决策嫌疑名单；旧宿主/跨分区视图可能整段省略。 */
  decisionSuspects?: PanelSnapshot['decisionSuspects'] | null
  /** 误伤校准；旧宿主/跨分区视图可能整段省略。 */
  calibration?: PanelSnapshot['calibration'] | null
  /** 贝叶斯读数；旧宿主/跨分区视图可能整段省略。 */
  bayes?: PanelSnapshot['bayes'] | null
  /** 共现验证；旧宿主/跨分区视图可能整段省略。 */
  cooccurrence?: PanelSnapshot['cooccurrence'] | null
  /**
   * RQ3 预防性读数（T15-01）。旧宿主没有该字段、跨分区只读视图不提供运行时
   * 采集面 —— 因此按「缺失/可空」处理；有值时形状完全跟随宿主（不复制第二套）。
   */
  preventive?: PanelSnapshot['preventive'] | null
  /**
   * v0.18 T16-14：执行操作记录（步骤记录）。旧宿主没有该字段、跨分区
   * 只读视图不提供当前进程的步骤轨迹 —— 因此按「缺失/可空」处理；
   * 有值时形状完全跟随宿主（StepSpan 投影，不复制第二套）。
   */
  steps?: PanelSnapshot['steps'] | null
  /**
   * 乐观并发凭证；跨分区只读视图恒 null（动作只作用于当前分区，
   * 拿对方凭证核对必然假冲突）。null 让面板走「不带凭证」分支。
   */
  revision: PanelSnapshot['revision'] | null
  /**
   * 产物新鲜度（v0.19）。旧宿主没有该字段 ⇒ 按「缺失」处理（可选）。
   *
   * 为什么是可选而不是必填：面板要能加载**旧宿主**的快照（回放路径、
   * 跨版本读取）—— 把新字段声明成必填会让 `.buildFreshness.stale` 直接崩。
   * 缺失时面板不显示这一行（而不是显示「正常」——那是假绿）。
   */
  diagnostics: PanelSnapshot['diagnostics'] & {
    buildFreshness?: PanelSnapshot['diagnostics']['buildFreshness'] | null
    /**
     * journal 坏行计数（v0.20.0）：旧宿主快照没有这个字段 ⇒
     * `undefined` = 未知，面板不显示这一行（未知 ≠ 完整，不假绿）。
     */
    journalMalformed?: number | null
  }
  /**
   * recentEvents 的 seq 地板（v0.20.0）：旧宿主快照没有 ⇒ undefined，
   * 投影退回原 detail 文案（不显示地板数）。
   */
  recentEventsFloor?: number
}