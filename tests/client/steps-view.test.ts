/**
 * 执行操作记录投影（T16-14，用户要求「插件的执行一定要有操作记录（可视化）」）。
 *
 * ## 钉住的行为
 *
 * 1. **三态诚实表达**：已结束成功（ok+耗时）、已结束失败（failed+原因）、
 *    未结束（running、无耗时、无结果）——「还在跑」与「跑完了」是两回事，
 *    投影不许编造耗时或结果。
 * 2. **旧宿主兼容**：快照缺 steps（旧宿主/跨分区只读视图）⇒ 空数组，
 *    不构造假记录。
 * 3. **数据层不截断**：投影消费的是调用方传入的完整数组；截尾（slice）
 *    是调用方（index.ts）的显示策略，投影层保持全量。
 */
import { stepRows, type StepRowView } from '../panel-model-export.ts'
import type { PanelSnapshotView } from '../../src/client/panel/snapshot-view.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 构造最小快照（steps 是唯一被投影消费的字段）。 */
function withSteps(steps: unknown): PanelSnapshotView {
  return { at: '2026-01-01T00:00:00.000Z', steps } as unknown as PanelSnapshotView
}

function main(): void {
  console.log('\n== 三态诚实表达 ==')
  {
    const rows = stepRows(
      withSteps([
        { name: 'recover', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.500Z', durationMs: 1500, ok: true, reason: '已关闭 1 个嫌疑插件' },
        { name: 'rollback', startedAt: '2026-01-01T00:00:02.000Z', endedAt: '2026-01-01T00:00:02.100Z', durationMs: 100, ok: false, reason: '管理器拒绝' },
        { name: 'boot', startedAt: '2026-01-01T00:00:03.000Z' },
      ]),
    )
    check('投影保留全部 3 条（数据层不截断）', rows.length === 3, rows.length)

    const ok = rows[0]
    check('成功步骤：status=ok、有耗时', ok.statusText === 'ok' && ok.durationText === '1500ms', ok)
    check('成功步骤：摘要取 reason', ok.summary === '已关闭 1 个嫌疑插件', ok.summary)

    const failed = rows[1]
    check('失败步骤：status=failed、有耗时', failed.statusText === 'failed' && failed.durationText === '100ms', failed)
    check('失败步骤：摘要是失败原因', failed.summary === '管理器拒绝', failed.summary)

    const running = rows[2]
    check('执行中步骤：status=running、无耗时、无结束时刻', running.statusText === 'running' && running.durationText === null && running.endedAt === null, running)
    check('执行中步骤：摘要有缺省文案（不空白）', running.summary.length > 0, running.summary)
  }

  console.log('\n== 旧宿主兼容（缺省为空，不构造假记录） ==')
  {
    check('steps 缺省 ⇒ 空数组', stepRows(withSteps(undefined)).length === 0)
    check('steps=null ⇒ 空数组', stepRows(withSteps(null)).length === 0)
    check('steps=[] ⇒ 空数组', stepRows(withSteps([])).length === 0)
  }

  console.log('\n== 投影不篡改内部字段（不可变拷贝语义） ==')
  {
    // 投影函数只读不改：同一快照重复投影结果一致。
    const snap = withSteps([{ name: 'recover', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000, ok: true }])
    const first = stepRows(snap)
    const second = stepRows(snap)
    check('重复投影结果逐字段一致', JSON.stringify(first) === JSON.stringify(second))
    check('投影产出为 StepRowView（结构化行）', Array.isArray(first) && typeof first[0].name === 'string', first)
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
