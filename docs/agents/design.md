# 架构与设计（dsh-recency-guard v0.4）

## 1. 模块地图（依赖方向：自上而下）

```
src/
├── index.ts            宿主入口（Loader 四件套：name / inject / Config / apply）
│   └── Guard           守护流程：启动记录 / 崩溃决策 / 恢复 / 观测面
├── tool-render.ts      工具输出双形态投影（规范值 ↔ 人读文本，同源）
├── capability.ts       能力图（邻接表 + 双向可达性分析）
├── capability-specs.ts 能力清单（投影，非第二真相源）
├── lifecycle.ts        生命周期状态机 + 风险模型 + 崩溃趋势模型
├── observability.ts    量化指标（Metric<T>）+ 统计工具（EWMA/CUSUM/分位数）
├── isolation.ts        项目分区（路径归一 + 哈希键 + 分区索引）
├── store.ts            分区存储（journal / state / decision / backups）
├── decision.ts         预启动决策 + 指针文件 + 守护行表达式
├── sentinel.ts         进程级崩溃哨兵（退出码 0/1 区分干净退出与崩溃）
├── archive.ts          归档重置（搬走 + 留档；manifest 先读后搬）
├── snapshot.ts         面板快照投影（一次成型，多视图共享）
├── graph-data.ts       图谱数据模型 + 分层布局 + 连通分量（并查集）
├── routes.ts           宿主数据面路由（Node http 风格 handler，路径字面量）
├── routes-plugin.ts    路由子插件（唯一声明 webServer 硬依赖的地方）
├── patch.ts / guarded-rows.ts  profile patch 行读写与守护行安装
├── recency.ts          嫌疑分类与最近更新排序
└── client/
    ├── index.ts        席位注册（main + sidebar.panellist）
    ├── GuardPanel.tsx  管理面板（生命周期/指标/排名/能力/分区/事件流/归档）
    ├── GuardGraph.tsx  可交互图谱（箭头/裁剪边/图例过滤/悬停/列标题）
    ├── viewport.ts     视口原语（纯函数）+ clipToRect 边裁剪
    ├── api.ts          数据面客户端（形状校验，诚实失败）
    └── i18n.ts         自持字典（zh/en，回退链可见）
```

## 2. 核心数据流（崩溃恢复主线）

```
启动 → recordStartupSync【同步】安装守护行 + 读哨兵 + 记录安装/更新
     → boot()【异步】状态机迁移 + recordChanges
崩溃 → process exit(code≠0) → sentinel 落盘【同步】
     → publishDecisionOnCrash【同步】决策文件 + 指针文件 + 状态更新
下次启动 → 守护行 disabled 表达式读指针 → 找到分区决策文件
         → 嫌疑插件模块**不被导入** → profile 正常启动
稳定启动 → restore()：恢复非嫌疑 + 首要嫌疑保持关闭待确认
```

**为什么决策在崩溃时发布**：Loader 并发创建各行，等下次启动再写决策会与
嫌疑插件那一行的求值竞态（v0.1 实测）。

## 3. 生命周期状态机

```
idle ──▶ monitoring ──崩溃──▶ crashed ──▶ deciding ──▶ stabilizing ──▶ recovered
  ▲          │                                          │
  └──────────┴──────────── 恢复完成 ◀───────────────────┘
```

- 白名单迁移表（`lifecycle.ts`），非法迁移返回 false 不抛异常。
- 不变式：只有 `deciding` 可发「关闭插件」动作；`crashed` 只能经 `deciding` 离开。

## 4. 数学模型（observability.ts）

| 模型 | 用途 | 关键参数 |
|---|---|---|
| `Metric<T>` | 诚实边界：null ≠ 0 | `defined` + `reason` |
| EWMA（半衰期） | 近期崩溃密度平滑 | H=3 ⇒ α≈0.206 |
| CUSUM 变点 | 崩溃密度上行检测 | P75 基准 × 0.75 容差，阈 1.5×q |
| 中位间隔 + CV | 崩溃间隔鲁棒统计 | — |
| 线性插值分位数 | 小样本平滑阈值 | 与 NumPy linear 一致 |
| 风险分（lifecycle） | 嫌疑排名 | 新近性×实验性×历史命中 |
| 崩溃趋势（相邻间隔回归） | 变密/变稀方向 | **必须回归间隔本身**，不是时间戳 |

**CUSUM 基准为什么是 P75 不是中位数**：中位数定义上让一半样本低于基准，
容差后几乎无法累计证据 —— 检测器对真实变化结构性失明（cycle-3 实测）。
P75 之下只有 25% 样本，只有持续显著变密才推得过阈值。

## 5. 图谱布局与交互

- **分层布局**（列 = 生命周期阶段），不用力导向：确定性（同数据同图）+ O(V log V)。
- 列内按 label 字典序排序，输出可逐字节比对（契约测试）。
- 边端裁剪 `clipToRect`：线段参数化 + 四边界线性求交，取**最小 t**（进入点）。
- 命中测试：哈希网格（O(1)），不用四叉树（几十节点规模下收益不值复杂度）。
- 追溯：BFS（最少跳数 = 用户心里的「直接相关」）。
- 视口原语全纯函数：锚点缩放推导 `t1 = anchor − (anchor−t0)·s1/s0`。

## 6. 多项目隔离

- 分区锚点是**项目目录**（`profileContext.cwd`），不是 profile 目录。
- 守护行表达式拿不到分区键（只有 ctx + process）⇒ 用指针文件
  `.recency-guard/current.json` 搭桥：profile 目录 → 分区路径。
- 分区索引只存引用不存状态；每分区独立 journal/state/decision/backups。
