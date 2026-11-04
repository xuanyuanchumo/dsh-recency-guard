/**
 * 工具输出 —— 规范值与人读文本的**双形态**投影。
 *
 * 为什么要双形态（dsh-plugin-dev-kb cookbook「adding-a-tool」L74/L93）
 * ----------------------------------------------------------------
 * `execute` 返回**规范 JSON 值**（模型消费、可快照回放），`output.render`
 * 把同一个值渲染成**人读文本**（命令窗口/会话显示）。此前本插件把裸
 * `JSON.stringify` 直接丢给模型 —— 会话里的命令窗口因此满屏转义与引号，
 * 用户一眼看不到「发生了什么」。人读解释进 render，结构化事实进规范值，
 * 两者**同源**：文本由同一个对象投影而来，不会出现「文本说 A、数据是 B」。
 */

/**
 * JSON 可序列化值 —— 与宿主 dsh-tools 的 `JsonValue` 定义逐字一致。
 *
 * 为什么自己再声明一份：宿主的类型不从此包导出，而 defineTool 的
 * `execute` 契约要求返回 `Record<string, JsonValue>`。结构化复制
 * （结构相同即可赋值）让两份定义保持兼容；契约测试钉住这个一致性。
 */
export type JsonSafe = null | boolean | number | string | JsonSafe[] | { [key: string]: JsonSafe }

/** 工具执行结果（规范形态：JSON 可序列化）。 */
export interface ToolOutcome {
  /** 触发的 action（回显，便于多步会话中对账）。 */
  action: string
  /** 业务是否成功（业务失败不是异常 —— 异常留给真正的调用错误）。 */
  ok: boolean
  /** 一行摘要（命令窗口第一眼）。 */
  summary: string
  /** 人读明细行（不含摘要）。 */
  lines: string[]
  /** 结构化数据（与文本同源；模型按此取数）。 */
  data: Record<string, JsonSafe>
  /**
   * 索引签名：让 ToolOutcome 满足宿主的 `Record<string, JsonValue>`
   * execute 返回契约（没有它，defineTool 的类型检查会拒绝本接口）。
   */
  [key: string]: JsonSafe
}

/** 把规范值渲染成人读文本（output.render 的实现体）。 */
export function renderOutcome(outcome: ToolOutcome): string {
  const head = `${outcome.ok ? '✔' : '✘'} ${outcome.summary}`
  if (outcome.lines.length === 0) return head
  return [head, ...outcome.lines.map((line) => `  ${line}`)].join('\n')
}

/** 构造一个成功结果（data 摊平到顶层供模型直取，同时保留在 data 下便于遍历）。 */
function ok(action: string, summary: string, lines: string[], data: Record<string, JsonSafe>): ToolOutcome {
  return { action, ok: true, summary, lines, data, ...data }
}

/* ---------- 各 action 的投影（纯函数：同一输入必得同一文本） ---------- */

interface StatusLike {
  profile: string
  dshVersion: string
  enabled: boolean
  crashedLastRun: boolean
  crashSeq: number
  stabilized: boolean
  autoDisabled: Array<{ name: string; reason: string; crashSeq: number; disabledAt: string }>
  suspectRanking: Array<{ bundle: string; lastChangeAt: string; lastKind: string }>
  experimentalSuspects: string[]
}

/** status：崩溃状态 + 嫌疑排名的摘要。 */
export function formatStatus(s: StatusLike): ToolOutcome {
  const lines: string[] = [
    `profile ${s.profile} · dsh ${s.dshVersion} · 守护${s.enabled ? '开启' : '仅记录'}`,
  ]
  if (s.crashedLastRun) lines.push(`上次运行崩溃（第 ${s.crashSeq} 次），已自动关闭嫌疑插件`)
  else if (s.stabilized) lines.push('上次崩溃已恢复，当前稳定')
  else lines.push('未检测到上次崩溃')
  if (s.autoDisabled.length > 0) {
    lines.push(`保持关闭：${s.autoDisabled.map((d) => `${d.name}(seq=${d.crashSeq})`).join(', ')}`)
  }
  if (s.suspectRanking.length === 0) {
    lines.push('当前没有第三方/实验性嫌疑插件')
  } else {
    lines.push('嫌疑排名（最近更新优先）：')
    for (const [index, r] of s.suspectRanking.slice(0, 5).entries()) {
      lines.push(`${index + 1}. ${r.bundle} · ${r.lastKind} @ ${r.lastChangeAt.slice(0, 19).replace('T', ' ')}`)
    }
  }
  if (s.experimentalSuspects.length > 0) lines.push(`实验性命名：${s.experimentalSuspects.join(', ')}`)
  return ok('status', s.crashedLastRun ? `上次运行崩溃，已进入第 ${s.crashSeq} 轮恢复` : '守护正常，无待处理崩溃', lines, {
    ...s,
  } as unknown as Record<string, JsonSafe>)
}

/** history：事件日志的时间线（只列 kind/bundle/时刻）。 */
export function formatHistory(events: JsonSafe[]): ToolOutcome {
  const lines = events.map((event) => {
    const e = event as { t?: string; kind?: string; bundle?: string; detail?: string }
    const t = typeof e.t === 'string' ? e.t.slice(0, 19).replace('T', ' ') : '?'
    const subject = e.bundle ?? e.detail ?? ''
    return `${t}  ${String(e.kind ?? '?').padEnd(14)} ${subject}`
  })
  return ok('history', `共 ${events.length} 条事件`, lines, { events })
}

/** recover：本次自动关闭了哪些嫌疑插件。 */
export function formatRecover(r: { disabled: string[]; note: string }): ToolOutcome {
  const lines = r.disabled.length > 0 ? r.disabled.map((b) => `已关闭 ${b}`) : ['没有可关闭的嫌疑插件']
  lines.push(r.note)
  return ok('recover', `已按最近更新关闭 ${r.disabled.length} 个嫌疑插件`, lines, { ...r })
}

/** restore：恢复（重新启用）与保持关闭的名单。 */
export function formatRestore(r: { reenabled: string[]; keptDisabled: string[]; note: string }): ToolOutcome {
  const lines: string[] = []
  if (r.reenabled.length > 0) lines.push(`已恢复：${r.reenabled.join(', ')}`)
  if (r.keptDisabled.length > 0) lines.push(`保持关闭（首要嫌疑）：${r.keptDisabled.join(', ')}`)
  lines.push(r.note)
  return ok('restore', `恢复 ${r.reenabled.length} 个，保持关闭 ${r.keptDisabled.length} 个`, lines, { ...r })
}

/** reenable：单个插件的手动恢复。 */
export function formatReenable(r: { bundle: string; reenabled: boolean; hasConfigBackup: boolean }): ToolOutcome {
  const lines = [
    r.hasConfigBackup ? '该插件的配置备份存在，可在需要时对照' : '该插件没有配置备份（此前未自动关闭过）',
  ]
  return ok('reenable', `${r.bundle} ${r.reenabled ? '已重新启用' : '未能启用'}`, lines, { ...r })
}

/** backups：配置备份清单。 */
export function formatBackups(list: JsonSafe[]): ToolOutcome {
  const lines =
    list.length === 0
      ? ['没有配置备份 —— 从未自动关闭过插件，或备份已被清理']
      : list.map((b) => {
          const entry = b as { bundle?: string; writtenAt?: string }
          return `${String(entry.bundle ?? '?')} · ${String(entry.writtenAt ?? '').slice(0, 19).replace('T', ' ')}`
        })
  return ok('backups', `共 ${list.length} 份配置备份`, lines, { backups: list })
}

/** archive：归档重置（归档不删证据，但不继承旧结论）。 */
export function formatArchive(r: { ok?: boolean; archiveDir?: string; count?: number; manifest?: JsonSafe }): ToolOutcome {
  const lines = [
    `归档目录：${String(r.archiveDir ?? '?')}`,
    `搬走产物：${String(r.count ?? 0)} 项（manifest 已留档）`,
    '崩溃计数已归零，下次启动按最新事实重新推导嫌疑',
  ]
  return ok('archive', '归档重置完成，守护将以最新事实重新开始', lines, { ...r })
}

/** archives：历史归档清单。 */
export function formatArchives(
  r: { archives?: Array<{ dir: string; archivedAt: string; reason: string; count: number }> },
): ToolOutcome {
  const archives = Array.isArray(r.archives) ? r.archives : []
  const lines =
    archives.length === 0
      ? ['还没有归档 —— 归档在每次 archive 重置时产生']
      : archives.map((a) => `${a.dir} · ${a.reason} · ${a.archivedAt.slice(0, 19).replace('T', ' ')}`)
  return ok('archives', `共 ${archives.length} 份归档`, lines, { ...r })
}
