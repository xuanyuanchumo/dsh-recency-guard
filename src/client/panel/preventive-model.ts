/**
 * RQ3 预防性预警的**视图投影**（纯函数）—— 只读事实，绝不产生动作。
 *
 * ## 硬纪律（研究 07 §4.3）
 *
 * 「**只预警，不关闭任何插件**」：本文件只把 `preventive` 读数转成可渲染行，
 * 不含任何 `postAction` / `reenable` / 关闭决策的引用。面板上那张卡只能看，
 * 不能动手 —— 动手仍走 RQ1/RQ2 的取证流程。
 *
 * ## 诚实边界
 *
 * 1. `defined:false` ⇒ **不给任何数值行**（不显示 0），只显示宿主给的原因；
 * 2. 旧宿主没有 `preventive` 字段 / 跨分区只读视图不提供采集面 ⇒ 整卡显示
 *    「不可得」，而不是一张全 0 的绿灯卡；
 * 3. `defined:true` 但运行时子字段非有限（宿主投影可能漂移）⇒ 同样降级为
 *    不可判定 —— 与 `metricRows` 的 null 纪律同源，绝不 `Number(null)=0`。
 *
 * 纯函数、无 React/DOM；i18n 通过 `t()`（字典是客户端自持的，测试环境可跑）。
 */
import { t } from '../i18n/i18n.ts'
import type { PanelSnapshotView } from './snapshot-view.ts'

export interface PreventiveRow {
  key: string
  label: string
  /** 已格式化的读数（可能是不可判定文案，但不会把 null 变成 0）。 */
  value: string
}

export interface PreventiveRead {
  key: 'loadTime' | 'configChanges'
  title: string
  defined: boolean
  reason: string | null
  /** 宿主给的人读结论（可判定/不可判定都有）。 */
  label: string
  samples: number
  alert: boolean
  rows: PreventiveRow[]
}

export interface PreventiveSource {
  bootSamples: number
  changeSamples: number
  units: string
  note: string
}

export interface PreventiveSummary {
  /** false = 宿主没有该字段/视图不提供（整卡显示不可得，不伪造 0）。 */
  available: boolean
  reads: PreventiveRead[]
  source: PreventiveSource | null
  /** 卡片必须原样显示的纪律文案（只预警不行动）。 */
  note: string
  anyAlert: boolean
}

/** 有限数字判定：null/undefined/NaN/Infinity 都不是可展示读数。 */
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function percentOrValue(value: unknown, digits = 2): string {
  return finite(value) ? value.toFixed(digits) : t('metrics.undefined')
}

function preMinute(value: unknown): string {
  return finite(value) ? `${value.toFixed(2)} ${t('preventive.perMinute')}` : t('metrics.undefined')
}

function secondsOfMs(value: unknown, digits = 1): string {
  return finite(value) ? `${(value / 1000).toFixed(digits)} s` : t('metrics.undefined')
}

/**
 * 一个 Metric view 是否真的可渲染。
 *
 * `defined:true` 只在**值存在且所有必需子字段有限**时才算可判定；否则
 * 降级并给出原因（宿主 projection 的 `defined` 与 value 是两件事）。
 */
function usable<T>(metric: { defined: boolean; value: T | null; reason: string | null }, required: (value: T) => boolean): boolean {
  return metric.defined === true && metric.value !== null && required(metric.value)
}

export function preventiveSummary(snapshot: PanelSnapshotView): PreventiveSummary {
  const note = t('preventive.alertOnly')
  const preventive = snapshot.preventive
  if (preventive === null || preventive === undefined) {
    return { available: false, reads: [], source: null, note, anyAlert: false }
  }

  const load = preventive.loadTime
  const loadDefined = usable(load, (value) =>
    finite(value.current) && finite(value.baseline) && finite(value.upper) && finite(value.lower) && finite(value.sigma) && finite(value.ratio),
  )
  const loadRead: PreventiveRead = {
    key: 'loadTime',
    title: t('preventive.loadTime'),
    defined: loadDefined,
    reason: loadDefined ? null : (load.reason ?? t('metrics.valueUndefined')),
    label: load.label,
    samples: finite(load.samples) ? load.samples : 0,
    alert: loadDefined ? load.value!.alert === true : false,
    rows: loadDefined
      ? [
          { key: 'current', label: t('preventive.current'), value: preMinute(load.value!.current) },
          { key: 'baseline', label: t('preventive.baseline'), value: preMinute(load.value!.baseline) },
          { key: 'upper', label: t('preventive.upper'), value: preMinute(load.value!.upper) },
          { key: 'lower', label: t('preventive.lower'), value: preMinute(load.value!.lower) },
          {
            key: 'sigma',
            label: t('preventive.sigma'),
            value: `${percentOrValue(load.value!.sigma)} (${load.value!.sigmaEstimator})`,
          },
          { key: 'samples', label: t('preventive.samples'), value: String(load.samples) },
        ]
      : [],
  }

  const config = preventive.configChanges
  const configDefined = usable(config, (value) =>
    finite(value.statistic) && finite(value.threshold) && finite(value.reference) && finite(value.intervals) && finite(value.baselineMs),
  )
  const configRead: PreventiveRead = {
    key: 'configChanges',
    title: t('preventive.configChanges'),
    defined: configDefined,
    reason: configDefined ? null : (config.reason ?? t('metrics.valueUndefined')),
    label: config.label,
    samples: finite(config.samples) ? config.samples : 0,
    alert: configDefined ? config.value!.alert === true : false,
    rows: configDefined
      ? [
          { key: 'statistic', label: t('preventive.statistic'), value: percentOrValue(config.value!.statistic, 2) },
          { key: 'threshold', label: t('preventive.threshold'), value: percentOrValue(config.value!.threshold, 2) },
          { key: 'reference', label: t('preventive.reference'), value: percentOrValue(config.value!.reference, 2) },
          { key: 'baseline', label: t('preventive.baselineGap'), value: secondsOfMs(config.value!.baselineMs) },
          { key: 'sigma', label: t('preventive.sigma'), value: secondsOfMs(config.value!.sigmaMs) },
          { key: 'intervals', label: t('preventive.intervals'), value: String(config.value!.intervals) },
          {
            key: 'breach',
            label: t('preventive.breach'),
            value:
              config.value!.breachIndex === null
                ? t('preventive.noBreach')
                : t('preventive.breachAt', { index: config.value!.breachIndex }),
          },
        ]
      : [],
  }

  const source = preventive.source
  return {
    available: true,
    reads: [loadRead, configRead],
    source:
      source === undefined || source === null
        ? null
        : {
            bootSamples: finite(source.bootSamples) ? source.bootSamples : 0,
            changeSamples: finite(source.changeSamples) ? source.changeSamples : 0,
            units: source.units,
            note: source.note,
          },
    note,
    anyAlert: loadRead.alert || configRead.alert,
  }
}