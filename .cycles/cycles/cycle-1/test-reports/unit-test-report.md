# 分层单元测试报告（cycle-1）

## 1. 头部

| 字段 | 值 |
|---|---|
| 日期 | 2026-11-04 |
| 执行者 | lead（AI，ANIC L4 全自主） |
| 环境 | Node 24.14.0 / Windows / dsh 0.2.1-rc.5 / TypeScript 5.9 |
| 测试运行器 | `tsx tests/run.ts`（分层统一运行器） |

## 2. 执行命令与完整输出

```text
$ npm test

> dsh-recency-guard@0.2.0 test
> tsx tests/run.ts

运行 4 个测试文件：

  PASS  [Client] tests/client/viewport.test.ts
  PASS  [Contract] tests/contract/capability.test.ts
  PASS  [Core] tests/unit/core.test.ts
  PASS  [Host] tests/host/tool.test.ts

分层汇总：
  PASS  Client: 1/1
  PASS  Contract: 1/1
  PASS  Core: 1/1
  PASS  Host: 1/1

全部通过（4/4）
（退出码 0）
```

## 3. 断言汇总

| 层 | 文件 | 断言主题 | 结果 |
|---|---|---|---|
| Core | tests/unit/core.test.ts | 嫌疑分类/最近更新排序/版本比对、存储（journal 原子写+同步写）、能力图三类缺口、契约双向比对、状态机白名单迁移、风险模型、崩溃趋势（相邻间隔回归）、可观测性诚实边界（null≠0）、EWMA/中位数、风险排名、项目隔离（路径归一/分区索引/归档重置不继承旧结论）、图谱数据 | PASS |
| Host | tests/host/tool.test.ts | 从解出的 DSH runtime 挂载真实插件（fake services），验证工具注册、六个 action（status/history/recover/restore/reenable/backups）、崩溃决策发布、路由子插件软依赖 | PASS |
| Client | tests/client/viewport.test.ts | 视口缩放钳制、指针锚定缩放、坐标变换互逆、拖拽死锁防护、fit-to-view、空间网格命中、BFS 追溯、节点形状双通道、i18n 回退、响应形状校验 | PASS |
| Contract | tests/contract/capability.test.ts | 见 contract-test-report.md（清单↔注册处双向比对，100% 层） | PASS |

## 4. 失败与错误

- 失败（FAIL）：**0**
- 错误（ERROR）：**0**
- 已知 SKIP：无（分层测试无跳过逻辑）

## 5. 复现步骤

```bash
npm install        # 依赖安装（overrides zod ^4.6.7 / undici ^8.12.2）
npm test           # 分层测试
```

Host 层依赖解出的运行时：`npm run extract-runtime`（本仓库已就位 runtime/）。

## 6. 结论

分层测试 4/4 全部通过，零失败零错误。G2「测试报告零错误」的本层证据成立。
