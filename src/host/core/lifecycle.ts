/**
 * 生命周期状态机 —— 守护能力的阶段模型。
 *
 * 为什么用状态机而不是散落的标志位
 * ------------------------------
 * 「这个守护现在处于什么状态」如果由多个布尔量拼出来（enabled / crashed /
 * recovering / stabilized），就会出现**不可能的组合**（既 crashed 又 stabilized），
 * 而这些组合在真实运行中确实会发生（崩溃瞬间、恢复中途、重载过程中）。
 * 状态机让不可能的状态**根本无法表示**，并把「合法迁移」显式写出来。
 *
 * 状态集合覆盖完整生命周期：
 *
 *   idle ──安装/发现插件──▶ monitoring ──崩溃──▶ crashed
 *     ▲                        │                    │
 *     │                        │ 稳定启动            │ 崩溃计数递增
 *     │                        ▼                    ▼
 *     └──恢复完成──────── stabilizing ◀─── deciding ─┘
 *                              │
 *                              │ 手动确认首要嫌疑
 *                              ▼
 *                          recovered
 *
 * 迁移的**不变式**（可被测试钉死）：
 *   - 只有 `deciding` 可以发出「关闭插件」的业务动作
 *   - 只有 `recovered` / `idle` 是终态（可安全重载）
 *   - `crashed` 只能由 `deciding` 离开（必须先做决策）
 *
 * 状态之外还有**步骤**（`StepSpan`）：状态回答「现在处于什么状态」，步骤回答
 * 「这一轮做了哪些事、各花多久、哪一步失败了」。归零动作（归档重置）走
 * `reset()`：它绕过白名单但留 `forced` 痕迹 —— 归档后旧结论作废，界面不能
 * 继续显示上一轮的 `crashed`。
 */

/**
 * 生命周期状态词汇 —— 定义在 `src/shared/graph-contract.ts`（跨运行时契约层）。
 *
 * 为什么从这里搬走：阶段同时出现在**宿主状态机**与**浏览器面板**里。
 * 若词汇定义在 host，client 就必须 import `src/host/**` —— 那会把浏览器
 * bundle 绑到宿主实现上，且被边界契约测试判为越界。词汇是契约，不是实现。
 *
 * 这里保留 re-export：既有调用方（`host/**`、测试）继续从 lifecycle 取，
 * 不必全量改 import；而 client 直接依赖 shared，不经过 host。
 */
// 这里的 `import` 与 `export` 两行都是必需的：`export ... from` 只做转发，
// **不会把名字带进本文件作用域**，而本文件的 StateMachine 内部要用 `GuardStage`
// 与 `ALL_STAGES`（曾经只写 export 导致 30+ 处 TS2304，教训记在 CLAUDE.md）。
import { ALL_STAGES, STAGE_LABELS, type GuardStage } from '../../shared/graph-contract.ts'
export { ALL_STAGES, STAGE_LABELS, type GuardStage }

/** 一次状态迁移。 */
export interface StageTransition {
  from: GuardStage
  to: GuardStage
  /** 迁移原因（白盒透明）。 */
  reason: string
  /** 迁移时刻。 */
  at: string
  /** 在 `from` 阶段停留的毫秒数（首次迁移无前序，故可选）。 */
  durationMs?: number
  /**
   * 是否为**治理复位**（绕过白名单的一次显式重置）。
   *
   * 归档重置会作废全部旧结论，此时「当前阶段」本身也失去意义：若上一轮停在
   * `crashed`，白名单里根本没有通往 `idle` 的路，重置后界面会继续显示「崩溃」——
   * 旧结论换了种方式继续生效。复位必须**显式标记**，让读者一眼看出这条迁移
   * 不是业务流程走出来的，而是人（或治理动作）宣告的。
   */
  forced?: boolean
}

/**
 * 合法迁移表。
 *
 * 用「显式白名单」而非「黑名单禁止」：新增状态时若忘了补迁移表，
 * 编译/测试会暴露它，而不是让它悄悄变成一个可达的死角。
 */
const ALLOWED: Record<GuardStage, readonly GuardStage[]> = {
  idle: ['monitoring'],
  monitoring: ['crashed', 'idle'],
  crashed: ['deciding'],
  deciding: ['stabilizing', 'monitoring', 'crashed'],
  stabilizing: ['recovered', 'monitoring', 'crashed'],
  recovered: ['monitoring', 'idle'],
}

/** 是否允许这次迁移。 */
export function canTransition(from: GuardStage, to: GuardStage): boolean {
  return ALLOWED[from].includes(to)
}

/**
 * 生命周期**步骤**名 —— 插件真实走过的流程节点。
 *
 * 状态机回答「守护现在处于什么状态」，步骤回答「这一轮到底做了哪些事、
 * 各花了多久、哪一步失败了」。两者缺一不可：只有状态时，一次失败的 boot
 * 只会让阶段停在 `monitoring`，没人知道它为什么没进 `recovered`。
 */
export type LifecycleStepName =
  | 'loader' // Loader 四件套（name/inject/Config/apply）就绪
  | 'install-guarded-rows' // 同步安装守护行
  | 'startup-record' // 同步启动记录（哨兵 + 安装/更新事实）
  | 'boot' // 异步启动流程（状态迁移 + 变更记录 + 自动恢复）
  | 'crash-decision' // 崩溃时的同步决策发布
  | 'restore' // 稳定后的配置恢复
  | 'rollback' // 级联刹车回滚（升级到顶后的自动兜底，v0.18 T16-12）
  | 'archive' // 归档搬走 + 留档
  | 'rerun' // 以最新项目事实重跑（新循环基线）
  | 'watch-events' // 订阅宿主 plugin-manager/changed（事件驱动加速器）
  | 'shutdown' // 退出清理

/** 一次步骤的执行区间。 */
export interface StepSpan {
  name: LifecycleStepName
  /** 进入时刻。 */
  startedAt: string
  /** 退出时刻（未结束时缺失 —— 诚实表达「还在里面」）。 */
  endedAt?: string
  /** 耗时（毫秒，退出后才可判定）。 */
  durationMs?: number
  /** 是否成功（未结束时缺失）。 */
  ok?: boolean
  /** 失败原因（`ok === false` 时存在）。 */
  reason?: string
}

/** 一次被拒绝的迁移（非法迁移的留痕）。 */
export interface RejectedTransition {
  from: GuardStage
  to: GuardStage
  reason: string
  at: string
}

/**
 * 状态机。
 *
 * 迁移历史保留最近 N 条（环形缓冲），既是白盒透明的证据链，也是
 * 面板「生命周期流动」可视化的数据来源。
 */
export class StageMachine {
  private current: GuardStage
  private readonly history: StageTransition[] = []
  private readonly historyLimit: number
  /** 被拒绝的迁移（观测证据：非法迁移不是「什么都没发生」）。 */
  private readonly rejected: RejectedTransition[] = []
  /** 步骤区间（环形缓冲：观测面不无限增长）。 */
  private readonly spans: StepSpan[] = []
  /** 上一次迁移的时刻（用于算「在上一阶段停留了多久」）。 */
  private lastTransitionAt?: number

  constructor(initial: GuardStage = 'idle', historyLimit = 200) {
    this.current = initial
    this.historyLimit = historyLimit
  }

  /** 当前状态。 */
  get stage(): GuardStage {
    return this.current
  }

  /** 迁移历史（按时间顺序）。 */
  get transitions(): readonly StageTransition[] {
    return this.history
  }

  /** 被拒绝的迁移（按时间顺序）。 */
  get rejectedTransitions(): readonly RejectedTransition[] {
    return this.rejected
  }

  /** 全部步骤区间（按时间顺序，含未结束的）。 */
  get steps(): readonly StepSpan[] {
    return this.spans
  }

  /**
   * 尝试迁移。
   *
   * @returns 成功则返回 true；非法迁移不改变状态并返回 false（不抛异常：
   *          状态机是观测设施，不该因为一次非法迁移拖垮守护流程）。
   *          被拒绝的尝试会**留痕**（from/to/reason/时刻），因为「非法迁移
   *          发生过」本身就是要被看见的事实 —— 静默返回 false 会让一条
   *          写错的迁移路径永远不被发现。
   */
  transition(to: GuardStage, reason: string): boolean {
    const now = Date.now()
    if (!canTransition(this.current, to)) {
      this.rejected.push({ from: this.current, to, reason, at: new Date(now).toISOString() })
      if (this.rejected.length > REJECTED_LIMIT) this.rejected.shift()
      return false
    }
    const durationMs = this.lastTransitionAt === undefined ? undefined : now - this.lastTransitionAt
    this.history.push({
      from: this.current,
      to,
      reason,
      at: new Date(now).toISOString(),
      ...(durationMs === undefined ? {} : { durationMs }),
    })
    if (this.history.length > this.historyLimit) this.history.shift()
    this.current = to
    this.lastTransitionAt = now
    return true
  }

  /**
   * 治理复位 —— 显式地把阶段强制拉回 `idle`。
   *
   * 与 `transition` 的区别是**它绕过白名单**，这正是它的用途：归档重置后
   * 旧结论全部作废，此时不该再由「旧阶段 → 新阶段」的合法性决定界面显示什么。
   * 复位会写入一条 `forced: true` 的迁移记录（白盒留痕），非法迁移的语义
   * 并没有被稀释 —— 常规路径依旧只能走白名单。
   */
  reset(reason: string): StageTransition {
    const now = Date.now()
    const transition: StageTransition = {
      from: this.current,
      to: 'idle',
      reason,
      at: new Date(now).toISOString(),
      forced: true,
      ...(this.lastTransitionAt === undefined ? {} : { durationMs: now - this.lastTransitionAt }),
    }
    this.history.push(transition)
    if (this.history.length > this.historyLimit) this.history.shift()
    this.current = 'idle'
    this.lastTransitionAt = now
    return transition
  }

  /** 该状态下允许的动作。 */
  allowedActions(): readonly GuardStage[] {
    return ALLOWED[this.current]
  }

  // ---------- 步骤观测（进入 / 退出 / 耗时 / 失败原因）----------

  /**
   * 进入一个步骤。
   *
   * 同名步骤可以并发进入（例如两个工作区同一进程），因此用「未结束的同名
   * 区间栈」匹配退出：`endStep` 关闭**最近一个**未结束的同名区间。
   */
  beginStep(name: LifecycleStepName): StepSpan {
    const span: StepSpan = { name, startedAt: new Date().toISOString() }
    this.spans.push(span)
    if (this.spans.length > STEP_LIMIT) this.spans.shift()
    return span
  }

  /** 退出一个步骤（关闭最近的同名未结束区间）。 */
  endStep(name: LifecycleStepName, ok = true, reason?: string): StepSpan | undefined {
    const now = Date.now()
    for (let i = this.spans.length - 1; i >= 0; i -= 1) {
      const span = this.spans[i]
      if (span.name !== name || span.endedAt !== undefined) continue
      span.endedAt = new Date(now).toISOString()
      span.durationMs = Math.max(0, now - Date.parse(span.startedAt))
      span.ok = ok
      if (!ok) span.reason = reason ?? '未给出原因'
      return span
    }
    // 没有对应的进入记录：不补造区间（补造会让「未进入就退出」变成看似正常）。
    return undefined
  }

  /**
   * 一步到位的记录（进入与退出同一时刻）。
   *
   * 用于**同步**步骤：崩溃路径上的同步 IO 只有几十微秒，单独 begin/end
   * 反而在崩溃时留下永远闭合不了的区间（进程已死），一条闭合区间更诚实。
   */
  recordStep(name: LifecycleStepName, ok: boolean, reason?: string, durationMs = 0): StepSpan {
    const at = new Date().toISOString()
    const span: StepSpan = {
      name,
      startedAt: at,
      endedAt: at,
      durationMs,
      ok,
      ...(ok ? {} : { reason: reason ?? '未给出原因' }),
    }
    this.spans.push(span)
    if (this.spans.length > STEP_LIMIT) this.spans.shift()
    return span
  }

  /** 仍在进行中的步骤名（未闭合区间）。 */
  openSteps(): LifecycleStepName[] {
    return this.spans.filter((s) => s.endedAt === undefined).map((s) => s.name)
  }

  /**
   * 稳定性评分 ∈ [0,1]。
   *
   * 模型：状态是「健康度」的**序数代理**，用归一化的阶段序号做线性映射，
   * 再按最近迁移的**稳定性衰减**惩罚 —— 刚发生过迁移说明状态还在震荡。
   *
   *   score = stageWeight × exp(-λ · recentTransitions)
   *
   * 理由：单纯的 0/1 标志无法表达「刚刚恢复」（应高于 idle、低于 monitoring），
   * 而一个无衰减的阶段分数又无法区分「稳定运行 1 小时」与「刚崩完」。
   * λ = ln(2)/halfLife，halfLife 取 3 次迁移 —— 三次迁移内分数减半。
   */
  stabilityScore(): number {
    const weight = STAGE_WEIGHT[this.current]
    const recent = this.history.slice(-STABILITY_WINDOW)
    const halfLife = 3
    const lambda = Math.log(2) / halfLife
    const decay = Math.exp(-lambda * recent.length)
    return round4(weight * decay)
  }
}

/** 参与稳定性衰减计算的最近迁移条数。 */
const STABILITY_WINDOW = 6

/** 被拒绝迁移的留痕上限（观测面有界）。 */
const REJECTED_LIMIT = 50

/** 步骤区间的留痕上限（观测面有界）。 */
const STEP_LIMIT = 120

/** 各阶段的权重（有序：越靠后越接近完全健康）。 */
const STAGE_WEIGHT: Record<GuardStage, number> = {
  idle: 0.2,
  monitoring: 1.0,
  crashed: 0.0,
  deciding: 0.3,
  stabilizing: 0.7,
  recovered: 0.9,
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * 崩溃风险评分 ∈ [0,1]。
 *
 * 模型（可解释的三因子加权）：
 *
 *   risk = w_recency · recency + w_experimental · experimental + w_frecency · crashFrequency
 *
 * - **recency**：插件最近一次变更距今多近。半衰期 72 小时（3 天）——
 *   与「用户通常在装完插件后几天内发现它坏了」的经验一致。
 * - **experimental**：命名是否带 experimental/beta/rc 等实验性标记。
 * - **crashFrequency**：该插件被写入「嫌疑名单」的历史次数占比。
 *
 * 权重取 0.5 / 0.3 / 0.2：recency 是最强信号（时间局部性），
 * experimental 次之（命名是强先验），历史频率最弱（样本少、易过拟合）。
 */
export interface RiskInput {
  /** 最近一次变更时间（ISO）。 */
  lastChangeAt: string
  /** 是否为实验性命名。 */
  experimental: boolean
  /** 历史嫌疑次数。 */
  suspectHits: number
  /** 历史总观察次数。 */
  observations: number
  /**
   * 该插件的**安装/更新事件次数**（v0.13 方向①·变更频率维度）。
   *
   * ## 为什么要这个维度
   *
   * 只按「最近一次变更距今多久」排序（一维新近性）无法区分：
   * - 一小时前热更新五次（反复改动 ⇒ 引入缺陷的机会更多）
   * - 一小时前只安装一次（一次性动作 ⇒ 只有一次引入缺陷的机会）
   *
   * 两者 `lastChangeAt` 相同、`recency` 相同，在决策面上完全同分。
   * 变更频率把「一次动作」与「反复折腾」分开。
   *
   * ## 为什么是**调制项**而不是第四个加法因子
   *
   * 三个因子权重 0.5/0.3/0.2 之和恰为 1，再加一项要么破坏归一化、
   * 要么重新分配权重（会让既有断言集体失效，且旧决策不可比）。
   * 变更频率的语义是「放大或缩小新近性的可信度」，所以做成 recency 的
   * **乘数**：`recency × (1 + α·density)`。语义清晰、可解释、可回放。
   *
   * ## 诚实边界
   *
   * `undefined` ⇒ 乘数恒为 1（行为与 v0.12 逐位一致）。这不是「补 0」，
   * 而是「没有这个维度的信息就不改变结论」—— 与 `Metric.defined` 同一纪律。
   */
  changeCount?: number
}

/** 风险权重。 */
export const RISK_WEIGHTS = { recency: 0.5, experimental: 0.3, crashFrequency: 0.2 } as const

/** recency 因子的半衰期（小时）。 */
export const RECENCY_HALF_LIFE_HOURS = 72

/**
 * 变更频率调制参数（v0.13 方向①）。
 *
 * - `cap = 5`：5 次以上变更视为同一档「高频」（再多也只是"很折腾"，不该无限放大）
 * - `alpha = 0.5`：满档高频把新近性最多放大 50%
 *
 * 为什么上限只有 50%：频率是**辅助证据**（相关性），新近性才是主信号。
 * 让频率能把一个新近插件的排名从第 3 提到第 1，但不能把一个月没动过的
 * 插件顶到前面（那会违反时间局部性这个更强的基础假设）。
 */
export const CHANGE_FREQUENCY = { cap: 5, alpha: 0.5 } as const

/**
 * 三因子的加权贡献分解（v0.13 因子快照）。
 *
 * `riskScore` 是这三者之和，但**只给总分**时无法回答「为什么是 A 而不是 B」——
 * A 可能靠 experimental 拉高、B 可能靠 recency 拉高，总分相同但成因完全不同。
 * 决策文件需要落盘的是**分解**而不是总分，否则事后归因只能猜。
 *
 * 行为保持：`riskScore` 改为调用本函数后，数学公式与取整顺序不变
 * （先求三因子贡献、再求和、最后 round4 并夹到 [0,1]），既有断言不受影响。
 */
export interface RiskFactorContributions {
  /** 新近性贡献：`0.5 × 0.5^(ageHours/72) × (1 + α·density)`。 */
  recency: number
  /** 实验性贡献：`0.3 × experimental`。 */
  experimental: number
  /** 历史频率贡献：`0.2 × suspectHits/observations`。 */
  crashFrequency: number
}

/**
 * 变更频率的调制乘数 ∈ [1, 1+α]。
 *
 * `changeCount` 缺失 ⇒ 1（不变）。这是向后兼容的关键：
 * 没有频率信息时结论与 v0.12 逐位相同。
 */
export function changeDensityMultiplier(changeCount?: number): number {
  if (changeCount === undefined || !Number.isFinite(changeCount) || changeCount <= 1) return 1
  const density = Math.min(changeCount, CHANGE_FREQUENCY.cap) / CHANGE_FREQUENCY.cap
  return 1 + CHANGE_FREQUENCY.alpha * density
}

/** 分解三因子的加权贡献（未取整，供 riskScore 与快照共用）。 */
export function riskFactors(input: RiskInput, now = Date.now()): RiskFactorContributions {
  const changed = Date.parse(input.lastChangeAt)
  const ageHours = Number.isFinite(changed) ? Math.max(0, (now - changed) / 3_600_000) : Number.POSITIVE_INFINITY
  const baseRecency = ageHours === Number.POSITIVE_INFINITY ? 0 : Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS)
  const recency = baseRecency * changeDensityMultiplier(input.changeCount)
  const experimental = input.experimental ? 1 : 0
  const frequency = input.observations > 0 ? input.suspectHits / input.observations : 0
  return {
    recency: RISK_WEIGHTS.recency * recency,
    experimental: RISK_WEIGHTS.experimental * experimental,
    crashFrequency: RISK_WEIGHTS.crashFrequency * frequency,
  }
}

/** 计算单个插件的崩溃风险。 */
export function riskScore(input: RiskInput, now = Date.now()): number {
  const f = riskFactors(input, now)
  return round4(Math.min(1, Math.max(0, f.recency + f.experimental + f.crashFrequency)))
}

/**
 * 崩溃趋势 —— 判定「崩溃是否在加剧」。
 *
 * 模型：对崩溃时间序列做**简单线性回归**的斜率（每单位时间的崩溃数），
 * 再归一化到 [-1, 1]。正斜率 = 越崩越频繁（恶化），负斜率 = 改善。
 *
 * 为什么用线性回归而不是简单计数：计数无法区分「3 次崩溃集中在 1 分钟」
 * 与「3 次崩溃分散在 3 个月」—— 前者是急性恶化，后者是偶发。
 * 斜率恰好编码了这个时间分布信息。
 */
export interface TrendResult {
  /** 归一化斜率 ∈ [-1,1]。 */
  slope: number
  /** 原始斜率（崩溃数 / 天）。 */
  rawSlope: number
  /** 样本数。 */
  samples: number
  /** 趋势判定。 */
  verdict: 'improving' | 'stable' | 'worsening'
  /** 判定阈值（斜率绝对值）。 */
  threshold: number
}

/**
 * 趋势判定的斜率阈值（小时/次）。
 *
 * 基准是「相邻崩溃的间隔每次变化 1 小时」：超过它说明崩溃间隔在明显
 * 缩短或延长，低于它则视为平稳（避免把噪声当趋势）。
 */
export const TREND_THRESHOLD = 1

/** 计算崩溃趋势。 */
export function crashTrend(crashTimes: number[], _now?: number): TrendResult {
  const samples = crashTimes.filter((t) => Number.isFinite(t)).sort((a, b) => a - b)
  if (samples.length < 2) {
    return { slope: 0, rawSlope: 0, samples: samples.length, verdict: 'stable', threshold: TREND_THRESHOLD }
  }

  // 相邻崩溃的间隔序列（毫秒）。**回归间隔而不是崩溃时刻** ——
  // 只有间隔携带「变密 / 变稀」的方向信息。
  const gaps: number[] = []
  for (let i = 1; i < samples.length; i += 1) gaps.push(samples[i] - samples[i - 1])

  // X = 间隔序号；Y = 间隔长度（小时）。
  const xs = gaps.map((_, index) => index)
  const ys = gaps.map((gap) => gap / 3_600_000)
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i += 1) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY)
    denominator += (xs[i] - meanX) ** 2
  }
  // 斜率 b（小时/次）：负 ⇒ 间隔在缩短 ⇒ 崩溃在变密（恶化）。
  const rawSlope = denominator === 0 ? 0 : numerator / denominator
  // 归一化：间隔每次缩短/延长 24 小时视为满分。
  const slope = Math.max(-1, Math.min(1, -rawSlope / 24))
  const verdict =
    rawSlope < -TREND_THRESHOLD ? 'worsening' : rawSlope > TREND_THRESHOLD ? 'improving' : 'stable'
  return { slope: round4(slope), rawSlope: round4(rawSlope), samples: n, verdict, threshold: TREND_THRESHOLD }
}
