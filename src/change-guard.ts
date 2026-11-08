/**
 * 变更防护（v0.12）—— 写操作的**乐观并发**与**审计留痕**。
 *
 * ## 要解决的两个真实缺陷
 *
 * 1. **过期按钮**：面板每 5s 轮询一次快照。用户在 t 时刻看到「dsh-foo 仍被
 *    自动关闭」并点「重新启用」，但在点击之前，另一次崩溃恢复已经改了名单
 *    （GUI 与 agent 也可能同时操作）。此前动作路由无条件执行 ⇒ 用户按着一张
 *    过期地图开火。修法不是加锁（守护路径要快），而是**乐观并发**：
 *    快照带一枚 `revision`（由写状态派生的短哈希），动作可携带
 *    `expectedRevision`，不符则回 409 并回传当前 revision —— 让调用方重读再决定。
 * 2. **L4 审计线断裂**：全自主模式下人类只在事后审计。审计要能回答
 *    「是谁、以什么理由关了这个插件」。工具/路由的写动作此前只记结果，
 *    不记**发起方与理由** ⇒ journal 无法复现因果链。
 *
 * ## 为什么 revision 是「哈希」而不是「计数器」
 *
 * 计数器需要一个单调持久化位点（崩溃时它可能落后于状态 ⇒ 假冲突/假放行）。
 * 哈希直接从**被保护的事实本身**派生（state + decision + journal 尾部），
 * 无额外状态、无写入顺序依赖，崩溃重启后同一份事实必得同一枚 revision
 * —— 这是幂等的，也就不会被崩溃污染。SHA-256 截 12 hex（48 bit）：
 * 冲突判定要的是「变了没有」，不是抗对抗性碰撞。
 *
 * ## 诚实边界
 *
 * `expectedRevision` **可选**：不带就是「我知道自己在做什么」（agent 主动
 * 修复路径常属此类，它刚刚读过快照）。带了就一定要核对 —— 绝不出现
 * 「带了但没核对」的第三种状态。
 */

import { createHash } from 'node:crypto'

/** 参与 revision 派生的事实（缺省字段用稳定占位，避免 undefined 与 '' 混淆）。 */
export interface RevisionFacts {
  /** 连续崩溃计数。 */
  crashSeq: number
  /** 自动关闭名单（顺序敏感：它反映关闭次序）。 */
  autoDisabled: readonly string[]
  /** 已恢复名单。 */
  restored: readonly string[]
  /** 是否已稳定。 */
  stabilized: boolean
  /** 决策文件的 disable 名单（预启动拦截的真值）。 */
  decisionDisable: readonly string[]
  /** journal 末行时间戳（没有日志时为空串）。 */
  journalTail: string
}

/**
 * 一项带长度前缀的列表编码。
 *
 * 为什么不用 `join(',')`：插件名理论可含任意字符，裸拼接会让
 * `["a","b,c"]` 与 `["a,b","c"]` 得到同一个串 —— 那两种状态必须产生
 * 不同的 revision。长度前缀让每个元素的边界可判定（自描述编码）。
 */
function encodeList(label: string, items: readonly string[]): string {
  const body = items.map((s) => `${Buffer.byteLength(s, 'utf8')}:${s}`).join('|')
  return `${label}[${items.length}]=${body}`
}

/**
 * 由事实派生 revision（确定性：同输入 ⇒ 逐字节相同的输出）。
 *
 * 保留 autoDisabled 原序而不是排序：顺序本身是因果信息（先关谁），
 * 排序会把「A 先 B 后」与「B 先 A 后」折叠成同一枚 revision —— 那是
 * 把两种不同的事实当成一种。
 */
export function computeRevision(facts: RevisionFacts): string {
  const canonical = [
    'v1',
    `crashSeq=${facts.crashSeq}`,
    `stabilized=${facts.stabilized ? 1 : 0}`,
    encodeList('autoDisabled', facts.autoDisabled),
    encodeList('restored', facts.restored),
    encodeList('decision', facts.decisionDisable),
    `tail=${facts.journalTail}`,
  ].join('#')
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)
}

/** 乐观并发核对的结果。 */
export type RevisionCheck =
  /** 调用方带了且相符。 */
  | { ok: true; stale: false; unchecked: false }
  /** 调用方没带 revision：放行，但**显式标记**这次没核对（可观测）。 */
  | { ok: true; stale: false; unchecked: true }
  /** 带了但不符：状态已变，动作未执行。 */
  | { ok: false; stale: true; unchecked: false; current: string; expected: string }

/**
 * 核对 `expectedRevision`。
 *
 * 语义（写死，不留模糊地带）：
 * - 不带 ⇒ `ok` + `unchecked:true`；
 * - 带了且相等 ⇒ `ok`；
 * - 带了但不等 ⇒ `stale` + 当前值（409 的数据基础）。
 */
export function checkRevision(current: string, expected?: unknown): RevisionCheck {
  if (typeof expected !== 'string' || expected === '') return { ok: true, stale: false, unchecked: true }
  if (expected === current) return { ok: true, stale: false, unchecked: false }
  return { ok: false, stale: true, unchecked: false, current, expected }
}

/** 写动作的审计信封（L4 事后审计的最小可判定形态）。 */
export interface ActionAudit {
  /** 发起方：`tool`（模型经工具）/ `panel`（人在 GUI）/ `boot`（守护自动）。 */
  actor: 'tool' | 'panel' | 'boot'
  /** 动作名（与工具 action / 路由动作同名，跨通道可对账）。 */
  action: string
  /** 人类可读理由（进 journal，崩溃因果链的一手证据）。 */
  justification: string
}

/** 构造审计信封；理由缺席时给出**可审计的默认**而不是空串。 */
export function auditEnvelope(actor: ActionAudit['actor'], action: string, reason?: unknown): ActionAudit {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  return {
    actor,
    action,
    // 空理由不是「没有理由」，是「调用方没写」。默认文案把两者区分开，
    // 审计时才不会把「忘了写」误读成「不需要理由」。
    justification: trimmed.length > 0 ? trimmed : `（调用方未提供理由；发起方 ${actor}）`,
  }
}
