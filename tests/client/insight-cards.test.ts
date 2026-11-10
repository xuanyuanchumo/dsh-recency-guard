/**
 * v0.10 洞察卡投影的纯函数回归（R11/R12/R18）。
 *
 * 为什么只测投影不测组件：投影函数是「快照契约 → 渲染事实」的唯一转换点，
 * 诚实边界（不可判定不冒充 0、null 链接不渲染成死链）在这里断言最便宜；
 * 组件只是把行数组画出来，行为由 Host 层的快照接线测试覆盖。
 */
import type { PanelSnapshot } from '../../src/surface/snapshot.ts'
import { undefinedMetric } from '../../src/observe/observability.ts'
import { dataFlowStages, diagnosticsRows, markovView, metricRows } from '../panel-model-export.ts'
let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 最小快照（只填投影函数读的字段；缺字段会在读时抛错，正好暴露契约漂移）。 */
function minimalSnapshot(overrides: Partial<PanelSnapshot>): PanelSnapshot {
  return {
    at: '2026-11-07T04:00:00.000Z',
    profile: 'test',
    projectKey: 'abcdef1234567890',
    stage: 'monitoring',
    stageLabel: '监控中',
    transitions: [],
    stabilityScore: 1,
    metrics: {} as PanelSnapshot['metrics'],
    risks: [],
    capability: { total: 0, exposed: 0, connected: 0, connectivity: 1, gaps: [], byStage: [] },
    graphConnectivity: { components: 1, largest: 0, isolated: 0 },
    backupPolicy: {
      versionedBackups: true,
      retain: 3,
      customRoot: false,
      root: '/tmp/backups',
      configEditorAvailable: false,
    },
    partitions: [],
    restored: [],
    autoDisabled: [],
    recentEvents: [],
    eventFlow: [],
    markov: { rows: [], stationary: null, converged: false, samples: 0, label: '' },
    diagnostics: {
      pluginVersion: '0.10.0',
      hostVersion: '0.2.1-rc.5',
      platform: 'win32',
      nodeVersion: 'v24.14.0',
      dataPlane: true,
      snapshotMs: 3,
      repositoryUrl: null,
      issuesUrl: null,
    },
    ...overrides,
  } as PanelSnapshot
}

console.log('\n== markovView：空历史 ⇒ 诚实空态 ==')
const empty = markovView(minimalSnapshot({}))
check('空历史 ⇒ available=false', empty.available === false)
check('空历史 ⇒ 无平稳分布行', empty.stationary.length === 0)
check('空历史 ⇒ 汇总透传 markov.label', empty.summary === '')

console.log('\n== markovView：有数据 ⇒ 行与平稳分布 ==')
const populated = markovView(
  minimalSnapshot({
    markov: {
      rows: [
        { stage: 'monitoring', counts: { monitoring: 4, crashed: 1 }, total: 5, probabilities: { monitoring: 0.8, crashed: 0.2 }, label: 'monitoring → monitoring 80%' },
        { stage: 'idle', counts: {}, total: 0, probabilities: null, label: 'idle：无迁出样本' },
      ],
      stationary: { monitoring: 0.72, idle: 0.28 },
      converged: true,
      samples: 5,
      label: '5 次迁移 · 长期占比最高：monitoring 72%',
    },
  }),
)
check('有数据 ⇒ available=true', populated.available)
check('monitoring 行自环 0.8', populated.rows[0]?.selfLoop === 0.8, populated.rows[0])
check('monitoring 行条宽 80', populated.rows[0]?.barPercent === 80)
check('idle 行自环 null（无迁出样本）', populated.rows[1]?.selfLoop === null && populated.rows[1]?.barPercent === null)
check('平稳分布按占比降序', populated.stationary[0]?.stage === 'monitoring' && populated.stationary[0]?.percent === 72, populated.stationary)
check('收敛标记透传', populated.converged)

console.log('\n== dataFlowStages：链路四环与计数 ==')
const flow = dataFlowStages(
  minimalSnapshot({
    recentEvents: [{ t: '2026-11-07T04:00:00.000Z', kind: 'note' }],
    eventFlow: [
      { at: '', stage: 'monitoring', stageSource: 'inferred', action: 'startup', actionLabel: '记录启动', flow: { from: 'actor:process', to: 'node:guard' }, source: 'journal', detail: '', tone: 'info' },
      { at: '', stage: 'monitoring', stageSource: 'inferred', action: 'startup', actionLabel: '记录启动', flow: { from: 'actor:process', to: 'node:guard' }, source: 'journal', detail: '', tone: 'info' },
    ],
  }),
)
check('数据流是四环', flow.length === 4, flow.map((stage) => stage.key))
check('第一环是 journal 原文（计数 null = 全量在档）', flow[0]?.key === 'journal' && flow[0]?.count === null)
check('第二环计数 = recentEvents', flow[1]?.count === 1)
check('第三四环计数 = eventFlow', flow[2]?.count === 2 && flow[3]?.count === 2)
check('每环都有人读说明', flow.every((stage) => stage.detail.length > 0))

console.log('\n== diagnosticsRows：版本事实与反馈入口的诚实边界 ==')
const baseRows = diagnosticsRows(minimalSnapshot({}))
check('无链接 ⇒ 无仓库行', baseRows.every((row) => row.href === null), baseRows.map((row) => row.key))
check('分区键显示前 8 位', baseRows.find((row) => row.key === 'partition')?.value === 'abcdef12…')
check('数据面恒可达', baseRows.find((row) => row.key === 'dataPlane')?.value !== undefined)

const withLinks = diagnosticsRows(
  minimalSnapshot({
    diagnostics: {
      pluginVersion: '0.10.0',
      hostVersion: null,
      platform: 'win32',
      nodeVersion: 'v24',
      dataPlane: true,
      snapshotMs: 1,
      repositoryUrl: 'https://github.com/xuanyuanchumo/dsh-recency-guard',
      issuesUrl: 'https://github.com/xuanyuanchumo/dsh-recency-guard/issues',
    },
  }),
)
const repoRow = withLinks.find((row) => row.key === 'repository')
check('有链接 ⇒ 仓库行出现且带 href', repoRow?.href === 'https://github.com/xuanyuanchumo/dsh-recency-guard', repoRow)
check('仓库行显示短路径（不含协议）', repoRow?.value === 'xuanyuanchumo/dsh-recency-guard', repoRow?.value)

console.log('\n== metricRows：控制带进入指标卡 ==')
const notDetermined = <T,>(reason: string) => undefinedMetric<T>(reason, '不可判定')
const withBand = metricRows(
  minimalSnapshot({
    metrics: {
      crashRate: notDetermined('无观测'),
      crashPressure: notDetermined('无观测'),
      detectionRate: notDetermined('无崩溃样本'),
      isolationPurity: notDetermined('单分区'),
      meanRecoveryTime: notDetermined('无恢复样本'),
      intervals: notDetermined('间隔 < 2'),
      changePoint: notDetermined('间隔 < 4'),
      controlBand: {
        defined: true,
        value: { center: 60000, upper: 120000, lower: 0, breaches: [], label: '过程受控' },
        label: '过程受控',
        reason: null,
      },
    },
  }) as unknown as PanelSnapshot,
)
const bandRow = withBand.find((row) => row.key === 'controlBand')
check('控制带行存在且可判定', bandRow !== undefined && bandRow.defined, withBand.map((row) => row.key))
check('其余指标显示不可判定（不冒充 0）', withBand.filter((row) => row.key !== 'controlBand').every((row) => !row.defined))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
