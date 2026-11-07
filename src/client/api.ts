import type { PanelSnapshot } from '../../src/snapshot.ts'
import type { GraphData } from '../../src/graph-data.ts'

/**
 * 面板的宿主数据面客户端。
 *
 * 两条诚实边界
 * ------------
 * 1. **拉不到就是拉不到**：失败返回 `null` 并附上原因，**不返回空快照**。
 *    一个「全零的空面板」和「真的没有数据」在界面上无法区分 —— 那正是
 *    观测性最忌讳的假绿。
 * 2. **形状校验**：响应必须是对象且带 `at` 字段，否则视为不可用。
 *    路由返回 `{available:false, reason}` 时如实展示 reason。
 */

/** 路由前缀（与宿主侧一致）。 */
export const API_PREFIX = '/recency-guard/api'

/** 拉取失败的结果。 */
export interface FetchFailure {
  ok: false
  reason: string
}

/** 拉取成功的结果。 */
export interface FetchSuccess<T> {
  ok: true
  data: T
}

/** 拉取结果。 */
export type FetchResult<T> = FetchSuccess<T> | FetchFailure

/**
 * 是否是一个可用的快照。
 *
 * 导出供契约测试使用：形状校验是「面板不把错误数据当数据渲染」的唯一屏障，
 * 必须能被独立验证。
 */
export function isSnapshot(value: unknown): value is PanelSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.at === 'string' && typeof record.stage === 'string'
}

/** 是否是一个可用的图谱（导出供契约测试使用）。 */
export function isGraph(value: unknown): value is GraphData {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.nodes) && Array.isArray(record.edges)
}

/**
 * 拉取 JSON 并校验形状。
 *
 * 用 `fetch` + 显式检查 `res.ok`：一个 404 或 500 返回的 HTML 页面
 * 在 `res.json()` 时才报错，错误信息不指向真实原因。
 */
async function fetchJson(url: string, init?: RequestInit): Promise<FetchResult<unknown>> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    })
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` }
    }
    const payload: unknown = await response.json()
    // 宿主在拿不到数据时返回 `{available:false, reason}`。
    if (typeof payload === 'object' && payload !== null && (payload as { available?: unknown }).available === false) {
      const reason = (payload as { reason?: unknown }).reason
      return { ok: false, reason: typeof reason === 'string' ? reason : '宿主报告数据面不可用' }
    }
    return { ok: true, data: payload }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 拼装查询串。
 *
 * 为什么把分区键放在查询参数而不是路径段：路由路径必须是宿主 `routes.ts`
 * 里的**字面量**（契约测试核对），路径段会破坏这条核对；查询参数在
 * 不改变路由契约的前提下携带「请求哪个分区」。宿主若忽略未知参数，
 * 调用方必须核对返回的 `projectKey`（见 GuardPanel 的 mismatch 提示）——
 * 静默返回当前分区是最危险的假绿。
 */
function withPartition(url: string, partition?: string): string {
  if (partition === undefined || partition === '') return url
  return `${url}?partition=${encodeURIComponent(partition)}`
}

/** 拉取面板快照（可指定分区；宿主不支持时返回当前分区，由调用方核对）。 */
export async function fetchSnapshot(partition?: string): Promise<FetchResult<PanelSnapshot>> {
  const result = await fetchJson(withPartition(`${API_PREFIX}/snapshot`, partition))
  if (!result.ok) return result
  if (!isSnapshot(result.data)) return { ok: false, reason: '快照形状不合法' }
  return { ok: true, data: result.data }
}

/** 拉取图谱数据（可指定分区）。 */
export async function fetchGraph(partition?: string): Promise<FetchResult<GraphData>> {
  const result = await fetchJson(withPartition(`${API_PREFIX}/graph`, partition))
  if (!result.ok) return result
  if (!isGraph(result.data)) return { ok: false, reason: '图谱形状不合法' }
  return { ok: true, data: result.data }
}

/** 拉取历史归档清单（可指定分区）。 */
export async function fetchArchives(partition?: string): Promise<FetchResult<unknown>> {
  return fetchJson(withPartition(`${API_PREFIX}/archives`, partition))
}

/** 面板动作（v0.11：restore 补齐 —— 工具面早有，动作路由此前缺失）。 */
export type PanelAction = 'archive' | 'reenable' | 'recover' | 'restore'

/** 触发一个宿主动作。 */
export async function postAction(
  action: PanelAction,
  payload: Record<string, unknown> = {},
): Promise<FetchResult<unknown>> {
  return fetchJson(`${API_PREFIX}/action/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
