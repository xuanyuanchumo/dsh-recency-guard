/**
 * 命令窗口投影的单元测试（M1 校准 / M2 贝叶斯）。
 *
 * 为什么这层要单独测
 * ------------------
 * `status-projections.ts` 是从 `index.ts` 拆出来的纯投影：不读盘、不持状态。
 * 这意味着它**可以被直接构造输入验证**，不需要起一个 Store。
 * 若不测它，那么「面板/命令窗口显示什么」这条链路就只有集成测试兜着，
 * 而集成测试往往只覆盖一个快乐路径 —— 稀疏样本、无数据这些诚实边界
 * 会全部无人守护。
 */
import { projectBayesViews, projectCalibrationView } from '../../src/surface/status-projections.js'
import type { JournalRecord } from '../../src/data/store.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const NOW = Date.parse('2026-06-01T12:00:00.000Z')

function row(kind: string, bundle: string, seq: number, detail?: string): JournalRecord {
  return {
    t: new Date(Date.UTC(2026, 5, 1, 0, 0, seq)).toISOString(),
    kind,
    bundle,
    ...(detail === undefined ? {} : { detail }),
  }
}

console.log('\n== projectBayesViews：并行读数与诚实边界 ==')
{
  // 样本充足（≥3）⇒ 可判定。
  const rich = projectBayesViews(
    [{ bundle: 'dsh-a', experimental: true, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 2, observations: 3 }],
    NOW,
  )
  check('返回一行', rich.length === 1)
  check('样本充足时可判定', rich[0]?.defined === true, rich[0])
  check('可判定时带 score', typeof rich[0]?.score === 'number', rich[0]?.score)
  check('并行保留 riskScore（不替换默认口径）', typeof rich[0]?.riskScore === 'number', rich[0]?.riskScore)
  check('可判定时带 95% 区间', typeof rich[0]?.lower95 === 'number' && typeof rich[0]?.upper95 === 'number')

  // 样本稀疏（<3）⇒ 不可判定，且必须是 null 不是 0。
  const sparse = projectBayesViews(
    [{ bundle: 'dsh-b', experimental: false, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 1, observations: 1 }],
    NOW,
  )
  check('样本稀疏时不可判定', sparse[0]?.defined === false, sparse[0])
  check('样本稀疏时 score 是 null（不是 0）', sparse[0]?.score === null, sparse[0]?.score)
  check('样本稀疏时仍给 reason（说明差多少）', (sparse[0]?.label ?? '').length > 0, sparse[0]?.label)
  check('样本稀疏时 riskScore 仍可对照', typeof sparse[0]?.riskScore === 'number', sparse[0]?.riskScore)

  check('空输入返回空数组', projectBayesViews([], NOW).length === 0)
}

console.log('\n== projectBayesViews：多行顺序保持输入序 ==')
{
  const inputs = [
    { bundle: 'z-last', experimental: false, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 0, observations: 5 },
    { bundle: 'a-first', experimental: true, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 3, observations: 5 },
  ]
  const views = projectBayesViews(inputs, NOW)
  check('顺序与输入一致（不重排）', views.map((v) => v.bundle).join(',') === 'z-last,a-first', views.map((v) => v.bundle))
}

console.log('\n== projectCalibrationView：无数据 ≠ 零误伤 ==')
{
  check('无 journal ⇒ null（无数据）', projectCalibrationView([], 2) === null)

  // 只有 enable 没有 auto-disable ⇒ 没有分母 ⇒ null（仍未观测到自动关闭）。
  const enableOnly = [row('enable', 'dsh-a', 0)]
  check('只有 enable 没有自动关闭 ⇒ null', projectCalibrationView(enableOnly, 2) === null)

  // 有自动关闭但样本 < 5 ⇒ **不是 null**（有真实计数），但 rate 为 null。
  const few = [
    row('disable', 'dsh-a', 0, 'auto-recency'),
    row('disable', 'dsh-b', 1, 'auto-recency'),
  ]
  const fewView = projectCalibrationView(few, 2)
  check('样本不足时仍返回对象（有真实计数）', fewView !== null, fewView)
  check('样本不足时 rate 是 null（不谎报 0%）', fewView?.rate === null, fewView?.rate)
  check('样本不足时 autoDisables 是真值', fewView?.autoDisables === 2, fewView?.autoDisables)
  check('样本不足时带解释文案', (fewView?.explanation ?? '').length > 0, fewView?.explanation)
}

console.log('\n== projectCalibrationView：样本充足时给读数 ==')
{
  const enough = [
    row('disable', 'dsh-a', 0, 'auto-recency'),
    row('disable', 'dsh-b', 1, 'auto-recency'),
    row('disable', 'dsh-c', 2, 'auto-recency'),
    row('disable', 'dsh-d', 3, 'auto-recency'),
    row('disable', 'dsh-e', 4, 'auto-recency'),
    row('enable', 'dsh-a', 5),
    row('enable', 'dsh-b', 6),
  ]
  const view = projectCalibrationView(enough, 2)
  check('样本充足时可判定', view !== null)
  check('rate 是数字（2/5 = 0.4）', view?.rate === 0.4, view?.rate)
  check('falsePositives 计数正确', view?.falsePositives === 2, view?.falsePositives)
  check('autoDisables 计数正确', view?.autoDisables === 5, view?.autoDisables)
  check('base 来自入参', view?.base === 2, view?.base)
  check('required ≥ base（只升不降）', (view?.required ?? 0) >= (view?.base ?? 0), view)
}

console.log('\n== projectCalibrationView：系统自动恢复不计入误伤 ==')
{
  // 纯粹的「系统恢复」形态：enable 后紧跟 restore。
  const systemRestored = [
    row('disable', 'dsh-a', 0, 'auto-recency'),
    row('disable', 'dsh-b', 1, 'auto-recency'),
    row('disable', 'dsh-c', 2, 'auto-recency'),
    row('disable', 'dsh-d', 3, 'auto-recency'),
    row('disable', 'dsh-e', 4, 'auto-recency'),
    row('enable', 'dsh-a', 5),
    row('restore', 'dsh-a', 6),
    row('enable', 'dsh-b', 7),
    row('restore', 'dsh-b', 8),
  ]
  const view = projectCalibrationView(systemRestored, 2)
  check('系统恢复不计入误伤分子', view?.falsePositives === 0, view?.falsePositives)
  check('系统恢复有独立计数', (view?.systemRestored ?? 0) > 0, view?.systemRestored)
}

console.log('\n== 纯投影：同样输入两次调用逐字节相同 ==')
{
  const inputs = [{ bundle: 'dsh-x', experimental: true, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 1, observations: 2 }]
  const a = JSON.stringify(projectBayesViews(inputs, NOW))
  const b = JSON.stringify(projectBayesViews(inputs, NOW))
  check('贝叶斯投影确定性', a === b)
  const journal = [row('disable', 'dsh-a', 0, 'auto-recency')]
  check('校准投影确定性', JSON.stringify(projectCalibrationView(journal, 2)) === JSON.stringify(projectCalibrationView(journal, 2)))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
