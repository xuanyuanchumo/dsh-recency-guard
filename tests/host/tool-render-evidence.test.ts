/**
 * 命令窗口显示 —— 决策因子段（v0.13 T11-05）。
 *
 * ## 为什么在渲染层单测
 *
 * 「命令窗口显示问题」是本插件被真机用户报告最多的缺陷类型（v0.12 的根因是
 * 展示投影写好了却没接进 `defineTool`；v0.12.1 是小地图裸调用让 handler 中断）。
 * 两者的共同点是：**纯函数正确，但没有接到真实路径上**。
 *
 * 所以这里不只测「能渲染出字符串」，而是测三条**真实分支**：
 * 1. 新版决策文件（有 evidence）⇒ 渲染出三因子分解
 * 2. 旧版决策文件（无 evidence）⇒ 显式说「未记录」，**绝不渲成 0**
 * 3. 没有决策文件（字段缺失）⇒ 整段省略，不报错（诚实降级）
 */
import { formatStatus, renderOutcome } from '../../src/host/surface/tool-render.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 最小 status 输入（只填渲染必需字段）。 */
function baseStatus(extra: Record<string, unknown> = {}): never {
  return {
    profile: 'desktop',
    dshVersion: '0.2.2-rc.1',
    enabled: true,
    crashedLastRun: false,
    crashSeq: 0,
    stabilized: true,
    autoDisabled: [],
    suspectRanking: [],
    experimentalSuspects: [],
    ...extra,
  } as never
}

/** 渲染成命令窗口文本（走与宿主相同的 renderOutcome 通道）。 */
function render(status: never): string {
  return renderOutcome(formatStatus(status))
}

function main() {
  console.log('\n== 新版决策文件：渲染三因子分解 ==')
  {
    const text = render(
      baseStatus({
        crashedLastRun: true,
        crashSeq: 2,
        decisionEvidence: {
          hasEvidence: true,
          items: [
            {
              rank: 1,
              bundle: 'dsh-beta-thing',
              risk: 0.83,
              factors: { recency: 0.4, experimental: 0.3, crashFrequency: 0.13 },
              streak: 3,
              changeCount: 5,
              source: 'journal',
            },
          ],
        },
      }),
    )
    check('出现「决策因子」段标题', text.includes('决策因子'), text)
    check('渲染风险总分', text.includes('0.830'), text)
    check('渲染三因子分解（新近/实验/历史）', text.includes('新近') && text.includes('实验') && text.includes('历史'), text)
    check('渲染连续轮数与变更次数', text.includes('连续 3 轮') && text.includes('变更 5 次'), text)
    check('渲染证据来源', text.includes('来源 journal'), text)
    check('渲染排名标记', text.includes('#1'), text)
  }

  console.log('\n== 旧版决策文件：显式「未记录」，绝不渲染成 0 ==')
  {
    const text = render(
      baseStatus({
        decisionEvidence: {
          hasEvidence: false,
          items: [{ rank: 1, bundle: 'legacy-plugin', risk: 0, factors: { recency: 0, experimental: 0, crashFrequency: 0 }, streak: 0, changeCount: 0, source: null }],
        },
      }),
    )
    check('说明「未记录因子分解」', text.includes('未记录因子分解') || text.includes('旧版本'), text)
    check('不把 0 渲染成风险读数（不出现「风险 0.000」）', !text.includes('风险 0.000'), text)
  }

  console.log('\n== 无 decisionEvidence 字段：整段省略（诚实降级）==')
  {
    const text = render(baseStatus())
    check('不出现「决策因子」段', !text.includes('决策因子'), text)
    check('其余内容照常渲染（不因缺字段而空）', text.includes('profile') && text.includes('desktop'), text)
  }

  console.log('\n== 空名单但有 evidence 支持：不虚构条目 ==')
  {
    const text = render(baseStatus({ decisionEvidence: { hasEvidence: true, items: [] } }))
    check('空 items ⇒ 不出现因子列表（也无假条目）', !text.includes('#1'), text)
  }

  console.log('\n== 渲染是全函数：畸形输入不抛（回归） ==')
  {
    let threw = false
    try {
      render(baseStatus({ decisionEvidence: { hasEvidence: true, items: [{}] } }))
    } catch {
      threw = true
    }
    // 曾经抛在 `.toFixed` 上：渲染异常会吞掉整张卡片。现已用数值兜底修复，
    // 这里钉住「不抛」——否则观测设施会因为一条坏数据而整体不显示。
    check('畸形条目不再抛异常', threw === false, { threw })
    const text = render(baseStatus({ decisionEvidence: { hasEvidence: true, items: [{}] } }))
    check('畸形条目渲染为安全占位（未知/0）而不是崩溃', text.includes('（未知）') && text.includes('风险 0.000'), text)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
