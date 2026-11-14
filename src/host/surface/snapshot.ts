import type { CapabilityGraph } from '../capability/capability.ts'
import { buildCapabilityGraph, capabilitiesByStage, verifyCapabilityContract } from '../capability/capability-specs.ts'
import type { GuardStage, StageTransition, StepSpan } from '../core/lifecycle.ts'
import { ALL_STAGES } from '../core/lifecycle.ts'
import { computeMetrics, rankHazards, type MetricsSnapshot, type Observation, type RankedRisk } from '../observe/observability.ts'
import { deriveEventFlow, type FlowEvent } from '../observe/observations.ts'
import { computeRevision, type RevisionFacts } from '../core/change-guard.ts'
import { markovAnalysis, type MarkovAnalysis } from '../observe/markov.ts'
import { STAGE_LABELS, buildGraphData, connectedComponents, type GraphData, type GraphNode } from '../capability/graph-data.ts'
import { readPartitionIndex, type PartitionIndex } from '../core/isolation.ts'
import { calibratedConfirmRounds, calibrationExplanation, falsePositiveRate, falsePositiveSamples, type CalibrationDecision, type FalsePositiveRate } from '../risk/risk-calibration.ts'
import { bayesMetric, type BayesScoreValue } from '../risk/risk-bayes.ts'
import type { JournalRecord } from '../data/store.ts'
import type { Metric } from '../observe/observability.ts'
// 声明式冲突的形状只在 conflict-metadata 定义一次（store/status/panel 共用）。
import type { ConflictFinding } from '../guard/conflict-metadata.ts'
import { emptyPreventive, type PreventiveView } from './preventive-view.ts'

/**
 * 事件流快照的条数上限。
 *
 * 为什么是 64：面板的「流动」视图是**最近发生了什么**，不是全历史；
 * limit 同时也是环形缓冲的容量（额外内存 O(limit)），防止 journal 尾部
 * 的 1000 行原样进入快照契约。
 */
export const EVENT_FLOW_LIMIT = 64

/**
 * 观测面 —— 把分散的事实汇成一份**面板与图谱共用的快照**。
 *
 * 为什么是一个快照而不是多个接口
 * ------------------------------
 * 面板要同时展示状态、指标、排名、图谱、能力矩阵。若每块各调一个接口，
 * 各接口之间可能出现**时间点不一致**（状态是 A 时刻、指标是 B 时刻），
 * 用户会看到自相矛盾的界面。因此这里产出**一次成型的快照**，
 * 所有视图渲染同一份数据 —— 事实一致是可观测性的底线。
 *
 * 数据来源全部是**只读投影**：能力图来自清单，指标来自日志，
 * 状态来自状态机。观测面本身**不写**任何东西。
 */

/** 面板快照。 */
export interface PanelSnapshot {
  /** 快照时刻。 */
  at: string
  /**
   * 声明式冲突 finding（T14-03，面板数据面）。
   *
   * 空数组 = 当前没有可展示的冲突（不是「没扫」）；扫描失败也只降级为空，
   * 由 status 的 `conflicts` 同源字段一起承担这个诚实边界。
   */
  conflicts?: readonly ConflictFinding[]
  /** 上次恢复的残余 error finding（`decision.json` 的 `unresolved`）。 */
  unresolved?: readonly ConflictFinding[]
  /**
   * RQ3 预防性读数（T15-01）。
   *
   * 为什么进快照：预警是**观测面**事实，面板必须与状态/排名同屏出现；
   * 单独开一条接口会让「状态是 A 时刻、预警是 B 时刻」（快照的既有纪律）。
   * 只预警不行动：本字段不被任何关闭决策读取（源码扫描断言见
   * `tests/unit/preventive-wiring.test.ts`）。
   */
  preventive: PreventiveView
  /**
   * schema 版本降级事实（T15-03）。
   *
   * 未知版本时守护退到安全空态（看起来像干净启动）；必须让面板也能看到
   * 「文件版本不受支持」，否则数据损坏会被误读成系统正常。
   */
  corrupt: { state: boolean; decision: boolean }
  /** profile 名。 */
  profile: string
  /** 当前工作区（分区键）。 */
  projectKey: string
  /** 当前生命周期阶段。 */
  stage: GuardStage
  /** 阶段中文标签。 */
  stageLabel: string
  /** 迁移历史（按时间顺序）。 */
  transitions: StageTransition[]
  /**
   * 最近执行的步骤记录（v0.18 T16-14）。
   *
   * 截尾展示：完整记录在 state 机内，面板只显示最近 N 条（与 transitions
   * 同口径的截尾纪律 —— 数据层给全量、渲染层显式省略）。
   */
  steps: StepSpan[]
  /** 稳定性评分 ∈ [0,1]。 */
  stabilityScore: number
  /** 量化指标。 */
  metrics: MetricsSnapshot
  /** 嫌疑风险排名。 */
  risks: RankedRisk[]
  /** 当前决策文件的嫌疑名单（含因子证据，v0.13 方向③）。 */
  decisionSuspects: ReadonlyArray<{
    bundle: string
    version?: string
    lastChangeAt: string
    evidence?: {
      rank: number
      risk: number
      factors: { recency: number; experimental: number; crashFrequency: number }
      streak: number
      changeCount: number
      source?: 'journal' | 'mtime'
    }
  }>
  /**
   * 共现验证结论（v0.13 方向④）。
   *
   * 面板只报「能不能加权」，不报加权值 —— 加权需要额外的严格化论证。
   * 各命中率可为 `null`（样本不足 ⇒ 不可判定，绝不当作 0）。
   */
  cooccurrence: {
    samples: number
    activeSamples: number
    inactiveSamples: number
    activeHitRate: number | null
    inactiveHitRate: number | null
    hitRateDelta: number | null
    label: string
    mayWeight: { allowed: boolean; reason: string }
  }
  /**
   * 误伤校准读数（v0.14 / M1 / RQ2，研究文档 07 §3）。
   *
   * 为什么进快照而不只在后台算：07 §3.3 要求自适应阈值**必须可解释**
   * （面板显示「本轮为何提高阈值」），所以这里同时给结论与解释文案。
   * 样本不足时 `rate.defined === false`（`value === null`），面板必须显示
   * 「不可判定」而不是「误伤率 0%」—— 后者会把「没数据」谎报成「没问题」。
   */
  calibration: {
    /** 误伤率读数（`Metric`，不可判定时 defined=false + value=null）。 */
    rate: Metric<FalsePositiveRate>
    /** 自适应阈值决策（含调整理由）。 */
    decision: CalibrationDecision
    /** 人话解释（面板直接渲染）。 */
    explanation: string
    /**
     * 证据链缺口（v0.15 TD-1）：`restore` 声明恢复了某插件，但 journal 里
     * 找不到对应的 `enable`。
     *
     * 为什么面板要看到它：它说明**记录本身可能损坏**，而误伤率会因此偏低。
     * 用户若同时看到「误伤率 0%」与「证据链缺口 3」，正确的解读是
     * 「这个 0% 不可信」，而不是「一切正常」。恒为 0 时面板不显示该行。
     */
    unattributedRestores: number
  }
  /**
   * 贝叶斯并行读数（v0.14 / M2 / RQ1，研究文档 07 §2）。
   *
   * **并行读数纪律**（07 §2.3）：这里的结果与 `risks[]` 的 `risk` 并列，
   * 绝不替代默认 `riskScore`。面板同时显示两套，让用户看见分歧而不是
   * 被单一黑盒结论说服。
   *
   * 数组顺序与 `risks[]` 一致（同源输入），便于前端并排渲染。
   */
  bayes: Array<{
    bundle: string
    /** 样本稀疏时 defined=false（07 §2.3 的「小样本保持诚实」）。 */
    defined: boolean
    reason: string
    label: string
    /** 可判定时的读数，否则 null。 */
    value: BayesScoreValue | null
  }>
  /** 能力矩阵摘要。 */
  capability: {    total: number
    exposed: number
    connected: number
    connectivity: number
    gaps: Array<{ kind: string; capability: string; detail: string }>
    byStage: Array<{ stage: GuardStage; label: string; capabilities: string[] }>
  }
  /** 图谱连通性摘要。 */
  graphConnectivity: { components: number; largest: number; isolated: number }
  /** 最近恢复判定（面板生命周期卡片显示「观察中 N/M 轮」）。 */
  lastRecoveryVerdict?: {
    at: string
    crashSeq: number
    evidence: 'deterministic' | 'probabilistic'
    rounds: number
    required: number
    act: boolean
    label: string
    headSuspect: string | null
  }
  /** 备份策略投影（面板「备份」卡片）。 */
  backupPolicy: {
    versionedBackups: boolean
    retain: number
    customRoot: boolean
    root: string
    configEditorAvailable: boolean
  }
  /** 项目分区列表（隔离可见性）。 */
  partitions: Array<{ key: string; label: string; workspace: string; lastSeenAt: string }>
  /**
   * 写状态的乐观并发凭证（v0.12）。
   *
   * 为什么放在快照里：面板每 5s 轮询一次快照，用户点「重新启用」时依据的
   * 就是这张快照。带上 revision，动作请求才能回传「我是按哪份事实做的决定」；
   * 宿主比对不符就 409，而不是按一张过期地图执行破坏性动作。
   * 由 change-guard.computeRevision 从 state+decision+journal 尾部派生
   * （哈希而非计数器 ⇒ 崩溃重启后同一事实必得同一枚 revision）。
   */
  revision: string
  /** 已恢复的插件。 */
  restored: string[]
  /** 自动关闭的插件。 */
  autoDisabled: Array<{ name: string; reason: string; crashSeq: number; disabledAt: string }>
  /**
   * 最近事件流（journal 尾部投影）—— 「可视化流动」的数据源。
   *
   * 只投影面板要显示的字段，不透传整条 journal 行：
   * 快照是观测面，字段越少，前端与快照的契约越稳定。
   *
   * @deprecated 由 `eventFlow` 取代（后者带阶段/动作/流向/来源）。保留本字段
   * 只为不改动既有消费方；新代码一律读 `eventFlow`，迁移完成后删除。
   */
  recentEvents: Array<{ t: string; kind: string; bundle?: string; detail?: string }>
  /**
   * recentEvents 的 **seq 地板**（v0.20.0，取经 dsh-context floor 契约）：
   * 被裁掉的事件数 —— 客户端由此知道「快照里第一条事件之前还有多少条」。
   * 0 = 从头开始；>0 = 顶部被裁（不是「事件只有这么多」）。
   * 与「省略计数」互补：计数说「少了多少」，地板说「从哪开始」。
   */
  recentEventsFloor: number
  /**
   * 事件流 / 状态流转的时序契约（升序，最近 `EVENT_FLOW_LIMIT` 条）。
   *
   * 「可视化流动」的全部数据基础：时间点 `at`、阶段 `stage`、动作
   * `action`/`actionLabel`、流向 `flow.from → flow.to`、来源 `source`。
   * 纯投影、无副作用、排序确定 —— 同一份输入必得逐字节相同的输出。
   */
  eventFlow: FlowEvent[]
  /** 马尔可夫转移矩阵（v0.10 R11）：阶段行为的「去向分布」+ 平稳分布。 */
  markov: MarkovAnalysis
  /**
   * 系统诊断投影（v0.10 R12）：宿主与插件的版本事实 + 数据面状态。
   *
   * 为什么是投影而非让前端自读：客户端拿不到宿主进程信息（浏览器沙箱），
   * 版本事实只能在宿主侧收集后随快照下发；`available:false` 是诚实边界
   * （不是所有宿主都提供 version 服务），绝不填假值。
   */
  diagnostics: {
    /** 插件自身版本（package.json version，构建期注入或运行时读）。 */
    pluginVersion: string | null
    /** 宿主版本（ctx.env?.version；宿主不提供时 null）。 */
    hostVersion: string | null
    /** 平台标识（win32/darwin/linux）。 */
    platform: string
    /** Node 版本（宿主进程）。 */
    nodeVersion: string
    /** 数据面路由是否可达（能产出这份快照 ⇒ 恒 true）。 */
    dataPlane: true
    /** 快照产出的耗时（毫秒，观测面自身的白盒开销）。 */
    snapshotMs: number
    /**
     * 反馈入口（v0.10 R18）：来自插件 package.json 的 repository.url 与 bugs.url。
     * 没有登记时为 null —— 前端**隐藏按钮**而不是放一条必 404 的死链。
     */
    repositoryUrl: string | null
    /** 问题反馈直达链接（GitHub Issues；未登记时 null）。 */
    issuesUrl: string | null
    /**
     * 产物新鲜度（v0.19）：**「我跑的到底是哪份代码」的白盒事实**。
     *
     * 为什么必须上屏：`link:`/`file:` 安装下改了 `src/**` 但忘了重建时，
     * 插件照常加载、工具照常注册、面板照常出数 —— **只有行为是旧的**，
     * 而且不报任何错。用户会以为「改了没生效」，开发者会以为「代码有问题」，
     * 而真相是产物是旧的。这个字段把真相摆在面板上。
     *
     * 三态严格区分：`stale: true` = 确认过期；`false` = 确认不旧；
     * `null` = **无法判定**（发布态无 src/ 可比）—— 绝不把「无法判定」
     * 报成「正常」。
     */
    buildFreshness: {
      stale: boolean | null
      revision: string | null
      builtAt: string | null
      newestSourceAt: string | null
      driftMs: number | null
      builtVersion: string | null
      reason: string | null
    }
    /**
     * journal 坏行计数（v0.20.0，degraded 白盒）。
     *
     * `null` = 调用方没报（旧调用方）—— **未知 ≠ 完整**：不能替旧宿主
     * 说「没有坏行」。`0` = 本次读取确认完整；`>0` = 有行读不出
     * （行保留在盘上，轮转时自然愈合）。
     */
    journalMalformed?: number | null
  }
}

/** 观测面需要的输入。 */
export interface SnapshotInput {
  profile: string
  projectKey: string
  stage: GuardStage
  transitions: readonly StageTransition[]
  /**
   * 最近执行的步骤记录（v0.18 T16-14，用户要求「执行一定要有操作记录」）。
   *
   * 步骤回答「这次启动/恢复做了哪些动作、耗时、成败」——与 transitions
   * （阶段迁移）是两层事实：transitions 是**状态**轨迹，steps 是**执行**
   * 轨迹。面板把两者分开展示，用户才能区分「阶段从 A 到 B」与
   * 「recover 执行了、耗时多少、成功与否」。
   *
   * **可选**：旧调用方/测试夹具按 v0.17 的 SnapshotInput 形状构造，
   * 缺省时快照给出空数组（「没有执行记录」的诚实表达，不构造假记录）。
   */
  steps?: readonly StepSpan[]
  stabilityScore: number
  observations: Observation[]
  riskInputs: Array<{
    bundle: string
    experimental: boolean
    lastChangeAt: string
    suspectHits: number
    observations: number
  }>
  /**
   * 当前决策文件的嫌疑名单（含因子证据，v0.13 方向③）。
   *
   * 形状与 `decision.ts` 的 `DecisionSuspect` 一致（投影）。空 = 无决策文件
   * 或决策文件里没有 suspects（首次安装、从未崩溃）。
   *
   * 为什么面板需要它：`risks`（`RankedRisk[]`）只给总分，回答不了「A 是靠
   * experimental 拉高还是靠 recency 拉高」。决策证据把分解、streak、changeCount
   * 一起给出来，面板才能解释「为什么是它被选中」。
   */
  decisionSuspects: ReadonlyArray<{
    bundle: string
    version?: string
    lastChangeAt: string
    evidence?: {
      rank: number
      risk: number
      factors: { recency: number; experimental: number; crashFrequency: number }
      streak: number
      changeCount: number
      source?: 'journal' | 'mtime'
    }
  }>
  /** 共现验证输入（v0.13 方向④；由调用方从共现存储读出）。 */
  cooccurrence: {
    samples: number
    activeSamples: number
    inactiveSamples: number
    activeHitRate: number | null
    inactiveHitRate: number | null
    hitRateDelta: number | null
    label: string
    mayWeight: { allowed: boolean; reason: string }
  }
  /**
   * journal 尾部（v0.14 / M1）：误伤样本从**事件流**里判定，不从快照自身推断。
   *
   * 为什么需要整条 journal 而不只 counts：区分「用户主动 reenable」与
   * 「系统自动 restore」必须看 enable 事件的**上下文**（07 §3.3）——
   * 单看次数无法区分两者，而把系统恢复误算成误伤会让阈值越来越高。
   */
  journal: readonly JournalRecord[]
  /**
   * 误伤校准的基线轮数（v0.14 / M1）：来自配置 `confirmRounds`。
   *
   * 为什么由调用方给而不是快照内硬编码默认值：面板显示的「校准后 N 轮」
   * 必须与宿主**实际采用**的阈值同源，否则面板说的和系统做的是两回事。
   */
  confirmRoundsBase: number
  restored: readonly string[]
  autoDisabled: Array<{ name: string; reason: string; crashSeq: number; disabledAt: string }>
  partitions: PartitionIndex
  /** 最近事件（journal 尾部，快照按序投影）。 */
  recentEvents: Array<{ t: string; kind: string; bundle?: string; detail?: string }>
  /** 实际注册出来的对外名称（契约校验用）。 */
  registeredExposedAs: readonly string[]
  /**
   * 声明式冲突 finding（T14-03）。
   *
   * 为什么进快照而不是只进 status：面板是「事后看一眼」的地方，冲突是
   * **可复核的声明**（文件 + 行号 + 原文），必须与决策同屏出现 —— 否则
   * 用户只能看到「关了 2 个插件」，看不到「为什么这 2 个是确定性的」。
   */
  conflicts?: readonly ConflictFinding[]
  /**
   * 上次恢复的残余 error finding（`decision.json` 的 `unresolved`）。
   *
   * 与 `conflicts` 分开：前者是「现在仍成立的冲突」，后者是「上次隔离后
   * 仍治不了的那部分」。合并会让「有冲突」与「试过但治不了」无法区分。
   */
  unresolved?: readonly ConflictFinding[]
  /** 最近恢复判定（v0.9.1：观察中 N/M 轮或「为什么关了它」）。 */
  lastRecoveryVerdict?: {
    at: string
    crashSeq: number
    evidence: 'deterministic' | 'probabilistic'
    rounds: number
    required: number
    act: boolean
    label: string
    headSuspect: string | null
  }
  /** 备份策略（v0.9：面板可视化配置的数据源；只读投影，改配置走宿主设置页）。 */
  backupPolicy: {
    versionedBackups: boolean
    retain: number
    customRoot: boolean
    root: string
    configEditorAvailable: boolean
  }
  /** 系统诊断输入（v0.10 R12/R18）：版本事实由宿主侧收集，null = 宿主未提供（诚实边界）。 */
  diagnostics: {
    pluginVersion: string | null
    hostVersion: string | null
    repositoryUrl: string | null
    issuesUrl: string | null
    /** 产物新鲜度输入（宿主侧算好；快照只投影）。 */
    buildFreshness: {
      stale: boolean | null
      revision: string | null
      builtAt: string | null
      newestSourceAt: string | null
      driftMs: number | null
      builtVersion: string | null
      reason: string | null
    }
    /**
     * journal 坏行计数（v0.20.0，degraded 白盒）。
     *
     * `null`/省略 = 调用方没报（旧调用方）—— **未知 ≠ 完整**；
     * `0` = 本次读取确认完整；`>0` = 有行读不出（行保留在盘上，轮转时自然愈合）。
     */
    journalMalformed?: number | null
  }
  /**
   * revision 派生所需的写状态事实（v0.12）。
   *
   * 为什么给**完整事实**而不是让本文件自己拼：面板快照的 revision 与动作路由
   * 核对的 revision 必须是同一组字段跑同一算法。两处各自装配时，将来加一个
   * 字段漏改另一处的后果不是「少核对一项」，而是**每次动作都 409**（面板
   * 发出去的凭证永远核对不过）—— 一个可选加强项变成整体失效。
   * 装配唯一在 `Guard.revisionFactsFrom()`，本文件只消费并派生。
   *
   * 为什么给输入而不是给现成的 revision 字符串：`revision` 必须是**派生值**
   * （投影），而不是调用方随手传进来的字符串 —— 否则「快照说 revision=X
   * 但事实早已变」这种漂移就无法在结构上排除。
   */
  revisionFacts: RevisionFacts
  /**
   * RQ3 预防性读数（T15-01，可选）。
   *
   * 省略 = 调用方没有 journal 事实；投影会退化成「不可判定」而不是 0
   * （`emptyPreventive()` 的两条读数都是 defined:false + reason）。
   */
  preventive?: PreventiveView
  /** schema 版本降级事实（T15-03；省略 ⇒ 按「无损坏」渲染）。 */
  corruption?: { state: boolean; decision: boolean }
}

/**
 * 构造面板快照。
 *
 * 纯函数：给定输入必得同一输出（无时间依赖、无随机），
 * 因此可被契约测试逐字节比对。
 */
export function buildPanelSnapshot(input: SnapshotInput, now = Date.now()): PanelSnapshot {
  const graph = buildCapabilityGraph()
  const analysis = graph.analyze()
  const metrics = computeMetrics(input.observations, input.stabilityScore, partitionHealth(input.partitions), now)
  // 排名走白盒版本（带样本量/置信度/公式），数组形态由 `.value` 提供；
  // 空队列时 `.value` 为 null ⇒ 用空数组表示「没有嫌疑插件」，与「排名失败」区分。
  const risks = rankHazards(input.riskInputs, now).value ?? []
  const graphData = buildGraphDataFor(graph)

  const byStage = capabilitiesByStage(graph)
  const stageBreakdown = ALL_STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    capabilities: (byStage.get(stage) ?? []).map((r) => r.id),
  }))

  const contract = verifyCapabilityContract(graph, input.registeredExposedAs)

  // 误伤校准（M1）：样本来自 journal，判定来源区分用户/系统（07 §3.3）。
  const fpStats = falsePositiveSamples(input.journal)
  const calibrationDecision = calibratedConfirmRounds(input.confirmRoundsBase, fpStats)

  // 贝叶斯并行读数（M2）：与 risks 同源同序，便于前端并排渲染。
  // 注意这里**不动** risks —— 并行读数的全部意义是让分歧可见（07 §2.3）。
  const bayes = input.riskInputs.map((riskInput) => {
    const metric = bayesMetric(riskInput, now)
    return {
      bundle: riskInput.bundle,
      defined: metric.defined,
      reason: metric.reason ?? '',
      label: metric.label,
      value: metric.value,
    }
  })

  return {
    at: new Date(now).toISOString(),
    profile: input.profile,
    projectKey: input.projectKey,
    stage: input.stage,
    stageLabel: STAGE_LABELS[input.stage],
    transitions: [...input.transitions],
    // v0.18 T16-14：执行操作记录随快照上屏。切片在调用方（index.ts 传
    // machine.steps.slice(-12)），这里只做不可变拷贝 —— 快照是只读投影，
    // 消费方（面板）拿到的必须是快照时刻的冻结事实，不共享可变数组。
    // 旧调用方/夹具缺省 ⇒ 空数组（「没有执行记录」的诚实表达）。
    steps: [...(input.steps ?? [])],
    stabilityScore: input.stabilityScore,
    metrics,
    risks,
    decisionSuspects: [...input.decisionSuspects],
    cooccurrence: { ...input.cooccurrence },
    calibration: {
      rate: falsePositiveRate(fpStats),
      decision: calibrationDecision,
      explanation: calibrationExplanation(calibrationDecision),
      unattributedRestores: fpStats.unattributedRestores,
    },
    bayes,
    backupPolicy: input.backupPolicy,
    lastRecoveryVerdict: input.lastRecoveryVerdict,
    capability: {
      total: analysis.total,
      exposed: analysis.exposed,
      connected: analysis.connected,
      connectivity: analysis.connectivity,
      gaps: [
        ...analysis.broken.map((g) => ({ kind: g.kind, capability: g.capability, detail: g.detail })),
        ...analysis.overproduced.map((g) => ({ kind: g.kind, capability: g.capability, detail: g.detail })),
        ...analysis.isolated.map((g) => ({ kind: g.kind, capability: g.capability, detail: g.detail })),
        ...contract.missing.map((name) => ({ kind: 'undeclared-registration', capability: name, detail: '清单声明暴露但未注册' })),
        ...contract.extra.map((name) => ({ kind: 'unregistered-declaration', capability: name, detail: '已注册但清单未声明' })),
      ],
      byStage: stageBreakdown,
    },
    graphConnectivity: (() => {
      const components = connectedComponents(graphData.nodes, graphData.edges)
      return { components: components.count, largest: components.largest, isolated: components.isolated.length }
    })(),
    partitions: input.partitions.partitions.map((p) => ({
      key: p.key,
      label: p.label,
      workspace: p.workspace,
      lastSeenAt: p.lastSeenAt,
    })),
    restored: [...input.restored],
    autoDisabled: input.autoDisabled.map((d) => ({ ...d })),
    // 声明式冲突数据面（T14-03）：全量给面板，截断由渲染层做。
    // `?? []` 是「调用方没传」的降级，与「扫描结果为空」在快照里同形 ——
    // 这一点必须诚实：空数组只表示「没有可展示的 finding」，不区分原因。
    conflicts: [...(input.conflicts ?? [])],
    unresolved: [...(input.unresolved ?? [])],
    // RQ3 预防性读数（T15-01）：只预警不行动，见 preventive-view.ts 头注。
    // 调用方没传 ⇒ 退回空读数（defined:false + reason），不伪装成「无预警」。
    preventive: input.preventive ?? emptyPreventive(),
    // T15-03：未知 schemaVersion 的降级必须与状态同屏（缺省 = 未读到损坏）。
    corrupt: input.corruption ?? { state: false, decision: false },
    // revision 是**派生**的：同一份事实重算必得同一枚值（哈希而非计数器），
    // 所以它不需要持久化位点，也不会在崩溃后说谎。字段装配唯一在
    // Guard.revisionFactsFrom（见 SnapshotInput 注释）—— 本函数只投影不拼字段。
    revision: computeRevision(input.revisionFacts),
    recentEvents: input.recentEvents.slice(-24).map((e) => ({ ...e })),
    // v0.20.0：seq 地板（取经 dsh-context floor 契约）—— 客户端能如实表达
    // 「数据从这里开始」。0 = 从 journal 头开始（nothing dropped）；
    // N = 第 N 条之前的事件**确实存在但被裁掉**（不是「只有 N 条」）。
    // 与「省略计数」互补：计数说「少了多少」，地板说「从哪开始」。
    recentEventsFloor: Math.max(0, input.recentEvents.length - input.recentEvents.slice(-24).length),
    eventFlow: deriveEventFlow(input.recentEvents, input.transitions, EVENT_FLOW_LIMIT),
    markov: markovAnalysis(input.transitions),
    diagnostics: {
      pluginVersion: input.diagnostics.pluginVersion,
      hostVersion: input.diagnostics.hostVersion,
      repositoryUrl: input.diagnostics.repositoryUrl,
      issuesUrl: input.diagnostics.issuesUrl,
      buildFreshness: { ...input.diagnostics.buildFreshness },
      // v0.20.0：journal 坏行计数（degraded 白盒）。0 = 时间线完整；
      // >0 = 有行读不出（行保留在盘上，轮转时自然愈合）。缺省（旧调用方）=
      // null = 未知（不是「完整」—— 旧宿主没报这个数，不能替它说「没有」）。
      journalMalformed: input.diagnostics.journalMalformed ?? null,
      platform: process.platform,
      nodeVersion: process.version,
      dataPlane: true,
      snapshotMs: Math.max(0, Math.round(Date.now() - now)),
    },
  }
}

/**
 * 构造图谱数据。
 *
 * 能力节点 + 边（生产/消费）+ 缺口节点。
 * 缺口节点是**一等公民**：把「断链」「过度生产」画进图里，
 * 让缺口在视觉上无法被忽略。
 */
export function buildGraphDataFor(graph: CapabilityGraph): GraphData {
  const records = graph.all()
  const edges: Array<{ from: string; to: string; kind?: 'produces' | 'consumes' }> = []
  for (const record of records) {
    // 边的方向是「生产方 → 消费方」：`consumedBy` 就是「谁消费我的产出」。
    for (const consumer of record.consumedBy) {
      edges.push({ from: record.id, to: consumer, kind: 'produces' })
    }
  }

  const analysis = graph.analyze()
  const extras: GraphNode[] = []
  for (const gap of [...analysis.broken, ...analysis.overproduced, ...analysis.isolated]) {
    extras.push({
      id: `gap:${gap.capability}:${gap.detail}`,
      kind: 'gap',
      label: gapLabel(gap.kind),
      detail: `${gap.capability} · ${gap.detail}`,
      shape: 'triangle',
      tone: 'error',
      x: 0,
      y: 0,
      column: 0,
      ref: gap.capability,
    })
  }

  return buildGraphData(records, edges, extras)
}

/** 缺口的可读标签。 */
function gapLabel(kind: string): string {
  switch (kind) {
    case 'broken-consumption':
      return '消费断链'
    case 'over-production':
      return '过度生产'
    case 'isolated':
      return '孤立能力'
    default:
      return kind
  }
}

/**
 * 分区健康度 —— 用于隔离纯度指标。
 *
 * 一个分区「被污染」的判定：本分区的事件里出现了其它分区的项目键。
 * 这里用**分区索引里的重复工作区**作为可判定信号：
 * 同一个规范化路径出现在两个不同键下 ⇒ 隔离被破坏。
 */
function partitionHealth(index: PartitionIndex): Array<{ key: string; contaminated: boolean }> {
  const byWorkspace = new Map<string, string[]>()
  for (const partition of index.partitions) {
    const keys = byWorkspace.get(partition.workspace) ?? []
    keys.push(partition.key)
    byWorkspace.set(partition.workspace, keys)
  }
  return index.partitions.map((partition) => ({
    key: partition.key,
    contaminated: (byWorkspace.get(partition.workspace)?.length ?? 0) > 1,
  }))
}

/** 读取分区索引（只读；文件不存在时返回空索引）。 */
export { readPartitionIndex }
