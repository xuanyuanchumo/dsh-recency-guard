import { configChangeCusum, loadTimeEwma, type ConfigChangeCusum, type LoadTimeBand } from '../observe/preventive.ts'
import type { JournalRecord } from '../data/store.ts'

/**
 * RQ3 预防性读数的**生产投影**（T15-01）—— 把 `preventive.ts` 从孤岛接进数据面。
 *
 * ## 为什么需要这一层（研究闭环缺口）
 *
 * `preventive.ts` 的 `loadTimeEwma` / `configChangeCusum` 是 07 §4 的实现，
 * 但在 v0.16 之前**只有单测直接 import**（全仓对 preventive 的 import 依赖点 = 0）
 * ⇒ 机制存在、生产零消费 ⇒ 面板永远看不到预警。没有消费者的机制就是孤岛；
 * 本文件是它的第一个生产消费者，只做「取真实 journal 事实 → 投影」。
 *
 * ## 两个代理（代理不是测量，必须写在数据面里）
 *
 * ### 加载耗时：用「启动频率」而不是直接测加载
 *
 * journal 里**没有**加载耗时的落盘事实：`recordStartupSync` 写启动 note 时
 * 加载已经结束，之后的事件只记录变更，不记录耗时。唯一能拿到的真实时间戳
 * 是**相邻启动 note 的时刻差**（同一 profile 的分区 journal 天然按工作区隔离）。
 *
 * 但直接把「间隔」喂给 EWMA 会让越界方向反过来：间隔变大 = 启动变稀 = 更安全，
 * 而模型只在**上越界**时预警（`level > upper`）。因此投影序列取同一份事实的
 * **倒数**：启动频率（次/分钟）= 60_000 / 间隔。频率上越界 ⇔ 启动变密 ⇔
 * 更可能在崩溃循环里 —— 与「越界即风险」同向。
 *
 * 这也是为什么下面把 `LoadTimeBand` 的 `*Ms` 字段映射成中性名
 * （`current/baseline/upper/lower/sigma`）：单位已经不是毫秒，继续叫 Ms
 * 就是在数据面撒谎。单位写在 `source.units` 里（`per-minute`）。
 *
 * 代理的失真面（诚实登记）：间隔里混着「会话有多长」与「停了多久」，
 * 它**不能**告诉你「这次启动比上次慢了多少毫秒」。它能回答的只是
 * 「启动是否变得异常频繁」，这是崩溃前兆不是加载性能。
 *
 * ### 配置变更：install/update 的事件时刻
 *
 * `configChangeCusum` 要的是「变更时刻序列」，journal 的 `install`/`update`
 * 事件恰好逐条带时刻（`t`）—— 这对它来说是**直接测量**而非代理（粒度是
 * 事件到达时刻，不是 fs 写入时刻，但「变更频率」正是按事件口径定义的）。
 *
 * ## 只预警不行动（07 §4.3 硬纪律）
 *
 * 本文件与 `preventive.ts` 都只返回读数：不 import 任何决策/关闭模块，
 * 也不被它们 import（`tests/unit/preventive-wiring.test.ts` 的源码扫描断言
 * 钉住这条依赖方向）。是否动手由 RQ1/RQ2 的取证流程决定。
 *
 * ## Metric 纪律
 *
 * 样本不足 ⇒ `defined:false` + `reason`（透传模型的原文），`value` 恒为 null。
 * **绝不填 0**：把「没有数据」渲染成绿灯是本项目最忌讳的假绿。
 */

/** 启动频率（次/分钟）—— 见头注：这是「相邻启动时刻差」的倒数代理。 */
export type PreventiveUnits = 'per-minute'

/** 启动频率控制带的投影（中性字段名：单位不是毫秒）。 */
export interface PreventiveBandView {
  /** 当前 EWMA 水平（次/分钟）。 */
  current: number
  /** 中心线（历史频率中位数）。 */
  baseline: number
  /** 上控制限；`current > upper` ⇒ 启动变密预警。 */
  upper: number
  /** 下控制限（白盒对照；夹到 ≥ 0，不参与预警）。 */
  lower: number
  /** 稳健标准差 σ̂（次/分钟）。 */
  sigma: number
  /** σ̂ 的估计器（MAD 在 ≥50% 同值时会降级，写进读数防止误读成「变稳」）。 */
  sigmaEstimator: string
  /** current / baseline。 */
  ratio: number
  /** 是否越界（**只预警不行动**）。 */
  alert: boolean
}

/** 配置变更频率 CUSUM 的投影。 */
export interface PreventiveCusumView {
  statistic: number
  threshold: number
  reference: number
  baselineMs: number
  sigmaMs: number
  sigmaEstimator: string
  intervals: number
  breachIndex: number | null
  alert: boolean
}

/** 一个预防性读数的命令窗口/面板形态。 */
export interface PreventiveMetricView<T> {
  /** 是否可判定（false ⇒ value === null，reason 必填）。 */
  defined: boolean
  /** 人读结论（可判定与不可判定都有，命令窗口直接显示）。 */
  label: string
  /** 不可判定的原因（可判定时为 null）。 */
  reason: string | null
  /** 参与计算的样本量（0 = 一条都没有）。 */
  samples: number
  /** 可判定时才有值。 */
  value: T | null
}

/** 预防性读数（`PanelSnapshot.preventive` 与 `status` 输出共用同一形状）。 */
export interface PreventiveView {
  /** 加载耗时代理：启动频率 EWMA 控制带。 */
  loadTime: PreventiveMetricView<PreventiveBandView>
  /** 配置变更频率：install/update 间隔 CUSUM。 */
  configChanges: PreventiveMetricView<PreventiveCusumView>
  /** 数据来源与代理链（面板必须能回答「这个数是怎么来的」）。 */
  source: {
    /** 参与代理的启动样本数（启动 note 条数）。 */
    bootSamples: number
    /** 参与 CUSUM 的变更事件数（install/update 条数）。 */
    changeSamples: number
    /** 序列单位（当前恒为 per-minute：启动频率）。 */
    units: PreventiveUnits
    /** 一句话代理说明（面板原样显示，防止被读成「真实加载耗时」）。 */
    note: string
  }
}

/** 启动 note 的 detail 前缀（与 `startup-record.ts` 写入的文案同源）。 */
export const BOOT_NOTE_PREFIX = 'dsh 启动 pid='

/** journal 里每一轮的启动时刻（升序，毫秒）。 */
export function bootTimestamps(journal: readonly JournalRecord[]): number[] {
  const times: number[] = []
  for (const record of journal) {
    if (record.kind !== 'note') continue
    if (typeof record.detail !== 'string' || !record.detail.startsWith(BOOT_NOTE_PREFIX)) continue
    const parsed = Date.parse(record.t)
    if (Number.isFinite(parsed)) times.push(parsed)
  }
  return times.sort((a, b) => a - b)
}

/** journal 里每一条 install/update 的时刻（升序，毫秒）—— 配置变更序列。 */
export function configChangeTimestamps(journal: readonly JournalRecord[]): number[] {
  const times: number[] = []
  for (const record of journal) {
    if (record.kind !== 'install' && record.kind !== 'update') continue
    const parsed = Date.parse(record.t)
    if (Number.isFinite(parsed)) times.push(parsed)
  }
  return times.sort((a, b) => a - b)
}

/**
 * 相邻启动间隔（毫秒，**只取 > 0 且有限**）。
 *
 * ## 为什么导出（T15 变异门禁：把兜底变成契约）
 *
 * 它原本私有，而 `i < boots.length` / `gap > 0` 两处边界只能靠「间接读快照」
 * 观察 ⇒ 变异体改坏后没有测试变红。导出后可以直接断言：
 * - `bootIntervals([t, t]) === []`（**同一毫秒的两次启动不产生间隔** —— 若
 *   `gap > 0` 被改成 `>= 0`，这里会得到 `[0]`，随后 `60000/0 = Infinity`
 *   进入频率序列；`loadTimeEwma` 会把它过滤掉，所以只有直接断言才杀得死）；
 * - 返回的每一项都必须 `Number.isFinite` 且 `> 0`。
 *
 * ## 为什么用「前一项」游标而不是下标循环
 *
 * 下标写法 `for (i = 1; i < boots.length)` 的边界变异（`<` → `<=`）只多读一个
 * 越界元素、得到 `NaN`，被 `gap > 0` 过滤 ⇒ 行为不可观测（上一轮就是这条
 * 进了未归因）。改成「遍历 + 前一项」后，循环边界不再依赖 `boots.length`，
 * 也就不存在这个变异点；剩下的守卫 `previous !== undefined` 与
 * `gap > 0` 都有直接断言钉住。
 */
export function bootIntervals(boots: readonly number[]): number[] {
  const gaps: number[] = []
  let previous: number | undefined
  for (const current of boots) {
    if (previous !== undefined) {
      const gap = current - previous
      // 过滤三类：同刻启动（gap=0，倒数会是 Infinity）、时间倒退（负值）、
      // 非有限输入（NaN 比较恒 false，天然被拦）。
      if (Number.isFinite(gap) && gap > 0) gaps.push(gap)
    }
    previous = current
  }
  return gaps
}

/** 启动频率（次/分钟）= 60_000 / 间隔毫秒。 */
function frequencyPerMinute(intervalsMs: readonly number[]): number[] {
  return intervalsMs.map((gap) => 60000 / gap)
}

/** 把模型的 `Metric` 投影成可跨运行时消费的窄形状（defined/value 不变式原样保留）。 */
function projectBand(band: ReturnType<typeof loadTimeEwma>): PreventiveMetricView<PreventiveBandView> {
  const value: LoadTimeBand | null = band.value
  return {
    defined: band.defined,
    label: band.label,
    reason: band.reason ?? (band.defined ? null : '不可判定'),
    samples: band.sampleSize ?? 0,
    value:
      value === null
        ? null
        : {
            current: value.levelMs,
            baseline: value.baselineMs,
            upper: value.upperMs,
            lower: value.lowerMs,
            sigma: value.sigmaMs,
            sigmaEstimator: value.sigmaEstimator,
            ratio: value.ratio,
            alert: value.alert,
          },
  }
}

/** 同上，CUSUM 形态。 */
function projectCusum(metric: ReturnType<typeof configChangeCusum>): PreventiveMetricView<PreventiveCusumView> {
  const value: ConfigChangeCusum | null = metric.value
  return {
    defined: metric.defined,
    label: metric.label,
    reason: metric.reason ?? (metric.defined ? null : '不可判定'),
    samples: metric.sampleSize ?? 0,
    value:
      value === null
        ? null
        : {
            statistic: value.statistic,
            threshold: value.threshold,
            reference: value.reference,
            baselineMs: value.baselineMs,
            sigmaMs: value.sigmaMs,
            sigmaEstimator: value.sigmaEstimator,
            intervals: value.intervals,
            breachIndex: value.breachIndex,
            alert: value.alert,
          },
  }
}

/**
 * 空读数（没有 journal 可读时）。
 *
 * 为什么不返回 `null`：面板与命令窗口需要**同一形状**才能稳定渲染；
 * 「没有样本」由 `defined:false + reason` 表达，这比「字段缺失」更难被
 * 误读成「没问题」。每次调用造新对象，避免共享可变引用。
 */
export function emptyPreventive(): PreventiveView {
  return projectPreventive([])
}

/**
 * 由 journal 投影出预防性读数（纯函数：同一 journal 必得同一输出）。
 *
 * 为什么在**投影层**而不是 Guard 里算：快照与 status 是两条消费路径，
 * 各算一遍必然漂移；投影层只依赖 journal 事实，可被单测直接驱动。
 */
export function projectPreventive(journal: readonly JournalRecord[]): PreventiveView {
  const boots = bootTimestamps(journal)
  const intervals = bootIntervals(boots)
  const changes = configChangeTimestamps(journal)
  return {
    loadTime: projectBand(loadTimeEwma(frequencyPerMinute(intervals))),
    configChanges: projectCusum(configChangeCusum(changes)),
    source: {
      bootSamples: boots.length,
      changeSamples: changes.length,
      units: 'per-minute',
      note: '启动频率（次/分钟）= 相邻启动 note 时刻差的倒数；代理不是真实加载耗时（间隔里混着会话长度与停机时间）。只预警，不关闭任何插件。',
    },
  }
}