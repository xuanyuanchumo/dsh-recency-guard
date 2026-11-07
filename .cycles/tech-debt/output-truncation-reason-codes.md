# 技术债：输出截断原因码与 Next 恢复句（dsh-ops 模式）

- 登记时间：2026-11-08（cycle-6）
- 来源：参考插件研究（dsh-ops `lib/projections/native/render.js:43-60`）
- 现状：工具文本输出的省略部分已有显式计数（`omitted` 字段 +
  truncation 指标进 KPI 条），但缺少机器可读的**原因码**
  （worker-limit / output-budget / none）与可执行的 **Next 恢复句**
  （「用更小的 limit 重读原始区间」）。
- 建议：DisplaySection 增加 `truncatedBy?: 'list-limit' | 'width' | 'none'`；
  renderOutcome 尾部在有省略时输出一行 `Next:` 指令（告知调用方如何拿全量 ——
  data 字段永远有全量事实，文本层只需指路）。
- 影响面：tool-render.ts + 契约测试快照；不涉及存储词汇。
- 优先级：P2（当前「数据全量 + 显示省略计数」已满足诚实边界，原因码是增强）。
