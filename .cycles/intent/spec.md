# 规格（spec）—— dsh-recency-guard v0.2

> E2「规格符合」门禁以本文件为准。每条需求对应实现位置与验证方式。

## 1. 模块地图

```
src/
├── index.ts            宿主入口（Loader 四件套：name / inject / Config / apply）
│   ├── apply()         组装：分区登记 → 路由子插件 → 工具注册 → 崩溃哨兵
│   └── Guard           守护流程：启动记录 / 崩溃决策 / 恢复 / 观测面
├── capability.ts       能力图（邻接表 + 双向可达性分析）
├── capability-specs.ts 能力清单（投影，非第二真相源）
├── lifecycle.ts        生命周期状态机 + 风险模型 + 崩溃趋势模型
├── observability.ts    量化指标（Metric<T>：null 表示不可判定）+ 统计工具
├── isolation.ts        项目分区（路径归一 + 哈希键 + 分区索引）
├── store.ts            分区存储（journal / state / decision / backups）
├── decision.ts         预启动决策 + 指针文件 + 守护行表达式
├── sentinel.ts         进程级崩溃哨兵
├── archive.ts          归档重置（留证据链 + 不继承旧结论）
├── snapshot.ts         面板快照投影（状态/指标/排名/能力矩阵/图谱连通性）
├── graph-data.ts       图谱数据模型 + 分层布局 + 连通分量
├── routes.ts           宿主数据面路由（Node http 风格 handler）
├── routes-plugin.ts    路由子插件（唯一声明 webServer 硬依赖的地方）
├── patch.ts            profile patch 行读写
├── recency.ts          嫌疑分类与最近更新排序
└── client/
    ├── entry.ts        客户端半部入口
    ├── index.ts        席位注册（main + sidebar.panellist）
    ├── GuardPanel.tsx  管理面板
    ├── GuardGraph.tsx  可交互图谱
    ├── GuardPanelIcon.ts 侧栏图标
    ├── viewport.ts     视口原语（纯函数）
    ├── api.ts          数据面客户端（形状校验）
    ├── i18n.ts         自持字典
    └── styles.css      唯一样式真相源
```

## 2. 需求 → 实现 → 验证 对照表

### R1 能力注册/生产/消费闭环

**规格**
- 能力是**有向图**：`consumes`（我消费谁）/ `consumedBy`（谁消费我）。
- 关系必须**双向登记**；单向关系是缺口。
- 三类缺口：消费断链 / 过度生产 / 孤立能力。
- 清单与实际注册面**双向**比对：漏登（清单有、没注册）与虚登（注册了、清单没提）。

**实现**：`capability.ts`（`CapabilityGraph.connect` 双向登记、`analyze` 三类缺口）、
`capability-specs.ts`（`CAPABILITY_SPECS` 清单、`buildCapabilityGraph`、
`verifyCapabilityContract`）。

**验证**：`tests/unit/core.test.ts`（缺口检出、连通率）、
`tests/contract/capability.test.ts`（双向比对、关系自洽、无死能力）。

**关键决定**：字段名用 `consumes` / `consumedBy` 而不是 `consumers` / `producers`
—— 后者方向相反，是真实的可读性缺陷（v0.2 开发中实测修正）。

### R2 生命周期步骤流程与状态

**规格**
- 六个阶段：`idle / monitoring / crashed / deciding / stabilizing / recovered`。
- **白名单迁移表**：非法迁移被拒且**不改变状态**（状态机返回 false，不抛异常 ——
  状态机是观测设施，不该因为一次非法迁移拖垮守护流程）。
- 迁移历史保留最近 N 条，每条带**原因与时刻**。

**实现**：`lifecycle.ts`（`StageMachine`、`ALLOWED` 迁移表）、
`src/index.ts`（在启动记录 / 崩溃决策 / 恢复三处接线）。

**验证**：`tests/unit/core.test.ts`（非法迁移被拒、状态不变、历史带原因）。

### R3 可量化

**规格**：七个量化读数，**不可判定时为 `null` 而非 0**（`Metric<T>` 类型带
`defined` 标志与可读标签）。

| 指标 | 模型 | 不可判定条件 |
|---|---|---|
| 崩溃率 | 崩溃数 / 观测启动数 | 观测数为 0 |
| 平均恢复耗时 | 样本均值（毫秒） | 无成功恢复样本 |
| 崩溃检出率 | 检出数 / 崩溃数 | 无崩溃样本 |
| 隔离纯度 | 未串扰分区 / 全部分区 | 分区数为 0 |
| 稳定性评分 | 阶段权重 × `exp(-λ·近期迁移数)` | 恒可得 |
| 风险评分 | `0.5·recency + 0.3·experimental + 0.2·frequency` | 恒可得 |
| 崩溃趋势 | **相邻崩溃间隔**的线性回归斜率 | 样本 < 2 |

**实现**：`observability.ts`（`Metric<T>`、`crashRate` 等）、
`lifecycle.ts`（`riskScore`、`crashTrend`、`StageMachine.stabilityScore`）。

**关键决定（开发中实测修正）**：崩溃趋势**不能**回归时间戳（斜率恒为 1），
也不能回归累计计数（方向信息丢失）；必须回归**相邻间隔** —— 只有间隔携带
「变密/变稀」的方向信息。

### R4 白盒透明化

**规格**
- 每个读数带**可读文字**（颜色不是唯一通道）。
- 决策、迁移、缺口都带原因与时刻。
- 面板的每个卡片都显示来源与不可判定的原因。

**实现**：`observability.ts`（`Metric.label`）、`lifecycle.ts`（`StageTransition.reason`）、
`src/index.ts`（journal 事件的 `detail`）、`src/client/GuardPanel.tsx`（卡片内显式文案）。

### R5 可视化流动（可交互图谱）

**规格**
- 滚轮缩放**以指针为锚**（指针下世界坐标不变）。
- 每次视口变化都过 `clampPan`（图不会被拖到找不回来）。
- **fit 只做一次**（ref 守卫）—— 数据轮询不得重置用户的缩放。
- 点击与拖拽以位移阈值区分。
- Esc 一次退出全部观察模式。

**实现**：`src/client/viewport.ts`（纯函数：`zoomAt`/`clampPan`/`fitToView`/
`SpatialGrid`/`traceFrom`）、`src/client/GuardGraph.tsx`（交互装配）。

**数据结构选择**：命中测试用**哈希网格**（`SpatialGrid`）而非扫描 —— 节点数十~数百，
网格构建 O(N)、查询 O(1)，且实现只有二十行；追溯用 **BFS**（最少跳数可达，
对应用户心里的「直接相关」）而非 DFS。

### R6 管理面板

**规格**
- 席位：`main`（keyed，根作用域）+ `sidebar.panellist`（list，根作用域），
  两者 id/key 必须一致。**不用** `conversation.view`（会话作用域，只在会话
  面板挂载时存在，语义是「会话内部视图切换」）。
- 响应式：`auto-fit` + `minmax` 卡片网格，窄屏（<720px）降为单列。
- 主题：只用 `--dsw-alias-*` 与 `--dsw-radius-*`；硬编码颜色仅用于图形本身。

**实现**：`src/client/index.ts`（席位注册）、`src/client/GuardPanel.tsx`、
`src/client/styles.css`、`src/client/GuardPanelIcon.ts`（原创几何图标，
按宿主给的 `size` 绘制）。

### R7 全生命周期质量评审体系

**规格**：四层测试 + 契约层双向比对 + 非功能项纳入门禁。

| 层 | 范围 | 覆盖率目标 |
|---|---|---|
| Core | 纯逻辑层（能力/生命周期/隔离/可观测性/图谱数据/归档） | 90% |
| Host | 宿主层（守护流程、工具行为、路由） | 85% |
| Client | 客户端纯函数（视口、形状、i18n、形状校验） | 80% |
| Contract | 清单 ↔ 注册面**双向**比对 | **100%** |

**实现**：`tests/run.ts`（分层运行器）、`tests/{unit,host,client,contract}/`。
非功能项：`.cycles/config.yml` 的 `build` 段（typecheck / lint / test / coverage）。

### R8 归档重置 + 举他

**规格**
- 归档 = **搬走 + 留档**（不删证据）：产物移到 `archive/<时间戳>/artifacts/`，
  写 `manifest.json`（归档了什么、何时、为什么、关键事实摘要）。
- 重置后**不继承**旧结论：崩溃计数归零、决策清空；下次启动按当前
  `node_modules` 重新推导嫌疑。
- 「举他」：另一个工作区可读取归档清单作**只读对照**，但**不导入**任何状态。

**实现**：`src/archive.ts`（`archiveAndReset`、`listArchives`、`readArchiveManifest`）。

**关键决定（开发中实测修正）**：归档清单里的崩溃计数必须在**搬走之前**读 ——
先搬后读会让摘要永远报 0（静默失真）。

### R9 多项目隔离

**规格**
- 分区锚点是**项目目录**（`profileContext.cwd`，即 launcher 记录的进程工作目录），
  **不是** profile 目录 —— 同一 profile 可以在多个项目里工作。
- 每个分区一份独立的 journal / state / decision / backups。
- 守护行的表达式只能拿到 profile 目录，**拿不到分区键** ⇒ 用**指针文件**
  （`<profile>/.recency-guard/current.json`）搭桥。

**实现**：`src/isolation.ts`（路径归一 + SHA-256 键 + 分区索引）、
`src/store.ts`（分区目录）、`src/decision.ts`（指针）。

**诚实边界**：指针在 profile 目录是全局一份 ⇒ 同一 profile 下**并发**跑多个工作区
时可能互相覆盖。选择理由：更糟的失败模式是「指针指向不存在的分区」⇒ 决策读不到
⇒ 全部放行 ⇒ 崩溃重演；而误指只损失一点精度。**宁可过放行，不可过拦截**。

## 3. 非功能性需求

| 项 | 要求 | 实现 |
|---|---|---|
| 类型安全 | `strict` + `noUnusedLocals` | `tsconfig.json` |
| 中文注释 | 每个模块文件头说明「为什么这样写」 | 全部源文件 |
| 依赖面 | 运行时只多一个 `dsh-atomic-write` | `package.json` |
| 失败降级 | 面板数据不可用时**如实显示原因**，不假装「没问题」 | `src/client/api.ts` |
| 幂等 | 样式注入、路由注册都幂等 | `src/client/styles.ts`、`src/routes.ts` |
| 可观测性附加项不得影响激活 | 所有观测代码包在 try/catch 内 | `src/index.ts` |

## 4. 明确排除

- 不实现跨 profile 的共享状态。
- 不替换 DSH 自身的插件管理 UI。
- 不做通用插件市场。
