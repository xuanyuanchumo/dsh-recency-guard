import { isOfficialExperimental, type BundleLike } from '../risk/recency.js'
import type { JournalEvent, Store } from '../data/store.js'

/**
 * 官方实验性插件观测（v0.8.1）—— 独立模块。
 *
 * ## 为什么从 index.ts 拆出来
 *
 * 复杂度预算（Q7）：观测循环、事件监听器与守护主流程挤在 index.ts 里，
 * 复杂度到 134（预算 100）。观测通道是**纯记录**的旁路 —— 与崩溃决策、
 * 守护行、恢复流程没有控制依赖，拆出去后 index.ts 只剩一行调用，
 * 本模块可独立测试（不依赖 ctx/pluginManager 的桩）。
 *
 * ## 设计取舍（用户需求：「获取备份 DSH 的官方实验性插件的信息与状态」）
 *
 * - **不进嫌疑面**：它们是官方包，自动关闭官方组件的风险远大于收益
 *   （`isOfficialExperimental` 判据保证普通实验插件仍进嫌疑面）；
 * - **但全量记录**：清单（名称/版本/启用态）diff 后追加 journal
 *   （kind: 'official-observe'），整组状态落时间线备份 ——
 *   实验插件崩溃时「当时装了哪些实验组件、什么版本、什么状态」就是归因输入；
 * - **diff 后只记变更**：每次启动全量记会污染 journal（1000 行封顶
 *   很快被冲掉）；只有集合/版本/启用态变化时才记。
 *
 * 纯函数 + 注入 store：diff 判定与事件构造无 IO，可直接单测。
 */

/** 官方实验插件的一个观测点。 */
export interface OfficialExperimentalEntry {
  bundle: string
  version?: string
  enabled: boolean
}

/** 从宿主 bundle 清单里筛出官方实验插件。O(b)。 */
export function pickOfficialExperimental(bundles: readonly BundleLike[]): Map<string, OfficialExperimentalEntry> {
  const out = new Map<string, OfficialExperimentalEntry>()
  for (const b of bundles) {
    if (!isOfficialExperimental(b.name)) continue
    out.set(b.name, { bundle: b.name, version: b.version, enabled: b.enabled !== false })
  }
  return out
}

/**
 * diff 判定：与上次观测相比是否发生变化。
 *
 * 比较维度：集合大小、每个成员的版本与启用态。O(b)。
 */
export function observationChanged(
  prev: ReadonlyMap<string, { version?: string; enabled: boolean }>,
  current: ReadonlyMap<string, { version?: string; enabled: boolean }>,
): boolean {
  if (prev.size !== current.size) return true
  for (const [name, info] of current) {
    const before = prev.get(name)
    if (before === undefined) return true
    if (before.version !== info.version || before.enabled !== info.enabled) return true
  }
  return false
}

/** 由当前观测构造 journal 事件（每个组件一条，便于按插件归因）。 */
export function observationEvents(current: ReadonlyMap<string, OfficialExperimentalEntry>): JournalEvent[] {
  return [...current.values()].map((info) => ({
    kind: 'official-observe' as const,
    bundle: info.bundle,
    version: info.version,
    detail: info.enabled ? 'enabled' : 'disabled',
  }))
}

/**
 * 观测主入口：diff → journal → 观测快照 → 整组状态时间线备份。
 *
 * 全程 best-effort：任何一步失败都不抛 —— 观测通道失效不能影响
 * 变更记录（崩溃归因主证据）与恢复主流程。调用方（index.ts）的
 * try/catch 是第二道保险，这里是第一道。
 *
 * 复杂度 O(b)（b = 官方实验插件数，通常 < 20），只在启动与
 * plugin-manager/changed 事件后调用。
 */
export async function observeOfficialExperimental(
  bundles: readonly BundleLike[],
  store: Store,
  options: { versionedBackups: boolean; backupRetain: number },
  log?: (message: string) => void,
): Promise<{ changed: boolean; count: number }> {
  const current = pickOfficialExperimental(bundles)
  const prev = await store.readObservationSnapshot('official-experimental')
  if (!observationChanged(prev, current)) return { changed: false, count: current.size }

  try {
    await store.append(observationEvents(current))
    await store.writeObservationSnapshot('official-experimental', current)
  } catch (err) {
    log?.(`[recency-guard] 官方实验插件观测写入失败：${err instanceof Error ? err.message : String(err)}`)
    return { changed: true, count: current.size }
  }

  if (options.versionedBackups) {
    try {
      const stateSnapshot = [...current.values()]
      await store.writeVersionedBackup(
        '@official-experimental/state',
        `set-${stateSnapshot.length}`,
        stateSnapshot,
        { retain: options.backupRetain },
      )
    } catch (err) {
      log?.(`[recency-guard] 写官方实验插件状态备份失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { changed: true, count: current.size }
}
