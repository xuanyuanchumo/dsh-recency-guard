import type { ConflictFinding } from './conflict-metadata.ts'
import { errorFindings, findingActive } from './conflict-metadata.ts'

/**
 * 贪心最小隔离集 + 依赖联动停用 + 候选排序（T14-04/05）。
 *
 * ## 为什么要贪心而不是「一次算完」
 *
 * finding 是**耦合**的：关掉 A 之后，B 的 `declared-conflict` 可能不再成立
 * （对手不在了），而 C 的 `missing-dependency` 反而从 warning 变成 error
 * （它需要的包刚被我们关掉）。一次性挑一批再验证会得到「关了 3 个，还剩 2 条
 * error」的半成品 —— 用户看到的是「隔离了但没治好」。
 *
 * 贪心循环把每一步都建立在**上一轮的真实残局**上：
 * 取一个候选 → 标记停用（含依赖联动）→ 用新的在场集合重算 error finding
 * → 再取。终止条件是「error 清零」或「没有可动的候选」。后者剩下的
 * finding 就是 `unresolved`，**必须上屏**：它代表「守护受保护组件/官方插件
 * 约束，治不了这条」—— 静默吞掉会让用户以为已经修好。
 *
 * ## 复杂度
 *
 * 每轮 O(P·F)（重算 finding），最多 P 轮（每轮至少停用一个）
 * ⇒ O(P²·F)。P 是第三方插件数（几十），F 是 finding 数，量级可忽略。
 * 轮数硬上界 `plugins.length + 1` 是**终止性保证**：环状依赖不会让它多跑，
 * 只会让同一轮联动停用一个环（见 `dependentsClosure`）。
 *
 * ## 与 compat-guardian 的差别
 *
 * 参考实现 `checkCompatibility` 的循环体是「错误 → 候选 → 关一个」，与我们
 * 同形；我们多两件事：**依赖联动**（关 A 时把它依赖者一起关，否则关掉 A 只会
 * 让 B 加载失败）与**排序 fallback**（无任何声明时保持纯 recency 顺序，
 * 保证旧行为逐位不变）。
 */

/** 隔离计划的一个输入候选。 */
export interface CandidatePlugin {
  name: string
  /** 磁盘/管理器里的启用态（false = 已经关着）。 */
  enabled: boolean
  /**
   * 本轮之前是否已被自动关闭（= 在 `state.autoDisabled` 里）。
   *
   * 为什么它影响排序：再关一次是**零代价**的（用户已经在这套配置下用过），
   * 而新关一个插件会让用户下次启动少一个功能。所以已停用者优先。
   */
  alreadyDisabled?: boolean
  /** `dshCompat.priority`；undefined = 未声明（不参与优先级比较）。 */
  priority?: number
  /** 该插件是否声明了 `dshCompat`（决定排序是否启用，见 `orderCandidates`）。 */
  declared?: boolean
  /**
   * 永不隔离：官方实验插件（只观测不关闭）、本守护自身、只读行。
   *
   * 这是硬不变式，不是排序偏好 —— 关官方组件等于卸宿主半边，
   * 关守护自身等于拆掉恢复机制。
   */
  protected?: boolean
  /** 在嫌疑列表中的位置（0 基，越小越新/越可疑）。 */
  index: number
  /** 依赖的 bundle 名（来自 requires / package.json dependencies，图边不是字符串改名）。 */
  dependencies?: readonly string[]
}

/** 计划的一步（白盒：关谁、为什么、联动关了谁、还剩几条 error）。 */
export interface QuarantineStep {
  bundle: string
  /** 触发这一步的 finding 分类 + 人读原因。 */
  reason: string
  /** 该步联动停用的依赖者（不含主目标）。 */
  linked: string[]
  /** 该步执行后残余的 error finding 数。 */
  remainingErrors: number
}

/** 计划结果。 */
export interface QuarantinePlan {
  /** 应保持关闭的插件（有序；含依赖联动者）。 */
  quarantine: string[]
  /**
   * 无法清除的残余 error finding。
   *
   * 非空 = 守护「治不了这条」（受保护/官方组件导致，或没有可动候选）。
   * 它是**数据面字段**，必须进 status / 工具输出 / 面板快照，不能静默。
   */
  unresolved: ConflictFinding[]
  steps: QuarantineStep[]
  /** 终止原因（白盒：为什么停了）。 */
  terminatedBy: 'no-error' | 'no-candidate' | 'cap'
}

/** 计划选项。 */
export interface PlanOptions {
  /** 最多停用几个（默认不限；真实守护传 `maxAutoDisable`）。 */
  maxDisable?: number
  /**
   * 轮数预算（默认 `roundBudget(plugins.length)`；测试可注入更小的值）。
   *
   * 为什么不只靠「每轮至少停用 1 个」推终止性：那是一个**不可观测**的上界
   * —— 有限候选被逐个停用后必然落到 `no-candidate`，循环体自己永远走不到
   * 预算耗尽。把它显式成参数后，「预算耗尽」成为一条可断言的分支，
   * 而不是一行没人能触发的死代码（实测：变异体改坏它没有任何测试变红）。
   */
  roundBudget?: number
}

/**
 * 轮数硬上界：候选数 + 1。
 *
 * 为什么 +1：最后一个候选被停用后，循环需要**再走一轮**才能观察到
 * 「error 已清零」，从而返回 `no-error`（而不是误报成预算耗尽）。
 */
export function roundBudget(pluginCount: number): number {
  return pluginCount + 1
}

/**
 * 一次实际恢复运行的产物（`recover()` 返回形状）。
 *
 * `unresolved` 是**数据面字段**，不是日志：它要进 status / 工具输出 / 面板
 * 快照。理由见 `QuarantinePlan.unresolved` 的头注。
 */
export interface RecoveryRun {
  /** 本次实际停用的插件（已落实到位）。 */
  quarantine: string[]
  /** 执行后仍成立的残余 error finding（治不了的那部分）。 */
  unresolved: ConflictFinding[]
  /** 计划步骤（白盒：关谁、为什么、联动关了谁）。 */
  steps: QuarantineStep[]
  /** 终止原因。 */
  terminatedBy: QuarantinePlan['terminatedBy'] | 'executed'
  /** 人读说明（工具输出直接显示）。 */
  note: string
}

/**
 * finding → 决策用的确定性目标（崩溃路径专用，纯函数）。
 *
 * 崩溃路径没有 `await` 的余裕做贪心循环（`recover()` 是异步的），所以那里
 * 只做**一轮**：把 error finding 直接点名的嫌疑插件挑出来当目标。真正的
 * 「取候选 → 标记 → 重算」留给启动后的恢复流程（`recover()`）。
 *
 * 过滤规则（缺一条都会把不该关的关掉）：
 * - 只认 error 级；
 * - 只认**在当前嫌疑名单里**的包（不在嫌疑名单 = 官方/守护自身/未安装）；
 * - 排除受保护者，且**不把受保护者对 findings 的牵连算到别人头上**：
 *   若一条 finding 涉及受保护插件，它仍然成立（会进 unresolved），
 *   但目标只取其中不受保护的那些；一个都取不到 ⇒ 返回空 targets
 *   ⇒ `assessConfidence` 走旧分支（不行动）。
 */
export function deterministicTargets(
  suspects: readonly string[],
  findings: readonly ConflictFinding[],
  options: { protected?: ReadonlySet<string>; maxTargets?: number } = {},
): string[] {
  const suspectSet = new Set(suspects)
  const protectedSet = options.protected ?? new Set<string>()
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const finding of errorFindings(findings)) {
    for (const name of finding.plugins) {
      if (seen.has(name)) continue
      if (!suspectSet.has(name)) continue
      if (protectedSet.has(name)) continue
      seen.add(name)
      ordered.push(name)
    }
  }
  const limit = options.maxTargets ?? Number.POSITIVE_INFINITY
  return ordered.slice(0, Math.max(0, limit))
}

/**
 * 候选排序：已停用优先 → `dshCompat.priority` 升序 → 列表靠后。
 *
 * ## 排序方向的理由
 *
 * - **已停用优先**：零代价（见 `CandidatePlugin.alreadyDisabled`）；
 * - **priority 升序**：`dshCompat.priority` 的语义是「作者的排位」，
 *   数值小 = 更靠后（参考实现 compat-guardian:151 同向）。先关低优先级的，
 *   保住用户真正在用的功能；
 * - **列表靠后**：列表按 recency 降序（越新越靠前）。同样代价时先关旧的 ——
 *   新装的那一个才是「这次崩溃前刚变过的东西」的反面证据？不是：旧插件
 *   已经稳定跑过很久，关它带来的行为变化更容易被用户接受，而新装的插件
 *   是**下一步排障**的主线索，不该第一轮就丢掉。
 *
 * ## 无声明时保持原序（fallback，逐位不变）
 *
 * 判据是「所有候选都 `declared !== true`」⇒ 直接返回输入顺序。这样没有
 * 任何插件声明元数据的 profile，隔离顺序**与旧实现（纯 recency）完全相同**；
 * 夹具见 `tests/unit/quarantine-plan.test.ts` 的「排序双向」段。
 */
export function orderCandidates<T extends CandidatePlugin>(candidates: readonly T[]): T[] {
  const anyDeclared = candidates.some((c) => c.declared === true)
  if (!anyDeclared) return [...candidates]
  return [...candidates].sort((a, b) => {
    const disabledOrder = Number(b.alreadyDisabled === true) - Number(a.alreadyDisabled === true)
    if (disabledOrder !== 0) return disabledOrder
    const priorityOrder = (a.priority ?? 0) - (b.priority ?? 0)
    if (priorityOrder !== 0) return priorityOrder
    // 列表靠后优先（index 大者先）。
    return b.index - a.index
  })
}

/**
 * 依赖联动：给定被停用的根，找出**全部直接/间接依赖它们**的插件。
 *
 * ## 为什么必须联动
 *
 * 隔离 X 而留下「requires X」的 Y，等于把 Y 变成一条新的加载失败：
 * Y 的模块在 `import 'X'` 处抛错，宿主看到的是一次与之前不同的崩溃。
 * 用户会以为「关掉插件反而更糟」，而真相是我们只关了一半。
 *
 * ## 为什么用反向图而不是字符串改名
 *
 * 改名式实现（`name.replace('dsh-recency-guard', ...)`）只在包名有规律时
 * 偶然成立；依赖关系是**数据**（package.json dependencies / dshCompat.requires），
 * 必须按图遍历。这里建一张 `dependency → dependents` 的反向邻接表。
 *
 * ## 环状依赖不会死循环
 *
 * `visited` 集合同时承担「已入计划」与「已访问」两职：A↔B 互相依赖时，
 * 从 A 出发先访问 B，B 再看 A 已在集合里 ⇒ 直接返回。返回顺序按插件
 * 原列表序（确定性），保证同一输入两次计划逐位一致。
 */
export function dependentsClosure(
  plugins: readonly CandidatePlugin[],
  roots: readonly string[],
  already: ReadonlySet<string> = new Set<string>(),
): string[] {
  const reverse = new Map<string, string[]>()
  for (const plugin of plugins) {
    for (const dep of plugin.dependencies ?? []) {
      const list = reverse.get(dep) ?? []
      list.push(plugin.name)
      reverse.set(dep, list)
    }
  }
  const visited = new Set<string>(already)
  for (const root of roots) visited.add(root)
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const dependent of reverse.get(current) ?? []) {
      if (visited.has(dependent)) continue
      visited.add(dependent)
      queue.push(dependent)
    }
  }
  // 输出顺序按插件列表序（确定性 + 可读）；根排在最前。
  const rootSet = new Set(roots)
  const ordered: string[] = roots.filter((name) => !already.has(name))
  for (const plugin of plugins) {
    if (rootSet.has(plugin.name)) continue
    if (visited.has(plugin.name) && !already.has(plugin.name)) ordered.push(plugin.name)
  }
  return ordered
}

/**
 * 贪心最小隔离集（循环「取候选 → 标记 → 重算 → 再取」）。
 *
 * @param plugins 当前在场的插件（含依赖边与保护标记）
 * @param findings 声明式 finding（warning 不参与隔离，只上屏）
 * @param options.maxDisable 停用上限（真实守护传 `config.maxAutoDisable`）
 */
export function planQuarantine(
  plugins: readonly CandidatePlugin[],
  findings: readonly ConflictFinding[],
  options: PlanOptions = {},
): QuarantinePlan {
  const cap = options.maxDisable === undefined ? Number.POSITIVE_INFINITY : Math.max(1, options.maxDisable)
  const disabled = new Set<string>()
  const quarantine: string[] = []
  const steps: QuarantineStep[] = []
  // 轮数硬上界（见 `roundBudget` 的注释）：每轮至少停用 1 个 ⇒ 超过 P 轮仍未
  // 收敛说明逻辑有 bug，但**绝不**允许它无限跑（崩溃路径上的隔离计划不能挂住）。
  const maxRounds = options.roundBudget ?? roundBudget(plugins.length)

  for (let round = 0; round < maxRounds; round += 1) {
    const active = new Set(plugins.filter((p) => !disabled.has(p.name)).map((p) => p.name))
    const errors = errorFindings(findings).filter((f) => findingActive(f, active))
    if (errors.length === 0) {
      return { quarantine, unresolved: [], steps, terminatedBy: 'no-error' }
    }
    const candidates = plugins.filter(
      (p) => !disabled.has(p.name) && p.protected !== true && errors.some((f) => f.plugins.includes(p.name)),
    )
    if (candidates.length === 0) {
      return { quarantine, unresolved: errors, steps, terminatedBy: 'no-candidate' }
    }
    if (quarantine.length >= cap) {
      return { quarantine, unresolved: errors, steps, terminatedBy: 'cap' }
    }
    // 依赖联动把「关一个」变成「关一组」：主目标之外的联动者也要算进配额。
    const ordered = orderCandidates(candidates)
    const picked = ordered[0] as CandidatePlugin
    const closure = dependentsClosure(plugins, [picked.name], disabled)
    // 配额必须先**整组**判定，不能「关到一半」：
    // 把 leaf 关掉、却因配额把依赖它的 mid 留下，mid 下一次启动就在 import
    // 处抛错 —— 那正是依赖联动要防的崩溃，而且它会被记成一次「新的」崩溃。
    // 所以整组放不进配额时宁可不动，残余如实进 unresolved（terminatedBy='cap'）。
    const fresh = closure.filter((name) => {
      if (disabled.has(name)) return false
      const plugin = plugins.find((p) => p.name === name)
      return plugin !== undefined && plugin.protected !== true
    })
    if (quarantine.length + fresh.length > cap) {
      return { quarantine, unresolved: errors, steps, terminatedBy: 'cap' }
    }
    const linked: string[] = []
    for (const name of fresh) {
      disabled.add(name)
      quarantine.push(name)
      if (name !== picked.name) linked.push(name)
    }
    // 极端情形：主目标本身受保护（理论上不会，候选已排除）⇒ 防死循环。
    if (!disabled.has(picked.name)) {
      return { quarantine, unresolved: errors, steps, terminatedBy: 'no-candidate' }
    }
    const remaining = errorFindings(findings).filter((f) =>
      findingActive(f, new Set(plugins.filter((p) => !disabled.has(p.name)).map((p) => p.name))),
    )
    const trigger = errors.find((f) => f.plugins.includes(picked.name)) as ConflictFinding
    steps.push({
      bundle: picked.name,
      reason: `${trigger.kind}：${trigger.message}`,
      linked,
      remainingErrors: remaining.length,
    })
  }

  // 走到这里说明轮数上界都没收敛：如实报告残余，不假装成功。
  const active = new Set(plugins.filter((p) => !disabled.has(p.name)).map((p) => p.name))
  return {
    quarantine,
    unresolved: errorFindings(findings).filter((f) => findingActive(f, active)),
    steps,
    terminatedBy: 'cap',
  }
}