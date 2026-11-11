# 能力清单与双向比对口径（v0.17.0）

> 本文回答三个问题：**这个插件对外承诺了哪些能力**、**每条能力在注册面/生产面/消费面的落点**、
> **"清单没漏、注册没虚"这件事由谁证明**。
>
> 事实基座纪律：本文的能力 id、对外名称、代码路径全部来自
> [`capability-specs.ts`](../../src/host/capability/capability-specs.ts)、
> [`capability.ts`](../../src/host/capability/capability.ts)、
> [`routes.ts`](../../src/host/surface/routes.ts) 与
> [`tool-registration.ts`](../../src/host/surface/tool-registration.ts)；
> 任何一条都能在这些文件里逐字 grep 到。

## 1. 三层关系（Definition / Provider / Consumer）

| 层 | 在哪里 | 是什么 |
| --- | --- | --- |
| Definition | `src/shared/graph-contract.ts` + `capability.ts` 的 `CapabilityRecord` | 能力 / 事实 / 载体的词汇与类型 |
| Provider | 注册处：`TOOL_SURFACE`（工具）、`ROUTE_SURFACE`（路由）、`client/index.ts`（面板席位） | 真正"把名字交给宿主"的地方 |
| Consumer | 工具 action 分派、面板轮询、图谱渲染、CLI 只读/可写 | 读事实并呈现 / 行动的地方 |

**能力的真相在 Provider 的注册处，不在清单里。** 清单只是投影——它让"有哪些能力"这个问题
可以被测试回答，而不是靠人读 60 个文件。

### 1.1 实现模块 ≠ 能力（v0.16 口径）

v0.16 新增的 `conflict-declarations.ts` / `conflict-findings.ts` / `conflict-metadata.ts` /
`quarantine-plan.ts` / `crash-decision.ts` / `boot-orchestration.ts` / `state-reconcile.ts` /
`lock-hygiene.ts` 是**既有能力的实现拆分**，不是新能力 id：

- `conflict-*` 与 `crash-decision` 喂给 `guard.decide.suspects` / `guard.recover.apply`；
- `quarantine-plan` 是 `guard.recover.apply` / `guard.recover.manual` 的计划器；
- `boot-orchestration` 是启动编排（`guard.observe.crash` / `guard.observe.state` 的消费者）；
- `state-reconcile` 是崩溃状态补账（决策文件为真相，`guard.observe.state` 的写后修复）；
- `lock-hygiene` 属于 `guard.observe.state` 的写安全；
- `schema-version` / `journal-io` 是 `guard.observe.state` 的数据文件版本判据与 journal 文本层；
- `preventive-view` 是 `guard.observe.metrics` 的生产消费者（RQ3 闭环：只预警不行动字段进
  `PanelSnapshot` / `status` / 面板）；`preventive` 自身仍不是能力 id —— 能力清单按**对外名称/action/路由**
  比对，数据字段的新增不改变能力条数。

因此 `CAPABILITY_SPECS.length` 仍为 **22**（未新增 id），注册面仍是
9 路由 + 1 工具名（8 action）+ 2 面板席位 —— 双向比对口径不变，契约测试
`tests/contract/capability.test.ts` 仍以「注册 ⊃ 清单 / 清单 ⊃ 注册」两侧核对。
**只有当对外名称 / action / 路由 / `hostServices` 变化时，才需要新增或改能力 id。**

## 2. 对外暴露面（三个注册真值）

### 2.1 工具：`recency_guard`（1 个注册名，8 个 action）

注册真值：[`TOOL_SURFACE`](../../src/host/capability/capability.ts) →
[`registerGuardTool`](../../src/host/surface/tool-registration.ts)。

| action | 承载能力 |
| --- | --- |
| `status` | `guard.tool.status` |
| `history` | `guard.tool.history` |
| `recover` | `guard.recover.manual` |
| `restore` | `guard.recover.restore` |
| `reenable` | `guard.recover.reenable` |
| `backups` | `guard.tool.backups` |
| `archive` | `guard.govern.reset` |
| `archives` | `guard.govern.archive` |

### 2.2 路由：前缀 `/recency-guard/api`（9 条，读 5 + 写 4）

注册真值：[`ROUTE_SURFACE` / `ROUTE_PATHS`](../../src/host/surface/routes.ts)。
路径是**字面量**，契约测试逐字核对；动作路由只接受 POST，过期凭证返回 409 且不执行。

| 方法 | 路径 | 对外名 | 承载能力 |
| --- | --- | --- | --- |
| GET | `/recency-guard/api/snapshot` | `recency-guard.panel` | `guard.present.panel` |
| GET | `/recency-guard/api/graph` | `recency-guard.graph` | `guard.present.graph` |
| GET | `/recency-guard/api/isolation` | `recency-guard.isolation` | `guard.govern.isolation` |
| GET | `/recency-guard/api/lifecycle` | `recency-guard.lifecycle` | `guard.observe.lifecycle` |
| GET | `/recency-guard/api/archives` | `recency-guard.archives` | `guard.govern.archive` |
| POST | `/recency-guard/api/action/archive` | `recency-guard.reset` | `guard.govern.reset` |
| POST | `/recency-guard/api/action/reenable` | `recency-guard.reenable` | `guard.recover.reenable` |
| POST | `/recency-guard/api/action/restore` | `recency-guard.restore` | `guard.recover.restore` |
| POST | `/recency-guard/api/action/recover` | `recency-guard.recover` | `guard.recover.manual` |

### 2.3 面板席位（2 个，客户端注册）

注册真值：[`client/index.ts`](../../src/client/index.ts) 的 `PANEL_ID = 'recency-guard'`：

| 席位 | 形态 | id / key |
| --- | --- | --- |
| `main` | keyed（中央面板） | `recency-guard` |
| `sidebar.panellist` | list（侧栏图标） | `recency-guard` |

两者 id 必须一致，侧栏据此把图标与中央面板对应起来；不一致的症状是"点了图标没反应"。

## 3. 22 条能力：生产 → 消费

字段方向（写反过一次，已在 `capability.ts` 用命名钉死）：

- `consumes` = **我消费谁**（我读它的产出）；
- `consumedBy` = **谁消费我**（它读我的产出）。

| 能力 id | 生产 | 消费 | 对外名 | 代码 | 测试 |
| --- | --- | --- | --- | --- | --- |
| `guard.observe.journal` | journal | 指标 / 面板 / history / 决策 / 归档 / revision | — | [`store.ts`](../../src/host/data/store.ts) | [`core.test.ts`](../../tests/unit/core.test.ts) |
| `guard.observe.crash` | crash | 决策 / 指标 / 生命周期 | — | [`sentinel.ts`](../../src/host/guard/sentinel.ts)、[`abnormal-boot.ts`](../../src/host/guard/abnormal-boot.ts) | [`fault-injection.test.ts`](../../tests/fault-injection/fault-injection.test.ts) |
| `guard.observe.state` | state | 面板 / 图谱 / 生命周期 / 重置 / 隔离 / 归档 / status / revision | — | [`store.ts`](../../src/host/data/store.ts)、[`state-reconcile.ts`](../../src/host/guard/state-reconcile.ts)、[`boot-orchestration.ts`](../../src/host/guard/boot-orchestration.ts)、[`schema-version.ts`](../../src/host/data/schema-version.ts)、[`journal-io.ts`](../../src/host/data/journal-io.ts) | [`state-reconcile.test.ts`](../../tests/unit/state-reconcile.test.ts)、[`pure-projections.test.ts`](../../tests/unit/pure-projections.test.ts)、[`journal-append-race.test.ts`](../../tests/unit/journal-append-race.test.ts)、[`boot-crashseq-race.test.ts`](../../tests/unit/boot-crashseq-race.test.ts) |
| `guard.observe.lifecycle` | state | 面板 / 图谱 | `recency-guard.lifecycle` | [`lifecycle.ts`](../../src/host/core/lifecycle.ts) | [`lifecycle-steps.test.ts`](../../tests/unit/lifecycle-steps.test.ts) |
| `guard.observe.config` | backup | 证据链 / backups | — | [`store.ts`](../../src/host/data/store.ts) | [`versioned-backup.test.ts`](../../tests/unit/versioned-backup.test.ts) |
| `guard.observe.metrics` | metric | 面板 / 图谱 / status / 生命周期 | — | [`observability.ts`](../../src/host/observe/observability.ts)、[`preventive.ts`](../../src/host/observe/preventive.ts)、[`preventive-view.ts`](../../src/host/surface/preventive-view.ts) | [`observability-math.test.ts`](../../tests/unit/observability-math.test.ts)、[`preventive-wiring.test.ts`](../../tests/unit/preventive-wiring.test.ts) |
| `guard.decide.suspects` | decision | 恢复 / 手动恢复 / 图谱 / 面板 / status / 风险 / revision | — | [`recency.ts`](../../src/host/risk/recency.ts)、[`conflict-declarations.ts`](../../src/host/guard/conflict-declarations.ts)、[`conflict-findings.ts`](../../src/host/guard/conflict-findings.ts)、[`crash-decision.ts`](../../src/host/guard/crash-decision.ts) | [`decision-evidence.test.ts`](../../tests/unit/decision-evidence.test.ts)、[`conflict-findings.test.ts`](../../tests/unit/conflict-findings.test.ts)、[`deterministic-evidence.test.ts`](../../tests/unit/deterministic-evidence.test.ts) |
| `guard.decide.risk` | metric | 面板 / 图谱 | — | [`risk-bayes.ts`](../../src/host/risk/risk-bayes.ts)、[`risk-calibration.ts`](../../src/host/risk/risk-calibration.ts) | [`risk-bayes.test.ts`](../../tests/unit/risk-bayes.test.ts) |
| `guard.recover.apply` | decision | 证据链 | — | [`crash-decision.ts`](../../src/host/guard/crash-decision.ts)、[`quarantine-plan.ts`](../../src/host/guard/quarantine-plan.ts)、[`decision.ts`](../../src/host/guard/decision.ts)、[`guarded-rows.ts`](../../src/host/guard/guarded-rows.ts) | [`quarantine-plan.test.ts`](../../tests/unit/quarantine-plan.test.ts)、[`crash-decision.test.ts`](../../tests/unit/crash-decision.test.ts)、[`patch-safety.test.ts`](../../tests/unit/patch-safety.test.ts) |
| `guard.recover.evidence` | backup | 恢复 / 重启用 / backups | — | [`recovery-actions.ts`](../../src/host/guard/recovery-actions.ts) | [`versioned-backup.test.ts`](../../tests/unit/versioned-backup.test.ts) |
| `guard.recover.restore` | state | 面板 | `recency_guard` / `recency-guard.restore` | [`recovery-actions.ts`](../../src/host/guard/recovery-actions.ts) | [`core.test.ts`](../../tests/unit/core.test.ts) |
| `guard.recover.reenable` | state | — | `recency_guard` / `recency-guard.reenable` | [`recovery-actions.ts`](../../src/host/guard/recovery-actions.ts) | [`core.test.ts`](../../tests/unit/core.test.ts) |
| `guard.recover.manual` | decision | — | `recency_guard` / `recency-guard.recover` | [`crash-decision.ts`](../../src/host/guard/crash-decision.ts)、[`quarantine-plan.ts`](../../src/host/guard/quarantine-plan.ts)、[`recovery-actions.ts`](../../src/host/guard/recovery-actions.ts) | [`crash-decision.test.ts`](../../tests/unit/crash-decision.test.ts)、[`tool.test.ts`](../../tests/host/tool.test.ts) |
| `guard.govern.archive` | archive | 重置 / 面板 | `recency-guard.archives` / `recency_guard` | [`archive.ts`](../../src/host/data/archive.ts) | [`core.test.ts`](../../tests/unit/core.test.ts) |
| `guard.govern.reset` | state | — | `recency_guard` / `recency-guard.reset` | [`archive.ts`](../../src/host/data/archive.ts) | [`core.test.ts`](../../tests/unit/core.test.ts) |
| `guard.govern.isolation` | state | 面板 / 指标 | `recency-guard.isolation` | [`isolation.ts`](../../src/host/core/isolation.ts) | [`isolation-journey.test.ts`](../../tests/host/isolation-journey.test.ts) |
| `guard.govern.revision` | state | 面板 / restore / reenable / recover / reset | —（随快照下发） | [`change-guard.ts`](../../src/host/core/change-guard.ts)、[`store.ts`](../../src/host/data/store.ts)（加锁读） | [`change-guard.test.ts`](../../tests/unit/change-guard.test.ts)、[`decision-concurrency.test.ts`](../../tests/unit/decision-concurrency.test.ts) |
| `guard.present.panel` | graph | — | `recency-guard.panel` | [`GuardPanel.tsx`](../../src/client/panel/GuardPanel.tsx)、[`snapshot-view.ts`](../../src/client/panel/snapshot-view.ts)、[`poll-adaptive.ts`](../../src/client/panel/poll-adaptive.ts)、[`PanelShell.tsx`](../../src/client/panel/PanelShell.tsx) | [`panel-v014.test.ts`](../../tests/client/panel-v014.test.ts)、[`panel-null-snapshot.test.ts`](../../tests/client/panel-null-snapshot.test.ts)、[`poll-adaptive.test.ts`](../../tests/client/poll-adaptive.test.ts) |
| `guard.present.graph` | graph | — | `recency-guard.graph` | [`GuardGraph.tsx`](../../src/client/graph/GuardGraph.tsx)、[`graph-interaction.ts`](../../src/client/graph/graph-interaction.ts)、[`graph-layout.ts`](../../src/client/graph/graph-layout.ts)、[`graph-palette.ts`](../../src/client/graph/graph-palette.ts) | [`graph-model.test.ts`](../../tests/client/graph-model.test.ts)、[`graph-keyboard.test.ts`](../../tests/client/graph-keyboard.test.ts)、[`graph-hover.test.ts`](../../tests/client/graph-hover.test.ts)、[`graph-drag.test.ts`](../../tests/client/graph-drag.test.ts) |
| `guard.tool.status` | metric | — | `recency_guard` | [`status-view.ts`](../../src/host/surface/status-view.ts)、[`tool-render.ts`](../../src/host/surface/tool-render.ts) | [`tool.test.ts`](../../tests/host/tool.test.ts)、[`unresolved-surfacing.test.ts`](../../tests/unit/unresolved-surfacing.test.ts) |
| `guard.tool.history` | journal | — | `recency_guard` | [`tool-dispatch.ts`](../../src/host/surface/tool-dispatch.ts) | [`tool.test.ts`](../../tests/host/tool.test.ts) |
| `guard.tool.backups` | backup | — | `recency_guard` | [`tool-dispatch.ts`](../../src/host/surface/tool-dispatch.ts) | [`versioned-backup.test.ts`](../../tests/unit/versioned-backup.test.ts) |

统计口径：截至本文件落盘，**22 条能力**（以 `CAPABILITY_SPECS.length` 为准，新增能力必须同步本表），
其中 12 条对外暴露；**9 条路由 + 1 个工具名（8 个 action）+ 2 个面板席位** 构成注册面。

## 4. 双向比对的四类判据

[`verifySurfaceAlignment`](../../src/host/capability/capability-specs.ts) 一次跑完两侧：

| 方向 | 判据 | 缺口 kind |
| --- | --- | --- |
| 清单 ⊃ 注册 | 声明暴露的能力必须至少有一个注册位点（工具名 / 路由名） | `unregistered-capability` |
| 注册 ⊃ 清单 | 注册面上的 tool action / 路由暴露名必须被某个能力声明 | `action-not-declared` / `undeclared-registration` |
| action 细化 | `exposedActions` 必须与 `TOOL_SURFACE.actions` 双向一致 | `action-not-registered` / `action-not-declared` |
| 宿主依赖 | `hostServices` 与真实 `inject` 面双向一致 | `host-service-not-injected` / `host-service-not-declared` |

另有连通性分析 [`CapabilityGraph.analyze()`](../../src/host/capability/capability.ts)：

- 消费了不存在 / 不承认我的上游 ⇒ **消费断链**；
- 非暴露能力没有任何下游 ⇒ **过度生产**（产出无人读）；
- 既不生产也不消费 ⇒ **孤立能力**。

## 5. 新增能力时的检查单（五处缺一即缺口）

1. `capability-specs.ts` 加清单条目（id / produces / consumes / consumedBy / stage / hostServices）；
2. 注册处加位点：工具 action 进 `TOOL_SURFACE.actions`，路由进 `ROUTE_PATHS` + `ROUTE_SURFACE`；
3. `tests/contract/capability.test.ts` 跑通（双向比对，不允许只在清单里存在）；
4. 快照 / 工具输出字段有消费点（不允许"生产了但没人读"）；
5. 面板或命令窗口能看到它（否则用户视角等于不存在）。

## 6. 复核命令

```bash
npm test                                              # 84 项（Core 42 / Host 10 / Client 24 / Contract 8）
npx tsx tests/contract/capability.test.ts             # 只跑能力双向比对
npx tsx tests/contract/install-resilience.test.ts     # optional peer 不得静态 import
npx tsx tests/contract/panel-snapshot-nullability.test.ts  # 面板可空契约
npx tsx tests/unit/state-reconcile.test.ts             # 决策文件→state 补账
npx tsx tests/unit/journal-append-race.test.ts         # journal 真追加（不覆盖崩溃事件）
npx tsx tests/unit/preventive-wiring.test.ts           # RQ3 生产消费者 + 关闭链路零依赖
npx tsx tests/contract/width-parity.test.ts            # rescue/宿主宽度跨实现对拍
```

判据：全部 0 失败。契约门只通过、不会失败 = 没有门；每条门都有变异自证记录
（见 [`docs/agents/verification.md`](./verification.md) §1）。