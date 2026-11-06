# 计划（plan）—— cycle-1

> R09「计划模式优先」：本计划是实现的依据。实现偏离计划时，同提交更新本文件。

## 1. 本循环目标

把 dsh-recency-guard 从 v0.1（能防崩溃、能自动恢复）升级为 v0.2
（能力闭环可证、生命周期显式、可观测性量化、面板与图谱可用、归档可重置、
多项目隔离）。

## 2. 任务分解

| # | 任务 | 交付物 | 状态 |
|---|---|---|---|
| T1 | 能力模型：注册/生产/消费闭环 | `src/capability.ts`、`src/capability-specs.ts` | 完成 |
| T2 | 生命周期状态机 | `src/lifecycle.ts` | 完成 |
| T3 | 可观测性数学模型 | `src/observability.ts` | 完成 |
| T4 | 项目隔离 | `src/isolation.ts`、`src/store.ts`（分区）、`src/decision.ts`（指针） | 完成 |
| T5 | 归档重置 | `src/archive.ts` | 完成 |
| T6 | 观测面投影（面板快照 + 图谱数据） | `src/snapshot.ts`、`src/graph-data.ts` | 完成 |
| T7 | 宿主数据面路由 | `src/routes.ts`、`src/routes-plugin.ts` | 完成 |
| T8 | 客户端面板与可交互图谱 | `src/client/**` | 完成 |
| T9 | 分层测试体系 | `tests/run.ts`、`tests/{unit,host,client,contract}/` | 完成 |
| T10 | 契约层双向比对 | `tests/contract/capability.test.ts` | 完成 |
| T11 | 沙箱真机验证（崩溃→拦截→恢复→隔离） | 沙箱 profile `sb-rg` | 完成 |
| T12 | 技术债务清理（复杂度、未用符号、构建口径） | `dist/` 迁移 + 抽取模块 | 完成 |

## 3. 实现顺序与依赖

```
T1 能力模型 ──┬─→ T6 观测面投影 ──→ T8 面板/图谱
              └─→ T10 契约层
T2 状态机 ─────→ T6
T3 可观测性 ───→ T6
T4 隔离 ───────→ T7 路由（分区寻址）
T5 归档 ───────→ T8（面板动作）
```

## 4. 验证策略

| 层 | 命令 | 判据 |
|---|---|---|
| 类型 | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` | 零错误 |
| 构建 | `npm run build` | `dist/index.js` + `dist/client.js` 均产出 |
| 分层测试 | `npm test` | Core / Host / Client / Contract 四层均 PASS |
| 契约 | `tests/contract` | 能力清单 ↔ 注册面双向比对 `ok === true` |
| 真机 | 沙箱 profile `sb-rg` | 崩溃→拦截→正常启动；A 的崩溃不影响 B |
| 复杂度 | band-detector | 无文件超预算 |

## 5. 风险与对策

| 风险 | 对策 | 状态 |
|---|---|---|
| 守护行安装晚于崩溃 | 安装**同步**执行（`guarded-rows.ts`） | 已解决 |
| 决策写入与 Loader 求值竞态 | 决策在**崩溃退出那一刻**落盘 | 已解决 |
| 分区键表达式算不出 | 指针文件搭桥（profile 根 → 分区决策） | 已解决 |
| 并发工作区指针互指 | 显式承认边界；宁可过放行不可过拦截 | 已接受（写入文档） |
| 状态机出现非法组合 | 白名单迁移表 + 状态机 | 已解决 |
| 指标把「无数据」当「零」 | `Metric<T>` 用 `null` + `defined` 标志 | 已解决 |

## 6. 范围外（沿用 intent）

跨 profile 共享状态、通用插件市场、替换 DSH 自身 UI。
