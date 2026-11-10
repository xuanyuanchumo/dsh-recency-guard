/**
 * 决策因子投影的回归（v0.13 方向③）。
 *
 * 测的是「面板如何读决策文件里的因子证据」，核心不变式是**诚实边界**：
 * 旧版决策文件（v0.12.x 及更早）没有 `evidence` 字段，此时绝不能把
 * 缺失画成 0 —— 那会让用户以为「这些插件零风险」。必须显式标记
 * `hasEvidence=false`，由面板显示「该决策未记录因子」。
 */
import { decisionEvidenceRows } from '../panel-model-export.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 最小快照：只带 decisionSuspects（其余字段不被本投影消费）。 */
function snapshot(decisionSuspects: unknown[]): never {
  return { decisionSuspects } as never
}

function main() {
  console.log('\n== 空名单 ==')
  {
    const { rows, hasEvidence } = decisionEvidenceRows(snapshot([]))
    check('无决策 ⇒ 空行', rows.length === 0)
    check('无决策 ⇒ hasEvidence=false（不伪装有证据）', hasEvidence === false)
  }

  console.log('\n== 旧版决策文件（无 evidence 字段）==')
  {
    const { rows, hasEvidence } = decisionEvidenceRows(
      snapshot([
        { bundle: 'legacy-plugin', version: '1.0.0', lastChangeAt: '2026-11-01T00:00:00.000Z' },
        { bundle: 'legacy-two', lastChangeAt: '2026-10-01T00:00:00.000Z' },
      ]),
    )
    check('旧版仍出行（rank 按顺序兜底）', rows.length === 2 && rows[0].rank === 1 && rows[1].rank === 2)
    check('旧版 hasEvidence=false', hasEvidence === false)
    check('旧版 factors 全零但由 hasEvidence 标记（不单独展示）', rows[0].risk === 0 && rows[0].factors.recency === 0)
    check('旧版 source 为 null（无证据来源）', rows[0].source === null)
  }

  console.log('\n== 新版决策文件（含 evidence）==')
  {
    const { rows, hasEvidence } = decisionEvidenceRows(
      snapshot([
        {
          bundle: 'dsh-beta-thing',
          version: '2.0.0',
          lastChangeAt: '2026-11-09T00:00:00.000Z',
          evidence: {
            rank: 1,
            risk: 0.83,
            factors: { recency: 0.4, experimental: 0.3, crashFrequency: 0.13 },
            streak: 3,
            changeCount: 5,
            source: 'journal',
          },
        },
        {
          bundle: 'dsh-stable',
          lastChangeAt: '2026-11-08T00:00:00.000Z',
          evidence: {
            rank: 2,
            risk: 0.21,
            factors: { recency: 0.2, experimental: 0, crashFrequency: 0.01 },
            streak: 0,
            changeCount: 1,
            source: 'mtime',
          },
        },
      ]),
    )
    check('新版 hasEvidence=true', hasEvidence === true)
    check('头号嫌疑标记正确', rows[0].head === true && rows[1].head === false)
    check('因子分解透传', rows[0].factors.recency === 0.4 && rows[0].factors.experimental === 0.3)
    check('三因子之和 ≈ risk（面板可自证一致性）', Math.abs(rows[0].factors.recency + rows[0].factors.experimental + rows[0].factors.crashFrequency - rows[0].risk) < 1e-9)
    check('streak / changeCount 透传', rows[0].streak === 3 && rows[0].changeCount === 5)
    check('source 区分 journal 与 mtime', rows[0].source === 'journal' && rows[1].source === 'mtime')
  }

  console.log('\n== 混合（部分条目有 evidence）==')
  {
    const { rows, hasEvidence } = decisionEvidenceRows(
      snapshot([
        { bundle: 'new-one', lastChangeAt: '2026-11-09T00:00:00.000Z', evidence: { rank: 1, risk: 0.5, factors: { recency: 0.5, experimental: 0, crashFrequency: 0 }, streak: 1, changeCount: 0 } },
        { bundle: 'old-one', lastChangeAt: '2026-11-01T00:00:00.000Z' },
      ]),
    )
    check('只要有一条有 evidence ⇒ hasEvidence=true', hasEvidence === true)
    check('缺 evidence 的条目仍给出占位行（rank 兜底）', rows[1].rank === 2 && rows[1].risk === 0)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
