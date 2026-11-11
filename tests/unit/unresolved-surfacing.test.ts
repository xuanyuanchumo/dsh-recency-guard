/**
 * `unresolved` / `conflicts` 真的上屏（T14-03 判据 3 的可见性部分）。
 *
 * ## 为什么单独一个断言文件
 *
 * 「数据面有字段」不等于「用户看得到」。本项目的纪律是：观测设施的价值
 * 在**排障现场**兑现，而排障现场常常是命令窗口 —— 字段只进 JSON 而渲染层
 * 不画，等于把「守护治不了这条」藏在浏览器开发者工具里。
 *
 * 这里钉两条通道：
 * 1. `formatRecover`（工具 recover）：残余冲突必须以独立分节出现；
 * 2. `formatStatus`（工具 status）：声明式冲突与残余冲突各一节。
 *
 * 另外钉「缺席 ≠ 空」：调用方不传 `unresolved` 时**整段不渲染**（诚实降级），
 * 而不是画一句「没有未解决的冲突」——后者会让旧调用方看起来像新功能没问题。
 */
import { formatRecover, formatStatus, renderOutcome } from '../../src/host/surface/tool-render.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const FINDING = {
  kind: 'duplicate-service',
  message: 'official-a、official-b 重复提供 service svc.x',
  plugins: ['official-a', 'official-b'],
  source: { file: 'D:/profile/node_modules/official-a/package.json', line: 12 },
  declaration: '{"services":["svc.x"]}',
}

function main() {
  console.log('\n== recover 工具：残余冲突上屏 ==')
  {
    const outcome = formatRecover({
      disabled: ['dsh-third-party'],
      note: '按声明式冲突与依赖联动停用 1 个插件；仍有 1 条未解决。重启 dsh 后生效。',
      unresolved: [FINDING],
    })
    const text = renderOutcome(outcome)
    check('recover renders the unresolved section', text.includes('未解决的冲突'), text)
    check('recover names the residual finding message', text.includes('重复提供 service svc.x'), text)
    check('recover keeps the data field (not only text)', JSON.stringify((outcome as { data?: unknown }).data ?? {}).includes('unresolved'))

    // 旧调用方（不传 unresolved）⇒ 整段不渲染。
    const legacy = renderOutcome(formatRecover({ disabled: [], note: '' }))
    check('legacy recover does not fabricate an unresolved section', !legacy.includes('未解决的冲突'), legacy)
  }

  console.log('\n== status 工具：冲突 + 残余两节上屏 ==')
  {
    const base = {
      profile: 'desktop',
      dshVersion: '0.2.2-rc.1',
      enabled: true,
      crashedLastRun: false,
      crashSeq: 0,
      stabilized: false,
      autoDisabled: [],
      suspectRanking: [],
      experimentalSuspects: [],
      conflicts: [FINDING],
      unresolved: [FINDING],
    }
    const text = renderOutcome(formatStatus(base as never))
    check('status renders the conflict section', text.includes('声明式冲突'), text)
    check('status renders the source line for review', text.includes('package.json:12'), text)
    check('status renders the unresolved section', text.includes('未解决的冲突'), text)
  }

  console.log('\n== 空数组与缺席的区分 ==')
  {
    const empty = renderOutcome(
      formatStatus({
        profile: 'p',
        dshVersion: '0.2.2-rc.1',
        enabled: true,
        crashedLastRun: false,
        crashSeq: 0,
        stabilized: false,
        autoDisabled: [],
        suspectRanking: [],
        experimentalSuspects: [],
        conflicts: [],
      } as never),
    )
    check('empty conflicts renders the explicit "no hit" note', empty.includes('没有命中任何声明式冲突'), empty)
    check('absent unresolved renders nothing', !empty.includes('未解决的冲突'), empty)
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
process.exit(failures === 0 ? 0 : 1)