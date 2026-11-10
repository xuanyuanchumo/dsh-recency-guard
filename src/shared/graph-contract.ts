/**
 * 跨运行时**契约定义层**（definition layer）。
 *
 * ## 为什么需要它（v0.15 架构重构的核心）
 *
 * dsh 的能力 seam 有三种角色：**Service Definition / Provider / Consumer**。
 * Definition 是契约，Provider 与 Consumer **互不依赖**，但两者都依赖 Definition。
 *
 * 本包的 `host/` 与 `client/` 是**两个运行时**（浏览器没有 `node:*`、没有进程）。
 * 重构后 client 不得 import `src/host/**`。但图谱的**类型**与**布局常量**
 * 是双方共用的词汇：
 * - host 产出 `GraphData`；
 * - client 渲染它、并按 `LAYOUT` 算坐标。
 *
 * 若把两者放进 host，client 就必须跨界（本项目的边界契约测试会红）：
 * `src/client/graph/graph-model.ts → ../../host/capability/graph-data.ts`。
 * 若让 client 各写一份，就会出现「两套列宽」这类必然漂移。
 *
 * 正确形态就是 dsh 的 Definition 角色：**一个只含类型与纯常量的模块，
 * 谁都可以依赖它，它谁也不依赖**。
 *
 * ## 纪律（必须遵守，否则定义层退化成第二个实现）
 *
 * 1. **只放类型、纯常量、无副作用的纯函数**。不放 IO、不放状态、不放 React。
 * 2. **不得 import `host/` 或 `client/`**：定义层反过来依赖实现，
 *    就又把边界搅乱了（会形成 host↔shared↔client 的隐性耦合）。
 * 3. 允许 import `node:*` 吗？**不允许** —— 它会被 client 引用，
 *    而浏览器没有 node。当前文件确实一个内建模块都没用。
 */

/**
 * 守护生命周期阶段 —— **全产品共享的状态词汇**。
 *
 * 为什么放在定义层而不是 `host/core/lifecycle.ts`：阶段是 host 状态机的
 * 内部状态，但它同时出现在**面板**（client 渲染阶段条与迁移历史）里。
 * 让 client 依赖 host 的状态机实现，等于把一个浏览器 bundle 绑到
 * 「宿主状态机怎么实现」上；而阶段词汇本身是稳定契约。
 */
export type GuardStage =
  | 'idle' // 空闲：已安装但没有需要守护的对象
  | 'monitoring' // 监控中：正常运行，记录安装/更新
  | 'crashed' // 崩溃：检测到上一次非正常退出
  | 'deciding' // 决策中：正在计算关闭哪些嫌疑插件
  | 'stabilizing' // 稳定中：已成功启动，准备恢复配置
  | 'recovered' // 已恢复：稳定运行且配置已恢复

/** 所有合法状态（穷举，供面板与测试使用）。 */
export const ALL_STAGES: readonly GuardStage[] = [
  'idle',
  'monitoring',
  'crashed',
  'deciding',
  'stabilizing',
  'recovered',
] as const

/** 阶段的中文标签（面板与命令窗口共用，避免两处文案漂移）。 */
export const STAGE_LABELS: Record<GuardStage, string> = {
  idle: '空闲',
  monitoring: '监控中',
  crashed: '崩溃',
  deciding: '决策中',
  stabilizing: '稳定中',
  recovered: '已恢复',
}

/** 节点类型。 */
export type GraphNodeKind =
  | 'capability' // 能力节点
  | 'stage' // 生命周期阶段节点
  | 'metric' // 指标节点
  | 'bundle' // 插件节点（嫌疑排名）
  | 'gap' // 缺口节点（断链 / 过度生产 / 孤立）

/** 节点形状 —— 颜色之外的第二通道。 */
export type GraphShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon'

/** 语义色（供主题变量映射，不是最终颜色）。 */
export type GraphTone = 'neutral' | 'info' | 'success' | 'warn' | 'error'

/** 一个图节点。 */
export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label: string
  /** 副标题（度量值 / 计数）。 */
  detail?: string
  shape: GraphShape
  tone: GraphTone
  /** 布局坐标（世界坐标，由 layoutGraph 计算）。 */
  x: number
  y: number
  /** 所属列（分层索引）。 */
  column: number
  /** 语义上的度量值（用于排序与色阶）。 */
  weight?: number
  /** 该节点代表的真实对象（能力 id / 插件名 / 阶段名）。 */
  ref?: string
}

/** 一条图边。 */
export interface GraphEdge {
  id: string
  from: string
  to: string
  label?: string
  /** 边的语义类型。 */
  kind: 'produces' | 'consumes' | 'transitions' | 'ranks'
  tone: GraphTone
}

/** 一张图。 */
export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 图的边界（布局后计算，供 fit-to-content）。 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** 分层说明（列 → 阶段名）。 */
  columns: Array<{ index: number; label: string; stage?: GuardStage }>
}

/**
 * 布局常量 —— **host 布局算法与 client 命中测试/小地图必须用同一组数字**。
 *
 * 为什么导出常量而不是各自算：小地图的点击坐标 → 世界坐标的换算依赖列宽/行高；
 * 若 client 自己写一份，host 调整列宽后小地图的点击就会整体偏移（且不报错）。
 */
export const LAYOUT = {
  /** 列间距。 */
  columnGap: 260,
  /** 行间距。 */
  rowGap: 76,
  /** 节点宽（卡片式）。 */
  nodeWidth: 200,
  /** 节点高。 */
  nodeHeight: 56,
  /** 画布内边距。 */
  padding: 40,
} as const