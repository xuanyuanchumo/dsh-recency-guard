/**
 * 命令窗口的 v0.14 新读数投影（M1 误伤校准 + M2 贝叶斯并行读数）。
 *
 * 为什么单独成文件
 * ----------------
 * 复杂度预算**按文件计分**，而 `index.ts` 承担的是崩溃恢复主线（守护行安装、
 * 崩溃决策、两阶段提交）。把「status 的两块读数投影」挂在主线上，会让
 * 旁路事实挤占主线预算 —— 这与 v0.13 把 `self-describe.ts` / `graph-data.ts`
 * 拆出去的判断是同一条纪律（cycle-5 的既有惯例：「旁路事实不该挤占
 * 崩溃恢复主线的预算」）。
 *
 * 拆出的边界是**纯投影**：本文件不读盘、不持状态、不依赖 Store。
 * 调用方把已经读到的事实传进来，这里只做形状转换 —— 因此它可被单测
 * 直接构造输入验证，不需要起一个 Store。
 */
import type { BayesView, CalibrationView } from './status-view.ts'
import { bayesMetric, bayesRisk, type BayesRiskInput } from '../risk/risk-bayes.ts'
import { calibratedConfirmRounds, calibrationExplanation, falsePositiveRate, falsePositiveSamples } from '../risk/risk-calibration.ts'
import type { JournalRecord } from '../data/store.ts'

/**
 * 贝叶斯并行读数投影（M2 / RQ1）。
 *
 * **并行读数纪律**（07 §2.3）：这里给的是第二套读数，绝不替换默认
 * `riskScore`。两者同时出现在 status 里，让用户看见分歧而不是被
 * 单一黑盒结论说服；样本稀疏的行 `defined:false`，命令窗口显示
 * 「不可判定」而不是编一个数字。
 */
export function projectBayesViews(
  riskInputs: ReadonlyArray<BayesRiskInput & { bundle: string }>,
  now = Date.now(),
): BayesView[] {
  return riskInputs.map((input) => {
    const metric = bayesMetric(input, now)
    const direct = bayesRisk(input, now)
    return {
      bundle: input.bundle,
      defined: metric.defined,
      label: metric.defined ? metric.label : (metric.reason ?? '不可判定'),
      score: metric.value?.score ?? null,
      // riskScore 并行保留：用户要能对照「时间戳口径 vs 贝叶斯口径」。
      riskScore: direct.riskScore,
      mean: metric.value?.mean ?? null,
      lower95: metric.value?.lower95 ?? null,
      upper95: metric.value?.upper95 ?? null,
    }
  })
}

/**
 * 误伤校准投影（M1 / RQ2）。
 *
 * 返回 `null` 表示「该分区还没有自动关闭记录」—— 这与「误伤率 0%」
 * 是两件事，命令窗口必须能区分（07 §3.3 的诚实边界）。
 * 注意 `autoDisables > 0` 但样本 < 5 时，本函数**不返回 null**：
 * 它有真实计数可展示，只是 `rate` 为 `null`（样本不足），
 * 两者在 `CalibrationView` 里靠 `autoDisables` 区分。
 */
export function projectCalibrationView(
  journal: readonly JournalRecord[],
  confirmRoundsBase: number,
): CalibrationView | null {
  const stats = falsePositiveSamples(journal)
  if (stats.autoDisables === 0) return null
  const rate = falsePositiveRate(stats)
  const decision = calibratedConfirmRounds(confirmRoundsBase, stats)
  return {
    rate: rate.value?.rate ?? null,
    autoDisables: stats.autoDisables,
    falsePositives: stats.falsePositives,
    systemRestored: stats.systemRestored,
    base: decision.base,
    required: decision.required,
    explanation: calibrationExplanation(decision),
  }
}
