# 计划（plan）—— dsh-recency-guard 自举循环迭代升级（L4）

> R09「计划模式优先」：本文件是 E2「规格符合」门禁的意图级计划，
> 与 `.cycles/cycles/cycle-1/plan.md`（循环级计划）互为引用：
> 前者回答「这个自举循环按什么阶段走」，后者回答「每个任务怎么交付」。

## 1. 本循环目标

把 dsh-recency-guard 从 v0.2（R1-R9 已实现、四层测试已绿）推进到
**v0.3 可交付**：补齐证据链、跑通 G0-G3 门禁与六阶段流转、归档重置后
按最新事实重跑自举与「举他」、沙箱干净安装验证 + 正反向用户旅程 100% 通过、
最后更新桌面端 dsh 的本插件。

## 2. 阶段计划（六阶段 × L4 全自主）

| 阶段 | 目标 | 产出 | 门禁 |
|---|---|---|---|
| plan | 意图与规格就绪；审计缺口 | intent.md / spec.md / 本文件 | G0（Q1+Q5） |
| design | 规格复核：需求→实现→验证对照无漂移 | spec.md 更新（如有偏离） | G0 |
| build | 缺口修复（Q4 依赖审计、证据链、技术债） | 代码 + 测试 + 报告 | G1（Q7） |
| test | 分层测试 + 沙箱真机正反向旅程 | test-reports/*.md | G2（Q2） |
| deploy | 版本升级 0.3.0 + 桌面端安装 | 交付清单 / dist 产物 | G3（Q3+Q4） |
| maintain | 复盘 + 已知边界登记 | 复盘记录 | 控制带 |

## 3. 任务分解

| # | 任务 | 交付物 | 状态 |
|---|---|---|---|
| P1 | Q4 依赖审计通道修复（.npmrc 官方 registry + overrides zod ^4.6.7 / undici ^8.12.2） | package.json / .npmrc | 完成（audit high:0 critical:0） |
| P2 | git 真相源建立（首个提交，提交链即审计轨迹） | git log | 完成（2dd9dd5） |
| P3 | 证据链补齐（plan / 测试报告 / 交付清单 / 审计日志 / 非功能报告 / 页面状态 / CLAUDE.md） | .cycles/** | 完成 |
| P4 | ANIC L4 循环执行（评估→门禁→阶段推进→复杂度带→HITL→复盘） | gate ledger / 评估报告 | 进行中 |
| P5 | 归档重置 + 按最新事实重跑自举 + 举他（源工作区零写入） | .cycles/archive/** | 进行中 |
| P6 | 沙箱干净安装 + 正反向用户旅程（崩溃→拦截→恢复→隔离→负向场景） | sandbox-journey-report.md | 进行中 |
| P7 | 版本升级 0.3.0 + 桌面端插件安装验证 | package.json / desktop profile | 待 P6 通过 |
| P8 | 最终门禁汇总 + 目标完成 | 账本 + 报告 | 待 P4-P7 |

## 4. 依赖顺序

```
P1 Q4 修复 ──┐
P2 git 基线 ─┼→ P3 证据链 → P4 门禁循环 → P6 沙箱旅程 → P7 版本+桌面端 → P8 收口
P5 归档/举他 ─┘                          （P5 与 P4-P6 并行）
```

## 5. 验证策略

| 层 | 命令 | 判据 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 零错误 |
| Lint | `npm run lint` | 零错误 |
| 构建 | `npm run build` | dist/index.js + dist/client.js |
| 分层测试 | `npm test` | Core/Host/Client/Contract 4/4 PASS |
| 依赖审计 | `npm audit --json` | high:0 critical:0 |
| 复杂度带 | band-detector | overBudgetCount 0 |
| 沙箱真机 | sb-rg-journey profile | 正反向旅程 100% |
| 门禁 | gate-check --quality --record | G0-G3 全 PASS 入账 |

## 6. 风险与对策

| 风险 | 对策 | 状态 |
|---|---|---|
| Q4 审计在镜像源不可用（404） | .npmrc 指向官方 registry；离线退化 --offline | 已解决 |
| dev 依赖链漏洞（zod/undici） | overrides 提升到已修版本（不动 peer 对齐） | 已解决 |
| 沙箱验证影响主力 profile | 独立 sb-rg-journey profile；绝不碰 desktop/web | 纪律 |
| 桌面端安装破坏现有 profile | 先沙箱通过；install_bundle 官方通道；失败可回滚 | 待执行 |
| 归档重置丢证据 | 搬走+留档语义；manifest 在搬走前读状态 | 已实现 |

## 7. 范围外（沿用 intent §3）

通用插件市场、跨 profile 共享状态、替换 DSH 自身插件管理 UI。
