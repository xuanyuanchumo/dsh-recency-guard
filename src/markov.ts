/**
 * 生命周期阶段转移的**马尔可夫链视角**（v0.10 · R11 可观测性增强）。
 *
 * ## 为什么是马尔可夫而不是直接数迁移次数
 *
 * 迁移历史是一串 `(from, to)` 序列。直接数次数只能回答「哪个迁移最多」，
 * 回答不了「这个系统的**行为模式**」：
 * - **转移概率矩阵**给每个阶段一个「去向分布」—— monitoring 有 80% 回到
 *   自己（健康值守）还是有 40% 掉进 crashed（高危巡逻），一行读数见分晓；
 * - **平稳分布**（幂法迭代）回答「长期来看守护花在哪」：若 crashed 的
 *   平稳占比高，说明这个 profile 的插件生态在持续引发崩溃，归档/重装
 *   才是根治，面板反复「恢复成功」只是止痛。
 *
 * ## 诚实边界（本插件铁律）
 *
 * 样本不足（迁移数 < 阶段数下限）或无法收敛 ⇒ `defined:false`（null），
 * 绝不把「无数据」当「确定性分布」。行和为 0 的孤立阶段（从未迁出）
 * 不参与平稳分布归一 —— 用它自己的自环概率 1 处理（吸收态语义），
 * 但在 label 里如实说明「无迁出样本」。
 *
 * ## 复杂度
 *
 * 构建 O(T)（T = 迁移数），幂法 O(K·S²)（K = 迭代数 ≤ 200，S = 阶段数 = 6）。
 * S 是常数，整体线性于迁移历史长度。
 */

/** 生命周期阶段（与 lifecycle.ALL_STAGES 同序；客户端不 import 宿主常量，这里独立声明）。 */
export const MARKOV_STAGES = ['idle', 'monitoring', 'crashed', 'deciding', 'stabilizing', 'recovered'] as const

export type MarkovStage = (typeof MARKOV_STAGES)[number]

/** 一条迁移记录的最小形状（与 lifecycle.StageTransition 兼容的窄投影）。 */
export interface MarkovTransition {
  from: string
  to: string
}

/** 转移概率矩阵的行（一个阶段的去向分布）。 */
export interface MarkovRow {
  /** 行阶段 id。 */
  stage: MarkovStage
  /** 去向计数：`Record<阶段 id, 次数>`（缺键 = 0）。 */
  counts: Record<string, number>
  /** 行总计（迁出次数；0 = 从未迁出，概率行不可判定）。 */
  total: number
  /** 去向概率（total > 0 时才有；键同 counts）。 */
  probabilities: Record<string, number> | null
  /** 人读标签（含「无迁出样本」这类诚实说明）。 */
  label: string
}

/** 马尔可夫分析结果（快照契约）。 */
export interface MarkovAnalysis {
  /** 转移计数矩阵（含行合计）。 */
  rows: MarkovRow[]
  /** 平稳分布（幂法收敛后；未收敛或样本不足为 null —— 不猜）。 */
  stationary: Record<string, number> | null
  /** 平稳分布是否收敛（‖π_{k+1}−π_k‖∞ < ε）。 */
  converged: boolean
  /** 迁移样本数（矩阵的总计数，即有效 from→to 对数）。 */
  samples: number
  /** 人读摘要（每行一个事实，面板逐行渲染）。 */
  label: string
}

/** 幂法迭代上限（S=6 的随机矩阵几十次内必收敛，200 是安全上限）。 */
const POWER_ITERATIONS = 200

/** 收敛阈值（L∞ 距离；1e-9 对四位小数显示足够）。 */
const EPSILON = 1e-9

/**
 * 从迁移历史构建马尔可夫分析。
 *
 * @param transitions 迁移历史（时间升序；乱序不影响计数，只影响「最后状态」语义）
 */
export function markovAnalysis(transitions: readonly MarkovTransition[]): MarkovAnalysis {
  const rows: MarkovRow[] = MARKOV_STAGES.map((stage) => ({
    stage,
    counts: {},
    total: 0,
    probabilities: null,
    label: '',
  }))
  const byStage = new Map<string, MarkovRow>(rows.map((row) => [row.stage, row]))

  // 未知阶段名（状态机白名单之外）不进矩阵 —— 计入 samples 会虚增置信度，
  // 丢弃并在 label 里说明是「白名单外迁移」。当前状态机不会产生它们，
  // 但 journal 是持久数据，旧版本/手改数据可能带进来。
  let unknown = 0
  let samples = 0
  for (const transition of transitions) {
    const from = byStage.get(transition.from)
    if (!from || !byStage.has(transition.to)) {
      unknown += 1
      continue
    }
    from.counts[transition.to] = (from.counts[transition.to] ?? 0) + 1
    from.total += 1
    samples += 1
  }

  // 概率行：total > 0 才可判定（0/0 不是 0，是「从未迁出」）。
  for (const row of rows) {
    if (row.total === 0) {
      row.label = `${row.stage}：无迁出样本`
      continue
    }
    const probabilities: Record<string, number> = {}
    for (const [to, count] of Object.entries(row.counts)) {
      probabilities[to] = Math.round((count / row.total) * 10000) / 10000
    }
    row.probabilities = probabilities
    const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]
    row.label = `${row.stage} → ${top?.[0] ?? '?'} ${((top?.[1] ?? 0) * 100).toFixed(0)}%（${row.total} 次迁出）`
  }

  // 平稳分布：幂法 π_{k+1} = π_k · P。无迁出样本的阶段按吸收态（自环 1）处理，
  // 否则行随机性破坏（行和 0）会让幂法发散。
  let stationary: Record<string, number> | null = null
  let converged = false
  if (samples > 0) {
    let pi = uniform()
    for (let iteration = 0; iteration < POWER_ITERATIONS; iteration += 1) {
      const next = multiply(pi, rows)
      const delta = infinityNorm(next, pi)
      pi = next
      if (delta < EPSILON) {
        converged = true
        break
      }
    }
    stationary = Object.fromEntries(MARKOV_STAGES.map((stage, index) => [stage, Math.round((pi[index] ?? 0) * 10000) / 10000]))
  }

  const summary =
    samples === 0
      ? '迁移历史为空，转移矩阵不可判定'
      : `${samples} 次迁移${unknown > 0 ? `（丢弃 ${unknown} 条白名单外记录）` : ''}${stationary && converged ? ` · 长期占比最高：${topStationary(stationary)}` : ''}`

  return { rows, stationary, converged, samples, label: summary }
}

/** 均匀初始分布。 */
function uniform(): number[] {
  return MARKOV_STAGES.map(() => 1 / MARKOV_STAGES.length)
}

/** π · P（行向量乘随机矩阵；无迁出的阶段按吸收态自环 1）。 */
function multiply(pi: readonly number[], rows: readonly MarkovRow[]): number[] {
  return MARKOV_STAGES.map((_, toIndex) => {
    const toStage = MARKOV_STAGES[toIndex] ?? ''
    let sum = 0
    rows.forEach((row, fromIndex) => {
      const p = row.probabilities?.[toStage] ?? 0
      // 吸收态：无迁出样本的阶段以概率 1 停在自己身上。
      sum += (pi[fromIndex] ?? 0) * (row.total === 0 ? (toIndex === fromIndex ? 1 : 0) : p)
    })
    return sum
  })
}

/** L∞ 距离（逐分量最大绝对差）。 */
function infinityNorm(a: readonly number[], b: readonly number[]): number {
  let max = 0
  for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
  return max
}

/** 平稳分布里占比最高的阶段（并列取字典序，确定性输出）。 */
function topStationary(stationary: Record<string, number>): string {
  let best = ''
  let value = -1
  for (const [stage, share] of Object.entries(stationary)) {
    if (share > value || (share === value && stage < best)) {
      best = stage
      value = share
    }
  }
  return `${best} ${(value * 100).toFixed(0)}%`
}
