/**
 * 恢复动作 —— 把被自动关闭的插件重新启用（v0.12.1 从 index.ts 抽出）。
 *
 * ## 为什么单独成模块
 *
 * 这段代码是「三条不变式 + 一个白盒修复」的集合，分支密集（restore 19 个、
 * reenable 11 个），留在 `Guard` 里把 index.ts 的复杂度热点推过预算
 * （复杂度按**文件**计分，在类之间搬方法没有意义，必须移出文件）。
 * 但它与「守护编排」确实不是一回事：这里只关心**怎么诚实地恢复**，
 * 不关心什么时候该恢复（那是 boot 的判断）。
 *
 * ## 三条必须保持的不变式
 *
 * 1. **首要嫌疑不恢复**：最近被关闭的那个是头号嫌疑，保持关闭直到人确认。
 * 2. **恢复结果必须如实**（v0.11.2 白盒修复）：只有插件管理器真的返回
 *    `application: 'applied'` 才算成功。此前无条件从 autoDisabled 里删掉，
 *    实测管理器在 HMR 嵌套事务下返回 `failed` 时，state 仍记「已恢复」
 *    —— 面板/工具显示成功而插件实际关着，假绿比失败更糟。
 *    失败者**留在名单**里，下轮启动重试。
 * 3. **恢复对象以决策文件为准，不重算排名**：排名会随插件安装而变化，
 *    重算可能把**另一个**插件排到头号，从而把真正的嫌疑重新放回来。
 */

import type { Store } from './store.js'
import { describeError } from './recency.js'

/** 恢复动作依赖的宿主与守护能力（窄接口：测试不必构造整个 Guard）。 */
export interface RecoveryDeps {
  store: Pick<Store, 'readState' | 'updateState' | 'append' | 'readBackup'>
  /** 插件管理器的最小面。 */
  pluginManager: {
    setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
    setPluginEnabled(entryId: string, enabled: boolean): Promise<unknown>
  }
  /** 找出某个 bundle 对应的插件行（用于逐行启用）。 */
  suspectRows: (entries: Array<{ bundle: string; lastChangeAt: string; lastKind: 'install' }>) => Promise<
    Array<{ entryId: string; moduleName: string }>
  >
  /** 发布预启动决策（守护行据此拦截）。 */
  publishDecision: (
    suspects: Array<{ bundle: string; lastChangeAt: string; lastKind: 'install' }>,
    disable: string[],
    reason: 'none' | 'crash-recovery',
  ) => Promise<void>
  /** 状态机迁移（白盒透明）。 */
  transition: (stage: 'stabilizing' | 'recovered', reason: string) => void
  /** 日志出口。 */
  warn: (message: string) => void
  /** JSON 安全化（journal 只存可序列化事实）。 */
  toJson: (value: unknown) => unknown
}

/** `restore` 的返回形状（工具与面板都消费它）。 */
export interface RestoreResult {
  reenabled: string[]
  keptDisabled: string[]
  note: string
}

/**
 * 恢复除首要嫌疑外的全部自动关闭插件。
 *
 * 判定顺序固定：空名单 → 逐个（头号保留、其余尝试启用）→ 落盘状态 →
 * 发布新决策。每一步都先判再写，避免"写了一半"的状态。
 */
export async function restoreDisabledExceptPrime(deps: RecoveryDeps): Promise<RestoreResult> {
  const state = await deps.store.readState()
  const auto = state.autoDisabled
  deps.transition('stabilizing', '崩溃后成功启动，准备恢复配置')
  if (auto.length === 0) {
    await deps.publishDecision([], [], 'none')
    return { reenabled: [], keptDisabled: [], note: '没有自动关闭记录。' }
  }

  const disabled = new Set(auto.map((d) => d.name))
  const reenabled: string[] = []
  const keptDisabled: string[] = []
  const failed: string[] = []

  for (const d of auto) {
    // 最近被关闭的那个是头号嫌疑：保持关闭直到人确认（不变式 1）。
    if (d.name === auto[auto.length - 1]?.name) {
      keptDisabled.push(d.name)
      continue
    }
    const result = (await reenableOne(deps, d.name)) as { reenabled?: boolean }
    if (result?.reenabled === true) reenabled.push(d.name)
    else failed.push(d.name)
  }

  await deps.store.updateState((s) => ({
    ...s,
    // 失败者留在 autoDisabled（下轮启动重试）；成功者与首要嫌疑移出。
    autoDisabled: s.autoDisabled.filter((d) => keptDisabled.includes(d.name) || failed.includes(d.name)),
    stabilized: true,
    restored: [...s.restored, ...reenabled],
  }))
  deps.transition('recovered', `已恢复 ${reenabled.length} 个插件`)
  await deps.store.append({
    kind: 'restore',
    detail: `重新启用 ${reenabled.join(', ') || '无'}${failed.length > 0 ? `；未启用（管理器拒绝，保留待重试） ${failed.join(', ')}` : ''}`,
  })
  await deps.publishDecision(
    [...disabled].map((bundle) => ({ bundle, lastChangeAt: '', lastKind: 'install' as const })),
    [...keptDisabled, ...failed],
    keptDisabled.length || failed.length ? 'crash-recovery' : 'none',
  )
  const kept = [...keptDisabled, ...failed]
  return {
    reenabled,
    keptDisabled: kept,
    note:
      keptDisabled.length || failed.length
        ? `已恢复 ${reenabled.length} 个配置；${keptDisabled.length > 0 ? `仅保留嫌疑插件 ${keptDisabled.join(', ')} 关闭` : ''}${
            failed.length > 0
              ? `${keptDisabled.length > 0 ? '；' : ''}${failed.join(', ')} 管理器拒绝恢复，已留在名单待下轮重试`
              : ''
          }。确认安全后可用 reenable 手动开启。`
        : '已恢复全部配置。',
  }
}

/**
 * 重新启用单个插件（含组合包与它的每个插件行），并**如实**报告是否成功。
 *
 * 两条纪律见模块头（不变式 2）：只有 `application: 'applied'` 才算成功；
 * 失败者留在名单里等下一轮。
 */
export async function reenableOne(deps: RecoveryDeps, bundle: string): Promise<unknown> {
  const rows = await deps.suspectRows([{ bundle, lastChangeAt: '', lastKind: 'install' }])
  const results: unknown[] = []
  try {
    results.push(await deps.pluginManager.setBundleEnabled(bundle, true))
  } catch (err) {
    deps.warn(`[recency-guard] 启用组合包 ${bundle} 失败：${describeError(err)}`)
  }
  for (const row of rows) {
    try {
      results.push(await deps.pluginManager.setPluginEnabled(row.entryId, true))
    } catch (err) {
      deps.warn(`[recency-guard] 启用插件 ${row.moduleName} 失败：${describeError(err)}`)
    }
  }
  await deps.store.append({ kind: 'enable', bundle, result: deps.toJson(results) as never })
  const applied = results.some(
    (r) => typeof r === 'object' && r !== null && (r as { application?: unknown }).application === 'applied',
  )
  if (applied) {
    await deps.store.updateState((s) => ({
      ...s,
      autoDisabled: s.autoDisabled.filter((d) => d.name !== bundle),
    }))
  } else {
    deps.warn(`[recency-guard] ${bundle} 未能恢复（管理器未 applied），保留在自动关闭名单待下轮重试`)
  }
  const backup = await deps.store.readBackup(bundle)
  return { bundle, reenabled: applied, hasConfigBackup: backup !== null }
}
