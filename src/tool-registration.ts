/**
 * 工具注册 —— `recency_guard` 的**唯一定义处**（v0.12 从 index.ts 抽出）。
 *
 * ## 为什么要抽出来
 *
 * 1. **复杂度带**：`defineTool({...})` 内联在 apply() 里让 index.ts 的热点分
 *    越过预算 100（实测 109）。工具定义是一张**声明表**，不是控制流 ——
 *    它和守护流程混在一个文件里只会互相抬高读者的负担。
 * 2. **漂移面集中**：注册面（名字/action 枚举）来自 `TOOL_SURFACE`，展示投影
 *    来自 `tool-presentation`，文本投影来自 `tool-dispatch`。三者接线在同一个
 *    小文件里，「漏接一条」就变成了肉眼可见的形状缺失，而不是埋在 1600 行中。
 * 3. **可测**：注册结果的可测性不依赖 Guard 实例（deps 是窄接口），
 *    host 层测试对着真实 `defineTool` 产物断言三个投影方法存在。
 *
 * ## 接线纪律（这条是被踩出来的）
 *
 * `presentCall` / `presentResult` / `output.presentationMeta` **必须**在这里接上。
 * 只写好 `tool-presentation.ts` 的纯函数而不接线，宿主就落回通用回退：
 * 命令窗口显示裸工具名 + 整坨参数 JSON（v0.12 实测根因）。纯函数单测全绿
 * 也发现不了这件事 —— 所以 `tests/host/tool.test.ts` 断言的是
 * **「注册出来的工具对象上有这三个方法」**，并走宿主同一条数据流。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { TOOL_SURFACE } from './capability.js'
import { dispatchToolAction, renderToolOutcome, type ToolDispatchDeps } from './tool-dispatch.js'
import { presentCallOf, presentResultOf, presentationMetaOf } from './tool-presentation.js'

/** 只用到 `register` 一面 —— 窄接口让测试不必桩整个 ctx。 */
export interface ToolRegistrar {
  register(tool: unknown): void
}

/** 工具描述文案。 */
const TOOL_DESCRIPTION =
  '插件崩溃恢复守护：记录第三方/实验性插件的安装、更新日期与配置备份；崩溃后按“最近更新”自动关闭嫌疑插件（先关最近 1 个，仍崩溃则关最近 2 个），稳定后自动恢复需要的配置。' +
  'action=status 查看崩溃状态、嫌疑排名与自动关闭列表；action=history 查看安装更新日志；action=recover 立即按最近更新执行一次恢复关闭；' +
  'action=restore 重新启用被自动关闭的非嫌疑插件；action=reenable 手动重新启用某个插件；action=backups 列出配置备份；' +
  'action=archive 归档当前产物并重置（按最新事实重新开始）；action=archives 列出历史归档。'

/**
 * 构造并注册守护工具。
 *
 * @param tools 宿主的工具注册面（`ctx.tools`）
 * @param deps  action 分派所需的窄依赖（Guard 的方法子集 + Store）
 */
export function registerGuardTool(tools: ToolRegistrar, deps: ToolDispatchDeps): void {
  tools.register(
    defineTool({
      // 工具名与 action 枚举来自**注册表**（`TOOL_SURFACE`）：注册处不写字面量，
      // 因此「清单声明的名称」与「实际注册的名称」不可能各自漂移。
      name: TOOL_SURFACE.name,
      description: TOOL_DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          required: true,
          // 展开成数组：schema 要的是可变数组，`TOOL_SURFACE.actions` 是 readonly。
          enum: [...TOOL_SURFACE.actions],
          description: '要执行的操作。',
        },
        bundle: { type: 'string', description: 'reenable 的目标插件名（包名）。' },
        limit: { type: 'number', description: 'history 返回的事件条数，默认 40。' },
        reason: { type: 'string', description: 'archive 的归档原因（可选）。' },
      },
      // 规范输出：模型消费结构化事实；人读文本由 output.render 投影
      // （会话里的命令窗口显示的就是它，而不是满屏转义的 JSON）。
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: renderToolOutcome(value) }],
        // v0.12 接线：把规范值投影成**可回放的 UI 卡片模型**。
        // 为什么必须在 output 里而不是 execute 的返回值里：宿主把 presentationMeta
        // 的产物持久化在 `tool/result` 事件上（createSuccessResult 的 meta 分支），
        // 回放路径据此重建卡片；写进 data 会让模型上下文为显示字段付 token。
        presentationMeta: (_args, value) => presentationMetaOf(value),
      },
      // v0.12 接线：PENDING / COMPLETED 两张卡片的展示投影。
      // 此前 tool-presentation.ts 的三个纯函数**写好了却没接上**（实测：
      // `grep presentCall src/index.ts` 零命中），于是命令窗口落到宿主通用
      // 回退 —— 标题是裸工具名 `recency_guard`、正文是整坨原始参数 JSON，
      // 这正是「本插件调用时的命令窗口显示问题」的根因。
      // 声明后：待执行卡片显示「崩溃守护状态 · 最多 40 条」这类人话摘要，
      // 完成卡片显示带标题与摘要的折叠卡（宿主在 args 不合法时自行回退）。
      presentCall: (args) => presentCallOf(args),
      presentResult: (args, result) => presentResultOf(args, result),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        // action 分派见 tool-dispatch.ts（表驱动；契约测试从表里对账 enum）。
        return dispatchToolAction(
          deps,
          String(args.action),
          { bundle: args.bundle, limit: args.limit, reason: args.reason },
        )
      },
    }),
  )
}
