import type { PanelSnapshotView } from '../../src/client/panel/snapshot-view.ts'
import { metricRows, stabilityView } from '../../src/client/panel/panel-model.ts'
import { t } from '../../src/client/i18n/i18n.ts'

/**
 * 可空读数回归 —— 真机 v0.16 崩溃快照（`intervals.cv = null`）。
 *
 * ## 为什么这条测试必须存在
 *
 * 宿主 `Metric<T>.defined === true` **不等于**所有子字段非空：
 * `intervals.value.cv` 在「间隔样本 < 2」时是 null（宿主类型 `IntervalStats`
 * 已声明 `cv: number | null`）。客户端 formatter 曾把它写成 `cv: number`
 * 并用 `as never` 逃过类型检查 → 真机 `cv.toFixed` 抛 TypeError，
 * 整个面板被错误边界接管。
 *
 * 断言锚点与实现同源：期望文案用 `t('metrics.undefined')` 取字典，
 * 不手抄「不可判定」四个字（CLAUDE.md：断言的锚点必须与实现文案同源）。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const UNDEFINED = t('metrics.undefined')
const CV_REASON = '间隔样本 < 2，离散度无自由度'

/** 真机快照里的 intervals 子结构（cv 为 null 是崩溃源）。 */
function intervalMetric() {
  return {
    defined: true,
    label: '2 个间隔',
    value: {
      medianMs: 2670479,
      meanMs: 2670479,
      cv: null,
      cvReason: CV_REASON,
      madMs: 0,
      iqrMs: 0,
      minMs: 2670479,
      maxMs: 2670479,
    },
  }
}

function undefinedMetric(reason = '样本不足') {
  return { defined: false, value: null, label: '', reason }
}

function fixture(overrides: Partial<PanelSnapshotView> = {}): PanelSnapshotView {
  return {
    at: '2026-11-11T04:00:00.000Z',
    profile: 'sb-rg-c14',
    projectKey: 'abcdef1234567890',
    stage: 'monitoring',
    stageLabel: '监控中',
    transitions: [],
    stabilityScore: null,
    metrics: {
      crashRate: undefinedMetric(),
      crashPressure: { defined: true, value: 0.42, label: '压力 0.42' },
      detectionRate: undefinedMetric(),
      isolationPurity: undefinedMetric(),
      meanRecoveryTime: undefinedMetric(),
      intervals: intervalMetric(),
      changePoint: undefinedMetric(),
      controlBand: undefinedMetric(),
      survival: undefinedMetric(),
      intervalTrend: undefinedMetric(),
      trend: { samples: 0, verdict: 'stable', rawSlope: 0 },
      trendMetric: undefinedMetric(),
      stabilityScore: null,
    },
    risks: [],
    decisionSuspects: [],
    cooccurrence: {
      samples: 0,
      activeSamples: 0,
      inactiveSamples: 0,
      activeHitRate: null,
      inactiveHitRate: null,
      hitRateDelta: null,
      label: '',
      mayWeight: { allowed: false, reason: '' },
    },
    calibration: {
      rate: { value: null },
      decision: { base: 2, required: 2, delta: 0 },
      explanation: '',
      unattributedRestores: 0,
    },
    bayes: [],
    capability: null,
    graphConnectivity: null,
    backupPolicy: { versionedBackups: true, retain: 5, customRoot: false, root: '', configEditorAvailable: true },
    partitions: [],
    revision: null,
    recentEvents: [],
    eventFlow: [],
    markov: null,
    diagnostics: {
      pluginVersion: '0.16.0',
      hostVersion: null,
      platform: 'win32',
      nodeVersion: 'v24',
      dataPlane: true,
      snapshotMs: null,
      repositoryUrl: null,
      issuesUrl: null,
    },
    ...overrides,
  } as unknown as PanelSnapshotView
}

console.log('\n[intervals.cv = null：真机崩溃 fixture]')
let rows: ReturnType<typeof metricRows> = []
let threw: unknown = null
try {
  rows = metricRows(fixture())
} catch (error) {
  threw = error
}
check('metricRows 不抛异常（崩溃源已消除）', threw === null, threw instanceof Error ? threw.message : threw)
const intervalRow = rows.find((row) => row.key === 'intervals')
check('intervals 行仍然可读（中位间隔没被 null 连带丢弃）', intervalRow?.defined === true)
check('中位间隔按秒格式化', intervalRow?.value.includes('2670.5 s') === true, intervalRow?.value)
check('cv null ⇒ 显示不可判定', intervalRow?.value.includes(`CV ${UNDEFINED}`) === true, intervalRow?.value)
check('把宿主的 cvReason 一起显示（不留白）', intervalRow?.value.includes(CV_REASON) === true, intervalRow?.value)
// 报告证据：把该 fixture 下的真实输出打出来（不是“测试绿了”四个字）。
console.log('  OUT   intervals 行 =', JSON.stringify({ defined: intervalRow?.defined, value: intervalRow?.value, reason: intervalRow?.reason }))

console.log('\n[稳定性评分 null ≠ 0]')
const nullScore = stabilityView(null)
check('null ⇒ 不可判定', nullScore.defined === false && nullScore.text === UNDEFINED)
check('null 不产生 0 分圆环几何（percent=0 但 defined=false 已标记）', nullScore.percent === 0)
const zeroScore = stabilityView(0)
check('真实的 0 分仍是「可判定」的 0（与 null 可区分）', zeroScore.defined === true && zeroScore.text === '0.00')
check('0 分的圆环几何 percent=0', zeroScore.percent === 0)
check('NaN ⇒ 不可判定（不渲染 NaN%）', stabilityView(Number.NaN).defined === false)
check('undefined ⇒ 不可判定', stabilityView(undefined).defined === false)
const high = stabilityView(0.876)
check('正常评分保留两位读数', high.text === '0.88')
check('圆环几何按百分比', Math.abs(high.percent - 87.6) < 1e-9, high.percent)

console.log('\n[metrics = null（跨分区只读视图）]')
const unavailable = metricRows(fixture({ metrics: null }))
check('只给一行「不可判定」而不是 8 行假 0', unavailable.length === 1)
check('行标记 defined=false', unavailable[0]?.defined === false)
check('原因说明跨分区视图不提供运行时指标', unavailable[0]?.reason?.includes('跨分区') === true, unavailable[0]?.reason)
check('读数文案是不可判定', unavailable[0]?.value === UNDEFINED)

console.log('\n[defined=true 但 value=null（结构不完整的旧记录）]')
const brokenValue = metricRows(
  fixture({
    metrics: {
      ...fixture().metrics!,
      crashRate: { defined: true, value: null, label: '' },
    },
  }),
)
const crashRow = brokenValue.find((row) => row.key === 'crashRate')
check('不可判定（不调用 toFixed）', crashedSafe(crashRow))
function crashedSafe(row: ReturnType<typeof metricRows>[number] | undefined): boolean {
  return row !== undefined && row.defined === false && row.value === UNDEFINED
}
check('原因指出声明为可判定但值为空', crashRow?.reason?.includes('不完整') === true, crashRow?.reason)

console.log('\n[风险/贝叶斯/校准的数值入口（纯格式化）]')
// 这些格式化函数在 PanelCards 内部，但同一个不可判定口径由 metricRows 覆盖；
// 这里旁证 null 不会被任何格式化路径当成 0。
check('intervals 行没有把 null 当作 0', intervalRow?.value.includes('CV 0.00') === false)

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')