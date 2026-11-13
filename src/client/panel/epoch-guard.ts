/**
 * 在途请求的**世代守卫**（epoch guard）。
 *
 * ## 问题根因（真实的串扰场景）
 *
 * 面板允许「查看别的分区」（`?partition=<key>`）。用户快速切换分区时，
 * **上一分区的请求可能还在路上**：
 *
 * ```
 * t0: 用户点「分区 B」 → 发出请求 B（慢）
 * t1: 用户点「分区 C」 → 发出请求 C（快）→ C 的响应先落地 ⇒ 画面显示 C
 * t2: B 的响应后到   → 若无守卫，直接 setSnapshot(B 的数据)
 *                      ⇒ 画面显示 B，但用户以为在看 C
 * ```
 *
 * 后果不是「画面抖一下」，而是**展示了错误分区的守护事实** ——
 * 在一个专门做「按项目隔离、不串扰」的插件里，这是最不能有的缺陷：
 * 用户会据此对**别的项目**的插件做出关闭/恢复决策。
 *
 * 现有的 `partitionMismatch` 检查**挡不住这个**：它比对的是「请求的分区」
 * 与「响应自称的分区」，而这里两者**一致**（B 的响应确实自称 B）——
 * 问题在于**这个响应已经过期了**（用户早已切到 C）。
 *
 * ## 守卫模型
 *
 * 每次「切换查看对象」（分区 / 当前分区）都会让世代号 +1。请求在**发起时**
 * 记下自己的世代号；响应落地时比对：
 *
 * - 代��号相同 ⇒ 仍是当前查看对象 ⇒ 接受；
 * - 世代号不同 ⇒ 已过期 ⇒ **丢弃**（不 setState）。
 *
 * ## 为什么是「丢弃」而不是「重新拉取」
 *
 * 过期响应本身携带的是**旧对象**的数据，不是新对象的。重新拉取是
 * 「再发一次正确的请求」—— 而正确的请求在世代切换时**已经发出去了**
 * （每次切换都会触发一轮 load）。再拉一次会造成请求风暴。
 *
 * ## 为什么不用 AbortController
 *
 * AbortController 能取消**请求**，但取消的是**传输**，
 * 未必能阻止已 resolve 的 promise 的 `then` 回调执行 ——
 * 「取消」与「不落地」是两件事。世代守卫管的是后者，且它对
 * **不可取消的注入实现**（测试桩、旧宿主）同样有效。
 *
 * 两者可以叠加：AbortController 省带宽，世代守卫保正确性。
 * 本仓选世代守卫，因为它是**纯函数**、可测、且不依赖 fetch 实现。
 */

/** 一个世代守卫。 */
export interface EpochGuard {
  /** 当前世代号（每次切换 +1）。 */
  readonly current: number
  /**
   * 记下一个请求的世代号（在**发起**时调用）。
   *
   * 必须发起时记，而不是响应时读 —— 响应时读已经没有意义了。
   */
  begin(): number
  /**
   * 判定某个世代号的响应是否仍然有效。
   *
   * @param epoch 发起时记下的世代号。
   * @returns true = 仍有效（可落地）；false = 已过期（必须丢弃）。
   */
  isCurrent(epoch: number): boolean
  /** 世代号 +1（切换查看对象时调用）。 */
  advance(): number
}

/**
 * 创建一个世代守卫。
 *
 * @param initial 初始世代号（默认 0）。
 */
export function createEpochGuard(initial = 0): EpochGuard {
  let epoch = initial
  return {
    get current(): number {
      return epoch
    },
    begin(): number {
      return epoch
    },
    isCurrent(candidate: number): boolean {
      return candidate === epoch
    },
    advance(): number {
      epoch += 1
      return epoch
    },
  }
}

/**
 * 在途请求的结果分派（世代守卫的用法示例，也是本仓的**唯一推荐用法**）。
 *
 * 为什么单独抽出来：守卫的正确用法有两种写法 ——
 * 「先判后写」与「写时判」。前者要先算好再写，后者写之前判一次。
 * 两者都容易写错（尤其在 `Promise.all` 里），因此把**分派**本身做成
 * 纯函数，让唯一正确的形态被单测钉住。
 *
 * @param epoch 请求发起时的世代号。
 * @param guard 当前守卫。
 * @param apply 落地函数（收到数据）。
 * @param data 响应数据。
 * @returns true = 已落地；false = 因过期被丢弃。
 */
export function applyIfCurrent<T>(
  epoch: number,
  guard: EpochGuard,
  apply: (data: T) => void,
  data: T,
): boolean {
  if (!guard.isCurrent(epoch)) return false
  apply(data)
  return true
}
