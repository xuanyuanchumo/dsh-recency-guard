# 技术债：面板 ErrorBoundary 与条件续轮询

- 登记时间：2026-11-08（cycle-6）
- 来源：参考插件研究（dsh-compat-guardian client.js ErrorBoundary + rr hook）
- 现状：
  1. 面板渲染抛错会白屏（无 React 错误边界兜底）；数据面失败已有诚实失败态，
     但「渲染本身崩溃」没有 UI 兜底。
  2. 轮询固定 5s（GuardPanel.tsx POLL_INTERVAL）：数据稳定时也在轮，
     数据剧变时等 5s。
- 建议：
  1. GuardPanel 外包一层 ErrorBoundary 类组件（「面板崩溃了 + 重试加载」按钮，
     不拖垮宿主侧栏）。
  2. 轮询间隔按快照内容哈希自适应：内容连续 N 轮不变则退避到 15s，
     内容变化则回到 5s（下限 3s，上限 30s）——「事件驱动+稳定退避」。
- 影响面：src/client/GuardPanel.tsx（+ErrorBoundary 新文件）；轮询契约变更需
  docs/agents/api.md 同步。
- 优先级：P2。
