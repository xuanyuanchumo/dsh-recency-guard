/**
 * 误伤反馈闭环 —— 风险校准与置信（v0.14 M1 / RQ2，研究文档 07 §3）。
 *
 * ## 为什么需要它
 *
 * `confirmRounds=2` 是一个**写死的先验**：它假设「两次同头号复现」足以
 * 支撑关闭一个插件的代价。但「关错了」这件事在系统里留了痕 —— 用户会
 * 手动 reenable。这条痕迹此前被完全忽略：guard 关错多少次、用户撤销过
 * 多少次，都只躺在 journal 里，不参与下一轮判定。
 *
 * 本模块把那批痕迹变成**校准输入**：误伤率越高，确认轮数越高（更保守）；
 * 样本足够且误伤率低于目标线，就退回基线。样本不足时**不调整**（无数据
 * 既不推出「低风险」也不推出「高风险」），只把读数标成不可判定。
 *
 * ## 两条证据来源必须分开（07 §3.3 明文要求）
 *
 * journal 里有两类「插件又开着」的记录，它们的证据力完全不同：
 *
 * - **用户主动 reenable**（`kind: 'enable'`，**其后没有 `restore` 收尾**）⇒
 *   **是证据**：用户亲手撤销了 guard 的决定，这直接说明「关错了」；
 * - **系统自动恢复**（`restoreDisabledExceptPrime` 在崩溃后干净启动时逐个
 *   `reenableOne`，最后写一条 `kind: 'restore'`）⇒ **不是证据**：那是常规
 *   流程（除头号嫌疑外全恢复），它发生得越多越说明不了 guard 对错。
 *
 * ## 判别来源：显式证据优先，启发式兜底（v0.15 / TD-1）
 *
 * 判别它俩需要一个 `enable` 记录本身没有的字段（actor）。v0.14.0 只能靠
 * **记录形态**：系统恢复的形态是「连续若干条 `enable` 紧跟一条 `restore`」，
 * 于是规则是**向后回溯的连续配对** —— 一段连续的 `enable` 若被一条 `restore`
 * 收尾，整段判为系统恢复；否则判为用户主动放行。
 *
 * 这是启发式，失效条件是真实存在的（见「诚实边界」#6）。TD-1 的修法是让
 * `restore` 记录**显式列出**它恢复了哪些 bundle（`JournalEvent.bundles`），
 * 本模块据此直接判定来源，不再依赖相邻性：
 *
 * 1. **显式证据（新 journal）**：`restore` 带 `bundles: string[]` ⇒ 对每个声明
 *    的 bundle，把它**之前最近一条尚未被认领的** `enable` 判为系统恢复。
 *    即使中间夹了别的记录（note、启动记录）也照样成立 —— 这正是启发式漏判
 *    的那一类。
 * 2. **启发式（老 journal，无该字段）**：`bundles` 缺失 ⇒ 原样走 v0.14.0 的
 *    形态配对。**这条路径必须逐字节不变**，否则升级会把历史 profile 的
 *    误伤率读数整体改写一遍。
 * 3. **显式证据只升级、不降级**：未被声明的 `enable` 保留启发式的判定。
 *    原因不是保守，而是 `reenableOne` 在**管理器拒绝**时也写 `enable` 记录
 *    ——「段里有 enable 但没被 restore 声明」是**失败的恢复尝试**，不是用户
 *    放行；降级会把系统的失败噪声算成误伤，白抬阈值。
 *
 * 老与新混在同一个 journal 里时按**每条 restore 自己有没有字段**分别处理：
 * 升级过的那段与 v0.14.0 结论相同（只多认出一些系统恢复），没升级的段
 * 逐字节等于 v0.14.0。这条「同序带/不带字段结论相同」的不变式由测试钉住。
 *
 * 注意「连续」的严格性仍然有效：**任何其它记录都会打断启发式配对**（含启动
 * 时的 note）。系统恢复只发生在启动路径上，而启动路径本身会写若干记录，
 * 所以「用户的 enable 恰好与系统恢复的 enable 相邻」在真实序列里几乎不可达
 * —— 这正是启发式够用的原因，也是显式证据只需补「漏判」而不必把全部来源
 * 判定推倒重来的原因。
 *
 * ## 数学模型：误伤率 + Wilson 置信区间
 *
 * 误伤率 p̂ = fp / n（fp = 用户撤销次数，n = 自动关闭次数）。n 很小时 p̂
 * 极不稳定（1/1 = 100%、0/1 = 0% 都毫无信息量），所以区间用 **Wilson 95%**
 * 而不是 Wald：
 *
 *   p̃ = (p̂ + z²/2n) / (1 + z²/n)
 *   half = z·√( p̂(1−p̂)/n + z²/4n² ) / (1 + z²/n)
 *   lower/upper = max(0, p̃ − half) / min(1, p̃ + half)
 *   （z = 1.96）
 *
 * 为什么不用 Wald：p̂ 常年贴近 0（误伤是少数），Wald 会给出 [0,0] 这种
 * 零宽伪区间 —— 「还没人撤销过」被画成「确定没误伤」，正好违反本项目的
 * 诚实边界。Wilson 在 p̂ = 0 时仍给出上界（n=10 ⇒ 27.8%），承认样本薄。
 *
 * ## 「样本少更保守」的实现口径（07 §3.1 H2.2）—— 这里做了一个明确取舍
 *
 * H2.2 原话是「样本少时更保守」。字面实现（样本少 ⇒ 阈值一律上调）会与
 * 本项目的既定原则冲突：上调阈值 = 放过真缺陷 = 检出率下降，而 E2.2 的
 * 判据同时要求「误伤率降 **且** 检出率不降」。样本少本身不是「我们关错了」
 * 的证据 —— 一上来就因为「还没有统计数据」把阈值从 2 抬到 3，等于凭空
 * 惩罚一个没有出错记录的守护。
 *
 * 所以本模块把「保守」落在**结构**上，而不是落在「一律上调」上：
 *
 * 1. **只升不降是硬结构**：校准结果永远 ≥ 基线。样本不足时它**没有能力**
 *    让判定比配置基线更激进 —— 这就是「保守」在样本少时的真实形态。
 * 2. **上调必须有直接证据**（≥1 次用户主动放行）。没有撤销记录 ⇒ 不动。
 * 3. **样本越薄，允许的调整越小**：n < 5 时最多 +1；样本充分时才可能 +2。
 *    这样「1 次撤销 / 6 次关闭」不会像「50% 误伤率」那样被当成确定的严重问题。
 *
 * ### 这个取舍是可反驳的命题（不是「我觉得」）
 *
 * 我们拒绝的是**字面实现 I**：「n < 5 ⇒ 阈值一律 +1」。
 * I 的可证伪推论是「在没有任何一次用户撤销的 profile 上，本模块也会抬高
 * 阈值」。该推论在 E2.2 的两个判据下都可被数据推翻：
 *
 * - **误伤率不降**：I 抬高阈值 ⇒ 关得更少 ⇒ 误伤本身确实下降，但
 * - **检出率下降**：I 在「0 撤销」时也推迟行动 ⇒ 真崩溃循环要多死一轮才被
 *   切断。「0 撤销」恰恰是**没有关错证据**的 profile，对它推迟切断没有任何
 *   证据支撑，却确定地降低检出率。E2.2 要求「误伤率降 **且** 检出率不降」，
 *   I 直接违反后半句。
 *
 * 我们采用方案 **S**（幅度看观测事实、上限看样本量）的对应命题：
 * 「在 0 撤销的 profile 上，S 的阈值等于基线（不推迟切断）；在出现撤销后，
 * S 的抬高幅度不超过样本量能支撑的上限」。这条命题可被历史 journal 离线
 * 回放直接检验 —— 这正是 `decision-evidence.ts` 因子快照存在的目的
 * （07 §2.3：没有可回放的事实就不许调参）。
 *
 * 若将来真实回放显示「0 撤销的 profile 依然高误伤」（例如用户根本不点
 * reenable，撤销记录天然缺失），那么 S 的前提失效，应改为按**隔离存留率**
 * 而非撤销记录驱动 —— 那时再推翻本取舍，而不是现在凭直觉放宽。
 *
 * | 模型 | 定义式 | 假设 | 失效条件 | 复杂度 |
 * |---|---|---|---|---|
 * | `falsePositiveRate` | fp / n，n ≥ 5 | 每次自动关闭是一次独立伯努利试验 | n < 5 ⇒ 不可判定 | O(m) |
 * | `wilsonInterval` | 见上 | 二项抽样近似正态 | n = 0 ⇒ 退化为 [0,1] | O(1) |
 * | `calibratedConfirmRounds` | base + f(fp/n)，f ∈ {0,1,2} | 用户撤销是误伤的直接证据 | 无撤销证据 ⇒ 不动（n<5 时封在 +1） | O(1) |
 *
 * ## 诚实边界（写进类型与测试）
 *
 * 1. **分母为 0 或样本不足 ⇒ 误伤率不可判定**：`Metric.defined === false`
 *    且 `value === null`。绝不把「还没人撤销过」读成「误伤率 0%」。
 * 2. **无数据 ≠ 低风险，也不等于高风险**：样本不足且无撤销证据 ⇒ **不动**。
 *    上一个方向的错误（用「没有数据」推出「误伤率低所以不必保守」）和
 *    反方向（用「没有数据」推出「样本薄所以必须上调」）都是把缺失当成了
 *    事实。本模块只用**观测到的事实**驱动调整。
 * 3. **只升不降**：校准结果不会低于基线。下调阈值 = 更早动手 = 更多误伤，
 *    与「误伤更少」的目标相反；「收敛」的语义是**退回基线**，不是穿透基线。
 * 4. **不黑盒**：每次决策都必须给出人话 `explanation`，面板直接显示
 *    「本轮为何提高阈值」（07 §3.3）。
 * 5. **安全网不被削弱**：`assessConfidence` 的兜底升级（crashSeq ≥ 3）在
 *    校准层之后仍然生效。所以即使校准把阈值抬到 4，崩溃循环也会在第 3 次
 *    触发兜底 —— 校准换来的是「多观察一轮」，不是「永远不救」。
 * 6. **哪些情况仍然只靠启发式**（v0.15 / TD-1 之后的诚实边界）：
 *    - 老 journal（`restore` 无 `bundles` 字段）⇒ 整份走形态配对；
 *    - 新 journal 里**未被声明**的 enable（含管理器拒绝恢复时 `reenableOne`
 *      仍写下的那条）⇒ 保留启发式判定，显式证据不降级；
 *    - `restore` 声明了 bundle 却找不到对应 enable ⇒ 记 `unattributedRestores`，
 *      不配给任何 enable（宁可少判也不瞎配对）。
 *    剩下的误分类风险因此只剩「老 journal 的形态配对」，代价仍被**上限 2 轮**
 *    的调整幅度压在有限轮数内。
 */

import type { JournalRecord } from './store.js'
import { definedMetric, round4, sampleConfidence, undefinedMetric, type Metric } from './observability.js'

/**
 * 误伤率可判定的最小自动关闭样本量。
 *
 * 取 5：n < 5 时即使 fp = 0，Wilson 上界也 > 0.43，任何「低误伤」结论
 * 都撑不住；取更大（如 20）会让本功能在真实 profile 上几乎永不生效
 * —— 自动关闭是低频事件，样本永远攒不够。
 */
export const CALIBRATION_MIN_SAMPLES = 5

/**
 * 误伤率目标线：点估计超过它 ⇒ 上调一轮。15% 意味着「关 7 个错 1 个」已到
 * 容忍边界 —— 再高就不该继续用同一套阈值。
 */
export const FALSE_POSITIVE_TARGET = 0.15

/**
 * 误伤率严重线：点估计超过它 ⇒ 上调两轮。
 *
 * 35% ≈ 「关 3 个错 1 个」。到这个程度说明当前阈值与真实缺陷分布明显错位，
 * 一轮不够抵偿；但也只给两轮 —— 再往上就进入「为了不误伤而放弃守护」的
 * 反面失败模式。
 */
export const FALSE_POSITIVE_SEVERE = 0.35

/**
 * 校准后的确认轮数上限。
 *
 * 4 轮 ≈ 连续 4 次崩溃才动手。再高就等于让宿主在崩溃循环里多死几次，
 * 与「宿主可用性优先于误伤最小化」冲突；而兜底升级在 crashSeq ≥ 3 时
 * 仍会强制行动，所以 4 是「保守但不算失能」的上限。
 */
export const MAX_CALIBRATED_ROUNDS = 4

/** Wilson 区间（95%，z = 1.96）。 */
export interface WilsonInterval {
  /** 点估计 k/n。 */
  point: number
  /** 下界（≥ 0）。 */
  lower: number
  /** 上界（≤ 1）。 */
  upper: number
}

/**
 * Wilson 得分区间。O(1)。
 *
 * 相比 Wald 区间（p̂ ± z√(p̂(1−p̂)/n)），Wilson 在 p̂ 贴近 0/1 或 n 小时
 * 不会退化成零宽/出界区间 —— 而本场景的 p̂ 恰恰常年贴近 0（误伤是少数），
 * Wald 会给出 [0,0] 这种「假装确定」的伪区间，正好违反诚实边界。
 *
 * n ≤ 0 时退化为 [0,1]（完全无信息），不是 [0,0]。
 */
export function wilsonInterval(successes: number, total: number, z = 1.96): WilsonInterval {
  const n = Number.isFinite(total) ? Math.max(0, total) : 0
  const k = Number.isFinite(successes) ? Math.min(Math.max(0, successes), n) : 0
  if (n === 0) return { point: 0, lower: 0, upper: 1 }
  const phat = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (phat + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom
  return {
    point: round4(phat),
    lower: round4(Math.max(0, center - half)),
    upper: round4(Math.min(1, center + half)),
  }
}

/** 一条误伤样本：某插件被自动关闭后又被**用户**主动放行。 */
export interface FalsePositiveSample {
  /** 被误关的插件。 */
  bundle: string
  /** 那次自动关闭的时刻（ISO）。 */
  autoDisabledAt: string
  /** 用户主动放行的时刻（ISO）。 */
  reenabledAt: string
}

/**
 * 误伤样本采集结果。
 *
 * 计数字段全是**事实**（哪怕为 0 也是可判定的事实），所以本结构本身不是
 * `Metric` —— 不可判定的是由它导出的**比率**（见 `falsePositiveRate`）。
 */
export interface FalsePositiveStats {
  /** 用户主动放行且能追溯到一次自动关闭的次数（误伤率的分子）。 */
  falsePositives: number
  /** 自动关闭（`auto-recency`）总次数（误伤率的分母）。 */
  autoDisables: number
  /** 被识别为系统自动恢复、明确排除在证据之外的 `enable` 次数。 */
  systemRestored: number
  /** 用户主动 enable 但追溯不到自动关闭的次数（既不是误伤也不是分母）。 */
  unattributed: number
  /**
   * `restore` 显式声明了 bundle、但窗口内找不到可配对 `enable` 的次数
   * （v0.15 / TD-1）。
   *
   * 为什么不并进 `unattributed`：后者是**用户行为口径**（用户开了个 guard
   * 没关过的插件），本项是**证据链一致性口径**（restore 说它恢复了 X，但
   * journal 里没有 X 的那条 enable）。混在一起会让面板把「记录断了一行」
   * 读成「用户又主动放行一次」，两种故障的处置完全不同。两者都标
   * unattributed，但必须分桶才白盒。
   *
   * 真实可达路径：journal 1000 行上限截断、或记录被手工改过。生产路径上
   * `reenableOne` 写 enable 之后才写 restore，二者相邻，不可能缺。
   */
  unattributedRestores: number
  /** 逐条误伤样本（面板时间线用，旧 → 新）。 */
  samples: FalsePositiveSample[]
}

/** 误伤率读数（含区间）。 */
export interface FalsePositiveRate {
  /** 点估计 fp / n。 */
  rate: number
  /** 分子。 */
  falsePositives: number
  /** 分母。 */
  autoDisables: number
  /** Wilson 95% 下界。 */
  lower: number
  /** Wilson 95% 上界（**只用于展示不确定性**；判阈值用点估计，理由见 calibratedConfirmRounds）。 */
  upper: number
}

/** 本次 `enable` 记录的证据来源。 */
export type RestoreSource = 'user' | 'system'

/** 内部：一条 enable 记录及其来源判定。 */
interface EnableMark {
  bundle: string
  source: RestoreSource
}

/** 内部：自动关闭的开启栈（按 bundle 分组，LIFO）。 */
type DisableStack = Map<string, string[]>

/**
 * 从 journal 采集误伤样本 —— 纯函数。
 *
 * ## 三段扫描，各自解决一个问题
 *
 * 1. **启发式来源判定**（v0.14 起）：一段连续的 `enable` 是否被紧随的
 *    `restore` 收尾 ⇒ 系统恢复；否则 ⇒ 用户主动。必须成段判定，因为单独的
 *    `enable` 不带 actor 字段（`recovery-actions.ts` 里同一个 `reenableOne`
 *    同时服务两条路径，唯一的差别是「调用者后来有没有写 restore」）。
 * 2. **显式证据覆盖**（v0.15 / TD-1）：`restore` 声明了 `bundles` ⇒ 按声明把
 *    对应的 `enable` 升级为系统恢复。只升级不降级，理由见 `applyExplicitRestores`。
 * 3. **归因**：按时间顺序把每条 enable 与同一 bundle 的**最近一次尚未
 *    被消费的**自动关闭配对。配上的用户放行 = 一次误伤（两条记录提供
 *    时戳，样本可回放）；配不上的用户 enable（插件不是 guard 关的、
 *    或重复放行）单独计数，绝不混进分子。
 *
 * 为什么必须消费掉已配对的关闭：否则「关 A → 系统恢复 A → 又关 A →
 * 用户放行 A」会被算成两次误伤（第一次其实是系统恢复），虚高误伤率
 * 会让阈值被无谓抬高。
 *
 * 复杂度：主体 O(m)（m = journal 行数，封顶 1000）。显式证据段最坏是
 * 「声明数 × 同 bundle 的 enable 数」，但 m ≤ 1000 且声明数受 bundle 数
 * 限制，不会把启动路径的读盘成本拖出线性量级。
 */
export function falsePositiveSamples(journal: readonly JournalRecord[]): FalsePositiveStats {
  const events = Array.isArray(journal) ? journal : []

  // 第一遍：启发式来源判定（连续 enable 段 + 收尾记录）。
  // `byBundle` 是给第二遍的显式证据定位用的「同 bundle 的 enable 下标表」，
  // 免得每条恢复声明都从头扫一遍 journal。
  const marks = new Map<number, EnableMark>()
  const byBundle = new Map<string, number[]>()
  let run: number[] = []
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (!event) continue
    if (event.kind === 'enable' && typeof event.bundle === 'string') {
      marks.set(i, { bundle: event.bundle, source: 'user' })
      const indexes = byBundle.get(event.bundle)
      if (indexes === undefined) byBundle.set(event.bundle, [i])
      else indexes.push(i)
      run.push(i)
      continue
    }
    // 只有 restore 才把这一段判成系统恢复；其它任何记录都会打断配对。
    if (event.kind === 'restore') {
      for (const index of run) {
        const mark = marks.get(index)
        if (mark) mark.source = 'system'
      }
    }
    run = []
  }

  // 第二遍：显式证据（v0.15 / TD-1）。老 journal 没有 `bundles` 字段 ⇒
  // 这一遍对每条记录都拿不到证据、一个字也不改，结论与 v0.14.0 逐字节一致。
  const unattributedRestores = applyExplicitRestores(events, marks, byBundle)

  // 第三遍：归因（自动关闭入栈，enable 出栈）。
  const stats: FalsePositiveStats = {
    falsePositives: 0,
    autoDisables: 0,
    systemRestored: 0,
    unattributed: 0,
    unattributedRestores,
    samples: [],
  }
  const open: DisableStack = new Map()
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (!event) continue
    if (isAutoDisable(event) && typeof event.bundle === 'string') {
      const bundle = event.bundle
      stats.autoDisables += 1
      const stack = open.get(bundle) ?? []
      stack.push(typeof event.t === 'string' ? event.t : '')
      open.set(bundle, stack)
      continue
    }
    const mark = marks.get(i)
    if (mark === undefined) continue
    if (mark.source === 'system') {
      stats.systemRestored += 1
      consume(open, mark.bundle)
      continue
    }
    const disabledAt = consume(open, mark.bundle)
    if (disabledAt === undefined) {
      stats.unattributed += 1
      continue
    }
    stats.falsePositives += 1
    stats.samples.push({
      bundle: mark.bundle,
      autoDisabledAt: disabledAt,
      reenabledAt: typeof event.t === 'string' ? event.t : '',
    })
  }
  return stats
}

/**
 * 取一条 `restore` 记录声明的 bundle 列表（v0.15 / TD-1）。
 *
 * 返回 `undefined` = **这条记录没有可用证据**，调用方必须回退到相邻性启发式。
 * 覆盖三种情形：不是 `restore`、字段缺失（老 journal）、字段形状坏掉。
 *
 * 为什么坏形状也整体回退、而不是把能认的那几项当证据：journal 是磁盘上可
 * 读可编辑的 JSON，`[123]` / `["a", null]` 这种记录若被拆开认一半，就等于让
 * 「一条坏记录」静默改写统计口径。宁可整条不认证据 —— 回退后的行为与
 * v0.14.0 逐字节一致，坏记录的代价被限制在「这次没享受到新证据」，而不是
 * 「误伤率被悄悄改了一个数」。
 *
 * 空数组 `[]` 是**有效证据**（这条 restore 真的一个都没恢复：只剩首要嫌疑
 * 时就是这形态），与「字段缺失」严格区分。当前实现只升级不降级，两者对
 * 判定结果等价，但语义不同 —— 将来若引入降级规则，这个区分必须还在。
 */
function declaredBundles(event: JournalRecord): string[] | undefined {
  if (event.kind !== 'restore') return undefined
  const raw = event.bundles
  if (!Array.isArray(raw)) return undefined
  if (!raw.every((item) => typeof item === 'string')) return undefined
  return raw as string[]
}

/**
 * 用 restore 的显式 bundle 列表改判来源 —— **只升级，不降级**。
 *
 * ## 配对规则：往前找「最近一条、同 bundle、尚未被认领」的 enable
 *
 * 生产路径上 `restoreDisabledExceptPrime` 对每个 bundle 调一次 `reenableOne`，
 * 它写 `enable` 之后才轮到收尾的 `restore`，中间没有别的记录插进来。所以
 * 声明里的每个 bundle 必然有一条**紧贴其前**的 `enable`（与其它 bundle 的
 * enable 相邻，但不会跨过 note 之外的记录）。往前找最近一条即命中；已被
 * 更早的 restore 认领过的跳过，否则一条 enable 会被两条 restore 各算一次
 * 「系统恢复」，把分母对应的关闭栈弹空。
 *
 * ## 找不到对应 enable 时不瞎配对
 *
 * 声明了 bundle 却在它**之前**找不到未认领的 enable（journal 1000 行上限
 * 截断、记录被手工改过）⇒ 记一次 `unattributedRestores`。三条禁止：
 * - 不许退而配一条**之后**才出现的 enable：restore 不可能恢复一个未来才
 *   开启的插件，方向本身就是错的；
 * - 不许拿别的 bundle 顶替（宁可少认证据，不可乱认）；
 * - 不许顺手弹掉自动关闭栈：没有 enable 就没有「谁被放行」这条事实可配对，
 *   硬弹等于凭空宣布「这次关闭已被系统恢复消化」。代价是后续那条用户
 *   enable 仍可能被算成误伤（偏保守方向），收益是每个结论都由观测到的
 *   记录撑着 —— 与「无数据不等于零」是同一条纪律。
 *
 * ## 为什么只升级不降级（这条同时是向后兼容的保证）
 *
 * `reenableOne` 在**管理器拒绝**时也会写一条 `enable`（它把结果原样塞进
 * `result`，失败者也留痕）。所以一段 restore 前的 enable 里，合法地包含
 * 「没被恢复成功的 bundle」。若用「未声明 ⇒ 降级为用户放行」来改判，这些
 * 失败的**系统尝试**会变成误伤证据 —— 误伤率被系统噪声抬高、阈值被无谓
 * 上调。v0.14.0「诚实边界」#6 点名的正是这类误分类，显式证据不该把它放大。
 *
 * 于是显式证据的作用面被限定为：把启发式**漏判成用户主动**的系统恢复补
 * 回来（相邻性被 note 打断、或 restore 前没有紧邻的连续段）。这也正是启发
 * 式唯一的漏判方向 —— 启发式从不需要「多加证据」，只需要「补漏」。
 *
 * @returns 声明了但配不上 enable 的 bundle 数（进 `unattributedRestores`）
 */
function applyExplicitRestores(
  events: readonly JournalRecord[],
  marks: Map<number, EnableMark>,
  byBundle: ReadonlyMap<string, number[]>,
): number {
  let unattributed = 0
  const claimed = new Set<number>()
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (!event) continue
    const declared = declaredBundles(event)
    if (declared === undefined || declared.length === 0) continue
    // 同一个 bundle 在同一条 restore 里重复出现只算一次（生产路径不可能重复，
    // 但手工记录可能重复，重复认领会把一条 enable 记两次系统恢复）。
    for (const bundle of new Set(declared)) {
      const index = nearestPrecedingEnable(byBundle, bundle, i, claimed)
      if (index === undefined) {
        unattributed += 1
        continue
      }
      claimed.add(index)
      const mark = marks.get(index)
      if (mark !== undefined) mark.source = 'system'
    }
  }
  return unattributed
}

/** 在 `before` 之前找最近一条同 bundle、尚未被认领的 enable 下标。 */
function nearestPrecedingEnable(
  byBundle: ReadonlyMap<string, number[]>,
  bundle: string,
  before: number,
  claimed: ReadonlySet<number>,
): number | undefined {
  const indexes = byBundle.get(bundle)
  if (indexes === undefined) return undefined
  // indexes 是按 journal 顺序 push 的升序表，从尾部往前即「最近优先」。
  for (let k = indexes.length - 1; k >= 0; k -= 1) {
    const index = indexes[k]
    if (index === undefined || index >= before) continue
    if (claimed.has(index)) continue
    return index
  }
  return undefined
}

/** 一条记录是否是 guard 的**自动**关闭（`manual` 是用户自己关的，不进分母）。 */
function isAutoDisable(event: JournalRecord): boolean {
  if (event.kind === 'auto-disable') return true
  return event.kind === 'disable' && event.detail === 'auto-recency'
}

/** 弹出该 bundle 最近一次未被消费的自动关闭时刻。 */
function consume(open: DisableStack, bundle: string): string | undefined {
  const stack = open.get(bundle)
  if (stack === undefined || stack.length === 0) return undefined
  const at = stack.pop()
  if (stack.length === 0) open.delete(bundle)
  return at ?? ''
}

/** 百分比短格式（解释文案用；保留 1 位小数，不制造虚假精度）。 */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 误伤率读数 —— 样本不足 ⇒ `defined: false` + `value: null`（07 §3.3）。
 *
 * 分母口径：**只看 guard 的自动关闭**（`auto-recency`）。用户自己 `manual`
 * 关掉的插件与误伤无关，混进分母会稀释误伤率、掩盖问题。
 */
export function falsePositiveRate(stats: FalsePositiveStats): Metric<FalsePositiveRate> {
  const formula = '误伤率 = 用户主动放行次数 / 自动关闭次数；区间用 Wilson 得分区间（95%）'
  const n = stats.autoDisables
  const fp = stats.falsePositives
  const inputs = { falsePositives: fp, autoDisables: n, systemRestored: stats.systemRestored }
  if (n <= 0) {
    return undefinedMetric('尚无自动关闭记录：误伤率分母为 0，不可判定', '不可判定', {
      formula,
      inputs,
      sampleSize: 0,
    })
  }
  if (n < CALIBRATION_MIN_SAMPLES) {
    return undefinedMetric(
      `自动关闭样本 ${n} 次 < ${CALIBRATION_MIN_SAMPLES} 次：误伤率不可判定（不是 0%）`,
      '样本不足',
      { formula, inputs, sampleSize: n },
    )
  }
  const interval = wilsonInterval(fp, n)
  const label = `误伤率 ${fp}/${n} = ${pct(interval.point)}（Wilson 95% 区间 ${pct(interval.lower)}–${pct(interval.upper)}）`
  return definedMetric(
    {
      rate: interval.point,
      falsePositives: fp,
      autoDisables: n,
      lower: interval.lower,
      upper: interval.upper,
    },
    label,
    { formula, inputs, sampleSize: n, confidence: sampleConfidence(n) },
  )
}

/** 校准的决策形态（机器可读 + 人读各一份，面板不猜）。 */
export type CalibrationKind =
  | 'hold-insufficient' // 样本不足且没有放行证据 ⇒ 不动（无数据 ≠ 低风险）
  | 'raise-insufficient' // 样本不足但已出现用户放行 ⇒ 保守上调 1 轮
  | 'hold-rate' // 样本充足且误伤率未超目标线 ⇒ 退回/维持基线
  | 'raise-rate' // 样本充足且误伤率超目标线 ⇒ 上调

/** 一次阈值校准的完整白盒输出。 */
export interface CalibrationDecision {
  /** 基线确认轮数（调用方配置或上游调节后的值）。 */
  base: number
  /** 校准后的确认轮数（∈ [base, max(base, MAX_CALIBRATED_ROUNDS)]）。 */
  required: number
  /** 相对基线的变化（0 = 维持；不会为负）。 */
  delta: number
  /** 决策分类（机器可读）。 */
  kind: CalibrationKind
  /** 本次用到的误伤率读数（不可判定时 defined:false）。 */
  rate: Metric<FalsePositiveRate>
  /** 一句话短解释（直接进 verdict label，命令窗口空间有限）。 */
  explanation: string
}

/**
 * 基于误伤反馈校准确认轮数 —— 纯函数，O(1)。
 *
 * ## 判据表（每一档都要求「有观测到的用户撤销」这个前提）
 *
 * | 条件 | delta | kind |
 * |---|---|---|
 * | n = 0（从没自动关过） | 0 | `hold-insufficient` |
 * | n < 5 且 fp = 0 | 0 | `hold-insufficient` |
 * | n < 5 且 fp ≥ 1（有撤销、样本薄） | +1 | `raise-insufficient` |
 * | n ≥ 5 且 p̂ ≤ 15% | 0 | `hold-rate`（退回基线 = 收敛） |
 * | n ≥ 5 且 15% < p̂ ≤ 35% | +1 | `raise-rate` |
 * | n ≥ 5 且 p̂ > 35% | +2 | `raise-rate` |
 *
 * ## 为什么档位按**点估计**而不是 Wilson 上界
 *
 * 上界衡量的是「这个比率有多不确定」，判「该不该更保守」需要的是「已经
 * 观测到的误伤有多少」。用上界判会造成一条荒谬的后果：**0 次误伤、5 次
 * 关闭 ⇒ 上界 43% > 35% ⇒ 上调 2 轮**。那等于说「因为你还没出过错所以
 * 我要更不信任你」，纯粹用样本量惩罚检出率 —— 与 E2.2「检出率不降」冲突，
 * 也与项目原则「宿主可用性优先」冲突。
 *
 * 所以：**调整的幅度看观测到的误伤率**（事实），**调整的上限看样本量**
 * （n < 5 时封在 +1）。Wilson 区间仍然对外输出（`rate.label` 与面板卡片），
 * 它的职责是告诉用户「这个误伤率有多不靠谱」—— 而不是驱动阈值。
 *
 * ## 为什么只升不降
 *
 * 降阈值 = 更早动手 = 更多误伤，与「误伤更少」的目标相反。「收敛」的正确
 * 语义是**退回基线**（delta = 0），不是穿到基线以下。这条纪律保证本模块
 * 永远不增加误伤，最坏情况只是「多观察一轮」；而 `assessConfidence` 的
 * 兜底升级（crashSeq ≥ 3）在那一轮里仍是最后的安全网。
 *
 * `base` 低于 1 或非有限 ⇒ 钳到 1（与 `assessConfidence` 的钳制口径一致）；
 * `base` 本身已高于 `MAX_CALIBRATED_ROUNDS` ⇒ 上限跟着抬高，绝不把它
 * 「压回去」（那会是一条隐藏的降级路径）。
 */
export function calibratedConfirmRounds(base: number, stats: FalsePositiveStats): CalibrationDecision {
  const safeBase = Math.max(1, Math.floor(Number.isFinite(base) ? base : 1))
  const rate = falsePositiveRate(stats)
  const n = Math.max(0, stats.autoDisables)
  const fp = Math.max(0, stats.falsePositives)
  const observed = n > 0 ? fp / n : 0
  // 上限不低于基线：base 已高于 MAX 时不能再把它压回去。
  const cap = Math.max(MAX_CALIBRATED_ROUNDS, safeBase)

  let delta = 0
  let kind: CalibrationKind
  let explanation: string

  if (!rate.defined) {
    // 样本不足：误伤率不可判定。只有「用户已经撤销过」才是可用的直接证据。
    if (fp >= 1) {
      delta = 1
      kind = 'raise-insufficient'
      explanation = `样本不足（自动关闭 ${n} 次 < ${CALIBRATION_MIN_SAMPLES}），但已出现 ${fp} 次用户主动放行（观测误伤率 ${pct(observed)}，占比不可外推）⇒ 保守上调 1 轮`
    } else {
      kind = 'hold-insufficient'
      explanation =
        n === 0
          ? '尚无自动关闭记录（分母 0），误伤率不可判定；无放行证据 ⇒ 不上调（无数据不等于高风险）'
          : `样本不足（自动关闭 ${n} 次 < ${CALIBRATION_MIN_SAMPLES}）且未见用户主动放行 ⇒ 不上调（无数据不等于高风险）`
    }
  } else if (fp === 0) {
    // 有足够样本且一次都没被撤销：这是**正面**证据，可以安心用基线。
    kind = 'hold-rate'
    explanation = `${n} 次自动关闭中 0 次被用户撤销（观测误伤率 0.0%）⇒ 维持基线`
  } else if (observed <= FALSE_POSITIVE_TARGET) {
    kind = 'hold-rate'
    explanation = `观测误伤率 ${pct(observed)}（${fp}/${n}）未超过目标线 ${pct(FALSE_POSITIVE_TARGET)} ⇒ 维持基线`
  } else if (observed <= FALSE_POSITIVE_SEVERE) {
    delta = 1
    kind = 'raise-rate'
    explanation = `观测误伤率 ${pct(observed)}（${fp}/${n}）超过目标线 ${pct(FALSE_POSITIVE_TARGET)} ⇒ 上调 1 轮`
  } else {
    delta = 2
    kind = 'raise-rate'
    explanation = `观测误伤率 ${pct(observed)}（${fp}/${n}）超过严重线 ${pct(FALSE_POSITIVE_SEVERE)} ⇒ 上调 2 轮`
  }

  const required = Math.min(cap, safeBase + delta)
  const actual = required - safeBase
  if (actual === 0 && delta > 0) {
    // 撞上限：必须如实说明「本想上调但已封顶」，否则面板会显示一个假的调整理由。
    explanation = `${explanation}（已达上限 ${cap} 轮，本轮实际未上调）`
  } else if (actual > 0 && actual !== delta) {
    explanation = `${explanation}（受上限 ${cap} 轮约束，实际上调 ${actual} 轮）`
  }
  return {
    base: safeBase,
    required,
    delta: actual,
    kind,
    rate,
    explanation,
  }
}

/**
 * 面板用的完整人话解释（07 §3.3「本轮为何提高阈值」，不做黑盒）。
 *
 * 短解释 `decision.explanation` 进命令窗口（一行放得下）；本函数补上
 * 「从几轮调到几轮」与口径说明，供面板卡片直接渲染。
 */
export function calibrationExplanation(decision: CalibrationDecision): string {
  const { base, required, delta, explanation, rate } = decision
  const head = delta === 0 ? `维持基线 ${base} 轮` : `确认轮数 ${base} → ${required}（+${delta}）`
  const basis = rate.defined
    ? `误伤率读数：${rate.label}`
    : `误伤率读数：不可判定（${rate.reason ?? '样本不足'}）`
  return `${head}。判定依据：${explanation}。${basis}。口径：只统计「用户主动放行 / 自动关闭」，系统自动恢复不计入证据。`
}
