import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preventiveSummary } from '../../src/client/panel/preventive-model.ts'
import type { PanelSnapshotView } from '../../src/client/panel/snapshot-view.ts'
import { t } from '../../src/client/i18n/i18n.ts'

/**
 * RQ3 预警卡视图投影 —— 只预警不行动 + 不可判定不显示 0。
 *
 * 缺陷形态：
 * - `defined:false` 时把 `metric.value` 当 0 渲染 ⇒ 面板亮绿灯，用户以为一切正常
 *   （研究 07 §4.3 第二条）；
 * - 旧宿主/跨分区没有 `preventive` 字段 ⇒ 整卡空数组渲染成「无预警」，同样是假绿；
 * - 卡片里顺手放一个「关闭插件」按钮 ⇒ 违反「只预警不行动」硬纪律。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function bandValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current: 12.34,
    baseline: 8.1,
    upper: 15.2,
    lower: 1,
    sigma: 2.1,
    sigmaEstimator: 'mad',
    ratio: 1.52,
    alert: false,
    ...overrides,
  }
}
function cusumValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    statistic: 3.2,
    threshold: 5,
    reference: 0.5,
    baselineMs: 12000,
    sigmaMs: 2000,
    sigmaEstimator: 'movingRange',
    intervals: 7,
    breachIndex: null,
    alert: false,
    ...overrides,
  }
}
function snapshot(preventive: unknown): PanelSnapshotView {
  return {
    at: '2026-11-11T08:00:00.000Z',
    profile: 'sb-rg-c14',
    projectKey: 'abcdef12',
    stage: 'monitoring',
    stageLabel: '监控中',
    transitions: [],
    stabilityScore: 0.9,
    metrics: null,
    risks: [],
    decisionSuspects: [],
    cooccurrence: null,
    calibration: null,
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
      pluginVersion: '0.17.0',
      hostVersion: null,
      platform: 'win32',
      nodeVersion: 'v24',
      dataPlane: true,
      snapshotMs: null,
      repositoryUrl: null,
      issuesUrl: null,
    },
    preventive,
  } as unknown as PanelSnapshotView
}

const definedPreventive = {
  loadTime: { defined: true, label: '启动频率稳定', reason: null, samples: 12, value: bandValue() },
  configChanges: { defined: true, label: '变更频率平稳', reason: null, samples: 7, value: cusumValue() },
  source: { bootSamples: 13, changeSamples: 8, units: 'per-minute', note: '启动频率代理' },
}

console.log('\n[正常读数：数值 + 白盒字段]')
const normal = preventiveSummary(snapshot(definedPreventive))
check('整卡可用', normal.available === true)
check('两条读数都在（加载 + 配置）', normal.reads.length === 2 && normal.reads.map((r) => r.key).join(',') === 'loadTime,configChanges')
const loadRead = normal.reads[0]!
const configRead = normal.reads[1]!
check('加载读数可判定且展示当前水平', loadRead.defined && loadRead.rows.some((row) => row.key === 'current' && row.value.includes('12.34')))
check('单位是「次/分钟」（代理不是毫秒）', loadRead.rows.find((row) => row.key === 'current')?.value.includes(t('preventive.perMinute')) === true)
check('控制带上下界都展示', loadRead.rows.some((row) => row.key === 'upper' && row.value.includes('15.20')) && loadRead.rows.some((row) => row.key === 'lower'))
check('样本数来自宿主 projection（12）', loadRead.samples === 12 && loadRead.rows.some((row) => row.key === 'samples' && row.value === '12'))
check('CUSUM 统计量与阈值都展示', configRead.rows.some((row) => row.key === 'statistic' && row.value === '3.20') && configRead.rows.some((row) => row.key === 'threshold' && row.value === '5.00'))
check('未越界时给出明确结论（不是空白）', configRead.rows.find((row) => row.key === 'breach')?.value === t('preventive.noBreach'))
check('来源样本数（boots/changes）原样投影', normal.source?.bootSamples === 13 && normal.source?.changeSamples === 8)
check('卡片纪律文案 = 只预警不关闭', normal.note === t('preventive.alertOnly'))
check('无预警时 anyAlert=false', normal.anyAlert === false)
const alarmed = preventiveSummary(
  snapshot({
    ...definedPreventive,
    loadTime: { ...definedPreventive.loadTime, value: bandValue({ alert: true }) },
  }),
)
check('宿主 alert=true ⇒ anyAlert=true（只传播事实，不自行判定）', alarmed.anyAlert === true)

console.log('\n[不可判定：只给原因，绝不显示 0]')
const undefinedPreventive = {
  ...definedPreventive,
  loadTime: { defined: false, label: '不可判定', reason: '至少需要 5 次加载样本', samples: 2, value: null },
}
const unavailable = preventiveSummary(snapshot(undefinedPreventive))
check('不可判定行不渲染任何数值', unavailable.reads[0]?.rows.length === 0)
check('显示宿主原因', unavailable.reads[0]?.reason === '至少需要 5 次加载样本')
check('report 的 defined=false 透传', unavailable.reads[0]?.defined === false)
check('没有把 null 格式化成 0.00', JSON.stringify(unavailable.reads[0]).includes('0.00') === false)
// 宿主 projection 漂移：defined=true 但 value=null（同 Metric<T> 的可空纪律）。
const broken = preventiveSummary(
  snapshot({
    ...definedPreventive,
    loadTime: { defined: true, label: '', reason: null, samples: 9, value: null },
  }),
)
check('defined=true 但 value=null ⇒ 仍降级不可判定', broken.reads[0]?.defined === false)
check('降级原因不是空白（用统一 valueUndefined 文案）', broken.reads[0]?.reason === t('metrics.valueUndefined'))
// 子字段非有限：不能把 null 当 0 参与展示。
const partial = preventiveSummary(
  snapshot({
    ...definedPreventive,
    loadTime: { defined: true, label: '', reason: null, samples: 9, value: bandValue({ current: null }) },
  }),
)
check('子字段 null ⇒ 整条读数降级（不显示 0/NaN）', partial.reads[0]?.defined === false)

console.log('\n[整段字段缺失（旧宿主 / 跨分区视图）]')
const missing = preventiveSummary(snapshot(undefined))
check('缺失 ⇒ available=false（不伪造「无预警」）', missing.available === false && missing.reads.length === 0)
check('缺失 ⇒ source=null（不报 0 个样本）', missing.source === null)
check('缺失时纪律文案仍然在场', missing.note === t('preventive.alertOnly'))
check('缺失时不触发预警', missing.anyAlert === false)

console.log('\n[结构：卡片只读、字段可空]')
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const cards = readFileSync(join(root, 'src/client/panel/PanelCards.tsx'), 'utf8')
const view = readFileSync(join(root, 'src/client/panel/snapshot-view.ts'), 'utf8')
const panel = readFileSync(join(root, 'src/client/panel/GuardPanel.tsx'), 'utf8')
check('客户端视图把 preventive 声明为可选/可空', /preventive\?: PanelSnapshot\['preventive'\] \| null/.test(view))
check('卡片渲染 PreventiveBody', /export function PreventiveBody/.test(cards))
check('卡片内没有关闭/重启用动作（只预警不行动）', !/PreventiveBody[\s\S]*?(onReenable|postAction)/.test(cards))
check('卡片出现在面板观测组', /id="preventive"/.test(panel))

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')