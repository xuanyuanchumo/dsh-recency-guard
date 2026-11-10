/**
 * 决策因子快照 —— 把「为什么是这个插件被选中」的因子分解落盘（v0.13，方向③落地）。
 *
 * ## 为什么需要它
 *
 * `decision.json` 此前只记录 `suspects[]` 的 `{bundle, version, lastChangeAt}`，
 * 即**排序键**。它回答「按什么顺序」，回答不了「为什么是 A 而不是 B」：
 * A 可能靠 experimental 拉高、B 可能靠 recency 拉高，总分相同但成因完全不同。
 *
 * 没有因子分解时，任何模型调参（方向一/二/四）都只能靠猜 ——
 * 改了权重后无法离线回放历史决策，看「命中率」是否真的提升。
 *
 * ## 记录什么
 *
 * 每个进入嫌疑面的插件记录：
 * - `rank`：在嫌疑名单中的位置（1 基）
 * - `risk`：`riskScore` 总分 ∈ [0,1]
 * - `factors`：三因子加权贡献分解（recency / experimental / crashFrequency）
 * - `streak`：连续作为头号嫌疑的轮数（含本轮；非头号 = 0）
 * - `changeCount`：journal 里该插件的安装/更新事件数（方向一的频率原始输入）
 * - `source`：`lastChangeAt` 的证据来源（journal = 安装事实，mtime = 引导值）
 *
 * ## 与决策行的隔离
 *
 * 守护行的 `disabled` 表达式只读 `disable` 数组（`decision.ts:153`），
 * **不读** `suspects` 与 `evidence`。所以本字段是**纯追加**的：
 * 老版本宿主读到多出来的字段不会崩（JSON 解析是宽容的），
 * 新字段只服务面板与离线回放。
 *
 * ## 复杂度
 *
 * O(r + e + h·s)（r = 嫌疑数，e = journal 事件数，h = 崩溃历史条数，s = 平均嫌疑名单长度）。
 * 崩溃路径上 journal 封顶 1000 条、历史封顶几十条，量级可忽略。
 */

import type { RecencyEntry } from './recency.js'
import type { JournalRecord } from './store.js'
import type { CrashHistoryEntry } from './recovery-policy.js'
import type { DecisionSuspect } from './decision.js'
import { deriveRiskInputs } from './observations.js'
import { riskFactors, riskScore } from './lifecycle.js'

/**
 * 连续作为头号嫌疑的轮数。
 *
 * 与 `assessConfidence`（`recovery-policy.ts`）的计数**同语义**：
 * 从最近一条历史往前数，遇到「嫌疑名单为空」的记录跳过（启动检测事件不是崩溃证据），
 * 遇到头号嫌疑变化就停。非头号嫌疑记 0 —— 它从未成为「解释这次崩溃的首选」。
 */
export function streakOf(
  bundle: string,
  isHead: boolean,
  history: readonly CrashHistoryEntry[],
): number {
  if (!isHead) return 0
  let streak = 1
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as CrashHistoryEntry
    if (entry.suspects.length === 0) continue
    if ((entry.suspects[0] ?? '') !== bundle) break
    streak += 1
  }
  return streak
}

/** 对快照里的因子做 4 位小数取整（与内部表示一致，可逐字节比对）。 */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 统计 journal 里每个插件的安装/更新事件数（remove 不算「变更」）。 */
function countChanges(events: readonly JournalRecord[]): Map<string, number> {
  const changes = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== 'install' && event.kind !== 'update') continue
    if (typeof event.bundle !== 'string') continue
    changes.set(event.bundle, (changes.get(event.bundle) ?? 0) + 1)
  }
  return changes
}

/**
 * 由嫌疑名单 + journal 事件 + 崩溃历史构造**决策文件形状**的 suspects 条目（纯函数）。
 *
 * 返回类型就是 `DecisionSuspect[]` —— 直接喂给 `store.writeDecisionSync`，
 * 中间不再有「先算 evidence 再手工拼 bundle」的二次映射（那会引入字段漂移）。
 *
 * `now` 可注入，保证快照**可复现**（同样的输入 ⇒ 逐字节相同的输出）。
 */
export function decisionSuspects(
  ranked: readonly RecencyEntry[],
  events: readonly JournalRecord[],
  history: readonly CrashHistoryEntry[],
  now = Date.now(),
): DecisionSuspect[] {
  const riskInputs = deriveRiskInputs(ranked, events)
  const changes = countChanges(events)
  const byBundle = new Map(riskInputs.map((r) => [r.bundle, r]))

  return ranked.map((entry, index) => {
    const input = byBundle.get(entry.bundle)
    const factors = input
      ? riskFactors(input, now)
      : { recency: 0, experimental: 0, crashFrequency: 0 }
    return {
      bundle: entry.bundle,
      ...(entry.version === undefined ? {} : { version: entry.version }),
      lastChangeAt: entry.lastChangeAt,
      evidence: {
        rank: index + 1,
        risk: input ? riskScore(input, now) : 0,
        factors: {
          recency: round4(factors.recency),
          experimental: round4(factors.experimental),
          crashFrequency: round4(factors.crashFrequency),
        },
        streak: streakOf(entry.bundle, index === 0, history),
        changeCount: changes.get(entry.bundle) ?? 0,
        ...(entry.source === undefined ? {} : { source: entry.source }),
      },
    }
  })
}

/** 可比较的时刻：不可解析 ⇒ −∞（排最后）。与 `recency.ts` 的 `sortableTime` 同语义。 */
function sortableTime(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/**
 * 决策排序口径统一（v0.13，研究文档 09 §5）。
 *
 * ## 为什么要统一
 *
 * 此前**决策路径用 `rankByRecency`（纯时间戳）**，而**面板展示用 `riskScore`
 * （三因子）**——两套排序口径。后果：
 * - 用户看到「风险排名」与实际「被关闭的顺序」不一致（高风险的没被关）；
 * - 任何改 `riskScore` 的模型改进**无法在决策路径上生效**（决策不消费它）。
 *
 * ## 统一规则
 *
 * - **确定性证据**（嫌疑名单只有 1 个）⇒ 顺序无关，直接返回 `rankByRecency` 序；
 * - **概率性证据**（多嫌疑）⇒ 按 `riskScore` 降序排列头号嫌疑，
 *   并列时用时间戳降序 + 包名字典序兜底（保证确定性）。
 *
 * 这样「面板显示的风险排名」与「决策的头号嫌疑」就是**同一套口径**，
 * 改 `riskScore` 的权重会同时影响面板与决策。
 *
 * ## 纪律
 *
 * 排序键的变化**不改变**「关几个」（`pickSuspects` 的 n 仍由 crashSeq 决定），
 * 只改变「关谁的顺序」。误伤率的变化由因子快照（`evidence`）记录，可离线回放验证。
 */
export function rankForDecision(
  ranked: readonly RecencyEntry[],
  events: readonly JournalRecord[],
  now = Date.now(),
): RecencyEntry[] {
  // 确定性证据：只有一个候选，顺序无关，保持 rankByRecency 原序（零行为变化）。
  if (ranked.length <= 1) return [...ranked]

  const riskInputs = deriveRiskInputs(ranked, events)
  const byBundle = new Map(riskInputs.map((r) => [r.bundle, r]))
  const scored = ranked.map((entry) => {
    const input = byBundle.get(entry.bundle)
    return { entry, risk: input ? riskScore(input, now) : 0 }
  })
  scored.sort((a, b) => {
    if (b.risk !== a.risk) return b.risk - a.risk
    const ta = sortableTime(a.entry.lastChangeAt)
    const tb = sortableTime(b.entry.lastChangeAt)
    if (ta !== tb) return tb - ta
    return a.entry.bundle.localeCompare(b.entry.bundle)
  })
  return scored.map((s) => s.entry)
}
