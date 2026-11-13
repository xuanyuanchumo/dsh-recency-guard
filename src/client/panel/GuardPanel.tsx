import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from '../i18n/i18n.ts'
import type { FetchResult, PanelAction } from '../api/api.ts'
import { GuardGraph } from '../graph/GuardGraph.tsx'
import {
  ArchivesCard,
  BackupPolicyBody,
  CapabilityBody,
  Card,
  CooccurrenceBody,
  DecisionEvidenceBody,
  CalibrationBody,
  BayesBody,
  DecisionsBody,
  EventsBody,
  KpiStrip,
  LifecycleBody,
  MetricsBody,
  PartitionsBody,
  PreventiveBody,
  RisksBody,
  archiveEntriesOf,
  type ArchiveEntry,
} from './PanelCards.tsx'
import { DataFlowBody, DiagnosticsBody, GraphStructureBar, MarkovBody } from './InsightCards.tsx'
import { PanelErrorBoundary } from './PanelErrorBoundary.tsx'
import { POLL_BASE_MS, nextFailureDelay, nextPollDelay, pageVisible, pollContentFingerprint, type PollOutcome } from './poll-adaptive.ts'
import { createEpochGuard } from './epoch-guard.ts'
import { degradedRoutes, panelForm, partitionView, shortenPath, type DegradedRoute, type PanelForm } from './panel-model.ts'
import { VIEWPORT_HEIGHT_NARROW, VIEWPORT_HEIGHT_WIDE } from '../graph/graph-model.ts'
import type { PanelSnapshotView } from './snapshot-view.ts'
import type { GraphData } from '../../shared/graph-contract.ts'

/**
 * 管理面板 —— 守护的全部可见面。
 *
 * ## 职责边界
 *
 * 本组件只做四件事：**取数、轮询、动作、布局**。所有派生事实在
 * `panel-model.ts`（纯函数，可测），所有块状内容在 `PanelCards.tsx`。
 *
 * ## 三条不可破坏的客户端纪律
 *
 * 1. **轮询只是刷新数据**：不重置用户事实（折叠态、图谱视口/拖拽偏移、选中）。
 * 2. **暂停即真停**：暂停后不再发任何 fetch，画面停在暂停时刻；
 *    按钮用 `aria-pressed` + 边框变色双通道提示（只靠颜色会在
 *    高对比度主题下消失）。
 * 3. **分区隔离可见且可归因**：header 显示当前分区（可读名 + 完整路径），
 *    切换查看别的分区是**显式动作**；若宿主数据面不支持按分区查询，
 *    如实说明「显示的仍是当前分区」，绝不把当前分区的事实冒充成别的分区。
 *
 * ## 响应式
 *
 * 形态由**面板自身宽度**决定（`panelForm`），不是窗口宽度 —— 面板可能挂在
 * 被拖窄的侧栏里，媒体查询会给出错误答案。
 */
export interface GuardPanelProps {
  /** 拉取快照；传入分区键时请求该分区（宿主不支持时如实降级，见下方 notice）。 */
  fetchSnapshot: (partition?: string) => Promise<FetchResult<PanelSnapshotView>>
  fetchGraph: (partition?: string) => Promise<FetchResult<GraphData>>
  /** 拉取历史归档（缺席即不显示归档卡片 —— 组件保持独立可用）。 */
  fetchArchives?: (partition?: string) => Promise<FetchResult<unknown>>
  postAction: (action: PanelAction, payload?: Record<string, unknown>) => Promise<FetchResult<unknown>>
}

/**
 * 轮询间隔（毫秒）。
 *
 * v0.17：不再是常量 —— 间隔由 `nextPollDelay` 按内容指纹自适应，
 * 这里只保留基准值（首帧/内容变化时使用的 5s）。
 */
const POLL_BASE = POLL_BASE_MS

/** 可折叠卡片的持久化键（localStorage：跨轮询/跨会话记住折叠态）。 */
const COLLAPSE_KEY = 'recency-guard-collapsed'

/** 折叠态的读写（storage 不可用时退回内存默认 —— 不抛异常）。 */
function loadCollapsed(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSE_KEY)
    if (raw === null || raw === undefined) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

function saveCollapsed(cards: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSE_KEY, JSON.stringify([...cards]))
  } catch {
    /* storage 不可用：折叠态退化为会话内记忆 */
  }
}

export function GuardPanel(props: GuardPanelProps): ReactElement {
  const [snapshot, setSnapshot] = useState<PanelSnapshotView | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [archives, setArchives] = useState<ArchiveEntry[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [polling, setPolling] = useState(true)
  /** 当前轮询间隔（状态栏要显示真实值，而不是写死的 5s）。 */
  const [pollDelay, setPollDelay] = useState(POLL_BASE)
  /** 连续未变的轮数（>0 时状态栏提示「数据稳定，已放慢刷新」）。 */
  const [stableRounds, setStableRounds] = useState(0)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => loadCollapsed())
  const [form, setForm] = useState<PanelForm>('wide')
  /** 选中的节点（图谱与能力清单共用这一份选中态）。 */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  /** 面板 → 图谱的居中请求（nonce 让重复请求也生效）。 */
  const [locateRequest, setLocateRequest] = useState<{ id: string; nonce: number } | null>(null)
  /** 请求查看的分区（null = 跟随当前分区）。 */
  const [requestedKey, setRequestedKey] = useState<string | null>(null)
  /** 数据面实际返回的分区与请求不一致时的诚实提示。 */
  const [partitionMismatch, setPartitionMismatch] = useState<{ requested: string; actual: string } | null>(null)
  /**
   * 可选项数据面当前**不可得**的清单（图谱/归档）。
   *
   * 与 `failure` 分开：快照失败 = 面板整体不可用；图谱/归档失败 =
   * 其余事实仍然可读。混成一个状态会让「图谱没读到」被渲染成
   * 「什么都没读到」，也会把可用的事实一起藏掉。
   */
  const [degraded, setDegraded] = useState<DegradedRoute[]>([])
  /**
   * 上一次动作因状态已变（409）被拦下。
   *
   * 为什么单独一个 state 而不是复用 failure：两者的**下一步**不同 ——
   * failure 要说「数据面有问题」，409 要说「世界变了，请看新事实再决定」。
   * 混在一起会让用户对着一条其实执行成功了读取失败的错误去怀疑守护本身。
   */
  const [conflictNotice, setConflictNotice] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const mounted = useRef(true)
  /** 上一次成功快照的指纹（null = 还没有基准）。 */
  const fingerprintRef = useRef<string | null>(null)
  /** 连续未变轮数（ref 而不是 state：轮询循环读取它时不能等一次渲染）。 */
  const sameRoundsRef = useRef(0)
  /**
   * 连续失败次数（v0.19）—— 指数退避的计数。
   *
   * 用 ref 而不是 state：轮询循环读它时不等一次渲染；且失败计数不该
   * 触发额外渲染（失败态由 `failure` 状态单独表达）。
   */
  const failureCountRef = useRef(0)
  /**
   * 在途请求的世代守卫（v0.19）。
   *
   * 用途：切换查看的分区时，让**上一分区还在路上的响应**落地即被丢弃。
   * 详见 `epoch-guard.ts` 的根因说明。
   */
  const epochGuardRef = useRef(createEpochGuard())

  const load = useCallback(
    async (partitionKey: string | null): Promise<PollOutcome> => {
      // 发起时记下世代号：响应落地时要拿它比对（见 epoch-guard.ts 的根因说明）。
      const epoch = epochGuardRef.current.begin()
      const [snapshotResult, graphResult, archivesResult] = await Promise.all([
        props.fetchSnapshot(partitionKey ?? undefined),
        props.fetchGraph(partitionKey ?? undefined),
        // archives 拉取是可选注入（旧宿主没有该路由）：缺席时给诚实失败，
        // 面板据此隐藏归档卡片 —— 不假装「归档为空」。
        props.fetchArchives
          ? props.fetchArchives(partitionKey ?? undefined)
          : Promise.resolve({ ok: false as const, reason: 'archives-absent' }),
      ])
      if (!mounted.current) return { changed: true, sameRounds: 0 }
      /**
       * **在途过期判定**（v0.19）。
       *
       * 用户切换查看的分区时，上一分区的请求可能还在路上；它落地时
       * 会把画面换成**旧分区**的事实。在一个专门做隔离的插件里，
       * 那是会误导用户对**别的项目**做关闭/恢复决策的缺陷。
       *
       * 与 `partitionMismatch` 不是同一道防线：那个比对「请求的分区 vs
       * 响应自称的分区」（宿主忽略了参数的情况），这个比对「响应是不是
       * 已经过期」（用户已经切走了的情况）—— 两者都旧但**旧得不一样**。
       */
      if (!epochGuardRef.current.isCurrent(epoch)) {
        return { changed: true, sameRounds: 0 }
      }
      if (snapshotResult.ok) {
        setSnapshot(snapshotResult.data)
        setFailure(null)
        // 宿主忽略未知查询参数时会**静默返回当前分区** —— 那会把当前分区的事实
        // 冒充成被查看的分区（本插件最忌讳的假绿）。因此比对 projectKey，
        // 不一致就如实说明，而不是把标签换成请求的分区。
        setPartitionMismatch(
          partitionKey !== null && snapshotResult.data.projectKey !== partitionKey
            ? { requested: partitionKey, actual: snapshotResult.data.projectKey }
            : null,
        )
      } else {
        setFailure(snapshotResult.reason)
      }
      if (graphResult.ok) setGraph(graphResult.data)
      if (archivesResult.ok) setArchives(archiveEntriesOf(archivesResult.data))
      // 降级清单在每次加载后重算：路由恢复时提示必须自动消失（不能只增不减）。
      setDegraded(
        degradedRoutes({
          graph: graphResult,
          archives: archivesResult,
          archivesInjected: props.fetchArchives !== undefined,
        }),
      )

      /**
       * 内容指纹 → 退避状态。
       *
       * 只在**快照成功**时更新基准：失败不是「内容变了」，但必须尽快恢复
       * 正常轮询（返回 changed=true 让下一轮回到 5s），同时保留上一次成功
       * 的指纹作为比较基准 —— 失败后恢复成功、内容与失败前相同，仍然算
       * 「未变」，退避不会因为一次网络抖动被清零。
       *
       * 但**连续失败**要单独计数（`failureCountRef`）：失败时立刻回到 5s
       * 会变成「每 5s 打一次死掉的宿主」—— 观测设施不能变成压力源。
       * 连续失败走 `nextFailureDelay` 的指数退避（5→10→20→40→60s）。
       */
      if (!snapshotResult.ok) {
        sameRoundsRef.current = 0
        failureCountRef.current += 1
        return { changed: true, sameRounds: 0, failed: true }
      }
      // 成功即清零失败计数：恢复后要立刻回到正常节奏，而不是等退避阶梯走完。
      failureCountRef.current = 0
      // 指纹覆盖**两条独立路由**：snapshot + graph。只哈希 snapshot 时，
// 「插件已安装、图谱多了一个节点」会被判成稳定，最长等 15s 才刷新。
      const fingerprint = pollContentFingerprint(
        snapshotResult.data,
        graphResult.ok ? graphResult.data : null,
      )
      const previous = fingerprintRef.current
      const changed = previous === null || previous !== fingerprint
      const sameRounds = changed ? 0 : Math.min(sameRoundsRef.current + 1, 999)
      fingerprintRef.current = fingerprint
      sameRoundsRef.current = sameRounds
      return { changed, sameRounds }
    },
    [props.fetchSnapshot, props.fetchGraph, props.fetchArchives],
  )

  /**
   * 轮询循环 —— `setTimeout` 递归而不是 `setInterval`。
   *
   * 为什么必须换：间隔本身是**上一步的结论**（稳定退避/变化回速），
   * setInterval 的周期在创建时就固定了；用 setInterval 再改周期只能
   * 反复重建定时器，期间的 tick 会同时挂在旧/新两个定时器上（双拉取）。
   *
   * 暂停/卸载的清理是硬要求：一个残留的 timer 会在用户暂停后继续打宿主，
   * 让「暂停即真停」变成假话（面板上画面冻结、后台还在请求）。
   * `cancelled` 是防「卸载后才 resolve 的 load 又 schedule 一个新 timer」
   * 的唯一开关 —— 只 clearTimeout 当前句柄是不够的。
   */
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const afterLoad = (outcome: PollOutcome): void => {
      if (cancelled) return
      /**
       * 延迟的**两条通路**（v0.19）：
       *
       * - 失败 ⇒ 指数退避（5→10→20→40→60s）：宿主挂掉时不打它。
       * - 成功 ⇒ 内容退避（稳定 5→10→15s，变化回 5s）。
       *
       * 失败优先于内容退避：失败时「内容变没变」没有意义 ——
       * 我们根本不知道内容是什么。
       */
      const delay =
        outcome.failed === true
          ? nextFailureDelay(failureCountRef.current)
          : nextPollDelay({
              sameRounds: outcome.sameRounds,
              changed: outcome.changed,
              baseMs: POLL_BASE,
            })
      setPollDelay(delay)
      setStableRounds(outcome.sameRounds)
      if (!polling) return
      timer = setTimeout(() => {
        void run()
      }, delay)
    }

    const run = async (): Promise<void> => {
      const outcome = await load(requestedKey)
      afterLoad(outcome)
    }

    // 首帧总是立刻拉一次（暂停态也拉：画面停在暂停时刻，而不是空白）。
    void run()

    /**
     * 页面可见性（v0.19）：隐藏时**推迟**拉取，恢复可见时**立即补一次**。
     *
     * 为什么不在隐藏时彻底停掉：用户切回标签页的那一刻最想看到新数据，
     * 而停掉意味着要等一个完整周期（最坏 15s）。推迟 + 立即补拉 = 用户
     * 回来即见最新，且隐藏期间不打宿主。
     *
     * 为什么监听挂在 effect 里而不是组件顶层：卸载时必须移除监听，
     * 否则热重载会累积监听器（每次挂载多一个 ⇒ 一次可见性变化触发 N 次拉取）。
     */
    const onVisibilityChange = (): void => {
      if (cancelled) return
      if (!pageVisible()) return
      // 立刻补一次：先把当前定时器清掉，避免补拉后又叠一个。
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      void run()
    }
    const doc = (globalThis as { document?: Document }).document
    doc?.addEventListener?.('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange)
      mounted.current = false
    }
  }, [load, polling, requestedKey])

  // 面板形态按**自身宽度**测量（侧栏里的面板与全屏面板是两种排版）。
  useEffect(() => {
    const measure = (): void => {
      const width = rootRef.current?.getBoundingClientRect().width ?? 0
      if (width > 0) setForm(panelForm(width))
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null
    if (observer && rootRef.current) observer.observe(rootRef.current)
    return () => observer?.disconnect()
  }, [])

  /**
   * 面板动作（v0.12 乐观并发闭环的客户端最后一米）。
   *
   * 为什么要在这里补 `expectedRevision`：宿主已经会核对凭证并回 409，
   * 但面板此前不带凭证 ⇒ 那道门对 GUI 用户永远是空转。面板每 5s 轮询一次，
   * 用户点击时依据的地图最长可能已经陈旧 5 秒，这正是「过期按钮」的窗口。
   *
   * 两个刻意的例外：
   * - **跨分区查看**时不携带：对方的 `revision` 恒 null（只读视图没有可改的
   *   事实），且动作只作用于当前分区 —— 拿对方的凭证去核对必然假冲突。
   * - 快照还没到位时不携带：没有基准就不要假装核对过（宿主会走「未带」分支，
   *   并在响应里如实标记 unchecked）。
   *
   * 409 的处理是**提示 + 重读**，不是静默重试：自动重放等于替用户决定
   * 「世界变了你也照做」，那正是这道门要防的事。
   */
  const runAction = useCallback(
    async (action: PanelAction, payload: Record<string, unknown> = {}): Promise<void> => {
      setBusy(true)
      try {
        const inspectingOther = requestedKey !== null
        const body =
          !inspectingOther && snapshot?.revision
            ? { ...payload, expectedRevision: snapshot.revision }
            : payload
        const result = await props.postAction(action, body)
        if (!result.ok) {
          // conflict 是机器可读判别（不挂 reason 文案 —— 文案会改，分支不能跟着坏）。
          if (result.conflict === 'stale-revision') setConflictNotice(true)
          else {
            setConflictNotice(false)
            setFailure(result.reason)
          }
        } else {
          setConflictNotice(false)
        }
        await load(requestedKey)
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [props.postAction, load, requestedKey, snapshot?.revision],
  )

  /**
   * 切换「正在查看的分区」。
   *
   * 为什么必须走这一个出口：每次切换都要**推进世代号**，让在途的旧分区
   * 响应落地即被丢弃。三处 `setRequestedKey` 若各写各的，早晚会漏一处
   * —— 漏掉的那处就是串扰入口（详见 epoch-guard.ts）。
   */
  const selectPartition = useCallback((key: string | null): void => {
    epochGuardRef.current.advance()
    setRequestedKey(key)
  }, [])

  /** 折叠/展开一张卡片（折叠态持久化到 localStorage）。 */
  const toggleCollapse = useCallback((card: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(card)) next.delete(card)
      else next.add(card)
      saveCollapsed(next)
      return next
    })
  }, [])

  /** 图谱里选中节点 → 能力清单同步高亮（面板级联动：选中态只有一个真相源）。 */
  const onGraphFocus = useCallback((id: string | null) => {
    setSelectedNodeId(id)
  }, [])

  /** 能力清单点行 → 图谱居中选择（同一份选中态的另一端）。 */
  const locateInGraph = useCallback((id: string | null) => {
    setSelectedNodeId(id)
    if (id !== null) setLocateRequest({ id, nonce: Date.now() })
  }, [])

  const currentPartition = snapshot?.partitions.find((partition) => partition.key === snapshot.projectKey)
  const partitionState = useMemo(
    () => (snapshot === null ? null : partitionView(snapshot, requestedKey ?? snapshot.projectKey)),
    [snapshot, requestedKey],
  )
  const graphHeight = form === 'narrow' ? VIEWPORT_HEIGHT_NARROW : VIEWPORT_HEIGHT_WIDE
  const selectedLabel = useMemo(() => {
    if (selectedNodeId === null || graph === null) return null
    return graph.nodes.find((node) => node.id === selectedNodeId)?.label ?? null
  }, [selectedNodeId, graph])

  const unavailable = failure !== null && snapshot === null
  const loading = snapshot === null
  // 暂停轮询后的「数据陈旧度」：面板停了，但用户要知道画面停在多早。
  // 用 tick 每分钟重算一次（暂停时才渲染这条，运行时 footer 显示轮询状态）。
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (polling) return
    const timer = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [polling])
  const staleMinutes = useMemo(() => {
    if (polling || snapshot === null) return 0
    return Math.max(0, Math.round((nowTick - Date.parse(snapshot.at)) / 60_000))
  }, [polling, snapshot, nowTick])

  return (
    <section className="rg-panel" data-form={form} data-recency-guard-panel="" ref={rootRef} aria-busy={loading || busy}>
      <header className="rg-header">
        <div className="rg-header-main">
          <h1 className="rg-title">{t('panel.title')}</h1>
          <p className="rg-subtitle">
            {t('panel.subtitle')}
            {snapshot !== null && (
              <>
                {' · '}
                <span className="rg-mono">{snapshot.profile}</span>
                {' · '}
                <span className="rg-project-name" title={currentPartition?.workspace ?? snapshot.projectKey}>
                  {currentPartition?.label ?? snapshot.projectKey.slice(0, 8)}
                </span>
              </>
            )}
          </p>
          {/* 隔离归因：哈希键不可读，路径才是可归因的事实（悬停 title 兜底长路径）。 */}
          {currentPartition && (
            <p className="rg-subtitle rg-partition-workspace-full" title={currentPartition.workspace}>
              {shortenPath(currentPartition.workspace, 72)}
            </p>
          )}
        </div>
        <div className="rg-actions">
          {/* 轮询间隔放在**操作区**而不是只放页脚：页脚在所有卡片/图谱之后，
              要滚过 16 张卡才看得到 —— 用户调「暂停/刷新」时的上下文在这里。 */}
          {polling && (
            <span className="rg-poll-chip" role="status" title={t('panel.pollingHint')}>
              {t('panel.pollingOn', { seconds: Math.max(1, Math.round(pollDelay / 1000)) })}
              {stableRounds > 0 && pollDelay > POLL_BASE && <> · {t('panel.pollingBackoff')}</>}
            </span>
          )}
          <button
            type="button"
            className={`rg-button${polling ? '' : ' rg-button-paused'}`}
            onClick={() => setPolling((current) => !current)}
            aria-pressed={polling}
          >
            {polling ? t('panel.pausePolling') : t('panel.resumePolling')}
          </button>
          <button type="button" className="rg-button" onClick={() => void load(requestedKey)} disabled={busy}>
            {t('panel.refresh')}
          </button>
          <button type="button" className="rg-button" onClick={() => void runAction('recover')} disabled={busy}>
            {t('panel.recover')}
          </button>
          {/* v0.11：restore 补齐面板动作面 —— 工具早有此动作，路由此前缺失。 */}
          <button type="button" className="rg-button" onClick={() => void runAction('restore')} disabled={busy}>
            {t('panel.restore')}
          </button>
          <button
            type="button"
            className="rg-button rg-button-danger"
            onClick={() => {
              if (typeof window !== 'undefined' && !window.confirm(t('panel.archiveConfirm'))) return
              void runAction('archive', { reason: t('panel.archiveDefaultReason') })
            }}
            disabled={busy}
          >
            {t('panel.archive')}
          </button>
        </div>
      </header>

      {/* 分区提示：切换查看 ≠ 切换数据面。宿主不支持时必须说出来。 */}
      {conflictNotice && (
        <p className="rg-notice" role="status">
          {t('panel.conflictNotice')}{' '}
          <button type="button" className="rg-link" onClick={() => setConflictNotice(false)}>
            {t('panel.conflictDismiss')}
          </button>
        </p>
      )}
      {partitionMismatch !== null && (
        <p className="rg-notice" role="status">
          {t('partitions.mismatch', {
            requested: partitionMismatch.requested.slice(0, 8),
            actual: partitionMismatch.actual.slice(0, 8),
          })}{' '}
          <button type="button" className="rg-link" onClick={() => selectPartition(null)}>
            {t('partitions.backToCurrent')}
          </button>
        </p>
      )}
      {partitionState !== null && partitionState.inspectingOther && partitionMismatch === null && (
        <p className="rg-notice" role="status">
          {t('partitions.inspectingNotice', { label: partitionState.selected?.label ?? '' })}{' '}
          <button type="button" className="rg-link" onClick={() => selectPartition(null)}>
            {t('partitions.backToCurrent')}
          </button>
        </p>
      )}

      {unavailable ? (
        <div className="rg-state-block" role="status">
          <h2 className="rg-state-title">{t('panel.unavailable')}</h2>
          <p className="rg-empty">{t('panel.unavailableHint')}</p>
          <p className="rg-error" role="alert">
            {failure}
          </p>
        </div>
      ) : loading ? (
        <div className="rg-state-block" role="status">
          <p className="rg-empty">{t('panel.loading')}</p>
        </div>
      ) : (
        <PanelErrorBoundary onRetry={() => void load(requestedKey)}>
        <>
          <KpiStrip snapshot={snapshot} />

          {/* 降级如实说明：路由不可得 ≠ 读数为零。放在 KPI 之后、卡片之前，
              因为它解释的是「下面哪些块不完整」。 */}
          {degraded.length > 0 && (
            <p className="rg-notice rg-notice-degraded" role="status">
              {degraded
                .map((route) =>
                  route.key === 'graph'
                    ? t(graph === null ? 'panel.degradedGraph' : 'panel.degradedGraphStale', { reason: route.reason })
                    : t(archives === null ? 'panel.degradedArchives' : 'panel.degradedArchivesStale', {
                        reason: route.reason,
                      }),
                )
                .join(' · ')}
            </p>
          )}

          <div className="rg-grid">
            <h2 className="rg-group-title">{t('groups.overview')}</h2>
            <Card
              id="lifecycle"
              title={t('sections.state')}
              hint={snapshot.stageLabel}
              collapsed={collapsed.has('lifecycle')}
              onToggle={() => toggleCollapse('lifecycle')}
            >
              <LifecycleBody snapshot={snapshot} />
            </Card>
            <Card
              id="metrics"
              title={t('sections.metrics')}
              collapsed={collapsed.has('metrics')}
              onToggle={() => toggleCollapse('metrics')}
            >
              <MetricsBody snapshot={snapshot} />
            </Card>
            <Card
              id="backup-policy"
              title={t('sections.backupPolicy')}
              hint={snapshot.backupPolicy.versionedBackups ? t('backupPolicy.on') : t('backupPolicy.off')}
              collapsed={collapsed.has('backup-policy')}
              onToggle={() => toggleCollapse('backup-policy')}
            >
              <BackupPolicyBody snapshot={snapshot} />
            </Card>
            <h2 className="rg-group-title">{t('groups.decisions')}</h2>
            <Card
              id="decisions"
              title={t('sections.decisions')}
              hint={t('decisions.count', { count: snapshot.autoDisabled.length })}
              collapsed={collapsed.has('decisions')}
              onToggle={() => toggleCollapse('decisions')}
            >
              <DecisionsBody snapshot={snapshot} />
            </Card>
            <Card
              id="decision-evidence"
              title={t('sections.decisionEvidence')}
              hint={
                snapshot.decisionSuspects == null
                  ? t('metrics.undefined')
                  : t('decisionEvidence.count', { count: snapshot.decisionSuspects.length })
              }
              collapsed={collapsed.has('decision-evidence')}
              onToggle={() => toggleCollapse('decision-evidence')}
            >
              <DecisionEvidenceBody snapshot={snapshot} />
            </Card>
            {/* v0.14 M1：误伤校准（07 §3.3 要求面板显示「本轮为何提高阈值」）。 */}
            <Card
              id="calibration"
              title={t('sections.calibration')}
              hint={
                snapshot.calibration == null
                  ? t('metrics.undefined')
                  : t('calibration.threshold') + ` ${snapshot.calibration.decision.required}`
              }
              collapsed={collapsed.has('calibration')}
              onToggle={() => toggleCollapse('calibration')}
            >
              <CalibrationBody snapshot={snapshot} />
            </Card>
            {/* v0.14 M2：贝叶斯并行读数（07 §2.3 要求两套并列，不替换默认）。 */}
            <Card
              id="bayes"
              title={t('sections.bayes')}
              hint={snapshot.bayes == null ? t('metrics.undefined') : t('bayes.score') + ` ${snapshot.bayes.length}`}
              collapsed={collapsed.has('bayes')}
              onToggle={() => toggleCollapse('bayes')}
            >
              <BayesBody snapshot={snapshot} />
            </Card>
            <Card
              id="cooccurrence"
              title={t('sections.cooccurrence')}
              hint={
                snapshot.cooccurrence == null
                  ? t('metrics.undefined')
                  : t('cooccurrence.count', { count: snapshot.cooccurrence.samples })
              }
              collapsed={collapsed.has('cooccurrence')}
              onToggle={() => toggleCollapse('cooccurrence')}
            >
              <CooccurrenceBody snapshot={snapshot} />
            </Card>
            <h2 className="rg-group-title">{t('groups.capabilities')}</h2>
            <Card
              id="capabilities"
              title={t('sections.capabilities')}
              hint={
                snapshot.capability == null
                  ? t('metrics.undefined')
                  : t('capabilities.hintCount', { count: snapshot.capability.total })
              }
              collapsed={collapsed.has('capabilities')}
              onToggle={() => toggleCollapse('capabilities')}
            >
              <CapabilityBody
                snapshot={snapshot}
                graph={graph}
                selectedId={selectedNodeId}
                onSelect={locateInGraph}
              />
            </Card>
            <h2 className="rg-group-title">{t('groups.observation')}</h2>
            <Card
              id="preventive"
              title={t('sections.preventive')}
              hint={t('preventive.hint')}
              collapsed={collapsed.has('preventive')}
              onToggle={() => toggleCollapse('preventive')}
            >
              <PreventiveBody snapshot={snapshot} />
            </Card>
            <Card
              id="risks"
              title={t('sections.risks')}
              hint={t('risks.count', { count: snapshot.risks.length })}
              collapsed={collapsed.has('risks')}
              onToggle={() => toggleCollapse('risks')}
            >
              <RisksBody snapshot={snapshot} onReenable={(bundle) => void runAction('reenable', { bundle })} />
            </Card>
            <Card
              id="partitions"
              title={t('sections.partitions')}
              hint={t('partitions.count', { count: snapshot.partitions.length })}
              collapsed={collapsed.has('partitions')}
              onToggle={() => toggleCollapse('partitions')}
            >
              <PartitionsBody
                snapshot={snapshot}
                selectedKey={requestedKey ?? snapshot.projectKey}
                onSelect={(key) => selectPartition(key === snapshot.projectKey ? null : key)}
              />
            </Card>
            <Card
              id="events"
              title={t('events.title')}
              hint={t('events.count', { count: snapshot.recentEvents.length })}
              collapsed={collapsed.has('events')}
              onToggle={() => toggleCollapse('events')}
            >
              <EventsBody events={snapshot.recentEvents} />
            </Card>
            <Card
              id="markov"
              title={t('sections.markov')}
              hint={t('markov.hint')}
              collapsed={collapsed.has('markov')}
              onToggle={() => toggleCollapse('markov')}
            >
              <MarkovBody snapshot={snapshot} />
            </Card>
            <Card
              id="dataflow"
              title={t('sections.dataflow')}
              hint={t('dataflow.hint')}
              collapsed={collapsed.has('dataflow')}
              onToggle={() => toggleCollapse('dataflow')}
            >
              <DataFlowBody snapshot={snapshot} />
            </Card>
            <h2 className="rg-group-title">{t('groups.diagnostics')}</h2>
            <Card
              id="diagnostics"
              title={t('sections.diagnostics')}
              hint={t('diagnostics.hint')}
              collapsed={collapsed.has('diagnostics')}
              onToggle={() => toggleCollapse('diagnostics')}
            >
              <DiagnosticsBody snapshot={snapshot} />
            </Card>
          </div>

          <section className="rg-section" aria-label={t('sections.graph')}>
            <div className="rg-section-head">
              <h2 className="rg-section-title">{t('sections.graph')}</h2>
              {selectedLabel !== null && (
                <span className="rg-selection-chip">
                  {t('graph.selected')}: <strong>{selectedLabel}</strong>
                  <button type="button" className="rg-link" onClick={() => setSelectedNodeId(null)}>
                    {t('graph.clearSelection')}
                  </button>
                </span>
              )}
            </div>
            {graph === null ? (
              <p className="rg-empty">{t('graph.unavailable')}</p>
            ) : (
              <>
                <GraphStructureBar graph={graph} onLocate={locateInGraph} />
                <GuardGraph
                  graph={graph}
                  height={graphHeight}
                  focusId={selectedNodeId}
                  onFocusChange={onGraphFocus}
                  locateRequest={locateRequest}
                />
              </>
            )}
          </section>

          {archives !== null && (
            <ArchivesCard
              archives={archives}
              reason={t('panel.archiveDefaultReason')}
              onArchive={(reason) =>
                void runAction('archive', { reason: reason.trim() === '' ? t('panel.archiveDefaultReason') : reason.trim() })
              }
              busy={busy}
            />
          )}

          {failure !== null && (
            <p className="rg-error" role="alert">
              {failure}
            </p>
          )}

          <footer className="rg-foot">
            <span>{t('panel.snapshotAt', { time: snapshot.at.replace('T', ' ').slice(0, 19) })}</span>
            <span>
              {polling
                ? t('panel.pollingOn', { seconds: Math.max(1, Math.round(pollDelay / 1000)) })
                : t('panel.stale', { minutes: staleMinutes })}
              {/* 退避必须说出来：用户看到刷新变慢时，需要知道是「数据稳定」
                  而不是「面板卡住了」。只在真的放慢时追加，不制造噪声。 */}
              {polling && stableRounds > 0 && pollDelay > POLL_BASE && (
                <> · {t('panel.pollingBackoff')}</>
              )}
            </span>
          </footer>
        </>
        </PanelErrorBoundary>
      )}
    </section>
  )
}
