/**
 * 启动时的**异常终止分流留痕**（v0.13 从 index.ts 抽出以控复杂度）。
 *
 * ## 这里做什么
 *
 * `assessAbnormalExit` 给出四分类判定（clean / self-reload / concurrent /
 * abnormal），本模块只负责「按结局写正确的 journal 事实」：
 *
 * | 结局 | 写什么 | 为什么 |
 * |---|---|---|
 * | `abnormal` | `crash-detected`（exitCode=null, signal='unobserved'） | 它**是**一次崩溃证据，必须进崩溃计数与趋势 |
 * | `concurrent` | `note` | 另一个实例还开着 ⇒ 不是崩溃，不能污染 crashSeq |
 * | `self-reload` | `note` | 热重载 ⇒ 不是崩溃；误报「另一个实例」会让人去查不存在的进程 |
 * | `clean` | 不写 | 干净退出没有可记的事实（写 note 只会制造噪声） |
 *
 * ## 为什么单独成模块
 *
 * 这段是**纯分流**：判定在 `abnormal-boot.ts`，状态写在别处，它只挑 kind 与文案。
 * 留在 `bootInner()` 里时，三条 `if/else` 分支把启动路径的主线读起来很累
 * （index.ts 复杂度 118，预算 100）。
 */

import type { JournalEvent } from '../data/store.js'
import type { AbnormalExitVerdict } from './abnormal-boot.js'

/**
 * 由判定结果构造要追加的 journal 事件（纯函数，可能为空数组）。
 *
 * 返回数组而不是直接写盘：写入时机与 best-effort 策略由调用方决定，
 * 这里保持可测试（不需要桩 store）。
 */
export function abnormalExitEvents(verdict: AbnormalExitVerdict): JournalEvent[] {
  if (verdict.abnormalDetail !== null) {
    // 记成 crash-detected 而不是新 kind：journal 的 kind 是**跨层词汇表**
    // （store / observations 的 FlowAction / 流动映射 / 面板着色四处）。
    // 新开一个 kind 而漏改任一处，这条事实就在事件流里静默消失。
    // 「没有退出码」写进 detail，而不是伪造一个 0。
    return [{ kind: 'crash-detected', detail: verdict.abnormalDetail, exitCode: null, signal: 'unobserved' }]
  }
  if (verdict.concurrentDetail !== null) {
    return [{ kind: 'note', detail: verdict.concurrentDetail }]
  }
  if (verdict.selfReloadDetail !== null) {
    return [{ kind: 'note', detail: verdict.selfReloadDetail }]
  }
  return []
}
