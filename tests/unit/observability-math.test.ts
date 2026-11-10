/**
 * 可观测性数学模型单测（obs-math / W3）。
 *
 * 覆盖纪律：每个模型都要有**边界**断言 —— n=0/1/2、全部同值（方差 0 ⇒ 除零）、
 * 极端离群、NaN/Infinity、时间倒序输入。断言里钉的是**观测到的真实值**
 * （先跑 scratch 输出再钉），不是「看起来对」的猜测。
 */
import {
  RingBuffer,
  computeMetrics,
  crashIntervalStats,
  crashPressure,
  crashRate,
  crashSeries,
  cusumChangePoint,
  definedMetric,
  detectionRate,
  displayDigits,
  ewma,
  ewmaLevel,
  intervalTrend,
  isolationPurity,
  meanRecoveryTime,
  median,
  medianAbsoluteDeviation,
  quantile,
  rankHazards,
  rankRisks,
  sampleConfidence,
  tailWindow,
  trendMetric,
  undefinedMetric,
  type Metric,
} from '../../src/observability.js'
// RQ3 预防性健康指标：cycle-12 按「一个数学模型一个文件」拆到独立模块
// （原落点 observability.ts 复杂度被这两个模型顶上 115 的带外）。
import { configChangeCusum, loadTimeEwma } from '../../src/preventive.js'
import { controlBand } from '../../src/control-band.js'
import { intervalSurvival } from '../../src/survival.js'
import { markovAnalysis } from '../../src/markov.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const S = 1000
const BASE = Date.parse('2026-01-01T00:00:00.000Z')

/** 由间隔序列造崩溃时刻（间隔是一等公民，时刻是派生物）。 */
function timesFromGaps(gaps: number[], base = BASE): number[] {
  const times = [base]
  for (const g of gaps) times.push(times[times.length - 1] + g)
  return times
}

/** 快照里的每个 Metric 都必须是自洽的白盒读数。 */
function sweepWhitebox(label: string, snapshot: Record<string, unknown>): void {
  let seen = 0
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === null || typeof value !== 'object' || !('defined' in (value as object))) continue
    seen += 1
    const metric = value as Metric<unknown>
    check(
      `${label}.${key} 白盒自洽（defined/value/reason/formula/label 一致）`,
      typeof metric.label === 'string' &&
        metric.label.length > 0 &&
        typeof metric.formula === 'string' &&
        metric.formula.length > 0 &&
        typeof metric.sampleSize === 'number' &&
        (metric.defined
          ? metric.value !== null && metric.reason === undefined
          : metric.value === null && typeof metric.reason === 'string' && metric.reason.length > 0) &&
        (metric.confidence === undefined || (metric.confidence >= 0 && metric.confidence <= 1)),
      { defined: metric.defined, value: metric.value, reason: metric.reason, formula: metric.formula },
    )
  }
  check(`${label} 至少扫到一个 Metric（扫空会让上面全成空转）`, seen >= 8, seen)
}

function main(): void {
  console.log('\n== Metric 构造器：诚实边界 ==')
  const undef = undefinedMetric<number>('没有样本', '不可判定', { formula: 'x/n', sampleSize: 0 })
  check('undefinedMetric 的 value 恒为 null', undef.value === null && undef.defined === false)
  check('undefinedMetric 带 reason 与 formula', undef.reason === '没有样本' && undef.formula === 'x/n')
  const def = definedMetric(0, '零是真值', { formula: 'x/n', sampleSize: 3, confidence: 0.4 })
  check('definedMetric 的 0 与 null 不同', def.value === 0 && def.defined === true)
  check('definedMetric 透传 meta', def.sampleSize === 3 && def.confidence === 0.4)

  console.log('\n== 样本充分度与位数预算 ==')
  check('conf(0) = 0（无样本不给分）', sampleConfidence(0) === 0)
  check('conf(1) = 0（单样本不支撑断言）', sampleConfidence(1) === 0)
  check('conf(4) = 0.5', sampleConfidence(4) === 0.5)
  check('conf(25) = 0.8', sampleConfidence(25) === 0.8)
  check('conf(100) = 0.9', sampleConfidence(100) === 0.9)
  check('conf(Infinity) = 0（非有限不当满分）', sampleConfidence(Number.POSITIVE_INFINITY) === 0)
  check(
    'conf 单调不减',
    [1, 2, 4, 9, 25, 100].every((n, i, arr) => i === 0 || sampleConfidence(n) >= sampleConfidence(arr[i - 1])),
  )
  check('3 个样本只配 1 位有效数字', displayDigits(3) === 1, displayDigits(3))
  check('10 个样本配 2 位', displayDigits(10) === 2, displayDigits(10))
  check('100 个样本配 3 位', displayDigits(100) === 3, displayDigits(100))
  check('位数夹在 [1,4]', displayDigits(0) === 1 && displayDigits(1e9) === 4)

  console.log('\n== 基础比率 ==')
  const emptyRate = crashRate([])
  check('无观测 ⇒ 崩溃率不可判定（null，不是 0）', !emptyRate.defined && emptyRate.value === null)
  const zeroRate = crashRate([{ at: '2026-01-01T00:00:00.000Z', crashed: false }])
  check('零崩溃 ⇒ 有定义的 0', zeroRate.defined && zeroRate.value === 0)
  check('崩溃率带 formula 与 inputs', zeroRate.formula === 'crashes / starts' && zeroRate.inputs?.crashes === 0)
  const half = crashRate([
    { at: '2026-01-01T00:00:00.000Z', crashed: true },
    { at: '2026-01-01T00:01:00.000Z', crashed: false },
  ])
  check('1/2 崩溃 ⇒ 0.5，样本量 2', half.value === 0.5 && half.sampleSize === 2)
  const noRecovery = meanRecoveryTime([{ at: '2026-01-01T00:00:00.000Z', crashed: true }])
  check('无恢复样本 ⇒ 不可判定', !noRecovery.defined && noRecovery.value === null)
  const recovery = meanRecoveryTime([
    { at: '2026-01-01T00:00:00.000Z', crashed: true, recoveryMs: 1000 },
    { at: '2026-01-01T00:01:00.000Z', crashed: true, recoveryMs: 3000 },
    { at: '2026-01-01T00:02:00.000Z', crashed: true, recoveryMs: Number.NaN },
  ])
  check('NaN 恢复耗时不进样本（均值 2000，样本 2）', recovery.value === 2000 && recovery.sampleSize === 2, recovery)
  const noDetection = detectionRate([{ at: '2026-01-01T00:00:00.000Z', crashed: false }])
  check('无崩溃样本 ⇒ 检出率不可判定', !noDetection.defined)
  const pure = isolationPurity([])
  check('无分区 ⇒ 隔离纯度不可判定', !pure.defined)
  check('一半污染 ⇒ 0.5', isolationPurity([{ key: 'a', contaminated: false }, { key: 'b', contaminated: true }]).value === 0.5)

  console.log('\n== 序列基础设施：环形缓冲 / 尾部窗口 ==')
  const ring = new RingBuffer<number>(3)
  check('空缓冲 size 0', ring.size === 0 && ring.toArray().length === 0)
  ring.push(1)
  ring.push(2)
  check('未满时按写入顺序导出', JSON.stringify(ring.toArray()) === '[1,2]' && ring.size === 2)
  ring.push(3)
  ring.push(4)
  check('满后覆盖最旧（保留 [2,3,4]）', JSON.stringify(ring.toArray()) === '[2,3,4]', ring.toArray())
  check('size 不超过容量', ring.size === 3)
  const clamped = new RingBuffer<number>(0)
  check('容量 0 夹到 1（不抛异常，观测设施不拖垮流程）', clamped.capacity === 1)
  const fractional = new RingBuffer<number>(2.7)
  check('非整数容量向下取整', fractional.capacity === 2)
  const negative = new RingBuffer<number>(-5)
  check('负容量夹到 1', negative.capacity === 1)
  const nanCapacity = new RingBuffer<number>(Number.NaN)
  check('NaN 容量夹到 1', nanCapacity.capacity === 1)
  check('tailWindow 取尾部', JSON.stringify(tailWindow([1, 2, 3, 4], 2)) === '[3,4]')
  check('tailWindow limit<=0 返回全量（不是空）', JSON.stringify(tailWindow([1, 2, 3], 0)) === '[1,2,3]')
  check('tailWindow limit 超长返回全量', JSON.stringify(tailWindow([1, 2], 99)) === '[1,2]')

  console.log('\n== 分位数 / 中位数 / MAD ==')
  check('中位数（奇数长度）', median([3, 1, 2]) === 2)
  check('中位数（偶数长度）', median([4, 1, 3, 2]) === 2.5)
  check('空集中位数是 0（**契约不是指标**：0 ≠「中位数为零」）', median([]) === 0)
  check('quantile p=0 取下界', quantile([5, 1, 3], 0) === 1)
  check('quantile p=1 取上界', quantile([5, 1, 3], 1) === 5)
  check('quantile 线性插值（2 个样本的 p75）', quantile([0, 100], 0.75) === 75, quantile([0, 100], 0.75))
  check('quantile 乱序输入也正确', quantile([9, 1, 5], 0.5) === 5)
  check('quantile 空集为 0（同 median 契约）', quantile([], 0.5) === 0)
  check('MAD 抗离群：[1,1,1,100] 的 MAD 为 0', medianAbsoluteDeviation([1, 1, 1, 100]) === 0)
  check('MAD 基本值：[1,2,3,4] 的 MAD 为 1', medianAbsoluteDeviation([1, 2, 3, 4]) === 1, medianAbsoluteDeviation([1, 2, 3, 4]))
  check('MAD 空集为 0（契约）', medianAbsoluteDeviation([]) === 0)

  console.log('\n== EWMA / 去暖机 EWMA ==')
  check('空序列 EWMA = 0（函数契约）', ewma([]) === 0)
  check('H=1 的单点冲击：[0,0,0,10] ⇒ 5', ewma([0, 0, 0, 10], 1) === 5)
  check('短半衰期更重近期', ewma([0, 0, 0, 10], 1) > ewma([0, 0, 0, 10], 5))
  check('ewmaLevel 空集为 0', ewmaLevel([]) === 0)
  check('ewmaLevel 单点为它自己（去偏后暖机因子恰为 α）', ewmaLevel([5]) === 5, ewmaLevel([5]))
  check('ewmaLevel 常数序列严格还原常数（n=3 也必须）', ewmaLevel([10 * S, 10 * S, 10 * S]) === 10 * S, ewmaLevel([10 * S, 10 * S, 10 * S]))
  check('ewmaLevel 长常数序列同样还原', ewmaLevel(new Array(12).fill(60 * S)) === 60 * S)
  check(
    '未去偏的 EWMA 在常数序列上会低报（这就是必须去偏的证据）',
    ewma(new Array(3).fill(60 * S)) === 30 * S,
    ewma(new Array(3).fill(60 * S)),
  )

  console.log('\n== 崩溃序列归一（时间倒序 / NaN / Infinity） ==')
  const series = crashSeries([3000, 1000, 2000], ['c', 'a', 'b'])
  check('倒序输入被归一为正序', JSON.stringify(series.times) === '[1000,2000,3000]', series.times)
  check('标签跟着时刻重排（否则 at 会指错崩溃）', JSON.stringify(series.labels) === '["a","b","c"]', series.labels)
  check('间隔全为正', JSON.stringify(series.gaps) === '[1000,1000]', series.gaps)
  const junk = crashSeries([Number.NaN, 1000, Number.POSITIVE_INFINITY, 2000])
  check('NaN/Infinity 被过滤', junk.times.length === 2 && junk.gaps.length === 1, junk)
  const same = crashSeries([5000, 5000])
  check('同刻崩溃 ⇒ 间隔 0（诚实保留，不丢弃）', JSON.stringify(same.gaps) === '[0]', same.gaps)

  console.log('\n== 间隔统计 ==')
  check('崩溃数 < 2 ⇒ 不可判定', !crashIntervalStats([BASE]).defined)
  check('单崩溃 ⇒ 不可判定且 value 为 null', crashIntervalStats([BASE]).value === null)
  const pair = crashIntervalStats([0, 1000, 3000])
  check('两个间隔的中位数 = 1500', pair.defined && pair.value?.medianMs === 1500, pair.value)
  check('两个间隔的 CV（[1000,2000]）', pair.value?.cv !== null && Math.abs((pair.value?.cv ?? 0) - 0.3333) < 1e-4, pair.value)
  const single = crashIntervalStats(timesFromGaps([1000 * S]))
  check('单间隔：中位数可判定', single.defined && single.value?.medianMs === 1000 * S)
  check('单间隔：CV 必须为 null（样本标准差恒 0 是「没信息」不是「完全规则」）', single.value?.cv === null, single.value)
  check('单间隔：cvReason 指明自由度不足', (single.value?.cvReason ?? '').includes('自由度'), single.value?.cvReason)
  const allZero = crashIntervalStats(timesFromGaps([0, 0, 0]))
  check('全 0 间隔 ⇒ CV 为 null（分母为 0 不给 0）', allZero.defined && allZero.value?.cv === null, allZero.value)
  check('全 0 间隔：cvReason 指明分母为 0', (allZero.value?.cvReason ?? '').includes('分母为 0'), allZero.value?.cvReason)
  const regular = crashIntervalStats(timesFromGaps([1000 * S, 1000 * S, 1000 * S]))
  check('全同值（非零）⇒ CV 为 0 且**是真值**', regular.value?.cv === 0, regular.value)
  check('全同值 ⇒ MAD/IQR 均为 0', regular.value?.madMs === 0 && regular.value?.iqrMs === 0)
  const outlier = crashIntervalStats(timesFromGaps([1000 * S, 1000 * S, 1000 * S, 1e9 * S]))
  check('极端离群：中位数仍是 1000s（鲁棒）', outlier.value?.medianMs === 1000 * S, outlier.value)
  check('极端离群：CV 被抬起（1.732）', outlier.value?.cv === 1.732, outlier.value?.cv)
  check('极端离群：MAD 仍为 0（抗离群通道）', outlier.value?.madMs === 0, outlier.value?.madMs)
  check('间隔统计带样本量与公式', pair.sampleSize === 2 && (pair.formula ?? '').includes('median(g)'))

  console.log('\n== CUSUM 变点（必须基于相邻间隔） ==')
  check('单次崩溃 ⇒ 不可判定', !cusumChangePoint([BASE]).defined)
  const steady = cusumChangePoint(timesFromGaps([60 * S, 60 * S, 60 * S, 60 * S]))
  check('稳定间隔 ⇒ 未检出（defined=false，不是「变点在第 0 次」）', !steady.defined && steady.value === null, steady)
  check('未检出时 label 说明是「未检出」', steady.label === '未检出', steady.label)
  const accelerating = cusumChangePoint(timesFromGaps([60 * S, 60 * S, 10 * S, 10 * S, 10 * S]))
  check('持续变密 ⇒ 检出变点', accelerating.defined, accelerating)
  check('变点落在第 6 次崩溃（1-based）', accelerating.value?.index === 6, accelerating.value)
  check('变点带基准/阈值/统计量（白盒）', accelerating.value?.baselineMs === 60 * S && accelerating.value?.thresholdMs === 90 * S && accelerating.value?.statistic === 105 * S, accelerating.value)
  check('变点标签含「上行」且量纲统一成秒', accelerating.label.includes('上行') && accelerating.label.includes('S=105.0s'), accelerating.label)
  const singleSpike = cusumChangePoint(timesFromGaps([60 * S, 60 * S, 60 * S, 10 * S, 60 * S]))
  check('单次尖峰不构成变点（CUSUM 只对持续漂移敏感）', !singleSpike.defined, singleSpike)
  const zeroBaseline = cusumChangePoint(timesFromGaps([0, 0, 0]))
  check('基准为 0 ⇒ 不可判定（统计量无尺度可比）', !zeroBaseline.defined && zeroBaseline.value === null)
  check('基准为 0 的 reason 直说原因', (zeroBaseline.reason ?? '').includes('基准间隔为 0'), zeroBaseline.reason)
  // 时间倒序输入：变点必须与正序一致（含标签指向哪一次崩溃）。
  const forward = cusumChangePoint(timesFromGaps([60 * S, 60 * S, 10 * S, 10 * S, 10 * S]), ['1', '2', '3', '4', '5', '6'])
  const reversed = cusumChangePoint(timesFromGaps([60 * S, 60 * S, 10 * S, 10 * S, 10 * S]).slice().reverse(), ['6', '5', '4', '3', '2', '1'])
  check('倒序输入得到同一个变点', reversed.value?.index === forward.value?.index && forward.value?.index === 6, { forward: forward.value, reversed: reversed.value })
  check('倒序输入的 at 仍指向第 6 次崩溃的标签', forward.value?.at === '6' && reversed.value?.at === '6', { forward: forward.value?.at, reversed: reversed.value?.at })

  console.log('\n== 崩溃压力 EWMA ==')
  check('无观测 ⇒ 不可判定', !crashPressure([]).defined && crashPressure([]).value === null)
  const calm = crashPressure([
    { at: '2026-01-01T00:00:00.000Z', crashed: false },
    { at: '2026-01-01T00:01:00.000Z', crashed: false },
  ])
  check('全平稳 ⇒ 有定义的 0（有数据且没崩）', calm.defined && calm.value === 0)
  const recent = crashPressure([
    { at: '2026-01-01T00:00:00.000Z', crashed: false },
    { at: '2026-01-01T00:01:00.000Z', crashed: false },
    { at: '2026-01-01T00:02:00.000Z', crashed: true },
  ])
  const ancient = crashPressure([
    { at: '2026-01-01T00:00:00.000Z', crashed: true },
    { at: '2026-01-01T00:01:00.000Z', crashed: false },
    { at: '2026-01-01T00:02:00.000Z', crashed: false },
  ])
  check('近期崩溃权重更高（时间局部性）', (recent.value ?? 0) > (ancient.value ?? 0), { recent: recent.value, ancient: ancient.value })
  check('压力恒在 [0,1]', (recent.value ?? -1) >= 0 && (recent.value ?? 2) <= 1)
  check('压力带半衰期与样本量', recent.inputs?.halfLife === 5 && recent.sampleSize === 3)

  console.log('\n== 生存 / 危险率（指数 + Weibull） ==')
  // 成簇样本：9 个 100s 间隔 + 1 个 10000s ⇒ 过离散 ⇒ 危险率递减。
  const clustered = intervalSurvival(timesFromGaps([...new Array(9).fill(100 * S), 10_000 * S]))
  check('成簇样本 ⇒ 可判定', clustered.defined, clustered)
  check('成簇样本 ⇒ k < 0.9（危险率递减）', clustered.value?.weibullShape === 0.504 && clustered.value?.hazardDirection === 'decreasing', clustered.value)
  check('成簇样本 CV > 1（对指数模型的直接反证）', (clustered.value?.cvObserved ?? 0) > 1, clustered.value?.cvObserved)
  check('n=10 ≥ 9 ⇒ 方向判定可靠', clustered.value?.hazardDirectionReliable === true)
  check('指数拟合均值 = 样本均值', clustered.value?.exponentialMeanMs === 1_090_000, clustered.value?.exponentialMeanMs)
  check('指数 λ̂ = 1/均值', Math.abs((clustered.value?.exponentialRatePerMs ?? 0) - 1 / 1_090_000) < 1e-12)
  check('Weibull 均值 ≠ 样本均值（模型不同则矩不同，不能混用）', clustered.value?.weibullMeanMs !== clustered.value?.exponentialMeanMs, clustered.value)
  check('生存指标带置信度（n=10 ⇒ 0.6838）', clustered.confidence === 0.6838, clustered.confidence)
  // 指数型（近似泊松）样本：CV ≈ 1 ⇒ 形状落在恒定带。
  const poissonish = intervalSurvival(timesFromGaps([5, 10, 20, 40, 80, 160].map((x) => x * S)))
  check('近似指数样本 ⇒ 形状落入恒定带（0.9~1.1）', poissonish.value?.hazardDirection === 'constant', poissonish.value)
  check('近似指数样本的 CV ≈ 1', Math.abs((poissonish.value?.cvObserved ?? 0) - 1) < 0.1, poissonish.value?.cvObserved)
  // 近乎完全规则：MLE 发散 ⇒ 撞搜索上界，必须自曝而不是报「k=1000」。
  const nearRegular = intervalSurvival(timesFromGaps([1000 * S, 1000 * S, 1000 * S, 1000 * S, 1000 * S, 1001 * S]))
  check('近乎完全规则 ⇒ 形状撞上界并标注', nearRegular.value?.weibullShapeAtBound === true, nearRegular.value)
  check('撞上界时标签自曝（不伪装成精确估计）', nearRegular.label.includes('撞搜索上界'), nearRegular.label)
  check('n=6 < 9 ⇒ 方向判定不可靠', nearRegular.value?.hazardDirectionReliable === false)
  check('间隔 < 3 ⇒ 不可判定', !intervalSurvival(timesFromGaps([1000 * S, 2000 * S])).defined)
  check('间隔 < 3 的 reason 说明样本不足', (intervalSurvival(timesFromGaps([1000 * S, 2000 * S])).reason ?? '').includes('至少需要 3'), intervalSurvival(timesFromGaps([1000 * S, 2000 * S])).reason)
  const zeroGaps = intervalSurvival(timesFromGaps([0, 1000 * S, 0]))
  check('含 0 间隔 ⇒ 不可判定（对数似然发散）', !zeroGaps.defined && (zeroGaps.reason ?? '').includes('零间隔'), zeroGaps.reason)
  // **`zeros > 0` 这个守卫的可达性已实测确认为「只有零间隔能触发」**：
  // `crashSeries` 先过滤非有限值、再**排序**，所以 gaps 恒 ≥ 0
  // ⇒ 「非有限间隔」与「负间隔」两个分支实际不可达（排序把负间隔消灭了）。
  // 因此 `zeros > 0` 改成 `>= 0` 的变异在语义上**等价**——
  // 它只是把不可达分支的文案换掉。这条断言钉住「该分支确实不可达」，
  // 而不是假装测到了它（诚实边界：不可达 = 不可证伪，标出来而不是编一个用例）。
  const unsorted = intervalSurvival([3000, 1000, 2000, 1500])
  check(
    '乱序时间戳会被排序 ⇒ 不产生负间隔（故负间隔分支不可达）',
    unsorted.defined || (unsorted.reason ?? '').includes('至少需要 3'),
    unsorted.reason,
  )
  const allEqual = intervalSurvival(timesFromGaps([60 * S, 60 * S, 60 * S, 60 * S]))
  check('全等间隔 ⇒ 不可判定（形状不可辨识）', !allEqual.defined && (allEqual.reason ?? '').includes('方差 0'), allEqual.reason)
  check('全等间隔时仍如实给出指数估计（信息不浪费）', allEqual.inputs?.meanMs === 60 * S, allEqual.inputs)

  console.log('\n== 间隔趋势（去偏 EWMA） ==')
  const constant = intervalTrend(timesFromGaps([60 * S, 60 * S, 60 * S, 60 * S, 60 * S]))
  check('常数间隔 ⇒ 比值恰为 1 且判定平稳（去偏生效）', constant.value?.ratio === 1 && constant.value?.direction === 'steady', constant.value)
  check('常数间隔 ⇒ 近期间隔 = 基准间隔', constant.value?.recentMs === constant.value?.baselineMs)
  const h1Denser = intervalTrend(timesFromGaps([3600 * S, 3600 * S, 3600 * S, 60 * S, 60 * S, 60 * S]), 1)
  check('变密样本 ⇒ direction = denser', h1Denser.value?.direction === 'denser', h1Denser.value)
  check('变密样本 ratio = 0.2477', h1Denser.value?.ratio === 0.2477, h1Denser.value?.ratio)
  const h1Sparser = intervalTrend(timesFromGaps([60 * S, 60 * S, 60 * S, 3600 * S, 3600 * S, 3600 * S]), 1)
  check('变稀样本 ⇒ direction = sparser', h1Sparser.value?.direction === 'sparser', h1Sparser.value)
  check('变稀样本 ratio = 1.7523', h1Sparser.value?.ratio === 1.7523, h1Sparser.value?.ratio)
  const h3Denser = intervalTrend(timesFromGaps([3600 * S, 3600 * S, 3600 * S, 60 * S, 60 * S, 60 * S]))
  check('默认半衰期 3 下变密样本 ratio = 0.6776', h3Denser.value?.ratio === 0.6776, h3Denser.value)
  check('单间隔 ⇒ 不可判定（无可比基准）', !intervalTrend(timesFromGaps([60 * S])).defined)
  const zeroTrend = intervalTrend(timesFromGaps([0, 0, 0]))
  check('全 0 间隔 ⇒ 不可判定（比值分母为 0）', !zeroTrend.defined && zeroTrend.value === null, zeroTrend)
  const windowed = intervalTrend(timesFromGaps([3600 * S, 3600 * S, 3600 * S, 60 * S, 60 * S]), 1, 2)
  check('窗口裁剪只保留最近 2 个间隔', windowed.value?.window === 2 && windowed.inputs?.gaps === 2, windowed.value)
  check('白盒 inputs 同时给出全量间隔数', windowed.inputs?.totalGaps === 5, windowed.inputs)
  const unwindowed = intervalTrend(timesFromGaps([3600 * S, 3600 * S, 3600 * S, 60 * S, 60 * S]), 1)
  check(
    '窗口是语义的一部分：裁剪后基准=60s，全量基准=3600s',
    windowed.value?.baselineMs === 60 * S && unwindowed.value?.baselineMs === 3600 * S,
    { windowed: windowed.value, unwindowed: unwindowed.value },
  )

  console.log('\n== 趋势包装（不把「无数据」当「平稳」） ==')
  const noInfo = trendMetric({ slope: 0, rawSlope: 0, samples: 0, verdict: 'stable', threshold: 1 })
  check('间隔 0 ⇒ 不可判定', !noInfo.defined && noInfo.value === null)
  const oneGap = trendMetric({ slope: 0, rawSlope: 0, samples: 1, verdict: 'stable', threshold: 1 })
  check('间隔 1 ⇒ 不可判定', !oneGap.defined)
  check('不可判定的 reason 直说「不是趋势平稳」', (oneGap.reason ?? '').includes('不是「趋势平稳」'), oneGap.reason)
  const real = trendMetric({ slope: -0.5, rawSlope: -12, samples: 4, verdict: 'worsening', threshold: 1 })
  check('间隔 ≥ 2 ⇒ 可判定且带样本量', real.defined && real.sampleSize === 4 && real.value?.verdict === 'worsening')
  check('可判定时标签说明方向', real.label.includes('变密'), real.label)

  console.log('\n== 可比危险度标度 ==')
  const noBundle = rankHazards([], BASE)
  check('空队列 ⇒ 不可判定（不是空排名）', !noBundle.defined && noBundle.value === null)
  const singleHazard = rankHazards(
    [{ bundle: 'only', experimental: false, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 0, observations: 1 }],
    BASE,
  )
  check(
    '单元素队列 ⇒ hazardIndex = 1 但置信度为 0（无可比性）',
    singleHazard.value?.[0]?.hazardIndex === 1 && singleHazard.confidence === 0,
    singleHazard,
  )
  const ranked = rankRisks(
    [
      { bundle: 'z-old', experimental: false, lastChangeAt: '2025-06-01T00:00:00.000Z', suspectHits: 0, observations: 1 },
      { bundle: 'a-new', experimental: true, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 1, observations: 1 },
      { bundle: 'm-mid', experimental: false, lastChangeAt: '2025-12-20T00:00:00.000Z', suspectHits: 0, observations: 1 },
    ],
    BASE,
  )
  check('最高风险排第一', ranked[0]?.bundle === 'a-new', ranked.map((r) => r.bundle))
  check('百分位随排名单调下降', ranked.every((r, i) => i === 0 || r.hazardIndex <= ranked[i - 1].hazardIndex), ranked.map((r) => r.hazardIndex))
  check('最高位的百分位为 1、最低位为 0', ranked[0]?.hazardIndex === 1 && ranked[ranked.length - 1]?.hazardIndex === 0)
  check('等级与原始分对应（满分为 high）', ranked[0]?.tier === 'high' && ranked[ranked.length - 1]?.tier === 'none', ranked.map((r) => r.tier))
  check('风险标签同时给出原始分与相对危险度', (ranked[0]?.label ?? '').includes('风险') && (ranked[0]?.label ?? '').includes('相对危险度'))
  const tied = rankRisks(
    [
      { bundle: 'b', experimental: false, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 0, observations: 1 },
      { bundle: 'a', experimental: false, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 0, observations: 1 },
    ],
    BASE,
  )
  check('同分按名称字典序（确定性）', tied[0]?.bundle === 'a' && tied[1]?.bundle === 'b', tied.map((r) => r.bundle))

  console.log('\n== computeMetrics：白盒自洽全扫 ==')
  const rich = computeMetrics(
    [
      { at: '2026-01-01T00:00:00.000Z', crashed: true, recoveryMs: 2000, detected: true },
      { at: '2026-01-01T00:01:00.000Z', crashed: true, recoveryMs: 4000, detected: true },
      { at: '2026-01-01T00:02:00.000Z', crashed: true, detected: true },
      { at: '2026-01-01T00:03:00.000Z', crashed: true, detected: true },
      // 变点场景必须给足够长的「变密后」序列：CUSUM 对**持续漂移**敏感，
      // 而不是对一次短暂下探敏感。这里前 3 个间隔 60s、后 4 个间隔 10s：
      //   q = P75(间隔) = 60000，k·q = 45000，A = 1.5·q = 90000
      //   S 依次 0,0,0,35000,70000,105000 —— 第 6 个间隔才越过 A。
      // 只给 2 个短间隔时 S 只到 70000，模型判「无变点」是**正确**的保守行为，
      // 所以夹具要改，而不是把阈值调低去迁就夹具。
      { at: '2026-01-01T00:03:10.000Z', crashed: true, detected: true },
      { at: '2026-01-01T00:03:20.000Z', crashed: true, detected: true },
      { at: '2026-01-01T00:03:30.000Z', crashed: true, detected: true },
      { at: '2026-01-01T00:03:40.000Z', crashed: true, detected: true },
      { at: '2026-01-01T00:03:50.000Z', crashed: false, detected: false },
    ],
    0.7,
    [{ key: 'p1', contaminated: false }],
    BASE + 4 * 60 * S,
  )
  sweepWhitebox('rich', rich as unknown as Record<string, unknown>)
  check('快照带崩溃压力', rich.crashPressure.defined)
  check('快照带间隔统计', rich.intervals.defined)
  check('快照带变点', rich.changePoint.defined)
  check('快照带生存分析', rich.survival.defined)
  check('快照带间隔趋势', rich.intervalTrend.defined)
  check('快照带诚实趋势包装', rich.trendMetric.defined)
  check('stabilityScore 原样透传', rich.stabilityScore === 0.7)

  console.log('\n== computeMetrics：全空输入（defined=false 分支可达） ==')
  const bare = computeMetrics([], 0.2, [], BASE)
  sweepWhitebox('bare', bare as unknown as Record<string, unknown>)
  check('无观测 ⇒ 崩溃率不可判定', !bare.crashRate.defined)
  check('无观测 ⇒ 间隔统计不可判定', !bare.intervals.defined)
  check('无观测 ⇒ 变点不可判定', !bare.changePoint.defined)
  check('无观测 ⇒ 生存分析不可判定', !bare.survival.defined)
  check('无观测 ⇒ 间隔趋势不可判定', !bare.intervalTrend.defined)
  check('无观测 ⇒ 趋势包装不可判定', !bare.trendMetric.defined)
  check('无观测 ⇒ 隔离纯度不可判定', !bare.isolationPurity.defined)
  check('全空快照里没有任何「0 冒充无数据」的指标', [bare.crashRate, bare.intervals, bare.changePoint, bare.survival, bare.intervalTrend].every((m) => m.value === null))

  console.log('\n== 单例边界：只有一次启动且未崩溃 ==')
  const once = computeMetrics([{ at: '2026-01-01T00:00:00.000Z', crashed: false }], 0.9, [{ key: 'p', contaminated: false }], BASE)
  sweepWhitebox('once', once as unknown as Record<string, unknown>)
  check('一次未崩启动 ⇒ 崩溃率是 0（真值）', once.crashRate.defined && once.crashRate.value === 0)
  check('一次未崩启动 ⇒ 压力是 0（真值）', once.crashPressure.defined && once.crashPressure.value === 0)
  check('一次未崩启动 ⇒ 无间隔统计', !once.intervals.defined)
  check('一次未崩启动 ⇒ 无崩溃检出率（无崩溃样本）', !once.detectionRate.defined)

  console.log('\n== 控制带（休哈特单值-MR）==')
  // 稳定过程：间隔在 60000ms 附近小幅波动 ⇒ 受控。
  const bandSteadyTimes = [0, 60_000, 120_500, 179_000, 240_000, 299_500].map((t) => BASE + t)
  const bandSteady = controlBand(bandSteadyTimes)
  check('稳定过程 ⇒ 控制带可判定', bandSteady.defined)
  check('稳定过程 ⇒ 无失控点', bandSteady.value !== null && bandSteady.value.breaches.length === 0, bandSteady.value)
  check('稳定过程 ⇒ label 说受控', bandSteady.value !== null && bandSteady.value.label.includes('受控'))
  // 失控过程：8 个恒定间隔 + 1 个骤缩。注意 MR 图的已知特性：单次突变会
  // 抬高 MR̄（σ̂ 被突变本身污染），突变必须足够大才越带 —— 夹具用 8:1 的
  // 恒定:骤缩比例让 LCL 显著高于 0，突变点（第 9 个间隔）才被点名。
  const bandWorseTimes = [0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000, 420_100].map(
    (t) => BASE + t,
  )
  const bandWorse = controlBand(bandWorseTimes)
  check('骤缩过程 ⇒ 控制带可判定', bandWorse.defined)
  check(
    '骤缩过程 ⇒ 报出失控间隔序号（第 8 个）',
    bandWorse.value !== null && bandWorse.value.breaches.length === 1 && bandWorse.value.breaches[0] === 7,
    bandWorse.value,
  )
  check('骤缩过程 ⇒ label 说失控（变密）', bandWorse.value !== null && bandWorse.value.label.includes('失控'))
  // 边界：0/1 个间隔 ⇒ 不可判定。
  const bandEmpty = controlBand([])
  check('无崩溃 ⇒ 控制带不可判定', !bandEmpty.defined && bandEmpty.value === null)
  const bandOne = controlBand([BASE, BASE + 60_000])
  check('一个间隔 ⇒ 控制带不可判定（无 MR）', !bandOne.defined && bandOne.value === null)
  // 时间戳倒序：非正间隔全部被过滤 ⇒ 无样本 ⇒ 诚实降级为不可判定
  // （不排序兜底 —— 面板的时间线语义来自宿主的升序投影，乱序输入本身
  // 就是数据缺陷，沉默修复会掩盖它）。
  const bandReversed = controlBand([...bandWorseTimes].reverse())
  check('倒序时间戳 ⇒ 诚实不可判定（负间隔全过滤）', !bandReversed.defined && bandReversed.value === null)
  const bandSame = controlBand([BASE, BASE + 60_000, BASE + 120_000])
  check('完美周期（σ̂=0）⇒ 带宽为 0 是真值', bandSame.defined && bandSame.value !== null && bandSame.value.lower === bandSame.value.upper, bandSame.value)
  check('computeMetrics 快照带控制带', rich.controlBand !== undefined)
  const bareBand = computeMetrics([], 0, [], BASE).controlBand
  check('全空观测 ⇒ 快照控制带不可判定', !bareBand.defined)

  console.log('\n== 马尔可夫转移矩阵 ==')
  // 健康值守模式：monitoring 大概率回自己，偶尔崩一次走完整恢复链。
  const healthy: Array<{ from: string; to: string }> = []
  for (let i = 0; i < 16; i += 1) healthy.push({ from: 'monitoring', to: 'monitoring' })
  healthy.push(
    { from: 'monitoring', to: 'crashed' },
    { from: 'crashed', to: 'deciding' },
    { from: 'deciding', to: 'stabilizing' },
    { from: 'stabilizing', to: 'recovered' },
    { from: 'recovered', to: 'monitoring' },
  )
  const mk = markovAnalysis(healthy)
  check('马尔可夫：样本数 = 迁移数', mk.samples === healthy.length, mk.samples)
  const monitorRow = mk.rows.find((row) => row.stage === 'monitoring')
  check('马尔可夫：monitoring 行有概率', monitorRow !== undefined && monitorRow.probabilities !== null)
  check(
    '马尔可夫：monitoring 自环概率 0.8（17 迁出中 16 次自环）',
    monitorRow?.probabilities?.monitoring === 0.9412,
    monitorRow?.probabilities,
  )
  check('马尔可夫：平稳分布收敛', mk.converged && mk.stationary !== null)
  check('马尔可夫：平稳分布归一（和≈1）', mk.stationary !== null && Math.abs(Object.values(mk.stationary).reduce((a, b) => a + b, 0) - 1) < 0.01, mk.stationary)
  check('马尔可夫：monitoring 平稳占比最高', mk.stationary !== null && Object.entries(mk.stationary).sort((a, b) => b[1] - a[1])[0]?.[0] === 'monitoring', mk.stationary)
  // 空历史 ⇒ 全部不可判定（不猜）。
  const mkEmpty = markovAnalysis([])
  check('马尔可夫：空历史 ⇒ 样本 0', mkEmpty.samples === 0)
  check('马尔可夫：空历史 ⇒ 平稳分布 null', mkEmpty.stationary === null && !mkEmpty.converged)
  check('马尔可夫：空历史 ⇒ label 说明不可判定', mkEmpty.label.includes('不可判定'))
  // 白名单外迁移被丢弃且如实计数。
  const mkJunk = markovAnalysis([{ from: 'monitoring', to: 'atlantis' }, { from: 'monitoring', to: 'monitoring' }])
  check('马尔可夫：白名单外迁移被丢弃', mkJunk.samples === 1 && mkJunk.label.includes('白名单外'), mkJunk.label)
  // 快照接线：transition 投影直接进快照（markovAnalysis 由 snapshot.ts 消费，
  // 这里只需确认同一实现被引用，防止模块被 tree-shake 出测试面）。

  // ─────────────── RQ3 预防性健康指标（07 §4.3 只预警不行动）───────────────
  // 断言里钉的全部是 scratch 实跑出来的真实值，不是「看起来对」的猜测。
  // 重点守三件事：样本不足给 null 不给 0、σ̂=0 不预警、纯函数无副作用。
  console.log('\n== RQ3 加载耗时 EWMA 控制带 ==')
  const loadEmpty = loadTimeEwma([])
  check('加载：空样本 ⇒ 不可判定且 value 是 null（不是 0）', !loadEmpty.defined && loadEmpty.value === null)
  check('加载：空样本 ⇒ reason 说明缺多少样本', (loadEmpty.reason ?? '').includes('至少需要 5 次'))
  const loadFour = loadTimeEwma([1000, 1000, 1000, 1000])
  check('加载：4 个样本低于门槛 5 ⇒ 不可判定', !loadFour.defined && loadFour.value === null)
  // 门槛与 EWMA 记忆长度 1/λ 绑定：半衰期 10 ⇒ λ=0.067 ⇒ 门槛抬到 ⌈1/λ⌉=15。
  const loadLongHalfLife = loadTimeEwma([1000, 1000, 1010, 990, 1005, 995], 10)
  check('加载：半衰期 10 ⇒ 门槛升到 15，6 个样本仍不可判定', !loadLongHalfLife.defined && loadLongHalfLife.value === null)
  check('加载：门槛随半衰期抬高的理由写进 reason', (loadLongHalfLife.reason ?? '').includes('15'))
  const loadZero = loadTimeEwma([0, 0, 0, 0, 0, 0])
  check('加载：全 0 耗时 ⇒ 不可判定（不是「加载很快」）', !loadZero.defined && loadZero.value === null)
  // 完全规则（σ̂=0）：带宽为 0 是真值，但零宽带没有区分度 ⇒ 一律不预警。
  const loadConstant = loadTimeEwma([1000, 1000, 1000, 1000, 1000, 1000, 1000])
  check('加载：完全规则 ⇒ 仍可判定（σ̂=0 是真值不是缺数据）', loadConstant.defined && loadConstant.value !== null)
  check('加载：完全规则 ⇒ 零带宽（UCL=LCL=中心线）', loadConstant.value !== null && loadConstant.value.upperMs === loadConstant.value.lowerMs && loadConstant.value.upperMs === 1000, loadConstant.value)
  check('加载：完全规则 ⇒ 不预警（零宽带无区分度）', loadConstant.value !== null && loadConstant.value.alert === false)
  check('加载：完全规则 ⇒ estimator 记为 none（白盒交代 σ̂ 来历）', loadConstant.value?.sigmaEstimator === 'none', loadConstant.value?.sigmaEstimator)
  const loadSteadyTimes = [1000, 1010, 990, 1005, 995, 1002, 998, 1001]
  const loadSteady = loadTimeEwma(loadSteadyTimes)
  check('加载：稳定序列 ⇒ 可判定', loadSteady.defined && loadSteady.value !== null)
  check('加载：稳定序列 ⇒ 不预警', loadSteady.value !== null && loadSteady.value.alert === false)
  check('加载：稳定序列 ⇒ 去暖机偏置的 EWMA 水平为 1000', loadSteady.value?.levelMs === 1000, loadSteady.value?.levelMs)
  check('加载：稳定序列 ⇒ 中心线是中位数 1001（不是均值）', loadSteady.value?.baselineMs === 1001, loadSteady.value?.baselineMs)
  check('加载：稳定序列 ⇒ σ̂=5.1891 来自 MAD', loadSteady.value?.sigmaMs === 5.1891, loadSteady.value?.sigmaMs)
  check('加载：稳定序列 ⇒ estimator 记为 mad', loadSteady.value?.sigmaEstimator === 'mad', loadSteady.value?.sigmaEstimator)
  check('加载：稳定序列 ⇒ 带因子 √(λ/(2−λ))=0.3391', loadSteady.value?.bandFactor === 0.3391, loadSteady.value?.bandFactor)
  check('加载：稳定序列 ⇒ UCL=1006 / LCL=995', loadSteady.value?.upperMs === 1006 && loadSteady.value?.lowerMs === 995, loadSteady.value)
  // 带宽关系式：UCL − μ̂ = L·σ̂·√(λ/(2−λ))，L=3。这条断言防的正是「直接拿 σ̂
  // 当带宽」的错误 —— 那会把带放宽约 3 倍，任何漂移都永远报不出来。
  check(
    '加载：带宽严格等于 3·σ̂·√(λ/(2−λ))（不是错误的 3σ̂）',
    loadSteady.value !== null && Math.abs(loadSteady.value.upperMs - loadSteady.value.baselineMs - 3 * loadSteady.value.sigmaMs * loadSteady.value.bandFactor) < 1,
    loadSteady.value,
  )
  const loadSlowTimes = [...loadSteadyTimes, 1400, 1800, 2200, 2600]
  const loadSlow = loadTimeEwma(loadSlowTimes)
  check('加载：持续变慢 ⇒ 预警', loadSlow.value !== null && loadSlow.value.alert === true, loadSlow.value)
  check('加载：持续变慢 ⇒ EWMA 1717ms 越过 UCL 1015ms', loadSlow.value?.levelMs === 1717 && loadSlow.value?.upperMs === 1015, loadSlow.value)
  check('加载：持续变慢 ⇒ label 带「预警」与白盒数值', (loadSlow.label ?? '').includes('预警') && (loadSlow.label ?? '').includes('UCL'))
  // 非有限/负值污染必须被剔除，否则 median/MAD 会被 NaN 污染成 NaN。
  const loadDirty = loadTimeEwma([1000, -5, Number.NaN, 1010, 990, 1005, 995, 1002])
  check('加载：负值与 NaN 被剔除（剩 6 个样本）', loadDirty.sampleSize === 6, loadDirty.sampleSize)
  // σ̂ 估计器的两级后备：MAD 在 ≥50% 样本同值时退化为 0，不能静默放行。
  const loadIqr = loadTimeEwma([1000, 1000, 1000, 1000, 1100, 900, 1050])
  check('加载：MAD 退化（≥50% 同值）⇒ 自动降级到 IQR', loadIqr.value?.sigmaEstimator === 'iqr' && loadIqr.value?.sigmaMs === 18.5322, loadIqr.value)
  const loadMeanAbsDev = loadTimeEwma([1000, 1000, 1000, 1000, 1000, 1000, 5000])
  check('加载：IQR 也退化（≥75% 同值）⇒ 降级到平均绝对偏差', loadMeanAbsDev.value?.sigmaEstimator === 'meanAbsDev', loadMeanAbsDev.value?.sigmaEstimator)
  check('加载：降级后仍能报出阶跃变慢（不是结构性失明）', loadMeanAbsDev.value?.alert === true, loadMeanAbsDev.value)
  // 只预警不行动 ⇒ 纯函数：同输入两次调用逐字节相同（无隐藏状态/无 IO）。
  check(
    '加载：零副作用（同输入两次调用逐字节相同）',
    JSON.stringify(loadTimeEwma(loadSlowTimes)) === JSON.stringify(loadTimeEwma(loadSlowTimes)),
  )

  console.log('\n== RQ3 配置变更频率 CUSUM ==')
  const cfgEmpty = configChangeCusum([])
  check('配置：空样本 ⇒ 不可判定且 value 是 null（不是 0）', !cfgEmpty.defined && cfgEmpty.value === null)
  const cfgThree = configChangeCusum([BASE, BASE + 60_000, BASE + 120_000, BASE + 180_000])
  check('配置：3 个间隔低于门槛 5 ⇒ 不可判定', !cfgThree.defined && cfgThree.value === null)
  check('配置：门槛理由写明「5 个间隔（6 次变更）」', (cfgThree.reason ?? '').includes('6 次变更'))
  // 完全规则 ⇒ σ̂=0 ⇒ 标准化增量无尺度，绝不用除零换一个「很敏感」的读数。
  const cfgRegular = configChangeCusum([0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000].map((t) => BASE + t))
  check('配置：间隔完全规则（σ̂=0）⇒ 不可判定（不做除零）', !cfgRegular.defined && cfgRegular.value === null)
  const cfgJitter = configChangeCusum([0, 58_000, 121_000, 179_000, 242_000, 298_000, 361_000, 419_000].map((t) => BASE + t))
  check('配置：受控抖动 ⇒ 可判定', cfgJitter.defined && cfgJitter.value !== null)
  check('配置：受控抖动 ⇒ 不预警', cfgJitter.value?.alert === false && cfgJitter.value?.breachIndex === null, cfgJitter.value)
  check('配置：受控抖动 ⇒ 统计量被钳在 0（变稀不累积证据）', cfgJitter.value?.statistic === 0, cfgJitter.value?.statistic)
  check('配置：σ̂ 取移动极差（避免被待检漂移自己污染）', cfgJitter.value?.sigmaEstimator === 'movingRange', cfgJitter.value?.sigmaEstimator)
  check('配置：k=0.5 / h=5 随读数一起返回（白盒可审计）', cfgJitter.value?.reference === 0.5 && cfgJitter.value?.threshold === 5, cfgJitter.value)
  // 失控：60s 稳定后连改 1s —— 这正是 07 H3.2 要抓的形状。
  const cfgBurst = configChangeCusum([0, 60_000, 120_000, 180_000, 240_000, 300_000, 301_000, 302_000, 303_000, 304_000].map((t) => BASE + t))
  check('配置：变更变密 ⇒ 预警', cfgBurst.value?.alert === true, cfgBurst.value)
  check('配置：变更变密 ⇒ S=34.096 越过 h=5', cfgBurst.value?.statistic === 34.096 && cfgBurst.value?.threshold === 5, cfgBurst.value)
  check('配置：变更变密 ⇒ 变点落在第 6 个间隔（0 基 5）', cfgBurst.value?.breachIndex === 5, cfgBurst.value?.breachIndex)
  check('配置：变更变密 ⇒ label 带基线与 σ̂（可判读）', (cfgBurst.label ?? '').includes('预警') && (cfgBurst.label ?? '').includes('基线'))
  // 尺度自污染的回归护栏：IQR/MAD 尺度下这个 20 倍阶跃只算出 S=3.4 < h=5，
  // 检测器对自己要抓的形状结构性失明。移动极差尺度下 S=21.8562 正常越界。
  const cfgBurst2 = configChangeCusum([0, 60_000, 120_000, 180_000, 240_000, 300_000, 302_000, 303_500, 304_000].map((t) => BASE + t))
  check('配置：阶跃仍被检出（尺度不被漂移污染）S=21.8562', cfgBurst2.value?.statistic === 21.8562 && cfgBurst2.value?.alert === true, cfgBurst2.value)
  // 同刻变更（install → enable 连发）不携带频率信息：丢弃而非记 0。
  const cfgSameInstant = configChangeCusum([0, 60_000, 120_000, 180_000, 240_000, 300_000, 300_000, 300_000].map((t) => BASE + t))
  check('配置：同刻变更被丢弃（8 次变更 ⇒ 5 个有效间隔）', cfgSameInstant.sampleSize === 5, cfgSameInstant.sampleSize)
  // 乱序输入：内部先排序再算间隔。若不排序，负间隔会被 `gap > 0` 全部过滤，
  // 结果不是「算错」而是**静默变成没有数据** —— 那种失败最难看出来。
  const cfgBurstTimes = [0, 60_000, 120_000, 180_000, 240_000, 300_000, 301_000, 302_000, 303_000, 304_000].map((t) => BASE + t)
  const cfgReversed = configChangeCusum([...cfgBurstTimes].reverse())
  check('配置：乱序输入 → 内部排序后仍可判定（不静默降级为无数据）', cfgReversed.defined && cfgReversed.value !== null, cfgReversed.reason)
  check('配置：乱序与升序给出逐字节相同的读数', JSON.stringify(cfgReversed) === JSON.stringify(configChangeCusum(cfgBurstTimes)))
  check(
    '配置：零副作用（同输入两次调用逐字节相同）',
    JSON.stringify(configChangeCusum(cfgBurstTimes)) === JSON.stringify(configChangeCusum(cfgBurstTimes)),
  )

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
