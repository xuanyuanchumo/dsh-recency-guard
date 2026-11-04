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
 */

/** 生命周期状态。 */
export type GuardStage =
  | 'idle' // 空闲：已安装但没有需要守护的对象
  | 'monitoring' // 监控中：正常运行，记录安装/更新
  | 'crashed' // 崩溃：检测到上一次非正常退出
  | 'deciding' // 决策中：正在计算关闭哪些嫌疑插件
  | 'stabilizing' // 稳定中：已成功启动，准备恢复配置
  | 'recovered' // 已恢复：稳定运行且配置已恢复

/** 所有合法状态（穷举，供面板与测试使用）。 */
export const ALL_STAGES: readonly GuardStage[] = [
  'idle',
  'monitoring',
  'crashed',
  'deciding',
  'stabilizing',
  'recovered',
] as const

/** 一次状态迁移。 */
export interface StageTransition {
  from: GuardStage
  to: GuardStage
  /** 迁移原因（白盒透明）。 */
  reason: string
  /** 迁移时刻。 */
  at: string
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
 * 状态机。
 *
 * 迁移历史保留最近 N 条（环形缓冲），既是白盒透明的证据链，也是
 * 面板「生命周期流动」可视化的数据来源。
 */
export class StageMachine {
  private current: GuardStage
  private readonly history: StageTransition[] = []
  private readonly historyLimit: number

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

  /**
   * 尝试迁移。
   *
   * @returns 成功则返回 true；非法迁移不改变状态并返回 false（不抛异常：
   *          状态机是观测设施，不该因为一次非法迁移拖垮守护流程）。
   */
  transition(to: GuardStage, reason: string): boolean {
    if (!canTransition(this.current, to)) return false
    this.history.push({ from: this.current, to, reason, at: new Date().toISOString() })
    if (this.history.length > this.historyLimit) this.history.shift()
    this.current = to
    return true
  }

  /** 该状态下允许的动作。 */
  allowedActions(): readonly GuardStage[] {
    return ALLOWED[this.current]
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
}

/** 风险权重。 */
export const RISK_WEIGHTS = { recency: 0.5, experimental: 0.3, crashFrequency: 0.2 } as const

/** recency 因子的半衰期（小时）。 */
export const RECENCY_HALF_LIFE_HOURS = 72

/** 计算单个插件的崩溃风险。 */
export function riskScore(input: RiskInput, now = Date.now()): number {
  const changed = Date.parse(input.lastChangeAt)
  const ageHours = Number.isFinite(changed) ? Math.max(0, (now - changed) / 3_600_000) : Number.POSITIVE_INFINITY
  const recency = ageHours === Number.POSITIVE_INFINITY ? 0 : Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS)
  const experimental = input.experimental ? 1 : 0
  const frequency = input.observations > 0 ? input.suspectHits / input.observations : 0
  const score =
    RISK_WEIGHTS.recency * recency +
    RISK_WEIGHTS.experimental * experimental +
    RISK_WEIGHTS.crashFrequency * frequency
  return round4(Math.min(1, Math.max(0, score)))
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
