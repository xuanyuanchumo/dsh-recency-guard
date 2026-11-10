/**
 * 面板视图模型 —— 卡片要展示的**派生事实**全在这里（纯函数，无 React / 无 DOM）。
 *
 * 为什么派生而不是直接打印快照字段
 * ------------------------------
 * 1. **快照是契约，卡片是解释**：换一种排版不该改后端契约；把「能力行」
 *    「决策历史」这类聚合放在客户端，后端只需继续投影事实。
 * 2. **诚实边界要能逐条断言**：`metricRows` 把 `defined=false` 转成
 *    「不可判定 + 原因」，这个转换一旦写错（例如把 null 当 0），界面就会
 *    出现「一切正常」的假绿 —— 它是本插件最忌讳的缺陷，所以必须是纯函数。
 * 3. **方向语义只在一处**：能力图的边方向是「生产方 → 消费方」，
 *    consumes = 我消费谁（入边来源），consumedBy = 谁消费我（出边去向）。
 *    这对方向在历史上写反过一次（见 docs/agents/conventions.md），
 *    因此只在一个函数里推导，并由测试钉死。
 */

import type { GuardStage, StageTransition } from '../../host/core/lifecycle.ts'
import type { GraphData } from '../../shared/graph-contract.ts'
import type { PanelSnapshot } from '../../host/surface/snapshot.ts'
import { t } from '../i18n/i18n.ts'

/**
 * 生命周期阶段顺序（镜像 lifecycle.ALL_STAGES）。
 *
 * 为什么不 import 宿主常量：客户端产物只应带**投影面**，把宿主模块拖进
 * 浏览器 bundle 会让「前端」与「宿主实现」耦合（宿主重构即前端崩）。
 * 漂移风险由测试兜底：tests/client/panel-model.test.ts 直接与 ALL_STAGES 比对。
 */
export const STAGE_ORDER: readonly GuardStage[] = ['idle', 'monitoring', 'crashed', 'deciding', 'stabilizing', 'recovered']

/** 阶段文案 —— 优先字典（英文界面要可读），缺键时回退快照自带标签。 */
export function stageLabelOf(stage: GuardStage, fallback?: string): string {
  const key = `stage.${stage}`
  const translated = t(key)
  return translated === key ? (fallback ?? stage) : translated
}

/** 阶段轨道的一格。 */
export interface StageCell {
  stage: GuardStage
  label: string
  state: 'current' | 'visited' | 'unvisited'
}

/**
 * 阶段轨道 —— 状态机不是进度条（recovered 还能回到 monitoring），
 * 所以这里只回答「哪些阶段真实出现过、现在在哪」，不画「完成百分比」
 * （那会把可逆状态机谎报成单向流程）。
 */
export function stageRail(current: GuardStage, transitions: readonly StageTransition[]): StageCell[] {
  const visited = new Set<GuardStage>()
  for (const transition of transitions) {
    visited.add(transition.from)
    visited.add(transition.to)
  }
  return STAGE_ORDER.map((stage) => ({
    stage,
    label: stageLabelOf(stage),
    state: stage === current ? 'current' : visited.has(stage) ? 'visited' : 'unvisited',
  }))
}

/* ---------- 能力清单（注册 / 生产 / 消费） ---------- */

export interface CapabilityRow {
  id: string
  label: string
  detail: string
  /** 所属阶段标签（来自图谱列）。 */
  stage: string
  /** 是否对外暴露（图谱节点的 weight 即「暴露」标记，见 graph-data.buildGraphData）。 */
  exposed: boolean
  /** 我消费谁（入边来源）。 */
  consumes: string[]
  /** 谁消费我（出边去向）。 */
  consumedBy: string[]
}

/**
 * 能力行 —— 从**图谱数据**推导生产/消费关系。
 *
 * 为什么不用快照的 capability.byStage：它只投影了「阶段 → 能力 id」，
 * 没有生产/消费链路；而链路恰好已经在图谱边里（同一次成型投影）。
 * 再让宿主投影一份就是第二真相源。
 */
export function capabilityRows(graph: GraphData | null, limit = 60): CapabilityRow[] {
  if (graph === null) return []
  const labelOf = new Map<string, string>()
  for (const node of graph.nodes) labelOf.set(node.id, node.label)
  const stageOfColumn = new Map<number, string>()
  for (const column of graph.columns) stageOfColumn.set(column.index, column.label)

  const rows = graph.nodes
    .filter((node) => node.kind === 'capability')
    .map((node) => {
      const consumes: string[] = []
      const consumedBy: string[] = []
      for (const edge of graph.edges) {
        // 边方向 = 生产方 → 消费方：入边来源生产给我（我消费它）。
        if (edge.to === node.id && edge.from !== node.id) consumes.push(edge.from)
        if (edge.from === node.id && edge.to !== node.id) consumedBy.push(edge.to)
      }
      const byLabel = (a: string, b: string): number =>
        (labelOf.get(a) ?? a).localeCompare(labelOf.get(b) ?? b) || a.localeCompare(b)
      return {
        id: node.id,
        label: node.label,
        detail: node.detail ?? '',
        stage: stageOfColumn.get(node.column) ?? '',
        exposed: (node.weight ?? 0) > 0,
        consumes: [...new Set(consumes)].sort(byLabel),
        consumedBy: [...new Set(consumedBy)].sort(byLabel),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  return rows.slice(0, limit)
}

/** 能力行的可读名称（把 id 映射成标签，找不到就用 id 本身）。 */
export function namesOf(ids: readonly string[], graph: GraphData | null): string[] {
  const labelOf = new Map<string, string>()
  for (const node of graph?.nodes ?? []) labelOf.set(node.id, node.label)
  return ids.map((id) => labelOf.get(id) ?? id)
}

/* ---------- 崩溃决策历史 ---------- */

export interface DecisionEntry {
  at: string
  kind: 'crash' | 'disabled' | 'restored' | 'note'
  bundle: string | null
  detail: string
}

/**
 * 决策历史 —— 把三类事实合成一条时间线：
 * ① journal 里的崩溃事件（crash-detected）；② 自动关闭名单（含崩溃序号）；
 * ③ 恢复事件（restore）。缺一都会让用户看不懂「为什么这个插件现在是关的」。
 *
 * 时间缺失的条目**不伪造时间**：排在末尾并留空时刻（诚实优先于整齐）。
 */
export function decisionHistory(snapshot: PanelSnapshot, limit = 12): DecisionEntry[] {
  const entries: DecisionEntry[] = []
  for (const event of snapshot.recentEvents) {
    if (event.kind === 'crash-detected') {
      entries.push({ at: event.t, kind: 'crash', bundle: event.bundle ?? null, detail: event.detail ?? '' })
    } else if (event.kind === 'restore') {
      entries.push({ at: event.t, kind: 'restored', bundle: null, detail: event.detail ?? '' })
    }
  }
  for (const disabled of snapshot.autoDisabled) {
    entries.push({
      at: disabled.disabledAt,
      kind: 'disabled',
      bundle: disabled.name,
      detail: `${disabled.reason}（崩溃序列 #${disabled.crashSeq}）`,
    })
  }
  const seen = new Set<string>()
  return entries
    .filter((entry) => {
      const key = `${entry.kind}|${entry.bundle ?? ''}|${entry.at}|${entry.detail}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
    .slice(0, limit)
}

/* ---------- 决策因子证据（v0.13 方向③） ---------- */

/**
 * 一条决策因子证据行 —— 面板「决策因子」卡片的一行。
 *
 * 为什么要单列 `factors` 而不是只给总分：`risks` 卡片给的 `risk` 是三项之和，
 * 0.72 可能是「1 小时前更新」也可能是「实验性插件」拉高的。用户问
 * 「为什么关它不关那个」时，只有分解能回答。
 */
export interface DecisionEvidenceRow {
  /** 排名（1 基，与决策文件一致）。 */
  rank: number
  bundle: string
  /** 风险总分 ∈ [0,1]。 */
  risk: number
  /** 三因子加权贡献（已取整到 4 位）。 */
  factors: { recency: number; experimental: number; crashFrequency: number }
  /** 连续头号嫌疑轮数。 */
  streak: number
  /** journal 里的安装/更新次数。 */
  changeCount: number
  /** 证据来源（journal = 安装事实；mtime = 引导值）。 */
  source: string | null
  /** 是否为当前头号嫌疑。 */
  head: boolean
}

/**
 * 决策因子证据行（纯函数）。
 *
 * 诚实边界：没有 `evidence` 的老决策文件（v0.12.x 及更早）**不伪造因子**——
 * 该行 `risk`/`factors` 保持 0 并由 `hasEvidence` 标记，面板显示
 * 「该决策未记录因子（旧版本）」而不是把 0 当成「零风险」。
 */
export function decisionEvidenceRows(snapshot: PanelSnapshot): { rows: DecisionEvidenceRow[]; hasEvidence: boolean } {
  const list = snapshot.decisionSuspects ?? []
  let hasEvidence = false
  const rows = list.map((suspect, index) => {
    const ev = suspect.evidence
    if (ev) hasEvidence = true
    return {
      rank: ev?.rank ?? index + 1,
      bundle: suspect.bundle,
      risk: ev?.risk ?? 0,
      factors: ev?.factors ?? { recency: 0, experimental: 0, crashFrequency: 0 },
      streak: ev?.streak ?? 0,
      changeCount: ev?.changeCount ?? 0,
      source: ev?.source ?? null,
      head: (ev?.rank ?? index + 1) === 1,
    }
  })
  return { rows, hasEvidence }
}

/* ---------- 指标 ---------- */

export interface MetricRow {
  key: string
  label: string
  /** 已格式化的读数；不可判定时为字典里的「不可判定」。 */
  value: string
  defined: boolean
  /** 不可判定的原因（诚实边界：不是空白，而是说清为什么）。 */
  reason: string | null
  /** 进度条比例 ∈ [0,1]；没有比例语义的读数（时长/变点）为 null。 */
  bar: number | null
}

function pctOf(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 指标行 —— 快照里的每个 Metric<T> 都转成「一定有东西可读」的一行。
 *
 * 关键不变式：`defined === false` 时读数是「不可判定」而**绝不是 0**
 * （把无数据当零，界面会显示一切正常）。
 */
export function metricRows(snapshot: PanelSnapshot): MetricRow[] {
  const metrics = snapshot.metrics
  const rows: MetricRow[] = []
  const push = (
    key: string,
    label: string,
    metric: { value: unknown; defined: boolean; reason?: string },
    format: (value: never) => string,
    bar: number | null,
  ): void => {
    rows.push({
      key,
      label,
      value: metric.defined ? format(metric.value as never) : t('metrics.undefined'),
      defined: metric.defined,
      reason: metric.defined ? null : (metric.reason ?? null),
      bar: metric.defined ? bar : null,
    })
  }

  push('crashRate', t('metrics.crashRate'), metrics.crashRate, (value: number) => pctOf(value), metrics.crashRate.value ?? null)
  push(
    'crashPressure',
    t('metrics.crashPressure'),
    metrics.crashPressure,
    (value: number) => value.toFixed(2),
    metrics.crashPressure.value ?? null,
  )
  push(
    'detectionRate',
    t('metrics.detectionRate'),
    metrics.detectionRate,
    (value: number) => pctOf(value),
    metrics.detectionRate.value ?? null,
  )
  push(
    'isolationPurity',
    t('metrics.isolationPurity'),
    metrics.isolationPurity,
    (value: number) => pctOf(value),
    metrics.isolationPurity.value ?? null,
  )
  push(
    'meanRecoveryTime',
    t('metrics.meanRecoveryTime'),
    metrics.meanRecoveryTime,
    (value: number) => `${(value / 1000).toFixed(2)} s`,
    null,
  )
  push(
    'intervals',
    t('metrics.intervals'),
    metrics.intervals,
    (value: { medianMs: number; cv: number }) => `${(value.medianMs / 1000).toFixed(1)} s · CV ${value.cv.toFixed(2)}`,
    null,
  )
  push(
    'changePoint',
    t('metrics.changePoint'),
    metrics.changePoint,
    (value: { index: number; at: string | null }) => `${t('kpi.changePointYes')} · #${value.index}`,
    null,
  )
  push(
    'controlBand',
    t('metrics.controlBand'),
    metrics.controlBand,
    (value: { label: string }) => value.label,
    null,
  )
  return rows
}

/* ---------- 马尔可夫转移矩阵 ---------- */

/** 马尔可夫卡要渲染的一行（一个阶段的去向分布）。 */
export interface MarkovRowView {
  stage: string
  label: string
  /** 自环概率（留在本阶段）；null = 无迁出样本。 */
  selfLoop: number | null
  /** 概率条的宽度百分比（自环 × 100）；null = 不画条。 */
  barPercent: number | null
  /**
   * 跨阶段去向 top-N（v0.11 P0 修复：自环之外的最大概率去向）。
   *
   * 为什么必须有：`monitoring → crashed 40%` 这类**跨阶段**迁移才是
   * 「高危巡逻」的核心信号，此前 UI 只渲染自环条，README 宣称的
   * 「去向分布」在界面上根本看不到。每行最多 2 个（top-2），
   * 排除自环与零概率；null = 无跨阶段迁出（健康值守或无样本）。
   */
  exits: Array<{ stage: string; percent: number }> | null
}

/** 跨阶段去向保留几个（top-2：一行最多放得下两个徽标，再多进 tooltip）。 */
const MARKOV_EXITS_LIMIT = 2

/** 马尔可夫分析的视图投影（纯函数：面板不直接读 markov 内部结构）。 */
export function markovView(snapshot: PanelSnapshot): {
  rows: MarkovRowView[]
  stationary: Array<{ stage: string; share: number; percent: number }>
  converged: boolean
  samples: number
  summary: string
  available: boolean
} {
  const markov = snapshot.markov
  const rows: MarkovRowView[] = markov.rows.map((row) => {
    const selfLoop = row.probabilities?.[row.stage]
    // 跨阶段去向：排除自环与零概率，按概率降序取 top-N（并列按阶段名稳定排序）。
    const exits =
      row.probabilities === null
        ? null
        : Object.entries(row.probabilities)
            .filter(([stage, p]) => stage !== row.stage && p > 0)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, MARKOV_EXITS_LIMIT)
            .map(([stage, p]) => ({ stage, percent: Math.round(p * 100) }))
    return {
      stage: row.stage,
      label: row.label,
      selfLoop: typeof selfLoop === 'number' ? selfLoop : null,
      barPercent: typeof selfLoop === 'number' ? Math.round(selfLoop * 100) : null,
      exits: exits !== null && exits.length > 0 ? exits : null,
    }
  })
  const stationary =
    markov.stationary === null
      ? []
      : Object.entries(markov.stationary)
          .map(([stage, share]) => ({ stage, share, percent: Math.round(share * 100) }))
          .sort((a, b) => b.share - a.share || a.stage.localeCompare(b.stage))
  return {
    rows,
    stationary,
    converged: markov.converged,
    samples: markov.samples,
    summary: markov.label,
    available: markov.samples > 0,
  }
}

/* ---------- 数据流（原始事件 → 投影 → 渲染） ---------- */

/** 数据流链路的一环（白盒透明：每层各做了什么、还剩几条）。 */
export interface DataFlowStage {
  key: string
  label: string
  detail: string
  count: number | null
}

/**
 * 数据流链路投影（v0.10 R11「可视化流动」的白盒面）。
 *
 * 为什么从快照字段反推而不是单独接口：链路的每一环就是快照的一个字段
 * （journal 原文 → recentEvents 截尾 → eventFlow 语义投影 → 面板渲染），
 * 从快照自身推导链路读数，保证「链路图」与「链路实际承载数据」同源 ——
 * 单独接口迟早会和快照漂移。
 */
export function dataFlowStages(snapshot: PanelSnapshot): DataFlowStage[] {
  const flowCount = snapshot.eventFlow.length
  return [
    {
      key: 'journal',
      label: t('dataflow.journal'),
      detail: t('dataflow.journalDetail'),
      count: null,
    },
    {
      key: 'events',
      label: t('dataflow.events'),
      detail: t('dataflow.eventsDetail'),
      count: snapshot.recentEvents.length,
    },
    {
      key: 'flow',
      label: t('dataflow.flow'),
      detail: t('dataflow.flowDetail'),
      count: flowCount,
    },
    {
      key: 'render',
      label: t('dataflow.render'),
      detail: t('dataflow.renderDetail'),
      count: flowCount,
    },
  ]
}

/* ---------- 系统诊断（R12/R18） ---------- */

/** 诊断卡的一行事实。 */
export interface DiagnosticsRow {
  key: string
  label: string
  value: string
  /** null = 该行没有链接；有链接时值渲染成 <a>。 */
  href: string | null
}

/** 系统诊断投影：版本事实 + 分区键 + 反馈入口。 */
export function diagnosticsRows(snapshot: PanelSnapshot): DiagnosticsRow[] {
  const d = snapshot.diagnostics
  const rows: DiagnosticsRow[] = [
    { key: 'pluginVersion', label: t('diagnostics.pluginVersion'), value: d.pluginVersion ?? t('diagnostics.unknown'), href: null },
    { key: 'hostVersion', label: t('diagnostics.hostVersion'), value: d.hostVersion ?? t('diagnostics.unknown'), href: null },
    { key: 'platform', label: t('diagnostics.platform'), value: `${d.platform} · node ${d.nodeVersion}`, href: null },
    { key: 'partition', label: t('diagnostics.partition'), value: `${snapshot.projectKey.slice(0, 8)}…`, href: null },
    { key: 'dataPlane', label: t('diagnostics.dataPlane'), value: t('diagnostics.dataPlaneOk'), href: null },
    { key: 'snapshotMs', label: t('diagnostics.snapshotMs'), value: `${d.snapshotMs} ms`, href: null },
  ]
  if (d.repositoryUrl !== null) {
    rows.push({ key: 'repository', label: t('diagnostics.repository'), value: shortRepoUrl(d.repositoryUrl), href: d.repositoryUrl })
  }
  return rows
}

/** 仓库链接的短显示（协议与域名去掉，路径留着）。 */
function shortRepoUrl(url: string): string {
  return url.replace(/^https:\/\/[^/]+\//, '')
}

/* ---------- 项目隔离 ---------- */

export interface PartitionOption {
  key: string
  label: string
  workspace: string
  lastSeenAt: string
  current: boolean
}

export interface PartitionView {
  currentKey: string
  selectedKey: string
  selected: PartitionOption | null
  /** 正在查看的是否不是当前分区（数据面是否真的切换过，由组件另行核对）。 */
  inspectingOther: boolean
  options: PartitionOption[]
}

/**
 * 分区视图 —— 当前分区永远排第一，其余按名称排序。
 *
 * 为什么「当前」要显式标记而不是靠选中态：用户切换查看历史分区后，
 * 必须一眼看出「哪一个是宿主正在写的那一个」，否则会误以为切换改变了宿主。
 */
export function partitionView(snapshot: PanelSnapshot, selectedKey: string | null): PartitionView {
  const options: PartitionOption[] = snapshot.partitions.map((partition) => ({
    key: partition.key,
    label: partition.label,
    workspace: partition.workspace,
    lastSeenAt: partition.lastSeenAt,
    current: partition.key === snapshot.projectKey,
  }))
  options.sort((a, b) => (a.current === b.current ? a.label.localeCompare(b.label) : a.current ? -1 : 1))
  const selected = selectedKey ?? snapshot.projectKey
  return {
    currentKey: snapshot.projectKey,
    selectedKey: selected,
    selected: options.find((option) => option.key === selected) ?? null,
    inspectingOther: selected !== snapshot.projectKey,
    options,
  }
}

/* ---------- 排版与时间 ---------- */

/**
 * 面板形态 —— 窄侧栏与全屏面板两种排版。
 *
 * 为什么用测量宽度而不是媒体查询：面板挂载在宿主的中央列里，**窗口**
 * 可能是宽的而面板列是窄的（用户拖窄了侧栏）。媒体查询量的是窗口，
 * 会给出「宽形态」，于是卡片在窄列里挤成一列乱码。
 */
export type PanelForm = 'narrow' | 'wide'

export const NARROW_PANEL_WIDTH = 640

export function panelForm(width: number): PanelForm {
  if (!Number.isFinite(width) || width <= 0) return 'wide'
  return width < NARROW_PANEL_WIDTH ? 'narrow' : 'wide'
}

/** 时刻（HH:MM:SS）；无法解析时返回空串，由调用方决定显示什么。 */
export function formatClock(iso: string): string {
  return typeof iso === 'string' && iso.length >= 19 ? iso.slice(11, 19) : ''
}

/** 日期 + 时刻（YYYY-MM-DD HH:MM）。 */
export function formatDateTime(iso: string): string {
  if (typeof iso !== 'string' || iso.length < 16) return iso ?? ''
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/**
 * 长路径的紧凑显示 —— 保留盘符/根与末两段，中间省略。
 *
 * 为什么不简单截断尾部：路径的**可归因部分在末尾**（项目目录名），
 * 截尾会把最重要的信息切掉，只剩一串相同的 `D:\Projects\TraeProj…`。
 */
export function shortenPath(path: string, max = 44): string {
  if (typeof path !== 'string' || path.length <= max) return path ?? ''
  // 分隔符沿用原路径的形态：Windows 用反斜杠、POSIX 用斜杠 —— 混用会让
  // 用户复制出来的路径无法直接粘贴使用（显示层不该发明新的分隔符）。
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/).filter((segment) => segment !== '')
  const tail = parts.slice(-2).join(separator)
  const head = parts[0] ?? ''
  const prefix = /^[a-zA-Z]:$/.test(head) ? head : path.startsWith('/') ? '' : head
  return `${prefix}${separator}…${separator}${tail}`
}

/**
 * 相对时间 —— 事件流里「3 分钟前」比「12:04:31」更快被理解。
 * 未来时间（时钟漂移）不显示负数，退回「刚刚」。
 */
export function agoLabel(iso: string, now = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return t('time.justNow')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: Math.round(hours / 24) })
}
