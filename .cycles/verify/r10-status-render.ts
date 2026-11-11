/**
 * R10 证据脚本：用**真实的** profile 状态数据，经宿主 status 的投影层
 * （tool-render.formatStatus → tool-text 的 padWidth/toLines）渲染一次，
 * 检查命令窗口里的中英混排列对齐。
 *
 * 为什么不是截图：状态卡片最终就是这段文本（`renderOutcome` 的返回值就是
 * 命令窗口显示的内容），文本能逐字核对列宽，截图只能目测。
 *
 * 只读：不写任何 profile 文件。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatStatus, renderOutcome } from '../../src/host/surface/tool-render.ts'

const profileDir = process.env.RG_PROFILE
const partitionKey = process.env.RG_PARTITION
if (!profileDir || !partitionKey) throw new Error('RG_PROFILE / RG_PARTITION 必填')

const partition = join(profileDir, '.recency-guard', 'projects', partitionKey)
const state = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8'))
const decision = JSON.parse(readFileSync(join(partition, 'decision.json'), 'utf8'))

const outcome = formatStatus({
  profile: 'sb-rg-c14',
  dshVersion: '0.16.0',
  enabled: true,
  crashedLastRun: state.bootMarker !== null,
  crashSeq: state.crashSeq ?? 0,
  stabilized: state.stabilized === true,
  autoDisabled: (state.autoDisabled ?? []).map((d: { name: string; reason: string; crashSeq: number; disabledAt: string }) => ({
    name: d.name,
    reason: d.reason,
    crashSeq: d.crashSeq,
    disabledAt: d.disabledAt,
  })),
  suspectRanking: (decision.suspects ?? []).map((s: { bundle: string; lastChangeAt: string }) => ({
    bundle: s.bundle,
    lastChangeAt: s.lastChangeAt,
    lastKind: 'install',
  })),
  experimentalSuspects: [],
  lastRecoveryVerdict: state.lastRecoveryVerdict,
  workspace: 'D:/Projects/TraeProjects/dsh-recency-guard',
  projectKey: partitionKey,
  pluginVersion: '0.16.0',
  issuesUrl: null,
  decisionEvidence: {
    hasEvidence: (decision.suspects ?? []).some((s: { evidence?: unknown }) => s.evidence !== undefined),
    items: (decision.suspects ?? [])
      .filter((s: { evidence?: unknown }) => s.evidence !== undefined)
      .map((s: { bundle: string; evidence: { rank: number; risk: number; factors: { recency: number; experimental: number; crashFrequency: number }; streak: number; changeCount: number; source?: string } }) => ({
        rank: s.evidence.rank,
        bundle: s.bundle,
        risk: s.evidence.risk,
        factors: s.evidence.factors,
        streak: s.evidence.streak,
        changeCount: s.evidence.changeCount,
        source: s.evidence.source ?? null,
      })),
  },
})

process.stdout.write(`${renderOutcome(outcome)}\n`)

// ── 第二段：折行/列宽实测（中英混排 + emoji + 组合字符 + 零宽）──
const { displayWidth, padWidth, toBoundedLinesWithNote, MAX_LINE_WIDTH } = await import('../../src/host/surface/tool-text.ts')
process.stdout.write('\n== 宽度实测 ==\n')
for (const sample of ['中文', 'abc', '🎉', 'e\u0301', 'a\u200bb', '👨‍👩‍👧', 'dsh-fi-crash（第 1 次崩溃后关闭）']) {
  process.stdout.write(`  width=${String(displayWidth(sample)).padStart(3)}  ${JSON.stringify(sample)}\n`)
}
process.stdout.write('\n== 列对齐实测（右填充到 12 列）==\n')
for (const label of ['崩溃计数', '上次运行', 'profile', 'dsh', '工作区']) {
  process.stdout.write(`  ${padWidth(`${label}：`, 12)}| 值\n`)
}
process.stdout.write('\n== 长行折行实测（max=118，含 emoji 与 CJK）==\n')
const longText =
  '错误详情：@third-party-scope/一个非常长的插件名字-very-long-name-that-cannot-break-anywhere 🎉👨‍👩‍👧 e\u0301 ——' +
  '这一段还包含中文标点、全角括号（以及路径 D:/Projects/TraeProjects/dsh-recency-guard/.recency-guard/projects/59ce36e13a01163b），' +
  '用来验证折行既不超过 118 列，也不把一个 emoji 或组合字符拆成两半。'
const wrapped = toBoundedLinesWithNote(longText, '    ', 4)
for (const [index, line] of wrapped.entries()) {
  process.stdout.write(`  L${index + 1}[${String(displayWidth(line)).padStart(3)}/${MAX_LINE_WIDTH}] ${line}\n`)
}