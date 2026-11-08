# cycle-6 意图：dsh-recency-guard v0.11.0 迭代升级

> 时间：2026-11-08。上游事实：v0.10.0 已发布 npm + GitHub（仓库创建 2026-11-07），
> cycle-5 五段沙箱用户旅程全过、G0-G3 全绿。仓库 topics 缺失（本循环补齐），
> awesome-dsh-plugin 市场未收录。

## 1. 本次迭代要解决的问题（来自用户直接需求）

| # | 需求 | 现状 | 目标 |
|---|------|------|------|
| R1 | 参考插件取长补短 | 未系统研究 dsh-ops/dsh-context/dsh-compat-guardian/dsh-cookie-guard | 研究报告 + 采纳清单落地 |
| R2 | 命令窗口显示完善 | v0.10 已修 CJK 宽度/注入/折行 | 复检全部 8 个 action 的显示质量，修复残留 |
| R3 | 可观测性（量化/白盒/流动） | EWMA/CUSUM/马尔可夫/生存分析/控制带已齐 | 补数据流四环链路的**流动动画可视化**（面板） |
| R4 | 管理面板完善 | 已现代化（KPI 条/折叠/限高/响应式） | 按 Q6 审计结果补交互缺口 |
| R5 | 图谱可视化交互增强 | 已有缩放/拖拽/搜索/布局切换/邻居导航 | 按审计结果补齐（图例/边点击/聚焦模式等） |
| R6 | 项目隔离不污染 | 分区机制完整（projectKey + partition index） | 契约测试确认零串扰 |
| R7 | 归档后按最新事实重跑 | archive = 搬走+留档（manifest 先读后搬） | 沙箱旅程覆盖「归档→重置→新事实自举」 |
| R8 | 热更新重载 | update-guide 已规范 dist/src 两类边界 | 沙箱验证 disable→enable 重载 client |
| R9 | 防崩溃自举 | 核心使命（守护行三层防线） | 回归测试 + 沙箱对抗验证 |
| R10 | docs/agents 开发文档 | 6 篇已齐 | 同步 v0.11 变更 |
| R11 | 市场收录 | topics 缺失（已补）、未投稿 | README 锚点检查 + 投稿 YAML 内容备好 |
| R12 | npm + GitHub 发布 | 0.10.0 已发布 | 0.11.0 发布（npm publish + gh release，ssh 优先） |

## 2. 范围外

- 不改 ANIC 技能本身（dsh-anic 是另一个项目）。
- 不替换 DSH 自带插件管理 UI。
- 不做跨 profile 共享状态。

## 3. 验收判据

1. build → typecheck → lint → test 全零错误（16 维评估 Q2 需测试报告落盘后转 PASS）。
2. 沙箱（sb-rg-* 独立 profile）干净安装 + 用户旅程正反向 100% 通过。
3. 桌面端 desktop profile 更新为本版本且面板可开（用户重启授权边界遵守）。
4. npm publish 0.11.0 成功；GitHub tag v0.11.0 + release 发布成功。
5. docs/agents 与 README 同步 v0.11 变更；投稿 YAML 按 contributing.md 形态备好。
