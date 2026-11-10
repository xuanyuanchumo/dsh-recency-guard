/**
 * 面板投影函数的**统一再导出**（测试入口）。
 *
 * 为什么需要这个文件：panel-model.ts 的 import 面向客户端 bundle
 * （`.ts` 后缀 + i18n 依赖 localStorage 探测链），测试环境直接导入
 * 会在 i18n 的 DOM 探测处走默认分支 —— 可行但把「测试要的纯函数」
 * 与「客户端加载面」绑在一起。这个出口只 re-export 投影函数，
 * 让测试可以按需挑选，也让「投影面」有一个显式的清单。
 *
 * 注意：不能在这里写任何新逻辑 —— 它是出口不是实现。
 */
export {
  dataFlowStages,
  decisionEvidenceRows,
  diagnosticsRows,
  markovView,
  metricRows,
  type DataFlowStage,
  type DecisionEvidenceRow,
  type DiagnosticsRow,
  type MarkovRowView,
} from '../src/client/panel/panel-model.ts'
