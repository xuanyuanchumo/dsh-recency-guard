import type { GuardStage, StageTransition } from '../core/lifecycle.ts'
import { STAGE_LABELS } from '../capability/graph-data.ts'
import type { Observation } from './observability.ts'
import { tailWindow } from './observability.ts'
import { isExperimentalName, type RecencyEntry } from '../risk/recency.ts'
import type { JournalRecord } from '../data/store.ts'

/**
 * 面板/图谱的**数据来源** —— 从日志与状态派生观测事实。
 *
 * ## 为什么要从 index.ts 抽出来
 *
 * `index.ts` 原本同时承担四件事：宿主接线、守护流程、观测派生、工具定义。
 * 1077 行、30 个方法的单类让**任何一处改动都要通读全文件**，也让复杂度
 * 预算（band-detector 的单文件上限）被单文件吃满。
 *
 * 本模块把「从日志/状态派生事实」这一件事独立出来，纯函数、无副作用、
 * 可独立单测 —— 复杂度自然被切分。
 *
 * ## 本模块对外提供两条契约
 * 1. `deriveObservations` / `deriveRiskInputs` —— 统计模型的输入序列。
 * 2. `deriveEventFlow` —— **可视化流动**的时序契约（时间点/阶段/动作/流向/来源）。
 *    字段命名直白可读、id 稳定、排序确定，前端只消费不改写。
 */

/** 风险排序的输入。 */
export interface RiskInput {
  bundle: string
  experimental: boolean
  lastChangeAt: string
  suspectHits: number
  observations: number
}

/**
 * 从日志推导启动观测序列。
 *
 * 一次启动 = 一条 `note`（"dsh 启动 pid=…"）；其后若出现 `crash-detected`，
 * 则该次启动以崩溃告终。
 *
 * 已知边界：`crash-detected` 出现在任何 `note` 之前时被忽略（没有对应的
 * 启动事实，凭空造一次观测会让 crashRate 的分母说谎）。journal 被截断
 * （只保留最近 1000 行）时，最早的那次启动可能已丢失 —— 这是**样本缺失**，
 * 不是「没有崩溃」，因此统计层用 `defined:false` 而不是 0 表达它。
 */
export function deriveObservations(events: readonly JournalRecord[]): Observation[] {
  const observations: Observation[] = []
  let current: Observation | null = null
  for (const event of events) {
    if (event.kind === 'note' && typeof event.detail === 'string' && event.detail.startsWith('dsh 启动')) {
      current = { at: event.t, crashed: false }
      observations.push(current)
      continue
    }
    if (event.kind === 'crash-detected' && current) {
      current.crashed = true
      current.detected = true
    }
  }
  return observations
}

/**
 * 从日志推导嫌疑插件的风险输入。
 *
 * 历史嫌疑次数 = 该插件被写入「关闭」记录的次数；观测次数 = 它在嫌疑
 * 名单里出现过的总次数（至少 1，避免除零）。
 *
 * 「至少 1」是**分母保护**而不是数据补全：分母为 0 的比率在统计上不可
 * 判定，但这里的 `observations` 只是风险加权分的一项（不是对外指标），
 * 用 1 表示「本轮进入过嫌疑名单一次」，语义与 `recency.ts` 的排名一致。
 */
export function deriveRiskInputs(
  ranked: readonly RecencyEntry[],
  events: readonly JournalRecord[],
): RiskInput[] {
  const hits = new Map<string, number>()
  const seen = new Map<string, number>()
  // 变更事件数（v0.13 方向①）：install/update 是「改动」，remove 不是 ——
  // 已移除的插件不在嫌疑面，把它算作"反复改动"会污染频率信号。
  const changes = new Map<string, number>()
  for (const event of events) {
    if (event.kind === 'disable' && typeof event.bundle === 'string') {
      hits.set(event.bundle, (hits.get(event.bundle) ?? 0) + 1)
    }
    if ((event.kind === 'install' || event.kind === 'update') && typeof event.bundle === 'string') {
      changes.set(event.bundle, (changes.get(event.bundle) ?? 0) + 1)
    }
  }
  for (const entry of ranked) {
    seen.set(entry.bundle, (seen.get(entry.bundle) ?? 0) + 1)
  }
  return ranked.map((entry) => ({
    bundle: entry.bundle,
    experimental: isExperimentalName(entry.bundle),
    lastChangeAt: entry.lastChangeAt,
    suspectHits: hits.get(entry.bundle) ?? 0,
    observations: Math.max(1, seen.get(entry.bundle) ?? 1),
    changeCount: changes.get(entry.bundle) ?? 0,
  }))
}

// ─────────────────────────── 事件流 / 状态流转契约 ───────────────────────────

/**
 * 动作 id —— 稳定、面向机器；中文名走 `actionLabel`。
 *
 * 命名的取舍：用**动词短语**而不是 journal 的 kind 字符串。kind 是存储
 * 层的词汇（'crash-detected'），动作是**语义**（'crash'）——
 * 存储格式演进时前者会变，后者是契约。
 */
export type FlowAction =
  | 'startup'
  | 'install'
  | 'update'
  | 'remove'
  | 'enable'
  | 'disable'
  | 'crash'
  | 'auto-disable'
  | 'recover'
  | 'restore'
  | 'backup'
  | 'transition'
  | 'unknown'

/**
 * 流向节点 id 的命名空间（前端按前缀上色/分组，不要硬编码单个 id）。
 *
 * - `actor:*`  —— 动作主体（人 / 进程 / 守护）
 * - `node:*`   —— profile 的部件（运行时、决策器、备份区…）
 * - `stage:*`  —— 生命周期阶段（用于状态流转）
 */
export type FlowNodeId = string

/** 事件流中的一个时序点（「可视化流动」的稳定契约）。 */
export interface FlowEvent {
  /** 时间点（ISO 8601）。 */
  at: string
  /** 阶段；`null` 表示无法归属任何阶段（不猜）。 */
  stage: GuardStage | null
  /** 阶段是记录下来的还是推断的 —— 推断值不可当作白盒证据。 */
  stageSource: 'recorded' | 'inferred'
  /** 动作 id（机器可读）。 */
  action: FlowAction
  /** 动作中文名（人可读）。 */
  actionLabel: string
  /** 流向：从哪个语义节点到哪个语义节点。 */
  flow: { from: FlowNodeId; to: FlowNodeId }
  /** 来源：journal 事实 / 状态机迁移。 */
  source: 'journal' | 'state-machine'
  /** 关联对象（插件名 / 阶段名）。 */
  ref?: string
  /** 人读摘要。 */
  detail: string
  /** 语义色调（颜色之外还有 actionLabel 这条通道）。 */
  tone: 'neutral' | 'info' | 'success' | 'warn' | 'error'
}

/** 事件流所需的最小 journal 行形状（快照的窄投影与完整 JournalRecord 都可传入）。 */
export interface FlowSourceEvent {
  t: string
  kind: string
  bundle?: string
  detail?: string
}

/** 一种 journal 事件在流里的语义投影。 */
interface FlowSpec {
  action: FlowAction
  actionLabel: string
  from: FlowNodeId
  to: FlowNodeId
  tone: FlowEvent['tone']
  /** 该事件发生时守护**多半**处在哪个阶段（journal 本身不记阶段 ⇒ 标为 inferred）。 */
  stage: GuardStage
}

/**
 * journal kind → 流动语义的映射表。
 *
 * 为什么要这张表而不是在循环里 if/else：事件种类与语义的对应是**契约**，
 * 表形态可以被测试逐项钉死（新增 kind 时忘了投影会被测出来，而不是
 * 在面板上悄悄显示成「unknown」）。
 */
const FLOW_BY_KIND: Record<string, FlowSpec> = {
  note: { action: 'startup', actionLabel: '记录启动', from: 'actor:process', to: 'node:guard', tone: 'info', stage: 'monitoring' },
  install: { action: 'install', actionLabel: '安装插件', from: 'actor:user', to: 'node:profile', tone: 'neutral', stage: 'monitoring' },
  update: { action: 'update', actionLabel: '更新插件', from: 'actor:user', to: 'node:profile', tone: 'info', stage: 'monitoring' },
  remove: { action: 'remove', actionLabel: '移除插件', from: 'node:profile', to: 'actor:user', tone: 'warn', stage: 'monitoring' },
  enable: { action: 'enable', actionLabel: '启用插件', from: 'node:profile', to: 'node:runtime', tone: 'neutral', stage: 'monitoring' },
  disable: { action: 'disable', actionLabel: '关闭插件', from: 'node:runtime', to: 'node:disabled', tone: 'warn', stage: 'monitoring' },
  'crash-detected': { action: 'crash', actionLabel: '检出崩溃', from: 'actor:process', to: 'node:sentinel', tone: 'error', stage: 'crashed' },
  'auto-disable': { action: 'auto-disable', actionLabel: '自动关闭嫌疑插件', from: 'node:decider', to: 'node:disabled', tone: 'error', stage: 'deciding' },
  recover: { action: 'recover', actionLabel: '执行恢复', from: 'node:decider', to: 'node:runtime', tone: 'success', stage: 'stabilizing' },
  restore: { action: 'restore', actionLabel: '恢复插件', from: 'node:guard', to: 'node:runtime', tone: 'success', stage: 'stabilizing' },
  'config-backup': { action: 'backup', actionLabel: '备份配置', from: 'node:profile', to: 'node:backups', tone: 'neutral', stage: 'stabilizing' },
}

/** 未知 kind 的兜底：**不猜**语义，只如实转述 kind。 */
const UNKNOWN_FLOW: FlowSpec = {
  action: 'unknown',
  actionLabel: '未知事件',
  from: 'node:profile',
  to: 'node:profile',
  tone: 'neutral',
  stage: 'monitoring',
}

/**
 * 从 journal 尾部 + 状态机迁移派生事件流。O((n + m) log(n + m))。
 *
 * 排序规则（确定性，可逐字节比对）：
 * 1. 按时刻升序；
 * 2. 时刻不可解析的事件排在**最后**（不静默当成 1970）；
 * 3. 同一时刻：journal 事实在前、状态机迁移在后，各自保持输入顺序（稳定）。
 *
 * `limit` 取**最近**的 limit 条（用环形缓冲，额外内存 O(limit)），
 * 因为「流动」看的是最近发生了什么。
 */
export function deriveEventFlow(
  events: readonly FlowSourceEvent[],
  transitions: readonly StageTransition[] = [],
  limit = 64,
): FlowEvent[] {
  const merged: Array<{ event: FlowEvent; time: number; sourceRank: number; seq: number }> = []
  const fromJournal = events.map((event, index) => ({ event: journalFlowEvent(event), time: Date.parse(event.t), sourceRank: 0, seq: index }))
  const fromMachine = transitions.map((transition, index) => ({
    event: transitionFlowEvent(transition),
    time: Date.parse(transition.at),
    sourceRank: 1,
    seq: index,
  }))
  merged.push(...fromJournal, ...fromMachine)
  merged.sort((a, b) => {
    const at = Number.isNaN(a.time) ? Number.POSITIVE_INFINITY : a.time
    const bt = Number.isNaN(b.time) ? Number.POSITIVE_INFINITY : b.time
    if (at !== bt) return at - bt
    if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank
    return a.seq - b.seq
  })
  return tailWindow(merged, limit).map((entry) => entry.event)
}

/** 单条 journal 行 → 流动事件。 */
function journalFlowEvent(event: FlowSourceEvent): FlowEvent {
  const spec = FLOW_BY_KIND[event.kind] ?? UNKNOWN_FLOW
  const known = FLOW_BY_KIND[event.kind] !== undefined
  return {
    at: event.t,
    // journal 不记录写入时的阶段：这里的 stage 是**推断**，必须标 inferred，
    // 否则面板会把推断当证据展示（白盒纪律）。
    stage: known ? spec.stage : null,
    stageSource: 'inferred',
    action: spec.action,
    actionLabel: spec.actionLabel,
    flow: { from: spec.from, to: spec.to },
    source: 'journal',
    ref: event.bundle,
    detail: event.detail ?? (event.bundle ? `${spec.actionLabel}：${event.bundle}` : spec.actionLabel),
    tone: spec.tone,
  }
}

/** 一次状态迁移 → 流动事件（阶段是**记录**下来的，不是推断）。 */
function transitionFlowEvent(transition: StageTransition): FlowEvent {
  return {
    at: transition.at,
    stage: transition.to,
    stageSource: 'recorded',
    action: 'transition',
    actionLabel: '阶段流转',
    flow: { from: `stage:${transition.from}`, to: `stage:${transition.to}` },
    source: 'state-machine',
    ref: transition.to,
    detail: `${STAGE_LABELS[transition.from]} → ${STAGE_LABELS[transition.to]}：${transition.reason}`,
    tone: stageTone(transition.to),
  }
}

/** 阶段 → 语义色调（与 lifecycle 的风险语义一致，不引入第二套配色语言）。 */
function stageTone(stage: GuardStage): FlowEvent['tone'] {
  switch (stage) {
    case 'crashed':
    case 'deciding':
      return 'warn'
    case 'recovered':
      return 'success'
    case 'stabilizing':
    case 'monitoring':
      return 'info'
    default:
      return 'neutral'
  }
}

/**
 * 读取 profile 的依赖清单 —— 插件**声明**的依赖（不是传递依赖）。
 *
 * 只有被 profile 声明的依赖才是「用户装的插件」；一个插件的传递依赖不是
 * 独立的嫌疑对象。
 *
 * 实现委托给 `store.declaredDependenciesSync`：同一份 JSON 读取逻辑此前
 * 在本模块与 store.ts 各写了一份（技术债），两处漂移就会让「谁算插件」
 * 出现两个答案。保留本名字是因为 guarded-rows.ts 按此名消费。
 */
export { declaredDependenciesSync as readDeclaredDependencies } from '../data/store.ts'
