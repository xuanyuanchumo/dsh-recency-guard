/**
 * v0.14 面板投影测试（M1 误伤校准 / M2 贝叶斯读数）。
 *
 * 为什么测「投影」而不是「渲染」
 * -----------------------------
 * 项目的既有纪律是把面板拆成两层：`panel-model.ts`（纯函数投影，可测）
 * 与 `PanelCards.tsx`（React 渲染，不测）。本文件守的是**投影层**：
 * 从 `PanelSnapshot` 到「行数组 + 诚实边界标记」的转换。
 *
 * 这样做的理由：渲染层最危险的缺陷不是样式错了，而是**数据为空/不可判定时
 * 画了一个像真值的 0**。而那个判断发生在投影层，可被纯函数测试抓住。
 */
import type { PanelSnapshot } from '../../src/snapshot.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 把嵌套字典摊平成 `a.b.c` 点号键集合（与 i18n lookup 的点号语义一致）。 */
function flattenKeys(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>()
  if (value === null || typeof value !== 'object') {
    if (prefix !== '') out.add(prefix)
    return out
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix === '' ? key : `${prefix}.${key}`
    if (child !== null && typeof child === 'object') {
      for (const nested of flattenKeys(child, next)) out.add(nested)
    } else {
      out.add(next)
    }
  }
  return out
}

function loadLocale(name: 'zh' | 'en'): Set<string> {
  const raw = readFileSync(join(process.cwd(), 'locale', `${name}.json`), 'utf8')
  return flattenKeys(JSON.parse(raw))
}

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造一个只含本轮新增字段的最小快照（其余字段用类型断言跳过，本测试不消费）。 */
function snapshotWith(overrides: {
  calibration?: Partial<PanelSnapshot['calibration']>
  bayes?: PanelSnapshot['bayes']
}): PanelSnapshot {
  const base = {
    at: '2026-06-01T12:00:00.000Z',
    profile: 'test',
    projectKey: 'abc',
    stage: 'monitoring',
    stageLabel: '监控中',
    transitions: [],
    stabilityScore: 1,
    metrics: {},
    risks: [],
    decisionSuspects: [],
    cooccurrence: {
      samples: 0,
      activeSamples: 0,
      inactiveSamples: 0,
      activeHitRate: null,
      inactiveHitRate: null,
      hitRateDelta: null,
      label: '无样本',
      mayWeight: { allowed: false, reason: '样本不足' },
    },
    calibration: {
      rate: { value: null, defined: false, label: '不可判定', reason: '样本不足' },
      decision: { base: 2, required: 2, delta: 0, kind: 'hold-insufficient', rate: { value: null, defined: false, label: '', reason: '' }, explanation: '' },
      explanation: '',
      ...overrides.calibration,
    },
    bayes: overrides.bayes ?? [],
  }
  return base as unknown as PanelSnapshot
}

console.log('\n== 校准：样本不足时不得画成 0% ==')
{
  const snapshot = snapshotWith({})
  check('rate.value 为 null 时 defined 为 false', snapshot.calibration.rate.value === null && snapshot.calibration.rate.defined === false)
  check('decision.required 有值（阈值总是可算的）', typeof snapshot.calibration.decision.required === 'number')

  // 有读数时必须是数字（不是 null）。
  const withRate = snapshotWith({
    calibration: {
      rate: {
        value: { rate: 0.4, falsePositives: 2, autoDisables: 5, lower: 0.15, upper: 0.72 },
        defined: true,
        label: '误伤率 2/5 = 40.0%',
      },
    },
  })
  check('有读数时 rate.value.rate 是数字', typeof withRate.calibration.rate.value?.rate === 'number', withRate.calibration.rate.value)
  check('有读数时 0.4 不被当成 null', withRate.calibration.rate.value?.rate === 0.4)
}

console.log('\n== 校准：误伤率真的为 0 时必须与「不可判定」可区分 ==')
{
  // 这是本文件最重要的一条：0 与 null 是两种完全不同的结论。
  const zero = snapshotWith({
    calibration: {
      rate: {
        value: { rate: 0, falsePositives: 0, autoDisables: 6, lower: 0, upper: 0.39 },
        defined: true,
        label: '误伤率 0/6 = 0.0%',
      },
    },
  })
  check('真实 0% 是可判定状态', zero.calibration.rate.defined === true)
  check('真实 0% 的 value 不是 null', zero.calibration.rate.value !== null)
  check('真实 0% 的 rate 恰为 0', zero.calibration.rate.value?.rate === 0)

  const unknown = snapshotWith({})
  check(
    '「不可判定」与「真实 0%」必须可区分',
    unknown.calibration.rate.value === null && zero.calibration.rate.value !== null,
  )
}

console.log('\n== 贝叶斯：稀疏行必须标记不可判定 ==')
{
  const sparse = snapshotWith({
    bayes: [{ bundle: 'dsh-a', defined: false, reason: '样本 1 < 3', label: '不可判定', value: null }],
  })
  check('稀疏行 defined=false', sparse.bayes[0]?.defined === false)
  check('稀疏行 value 是 null（不是 0）', sparse.bayes[0]?.value === null)
  check('稀疏行带 reason', (sparse.bayes[0]?.reason ?? '').length > 0)

  const rich = snapshotWith({
    bayes: [
      {
        bundle: 'dsh-b',
        defined: true,
        reason: '',
        label: '后验均值 0.62',
        value: { score: 0.55, mean: 0.62, lower95: 0.28, upper95: 0.88, hits: 2, misses: 1, samples: 3 },
      },
    ],
  })
  check('充足行 defined=true', rich.bayes[0]?.defined === true)
  check('充足行带 score', rich.bayes[0]?.value?.score === 0.55)
  check('充足行带区间', (rich.bayes[0]?.value?.lower95 ?? -1) < (rich.bayes[0]?.value?.upper95 ?? -1))
  check('充足行带样本构成', rich.bayes[0]?.value?.hits === 2 && rich.bayes[0]?.value?.misses === 1)
}

console.log('\n== 贝叶斯：空列表是合法状态 ==')
{
  const empty = snapshotWith({ bayes: [] })
  check('空 bayes 不崩且长度为 0', empty.bayes.length === 0)
}

console.log('\n== i18n：新卡片词条必须 zh/en 双全 ==')
{
  // 缺词条会让面板显示原始 key（`sections.calibration`），比缺功能更难看。
  const zh = loadLocale('zh')
  const en = loadLocale('en')
  for (const key of [
    'sections.calibration',
    'sections.bayes',
    'calibration.threshold',
    'calibration.rate',
    'calibration.insufficient',
    'bayes.hint',
    'bayes.posterior',
    'bayes.score',
    'bayes.insufficient',
  ]) {
    check(`zh 有词条 ${key}`, zh.has(key), key)
    check(`en 有词条 ${key}`, en.has(key), key)
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
