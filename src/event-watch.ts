import { describeError } from './recency.js'

/**
 * 事件驱动加速器（v0.8.1）—— 订阅宿主 `plugin-manager/changed`。
 *
 * ## 回答「轮询会不会影响性能」
 *
 * 本插件**没有轮询**：面板数据是前端每 5s 拉 HTTP 路由（读内存快照，
 * 不扫磁盘）；宿主侧的变更检测只在**启动时**跑一次。真正贵的是扫
 * node_modules 的 mtime（O(声明插件数) 次 stat）—— compat-guardian
 * 每 30s 全量爬一遍的做法实测不可取（真机取证报告：高频 realpath
 * 逐目录爬取是它最大的成本项），本插件不采纳。
 *
 * 事件驱动的价值：用户在 GUI 里装/升插件的瞬间（不等重启）就能进
 * 时间线与嫌疑面 —— 这接近「安装/更新时触发」的诉求：事件在变更
 * **完成后**发（含 failed），我们立刻 diff + 备份新版本，下次崩溃时
 * 证据已经在盘上。
 *
 * ## 防抖与降级
 *
 * - 事件可能在一次操作里连发（install → enable）：500ms 尾缘防抖合并；
 *   防抖后的检测本身带快照 diff，重复跑也是幂等的。
 * - 宿主事件面不可用（旧版/裁剪版宿主，`ctx.on` 缺席或抛错）时静默
 *   降级为纯启动检测 —— 可选能力缺席不是错误（tryReadService 同款纪律）。
 * - Node 的 setTimeout 不阻进程退出，无需 unref（运行在宿主进程内，
 *   宿主有自己的生命周期）。
 *
 * @param ctx 宿主 cordis ctx（读可选的 `on`）
 * @param detect 事件触发的检测动作（幂等）
 * @param onWatched 订阅成功回调（生命周期步骤记录）
 * @param onError 事件触发的检测失败回调
 * @returns 取消订阅的 disposer（同步、幂等；无法订阅时为 no-op）
 */
export function watchPluginChanges(
  ctx: unknown,
  detect: () => Promise<void>,
  onWatched?: (message: string) => void,
  onError?: (message: string) => void,
): () => void {
  try {
    const onFn = (ctx as unknown as { on?: (name: string, listener: (payload: unknown) => void) => unknown }).on
    if (typeof onFn !== 'function') return () => {}
    let pending = false
    const listener = (): void => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        void detect().catch((err: unknown) => {
          onError?.(`[recency-guard] 事件触发的变更检测失败：${describeError(err)}`)
        })
      }, 500)
    }
    const disposer = onFn.call(ctx, 'plugin-manager/changed', listener)
    onWatched?.('已订阅 plugin-manager/changed')
    return typeof disposer === 'function' ? (disposer as () => void) : () => {}
  } catch {
    // 事件面缺席：静默降级，启动时 diff 兜底。
    return () => {}
  }
}
