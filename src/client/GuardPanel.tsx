import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from './i18n.ts'
import type { FetchResult, PanelAction } from './api.ts'
import { GuardGraph } from './GuardGraph.tsx'
import {
  ArchivesCard,
  BackupPolicyBody,
  CapabilityBody,
  Card,
  DecisionsBody,
  EventsBody,
  KpiStrip,
  LifecycleBody,
  MetricsBody,
  PartitionsBody,
  RisksBody,
  archiveEntriesOf,
  type ArchiveEntry,
} from './PanelCards.tsx'
import { DataFlowBody, DiagnosticsBody, MarkovBody } from './InsightCards.tsx'
import { panelForm, partitionView, shortenPath, type PanelForm } from './panel-model.ts'
import { VIEWPORT_HEIGHT_NARROW, VIEWPORT_HEIGHT_WIDE } from './graph-model.ts'
import type { PanelSnapshot } from '../../src/snapshot.ts'
import type { GraphData } from '../../src/graph-data.ts'

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
  fetchSnapshot: (partition?: string) => Promise<FetchResult<PanelSnapshot>>
  fetchGraph: (partition?: string) => Promise<FetchResult<GraphData>>
  /** 拉取历史归档（缺席即不显示归档卡片 —— 组件保持独立可用）。 */
  fetchArchives?: (partition?: string) => Promise<FetchResult<unknown>>
  postAction: (action: PanelAction, payload?: Record<string, unknown>) => Promise<FetchResult<unknown>>
}

/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL = 5000

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
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [archives, setArchives] = useState<ArchiveEntry[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [polling, setPolling] = useState(true)
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
  const rootRef = useRef<HTMLElement | null>(null)
  const mounted = useRef(true)

  const load = useCallback(
    async (partitionKey: string | null): Promise<void> => {
      const [snapshotResult, graphResult, archivesResult] = await Promise.all([
        props.fetchSnapshot(partitionKey ?? undefined),
        props.fetchGraph(partitionKey ?? undefined),
        // archives 拉取是可选注入（旧宿主没有该路由）：缺席时给诚实失败，
        // 面板据此隐藏归档卡片 —— 不假装「归档为空」。
        props.fetchArchives
          ? props.fetchArchives(partitionKey ?? undefined)
          : Promise.resolve({ ok: false as const, reason: 'archives-absent' }),
      ])
      if (!mounted.current) return
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
    },
    [props.fetchSnapshot, props.fetchGraph, props.fetchArchives],
  )

  useEffect(() => {
    mounted.current = true
    void load(requestedKey)
    // 轮询可暂停：调试或截图时暂停轮询，画面不再跳动（数据时间停在暂停时刻）。
    if (!polling) {
      return () => {
        mounted.current = false
      }
    }
    const timer = setInterval(() => void load(requestedKey), POLL_INTERVAL)
    return () => {
      mounted.current = false
      clearInterval(timer)
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

  const runAction = useCallback(
    async (action: PanelAction, payload: Record<string, unknown> = {}): Promise<void> => {
      setBusy(true)
      try {
        const result = await props.postAction(action, payload)
        if (!result.ok) setFailure(result.reason)
        await load(requestedKey)
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [props.postAction, load, requestedKey],
  )

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
      {partitionMismatch !== null && (
        <p className="rg-notice" role="status">
          {t('partitions.mismatch', {
            requested: partitionMismatch.requested.slice(0, 8),
            actual: partitionMismatch.actual.slice(0, 8),
          })}{' '}
          <button type="button" className="rg-link" onClick={() => setRequestedKey(null)}>
            {t('partitions.backToCurrent')}
          </button>
        </p>
      )}
      {partitionState !== null && partitionState.inspectingOther && partitionMismatch === null && (
        <p className="rg-notice" role="status">
          {t('partitions.inspectingNotice', { label: partitionState.selected?.label ?? '' })}{' '}
          <button type="button" className="rg-link" onClick={() => setRequestedKey(null)}>
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
        <>
          <KpiStrip snapshot={snapshot} />

          <div className="rg-grid">
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
              id="capabilities"
              title={t('sections.capabilities')}
              hint={t('capabilities.hintCount', { count: snapshot.capability.total })}
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
                onSelect={(key) => setRequestedKey(key === snapshot.projectKey ? null : key)}
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
              <GuardGraph
                graph={graph}
                height={graphHeight}
                focusId={selectedNodeId}
                onFocusChange={onGraphFocus}
                locateRequest={locateRequest}
              />
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
            <span>{polling ? t('panel.pollingOn', { seconds: POLL_INTERVAL / 1000 }) : t('panel.pollingPaused')}</span>
          </footer>
        </>
      )}
    </section>
  )
}
