# 架构与设计（dsh-recency-guard v0.19.0）

> 版本说明：§0 记 v0.13 的三条设计纪律；§1–§15 是 0.7–0.12.1 的决策链与实测记录，
> **原文保留**（标题里的历史版本号是事件编号，不是当前版本）。v0.14 / v0.15 的变更以
> README 的版本记录与 git 历史为准（误伤闭环 / 贝叶斯 / 预防性指标 / 变异测试；
> 两层目录重构与边界契约）。v0.16.0 的发布面收口见 §16，确定性冲突证据 / 贪心最小隔离 /
> 可写 rescue / 客户端可空契约见 §17；v0.17.0 的研究闭环状态（RQ1–RQ4：机制 / 生产消费 /
> 验证 / 诚实边界）见 §18，技术债逐条状态见 [tech-debt.md](./tech-debt.md)。

## 0. v0.13 的关键变化（先读这段）

本轮把 `docs/research/` 九篇研究文档的候选方向落地，**三个原方案被改造或拒绝**。

| 变化 | 为什么 |
|---|---|
| 决策因子快照（`decision-evidence.ts`） | `decision.json` 此前只记排序键，回答不了「为什么是 A 不是 B」。因子分解让调参可验证、决策可回放 |
| 决策排序口径统一（`rankForDecision`） | 此前**决策用纯时间戳、面板用三因子**——两套口径。高风险的没被关，且改模型对决策完全不生效（这是研究文档 09 §5 的最大缺口） |
| 变更频率因子（`riskFactors` + `changeDensityMultiplier`） | 「一小时热更新五次」与「一小时前装一次」在纯新近性下同分。做成 recency 的**调制乘数**而非第四个加法因子（三权重之和恰为 1，加项会破坏归一化） |
| 分布形态阈值（`hazardAdjustedRounds`） | **拒绝**「证据年龄衰减」：环境未变时的复现仍是确定性缺陷，衰减会判成证据不足 ⇒ 放过真缺陷。改用已有的 Weibull 形状 k（±1 轮） |
| 共现采集与验证（`cooccurrence.ts`） | **拒绝**直接加权：数据基础不存在、共现≠因果、不可证伪。改为只采集 + 验证 + 门 |
| 可选 peer 惰性加载 | **P0**：`schemastery` / `dsh-tools` 是 optional peer 但静态 import ⇒ 宿主未暴露时**整个插件加载失败**（沙箱实测） |
| 图谱结构洞察（`graph-analysis.ts`） | 图谱此前只能画、不能读结构：枢纽/可达/影响面/最短路径都算不出来 |

### 0.0 v0.13 的三条设计纪律（本轮踩出来的）

1. **展示字段不得参与拦截判定**。`evidence` 只服务面板与回放；守护行若读它，
   旧决策文件（无该字段）会静默全放行 ⇒ 崩溃重演。三重门钉住（结构/行为/变异）。
2. **可选 peer 绝不静态 import**。守护插件必须在「宿主环境不完整」时也能加载，
   否则连"我降级了"都报告不出来。
3. **模型改进必须先修「决策路径是否消费它」**。否则模型再准，决策仍走旧口径 ——
   这是四个方向共同空转的根源。

## 0. v0.7 的关键变化（先读这段）

| 变化 | 为什么 |
|---|---|
| `patch.ts` 拆成 `patch-scalar.ts` / `patch-yaml.ts` / `patch.ts` 三层 | 发射+校验逻辑膨胀到复杂度 142（预算 100）。按「标量 / 文档 / 行寻址」切开，各层可独立穷举测试，`patch.ts` 退化为门面 |
| 守护行发射改为**永远引号** | `@` 是 YAML 保留指示符，scoped 包名让整份 profile patch 不可解析 —— 防崩溃的插件把 profile 写崩了 |
| 追加改为**校验后提交 + 原子回滚 + pristine 备份** | 发射正确还不够：文件里有别人手写的行，接缝才是风险所在 |
| 新增 `scripts/repair-patch.mjs` | 已经写坏的真机 profile 需要一次可逆修复 |
| `ctx.configEditor` 改走 `tryReadService` | 未 inject 直接读会抛错 → 整个插件不激活（沙箱实测） |
| 工具规范值 `data` 摊平回顶层 | v0.7 重构 display 时漏掉，宿主层测试以 `status.profile === undefined` 报出 |
| 图谱滚轮改原生非 passive 监听 | React 的 `onWheel` 是 passive，`preventDefault` 无效 → 缩放连带滚页面 |
| 面板自己滚动（v0.7.1） | 宿主槽位 `overflow:hidden` 且整页不滚，面板内容 3965px 被裁到 714px，下半部分永远看不到 |
| 滚轮改为 Ctrl/⌘+滚轮缩放（v0.7.1） | 普通滚轮被图谱吞掉后，指针停在图上就滚不到下方数据 —— 可用性优先于手势，缩放入口保留在工具栏按钮 |

## 0.1 面板滚动契约（v0.7.1）

`.rg-panel` 必须**自己**是滚动容器，不能指望宿主：

```text
.centerCol  { overflow-y: hidden }        ← 祖先裁掉溢出
.mainPanel  { height: 714px; overflow: visible }
.rg-panel   { height: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain }
document    { scrollHeight == clientHeight }   ← 整页永远不滚
```

四件套缺一不可：只写 `overflow-y` 而不限制高度时，flex 子项仍按内容撑开高度
（实测 `height: 3965px`），滚不起来。`overscroll-behavior: contain` 防止滚到
尽头把宿主/侧栏带着一起滚。

与之配套的滚轮分工：**普通滚轮滚动面板，Ctrl/⌘ + 滚轮缩放图谱**
（`page.mouse.wheel` 实测：普通滚轮 `scrollTop 3057→3362` 且 transform 不变；
Ctrl+滚轮 scale `0.5245→0.6032` 且 scrollTop 不变）。

## 1. 模块地图（依赖方向：自上而下）

```
src/
├── index.ts                    宿主入口（Loader 四件套：name / inject / Config / apply）
│   └── Guard                   守护流程：启动记录 / 崩溃决策 / 恢复 / 观测面
├── host/
│   ├── capability/             能力模型（邻接表 + 双向可达性分析）与清单（投影，非第二真相源）
│   ├── core/                   纯逻辑：配置严格校验 / 路径安全 / 隔离 / 指标 / 生命周期 / 自描述
│   │   └── build-freshness.ts  产物新鲜度（v0.19：指纹 + mtime 漂移，三态判定）
│   ├── data/                   分区存储（journal 轮转 / state / decision / backups / 归档）
│   ├── guard/                  崩溃检测 / 决策 / 隔离计划 / 恢复 / 守护行 / 冲突证据
│   ├── observe/                量化指标 / 控制带 / 贝叶斯 / 马尔可夫 / 共现 / 预防性
│   ├── profile/                profile patch 行（标量层 / 文档层 / 门面）
│   ├── risk/                   嫌疑排序 / 贝叶斯风险 / 误伤校准
│   ├── surface/                面板快照 / 路由 / 工具注册与投影 / 状态投影
│   └── self-describe.ts        插件自描述（版本 + 反馈链接，诚实降级）
├── shared/
│   └── graph-contract.ts       跨运行时契约（阶段词汇 / 图节点 / 布局常量；谁都不依赖）
└── client/
    ├── entry.ts                客户端入口（工厂无副作用；apply 里注册样式 + 面板 + 卡片）
    ├── index.ts                席位注册（main + sidebar.panellist）
    ├── panel/                  管理面板（KPI + 可折叠卡片 + 图谱 + 归档）
    │   ├── GuardPanel.tsx      取数 / 轮询 / 动作 / 布局（四件事，仅此四件）
    │   ├── poll-adaptive.ts    自适应轮询（内容退避 + 失败退避 + 页面可见性）
    │   └── epoch-guard.ts      在途世代守卫（v0.19：切换分区后旧响应落地即丢弃）
    ├── graph/                  可交互图谱（曲线边 / 拖拽 / 搜索 / 详情侧栏 / 小地图）
    ├── toolview/               命令窗口卡片（v0.19）
    │   ├── ToolViewIntegration.ts  `tool.call.toolview` keyed slot 注册（幂等守卫 + getter 计数）
    │   ├── GuardToolCard.tsx       终端卡渲染 + CSS 唯一真源
    │   └── toolview-model.ts       零 React 依赖的防御式抽取层
    ├── api/                    数据面客户端（形状校验，诚实失败）
    └── i18n/                   自持字典（zh/en，递归 Dict，回退链可见）
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
| **崩溃压力 crashPressure（v0.6）** | EWMA(0/1 启动信号)，时间局部性 | H=5 次启动；无观测 = null |
| CUSUM 变点 | 崩溃密度上行检测 | P75 基准 × 0.75 容差，阈 1.5×q |
| 中位间隔 + CV | 崩溃间隔鲁棒统计 | — |
| 线性插值分位数 | 小样本平滑阈值 | 与 NumPy linear 一致 |
| 风险分（lifecycle） | 嫌疑排名 | 新近性×实验性×历史命中 |
| 崩溃趋势（相邻间隔回归） | 变密/变稀方向 | **必须回归间隔本身**，不是时间戳 |

**CUSUM 基准为什么是 P75 不是中位数**：中位数定义上让一半样本低于基准，
容差后几乎无法累计证据 —— 检测器对真实变化结构性失明（cycle-3 实测）。
P75 之下只有 25% 样本，只有持续显著变密才推得过阈值。

**崩溃压力为什么不是 crashRate**：整体比率把「很久以前崩过一次」与
「刚刚连崩两次」算成同一个数。crashPressure 把启动序列编码成 0/1 信号
再做 EWMA（半衰期 5 次启动），指数遗忘表达「多久算近期」；全平稳序列的
0 是**真值**（有数据且每次都没崩），与不可判定的 null 语义不同（cycle-4）。

## 5. 图谱布局与交互

- **分层布局**（列 = 生命周期阶段），不用力导向：确定性（同数据同图）+ O(V log V)。
- 列内按 label 字典序排序，输出可逐字节比对（契约测试）。
- 边端裁剪 `clipToRect`：线段参数化 + 四边界线性求交，取**最小 t**（进入点）。
- 命中测试：哈希网格（O(1)），不用四叉树（几十节点规模下收益不值复杂度）。
- 追溯：BFS（最少跳数 = 用户心里的「直接相关」）。
- 视口原语全纯函数：锚点缩放推导 `t1 = anchor − (anchor−t0)·s1/s0`。

### v0.5 交互增强的设计取舍

- **曲线边**：二次贝塞尔（一个控制点够表达「往哪边弯」）；控制点 =
  线段中点沿单位法向量推开 `curvature`；零曲率退化为直线（老数据不变形）。
- **平行边**：同一端点对（互逆算同一对）的第 i 条边按 `parallelIndexes`
  得到序号，`parallelCurvature` 奇偶交替（+18/−18/+36…），一左一右分开。
- **节点拖拽**：屏幕位移 ÷ 当前 scale = 世界偏移，存 `offsets[id]` 叠加在
  分层布局上 —— 布局仍是确定性投影，用户调整是**叠加层**，轮询不重置。
- **搜索**：`matchNodes` 按精确 id → 前缀 → 标签子串三级排序；
  Enter 定位第一个 = `centerOn`（视口居中）+ 选中。
- **双击居中**：单击只改高亮（轻量探索），双击才移动视口（明确意图）。
- **性能不变式**：`id→node` 索引 useMemo 与节点数组绑定，每数组一次；
  严禁在边的 filter/map 回调里重建索引（v0.4 的 O(E·V) 实测债）。

### v0.6 邻居导航（T04）

- 度数（入/出）只回答「有几条边」，邻居列表回答「连到谁」——
  详情侧栏按上游（生产方）/下游（消费方）分组列出可点击邻居，点击即
  `locateNode`（居中 + 选中）。
- 邻居派生规则：可见边中 `to === focus` 的 `from`（上游）与
  `from === focus` 的 `to`（下游）；**端点不可见时不算**（类型过滤后幽灵
  端点不可导航），**自环不算**（导航到自身无意义），Set 去重 +
  label 字典序排序（稳定可比对）。派生逻辑与 client 测试同构，
  组件与测试必须同步修改（本轮实测：先改组件漏改测试 → 自环断言翻红）。

## 5.1 面板结构（v0.5 + v0.6）

- **KPI 摘要条置顶**：稳定性 SVG 圆环（弧长 = score×周长，`rotate(-90)` 从
  12 点起笔）、当前阶段、崩溃率、**崩溃压力（v0.6 EWMA）**、趋势判定、
  CUSUM 变点 —— 一眼可读的六个数。
- **卡片可折叠**：`Card` 骨架组件 + localStorage 记忆折叠态
  （键 `recency-guard-collapsed`，storage 不可用时退化为会话内记忆）。
- **轮询暂停**：暂停时画面时间停在暂停时刻（快照不更新），调试/截图用；
  按钮有 aria-pressed + 边框变色的双通道提示。
- **指标卡片补齐**：崩溃间隔（中位/CV）与 CUSUM 变点（v0.4 已在快照里）
  本版本接入 UI —— 数据到了界面必须接住。
- **隔离可见性（v0.6 T03）**：header 显示可读项目名（分区 label）+ 完整
  工作区路径（悬停 title 兜底长路径），哈希前缀只在分区记录缺失时兜底 ——
  哈希是机器的键，路径才是人可归因的事实。

## 6. 多项目隔离

- 分区锚点是**项目目录**（`profileContext.cwd`），不是 profile 目录。
- 守护行表达式拿不到分区键（只有 ctx + process）⇒ 用指针文件
  `.recency-guard/current.json` 搭桥：profile 目录 → 分区路径。
- 分区索引只存引用不存状态；每分区独立 journal/state/decision/backups。

## 7. 守护行写入管线（v0.7）——为什么不是「加个引号就完事」

### 7.1 缺陷与三层防线

真机证据：`~/.dsh/profiles/desktop/cordis.patch.yml:185`

```yaml
- id: ui-task-board
  name: @linxin666/dsh-client-ui-task-board   # ← @ 是 YAML 保留指示符
```

js-yaml 报 `bad indentation of a mapping entry (185:9)`。注意失败的不是这一行，
而是**整份文档**：Loader 拿不到任何 patch，守护行、禁用开关、config 覆盖一起失效。

三层防线（缺一层都能再犯同样的错）：

| 层 | 机制 | 失败时的行为 |
|---|---|---|
| 1 发射 | `yamlScalar()` 单引号 / `yamlDoubleQuoted()` 完整转义 | 结构上不可能产出非法标量 |
| 2 校验 | `validatePatchText()` 全文档子集校验 | `ok:false`，**不写**，返回原因+行号 |
| 3 落盘 | `.rg-tmp` + rename，回读复核 | 回滚到原文，文件字节不变 |

### 7.2 为什么校验器要按缩进扫描而不是正则

判断某个 `id:` 是不是 **Loader 行 id** 必须知道父级 key：`config.providers[].id`
只是配置数据。用「任意 `- id:`」去重，会在真机桌面 profile 上把模型名
`glm-5.3` / `deepseek-v4-flash-0731` 报成重复行 id（实测：一次 dry-run 刷出
10 条假警告）。正确判据只有两种位置：

1. 顶层序列（缩进 0 的 `- id:`）—— profile patch 覆盖既有行；
2. `insert:` 的直接子项 —— 包自己声明的行。

### 7.3 复杂度预算的驱动

拆分前 `patch.ts` 复杂度 142（branches 108 / functions 17），预算 100。
按职责切成标量层（87）与文档层后 `Status: OK`。
**这不是为指标而拆**：标量层可以脱离任何文件做穷举测试（含 `\0`、换行、emoji、
引号），文档层可以只喂文本 —— 两者混在一起时，测试必须建临时 profile 才能验证
一句引号规则。

## 8. 备份能力增强设计（v0.7 评估，未实现）

用户提出「记录插件更新前后状态 + 检测式备份 + 自定义目录 + 可视化配置」。
评估结论与分期如下（**当前未实现**，写在这里是为了让下一个循环不必重新论证）。

### 8.1 采纳的部分

| 需求 | 判断 | 落点 |
|---|---|---|
| 更新前后状态记录 | **采纳** | `journal.jsonl` 增事件：`update-start` / `update-complete`（含 from→to）/ `install-fail` |
| 更新前备份受影响插件配置 | **采纳（增量）** | 只备份变更插件在 patch 里的 config 覆盖段 + package.json 差异，不做全量克隆 |
| 自定义备份目录 | **采纳** | `RECENCY_GUARD_BACKUP_ROOT` 环境变量，默认 `<profile>/.recency-guard/backups` |
| 可视化配置 | **采纳（P2）** | 面板新增「备份策略」卡片：开关 / 路径 / 保留份数 / 上限 |

### 8.2 必须守住的约束

1. **启动路径同步纪律不能破**：`recordStartupSync` 里只写「事实摘要」到 journal；
   真正的备份动作排到启动完成后的微任务队列（fire-and-forget，失败只记日志）。
   在崩溃路径上做异步备份等于没有备份。
2. **有界**：保留份数 + 总大小上限 + LRU 清理；否则备份目录会自己变成下一个故障源。
3. **原子**：`.tmp` → 校验 → rename，与守护行写入同款；备份后追加 checksum，
   恢复前校验。
4. **隔离**：备份落在分区子目录（`partitionKey`），多工作区不交叉。
5. **失败不拖垮守护**：备份失败 = 降级（`configEditorAvailable: false` 同款语义），
   不是错误、更不能阻塞启动。

### 8.3 明确不采纳

- **全量克隆 profile**：体积不可控，且会把无关插件的敏感配置卷进来；
  增量 + 有界才是可持续的设计。
- **在 `apply` 里异步等待备份完成**：违反同步纪律，且会让启动变慢。

## 9. 可观测性接入点（宿主能力清单）

已消费的宿主面，以及刻意未消费的面：

| 宿主能力 | 用途 | 备注 |
|---|---|---|
| `profileContext` | profile 目录 / patch 路径 / cwd（分区锚点） | 必需，写进 `inject` |
| `pluginManager` | 列举 bundle/plugin、启停插件 | 必需，写进 `inject` |
| `tools` | 注册 `recency_guard` | 必需，写进 `inject` |
| `webServer` | 8 条数据面路由 | **只在 `routes-plugin.ts` 声明**，避免 headless 下 fiber 挂起 |
| `configEditor` | 关闭前备份插件配置 | **可选**：`tryReadService` + `ctx.inject` 子 fiber |
| 崩溃哨兵（自有） | 不用宿主事件，因为要覆盖「宿主自己都没起来」的情况 | 同步写 `.recency-guard/sentinel.json` |

未接入：session 事件、tool 调用钩子、宿主持久化层 —— 它们都要求插件已成功激活，
而本插件的核心价值恰恰发生在**激活之前**，接进来对主目标无增益。

## 10. v0.10 数学模型与洞察卡（cycle-5）

### 10.1 马尔可夫转移矩阵（src/host/observe/markov.ts）

- 状态空间 = 六阶段白名单（MARKOV_STAGES，与 lifecycle.ALL_STAGES 同序的独立声明
  —— 客户端不 import 宿主常量的铁律在**数据模型层**同样成立）。
- 计数矩阵 O(T) 一次成型；未知阶段名（旧数据/手改）**丢弃并计数**，不进矩阵
  （虚增置信度比丢失样本更危险）。
- 平稳分布用幂法 π_{k+1} = π_k·P，L∞ < 1e-9 判敛，上限 200 次迭代；
  无迁出样本的阶段按吸收态（自环 1）参与迭代，否则行随机性破坏会发散。
- 诚实边界：samples=0 ⇒ stationary=null（不猜）；概率四舍五入到 1e-4。

### 10.2 休哈特控制带（observability.controlBand）

- 单值-MR 图：σ̂ = MR̄/1.128（d₂(2) 无偏常数），UCL/LCL = x̄ ± 3σ̂。
- 与既有模型分工：CUSUM 看持续漂移的起点，回归斜率看整体方向，控制带点名
  **单次越界的间隔序号**（特殊原因 vs 偶然原因）。
- 已知特性（测试钉死）：单次突变会污染 MR̄，小漂移可能不越带 —— 这是该模型的
  正常保守行为，不是缺陷；抓持续漂移是 CUSUM 的职责。
- 负间隔（时间戳乱序）全部过滤；过滤后样本 < 2 ⇒ 诚实不可判定。

### 10.3 诊断投影与反馈入口（snapshot.diagnostics）

- 版本事实只在宿主侧收集（浏览器拿不到宿主进程信息），随快照下发。
- `readSelfPackage()` 用 `createRequire(import.meta.url).resolve('../package.json')`
  定位**自身**清单 —— 包名自引用在 pnpm 符号链接下会解析到别处。
- repository/bugs 链接归一（git+ssh → https）；未登记 ⇒ null ⇒ 前端**隐藏**
  反馈按钮（诚实边界：宁可不显示，不放 404 死链）。

### 10.4 rescue CLI 的 CJK 宽度（bin/rescue.mjs）

- 零依赖纪律 ⇒ 宽度判定（codePointWidth/displayWidth/padWidth）内联实现，
  与 src/host/surface/tool-text.ts 的同名原语语义一致但不共享代码 —— 崩溃现场 node_modules
  可能正是损坏状态，逃生通道只能依赖 node 内置模块。

## 11. v0.11 数据面安全与图谱一致性（cycle-6）

### 11.1 动作路由方法守卫（routes.ts）

- 漏洞形态：archive/reenable/recover 的 handler 不检查 `req.method`，
  GET 请求 readBody 读不到体 → reason 走默认值照常执行 —— 浏览器预取、
  爬虫、误点链接都可能触发破坏性动作。
- 修复：`rejectWrongMethod` 统一守卫，非 POST → 405 + `allow: POST`
  （RFC 7231 语义）。测试钉死：tests/host/routes.test.ts。

### 11.2 跨分区只读快照（partition-snapshot.ts）

- `?partition=` 的宿主侧实现：**磁盘投影**（另一个 Store 实例读对方分区目录），
  不是运行时视图切换 —— 观察动作不得影响本分区状态机。
- 诚实降级：stage 恒 `idle` + 说明标签、metrics/capability/markov 为 null
  （那些是当前进程的状态机事实，不能替对方编造）；未知分区 `available:false`。
- 独立成模块：index.ts 复杂度预算 100，内联投影实测 hotspot 到 103。

### 11.3 图例与着色同源（graph-model.ts）

- 缺陷形态：图例色固定语义色调色板（dotToneOf），节点在「按类型」口径用
  KIND_COLOR —— 同一个图例在两种口径下说两种谎。
- 修复：`legendColorOf(kind, mode)` 图例色跟随着色口径；
  `legendShapeOf(kind, nodes)` 代表形状从**实际数据多数票**导出
  （不复制 CAPABILITY_SHAPES 映射 —— 复制就是第二真相源）。

### 11.4 马尔可夫跨阶段去向（panel-model.ts）

- 缺陷形态：矩阵卡只渲染自环概率条 —— `monitoring → crashed 40%` 这类
  核心去向分布（README 宣称的）界面上看不到。
- 修复：`MarkovRowView.exits`（排除自环与零概率，按概率降序 top-2，
  并列按阶段名稳定排序）→ 行内「→ 崩溃 40%」徽标。

## 12. v0.11.1 紧急修复：宿主兼容与启动健壮性（cycle-6 应急）

### 12.1 预发布版本兼容（package.json）

- 事故：桌面端 DSH 升到 `0.2.2-rc.1`，旧 `engines.dsh` / peer 范围
  `>=0.2.1-rc.5 <0.3.0-0` 按 node-semver 规则**静默排除**该预发布版本
  （只有与版本元组相同、且自身带预发布标签的比较符才放行预发布），
  插件被兼容闸门移出 profile `bundles` → 守护消失 → 崩溃循环失去保护。
- 修复：显式多分支范围
  `>=0.2.1-rc.5 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || >=0.2.3-rc.1 <0.3.0-0`；
  契约测试钉死「每个 @deepseek-ai/dsh-* peer 必须包含 >=0.2.2-rc.1 分支」。
- 验证：`npx @deepseek-ai/dsh@0.2.2-rc.1 plugin add file:...` 干净沙箱
  （sb-rg-v0111）安装成功 + 启动后 journal 有 `dsh 启动` 与 install 0.11.1。

### 12.2 启动绝不抛出（index.ts Guard.boot）

- 事故：崩溃遗留的 0 字节 `state.json.lock` 让 `bootInner` 的 `updateState`
  等满 3s 超时抛错；`boot()` rethrow 后宿主报
  `dsh: fatal load failure: Error: atomic-write: timed out ...` 并退出码 1。
- 修复：`boot()` 捕获后只做**降级留痕**（步骤失败 + 警告日志），绝不外抛。
  理由是设计红线：观测/恢复设施不能拖垮主流程；守护自己失败时宿主应照常启动。

### 12.3 失效写锁自愈（store.ts）

- `cleanStaleLocks(dir)`：清理「空内容 / 非正整数 PID / PID 进程已死」且
  文件年龄 > 5s 的 `*.lock`；保留活锁与刚创建的锁（锁创建→写 PID 之间有
  零字节窗口，清理太新的锁会抢掉正在持有的写者）。
- 两处接线：`Store.init()` 启动先清理；`updateState` 锁超时后清理并重试一次
  （定向识别 timeout 消息，其他错误不重试）。
- 回归：tests/unit/store-lock.test.ts（11 断言，含「陈旧锁下 updateState 仍成功」）。

### 12.4 连续崩溃兜底升级（recovery-policy.ts）

- 事故：`readCrashHistory` 把启动时「无嫌疑 crash-detected」也当决策记录，
  连续计数每轮被打断 → crashSeq 涨到 3 仍「观察中 1/2 轮」→ 崩溃循环无解。
- 修复：历史读取跳过 suspects 为空的记录；`assessConfidence` 增加
  `crashSeq`/`hardEscalateAfter` 安全网（默认 3 次强制行动）。
  宿主可用性优先于误伤最小化 —— 崩溃循环本身就是确定性事实。
- 回归：tests/unit/recovery-policy.test.ts 新增 4 条断言。

## 13. v0.11.4 触屏双指缩放（viewport.pinchViewport）

- 不变式：**两指中点下的世界点**在捏合前后保持不动（与 zoomAt 同一推导）；
  中点位移同时带动画布平移 —— 一次解出 `t1 = nextMid - world(prevMid) · s1`，
  而不是先 zoomBy 再 panBy（后者以旧中点锚定会让世界点漂移）。
- 退化保护：两点距离 ≤ 0.01 或非有限 ⇒ 返回原视口（捏合刚开始两指可能
  落在同一像素，除零会污染视口）。
- 上界：scale 仍由 clampScale 钳制；组件层每帧 clampPan。
- 交互互斥：两指在场即取消画布平移拖拽；抬指后清空取样，下一次捏合重新取样。
## 14. v0.12：显示接线、乐观并发与审计线（cycle-10）

### 14.1 命令窗口显示问题的根因不在渲染层

用户报「本插件调用时命令窗口显示难看」。取证发现根因：`src/host/surface/tool-presentation.ts`
里 `presentCallOf` / `presentResultOf` / `presentationMetaOf` 三个纯函数**早就写好了**
（含详尽注释说明为什么需要它们），但 `defineTool` 从未接上它们 ——
`grep presentCall src/index.ts` 零命中。于是宿主落到通用回退：待执行卡片标题 =
裸工具名 `recency_guard`、正文 = 整坨原始参数 JSON。

这个缺陷形态**为什么能长期存活**：

| 防线 | 为什么没拦住 |
|---|---|
| 纯函数单测 | 三个函数各自被测过，全绿；「有没有被调用」不在任何断言里 |
| tsc / lint | 函数被 `tool-render.ts` import 了（用它的 `truncationMetric`），所以不是未使用符号 |
| 契约层 | 清单核对的是工具名与 action；展示投影不是一个「能力」，没有登记位点 |
| 宿主层测试 | 只断言 `execute` 返回的规范值形状 |

**结论**：凡是「写好了等着被消费」的显示/投影代码，必须有一道门断言
**注册对象上有这个方法**（行为门，`tests/host/tool.test.ts` 的 T10-03-H1..H13），
外加一道源码门核对注册文件里出现接线（`tests/contract/capability.test.ts`）。
两道门现在都在。

接线时撞出第二个漂移：本地自声明的 `GenericResultView { content: string }`
与宿主的 `content?: ContentBlock[]` 不一致 —— 因为函数从未被接进 `defineTool`，
tsc 从来没机会比较这两个类型。改为 `import type { ToolCallView, ToolResultView }`
直接用宿主词汇（纯类型 import 编译期擦除，`@deepseek-ai/dsh-tools` 是 optional peer，
不引入运行面依赖）。

同时修正 `presentResultOf` 的读取器：`displayModelOf` 面向**规范值**
（显示模型嵌在 `.display` 下），而宿主传给 presentResult 的是 `result.meta`
= `presentationMeta` 的返回值本身（字段**平铺**在顶层）。复用前者会永远拿到
null，卡片标题退化成「（无输出）」。所以新增 `displayModelFromMeta`
（先平铺后嵌套两种形状都试），而不是让一个函数猜两种形状。

### 14.2 依赖代际对齐：INC-2026-11-08-01 的深层形态

v0.11.1 那次事故修的是 engines/peer 没写 `0.2.2-rc.1` 分支。本轮以宿主
**真实事实**为见证重查，发现两条更深的洞：

1. `peerDependencies["@deepseek-ai/cordis"]: "~4.0.5"` ⇒ `satisfies('4.1.0','~4.0.5')` =
   **false**。宿主实际携带 cordis 4.1.0 ⇒ npm 安装会被兼容闸门**整体拒绝并回滚**。
   桌面端一直用 `link:` 直连源码，从不经过闸门，所以这个阻断级缺陷在本机
   完全不可见 —— 它正撞用户的第①条硬要求（其他插件的安装更新不得导致崩溃）。
2. `devDependencies` 全停在 `0.2.1-rc.5`，而装机是 `0.2.2-rc.1`。
   于是**测试跑在一个从未有人装过机器的代际上**：绿灯不代表装机绿。

修法是两步：范围改 `>=4.0.5 <5.0.0`、devDeps 全量对齐 0.2.2-rc.1；
然后把「代际一致」变成机器门 —— 契约测试读 `runtime/`（extract-runtime 从
app.asar 解出的宿主真实包），逐 peer 做 `semver.satisfies(装机版本, 声明范围)`，
并断言 devDep 版本 == 装机版本。`runtime/` 缺失记 **FAIL**（不是「无法评估=通过」）。
下次宿主升 0.2.3-rc 时这道门会自己响，而不是等用户装不上再来一轮事故。

设计取舍：为什么不写「文本式断言」（`range.includes('>=0.2.2-rc.1')`）——
它只证明范围**写着**那个分支，不证明它**放行**宿主实际版本。本轮把这类
「结构存在但语义未验证」的门统一升级为以事实为见证的判定。

### 14.3 乐观并发：为什么是哈希而不是计数器

`src/host/core/change-guard.ts` 从 state + decision + journal 尾派生 12 hex（48 bit）。

- 计数器需要一个单调持久化位点，崩溃时它可能**落后于状态** ⇒ 假冲突或假放行。
- 哈希从被保护的事实本身派生，无额外状态、无写入顺序依赖，
  崩溃重启后同一份事实必得同一枚 ⇒ 幂等，不会被崩溃污染。
- 列表编码带长度前缀，避免 `["a","b,c"]` 与 `["a,b","c"]` 塌缩成同一串。
- `autoDisabled` **保留原序**：先关谁是因果信息，排序会把两种不同事实当成一种。
- 48 bit 够用：这里要的是「变了没有」，不是抗对抗性碰撞。

三态核对（`checkRevision`）刻意做成**没有第四态**：不带 ⇒ `ok + unchecked:true`
（显式标记「这次没核对」，可观测）；带了且相等 ⇒ `ok`；带了不等 ⇒ `stale + current`。
绝不出现「带了但没核对」。

409 的四条语义（各对应一个真实缺陷形态）：
- **冲突时动作不执行**（否则等于没有门）；
- **400 优先于 409**（必错的请求不该占用冲突判定，否则调用方以为刷新就能成功）；
- `currentRevision` 缺席 ⇒ 跳过核对、动作照常执行（可选能力缺席不拖垮主流程）；
- 跨分区只读视图 `revision: null` 而非省略（只读无可改事实，带凭证必然假冲突；
  用 null 让「本版本没凭证」与「跨分区没凭证」可区分）。

最后一米在客户端：`fetchJson` 此前非 2xx 一律写死 `HTTP ${status}` 把 body 丢了 ⇒
宿主的 `reason/conflict/current` 全部蒸发，面板只看到「请求失败了」。
分支逻辑挂 `conflict` 字段而不是挂 `reason` 文案（文案会改，分支不能跟着坏）。

**同源性必须是结构保证，不是注释承诺。** 写文档时我先在草稿里断言
「面板看到的 revision 与宿主核对的 revision 结构上同源」，复查代码发现
两处**各自**装配字段（panelSnapshot 拼 4 个 + 由 snapshot.ts 补 2 个；
currentRevision 拼 6 个）—— 那句话当时并不成立。这种漂移的后果不是
「少核对一项」而是**每一次动作都被 409 拦下**（面板发出去的凭证永远核对不过），
即「按钮全废」：一个可选加强项变成整体失效。

三步修到位：

1. 装配唯一化 `Guard.revisionFactsFrom(state, journalTail)`，两处都只经它；
2. `SnapshotInput.revisionFacts` 直接采用 `RevisionFacts` 类型（不在 snapshot.ts
   复述字段），`buildPanelSnapshot` 只做 `computeRevision(input.revisionFacts)`
   —— 保住「快照给的是派生值而不是传入值」这条原有不变式；
3. 端到端门 `tests/host/revision-source.test.ts`（11 断言，真实 cordis Context +
   真实 `registerRoutes` 产物）：从 `/snapshot` 取面板凭证、从 409 的 `current`
   取动作路径算出的那枚，断言**相等**；再要求带快照凭证的动作**必须 200**
   （否则「两边都算错但彼此相等」也能让相等断言恒真）。

这道门同样做了**变异自证**：把面板侧装配改成 `{...facts, stabilized: true}`
模拟「加字段只改一侧」，实测两条断言转红并打印出两枚不同的凭证
（`b0340388ac73` vs `1df930ab5733`），且带旧凭证的动作退化成 409 —— 精确复现
文档里预言的失效形态；还原后复绿。

### 14.4 L4 审计线：复用 note 而不是新开 kind

L4 全自主下人类只在**事后**审计，审计线要能回答「谁、以什么理由、动了什么」。
写动作（recover/restore/reenable/archive）**先落审计行再执行** —— 崩溃发生在
动作中间时，理由必须已在盘上；反过来会让最需要审计的那次失败恰好没有审计。

为什么复用 `kind: 'note'` 而不是新增 `'audit'`：journal 的 kind 是一张**跨层词汇表**
（store 的 `JournalKind`、observations 的 `FlowAction`、eventFlow 渲染映射、面板着色
分组四处都要跟着改）。新开 kind 而漏掉任一处，审计行就在事件流里**静默消失** ——
那条线比「少一个语义标签」危险得多。审计语义靠 detail 前缀 + 结构化 `audit` 字段表达。

只审计写动作：把 status/history 也记进去 ⇒ 面板每 5s 轮询会把崩溃因果链冲掉
（信号被噪声淹没）。审计行写失败不阻塞动作（观测设施不否决守护流程）。
理由缺席时写「调用方未提供理由」而不是空串：空理由不是「没有理由」，
是「调用方没写」，默认文案让审计时不会把后者误读成前者。

### 14.5 前端补齐的六条（含两条被实证的原缺陷）

1. **「只看关联」此前是传递闭包** ⇒ 在连通图上等于**什么都不过滤**：
   选中任何节点画面都不变（「图谱功能贫乏」的实际内容之一）。
   改为 k 跳邻域（`kHopNeighborhood`：BFS，visited 在**入队时**标记，O(V+E)）
   + 三档（1 跳 / 2 跳 / 闭包），缺省 1 跳。`maxHops` 是**可选**字段：
   省略 = 闭包 = 老行为，旧测试零改动仍成立。
2. **边宽此前只表达交互态**（hover/selected），没有任何数据编码。
   改为连接度的对数刻度（度数大时线性会把小度数压扁）。两个坑：
   归一化自变量必须是**超出下界的部分**（否则全图只有一条边时那条叶子线
   因「它是最大值」被画成最粗 = 假信号）；参考上界用**固定常量**
   （`EDGE_DEGREE_SUM_MAX`）而不是当前图最大值 —— 相对刻度会让轮询多一条边
   就改变所有既有线的视觉含义，与「布局必须是确定性投影」冲突。
   末尾显式 clamp：`1.2+2.2*1` 在浮点下是 3.4000000000000004，越界 4e-16 也要修。
3. **小地图**三条几何纪律各有真实缺陷形态：与图形求交（不取交集会画出比图还大的框，
   看起来像控件坏了）；「全览」阈值的比较对象是**图的投影尺寸**而不是画布尺寸
   （长条图配方画布时永远判不出全览 = 说谎的指南针）；矩形尺寸下界 1.5px
   （40 节点时 worldScale<0.05，按真比例是亚像素 ⇒ 小地图变黑块）。
4. **数据层截断债 4 处**（「报 N 只列 5」的同族）：搜索 `limit=8` 同时当显示上限与
   回车循环范围 ⇒ 匹配 20 个时指示器说「第 1/8 个」，第 9~20 个既看不见也跳不到；
   `stationary.slice(0,4)`、`transitions.slice(-8)` 静默省略；
   `capabilityRows(graph, 200)` 是数据层上限且一次渲染算两遍全表。
   改为数据给全量（`matchNodes` 缺省 Infinity）+ `searchSummary` 一次成型
   total/visible/omitted/cycleIndex，窗口**滑动**而不是把当前命中插到尾部
   （后者会打乱相关度排序）；显示层显式省略计数 + 展开按钮。
5. **i18n 回退链会掩盖缺键**：只在 zh 加键时，英文版露中文原文而 CI 全绿。
   新增 `i18n-parity.test.ts` 做键集/空值/占位符/源码字面键/组合键族五张核对。
6. **小地图事件冒泡**（读自己的 diff 时发现，单测覆盖不到）：它渲染在
   `.rg-graph-viewport` 内部，而那个容器挂着 onPointerDown（拖画布）与
   onClick（点空白清选中）⇒ React 合成事件冒泡让**两个手势同时跑**：
   拖小地图时画布也被拖着平移（两套坐标系互相拉扯 = 框抖动漂移），
   抬手时容器 click 把刚选中的节点清空。

对第 6 条的处理是本轮方法论的一个样本：**无 DOM 时改用源码门**。
`tests/client/minimap-gesture.test.ts` 断言 GraphMinimap 的六个手势处理器
各自包含 `stopPropagation`。这道门经过**变异自证**：临时摘掉一处
⇒ 恰好 1 条断言 FAIL 且 exit 1 ⇒ 门会响。
（门的第一版本身有 bug：括号配平把参数解构的 `{` 当函数体起点，截到碎片 ——
被它自己的 `svgRef` 标识断言当场抓住。那条断言的存在理由正是
「配平失手必须响亮报错而不是静默漏检」，它按设计工作了。）

### 14.6 复杂度治理与循环依赖的规避

band-detector 实测两个文件越预算（100）：

- `src/index.ts` 109（工具注册内联在 apply 里）⇒ 抽出 `src/host/surface/tool-registration.ts`；
- `src/client/graph/graph-model.ts` 117（新增聚焦/小地图/边宽/导航）⇒ 抽出 `src/client/graph/minimap-model.ts`。

抽取小地图时刻意**不**从 graph-model import `NODE_WIDTH/NODE_HEIGHT`：
那会让 `graph-model ⇄ minimap-model` 形成循环依赖 —— 打包器能容忍，
但**常量在循环里的初始化顺序不确定（TDZ）**，症状是「小地图矩形尺寸
随机为 0」这类只在一台机器上复现的缺陷。改为两边各自直读同一真相 `LAYOUT`，
依赖图保持单向。

### 14.7 归档重跑与举他（本轮复核）

`rerunWithCurrentFacts` 的既有设计本轮复核通过：归档 = 搬走 + 留档
（manifest 必须在 rename **之前**读，否则摘要永远报 0），重置后不继承旧结论，
以「当前已安装插件集 + journal 长度 + 归档数」为新基线。沙箱实测证据：
sb-rg-v012 的 journal 首两条是 `note(dsh 启动)` + `install v0.12.0`，
随后 15 条 `official-observe` —— 官方实验插件只观测不关闭（进 journal 与
时间线备份，绝不进嫌疑面；关官方组件等于卸宿主半边）。

### 14.8 本轮从生态插件借鉴与拒绝的清单

对照 dsh-ops 0.5.1 / dsh-context 0.82.2 / dsh-compat-guardian 0.2.1 /
dsh-cookie-guard 0.1.1 的**安装副本实现**（以发布包为事实）：

| 采纳 | 来源 | 落点 |
|---|---|---|
| 乐观并发 revision（哈希派生） | compat-guardian `reconcile` | `change-guard.ts` + 4 条动作路由 |
| 写操作审计留痕（actor + justification） | compat-guardian / dsh-ops | `tool-dispatch.ts` 审计先行 |
| `dsh.compatibility.dshReleases` 逐发布线声明 | dsh-context | `package.json` |
| 防抖计时器持有 + `unref()` + dispose 清理 | compat-guardian | `event-watch.ts` |
| 错误通道桥回宿主 logger（不进 console 就不进采集面） | dsh-context 前缀格式 | `routes.ts` 的 `logError` |

| 拒绝 | 来源 | 理由 |
|---|---|---|
| 每 30s 全量爬 node_modules 做 mtime/realpath | compat-guardian | 真机取证：这是它最大成本项；本插件坚持「启动 diff + 事件加速器」，mtime 扫描绝不进定时器 |
| 宿主半部零值 import + 手写 schema 校验 | dsh-ops | 本仓已有 schemastery + 契约层双门，重复造会多一个真相源 |
| monkey-patch `tools.register` 用 `Error().stack` 反查归属 | dsh-context | 脆弱且与本插件「注册面自己回报」（`onRegister`）的既有机制冲突 |

## 15. v0.12.1：崩溃信号的第二条通道（哨兵盲区）

### 15.1 缺陷：只认哨兵 = 漏掉一半死法

崩溃信号此前**只有**哨兵文件，而哨兵写在 `process.on('exit')` 里
（`src/host/guard/sentinel.ts` 的 `installExitSentinel`）。真机实测（强杀沙箱后直接看磁盘）：

```
bootMarker = {"pid":39576}   crashSeq = 0   哨兵文件 = 不存在
```

SIGKILL / OOM killer / 断电 / 原生段错误**根本不运行 exit 处理器**，所以这条通道
对它们完全失明。旧逻辑于是报「启动时未发现上次崩溃」。

**为什么这是 P0 而不是「少记一次」**：守护的升级依据是 `crashSeq`
（第 1 次关 1 个、仍崩则关 2 个）。原生死法下每一轮都只看得到残留的 bootMarker、
每一轮都被当成干净启动把计数清零 ⇒ 永远停在「关 0 个」。插件以原生方式撞死宿主的
那个场景，恰好是本插件存在的理由，而它此前是**盲**的。

### 15.2 修法：四种结局，各有各的处理

`classifyAbnormalExit` 的判据顺序是语义问题：

| 结局 | 判据 | 处理 |
|---|---|---|
| `clean` | 无残留标记，**或**有哨兵 | 计数归零 |
| `self-reload` | 残留 pid **== 本进程** | 计数归零 + 留痕 |
| `concurrent` | 残留 pid 仍活着（且不是自己） | 计数归零 + 留痕 |
| `abnormal` | 残留 pid 已死 | 计数 +1，累计到 `confirmRounds` 才动手 |

三条设计取舍：

1. **有哨兵时本通道必须归零**。否则一次崩溃会被两条通道各记一笔，`crashSeq`
   翻倍 ⇒ 「关 1 个」变成第 1 轮就「关 2 个」，隔离面被凭空放大。
2. **`abnormal` 是概率性证据**，第 1 轮只观察。残留标记同样可由「用户主动杀进程 /
   关机」产生 —— v0.9 的分级早已把这两类归为偶发不确定证据，本通道沿用同一纪律，
   不新造一套策略。达阈值后**复用既有 `recover()`**，不另写关闭逻辑：
   两条通道若各写一套，隔离语义迟早各自漂移。
3. **`self-reload` 是实测后才补的**。装完新版后那个 pid 又写了一条启动记录
   （`bootMarker.pid` 与当时进程相同）。若把它归到 `concurrent`，会报
   「检测到另一个实例」——让用户去查一个根本不存在的第二个进程。假归因比沉默更糟。

### 15.3 二阶缺陷：`!crashedLastRun` 这个代理失效了

原恢复分支：

```ts
if (recovering && !crashedLastRun) { /* 崩溃已过，恢复被关的插件 */ }
```

`!crashedLastRun` 的真实含义是「**没有哨兵**」。在单哨兵通道下它恰好等价于
「活过了启动」，于是被当作后者的**代理**在用。新增异常终止通道后代理关系破裂：

> 异常终止同样没有哨兵 ⇒ 沿用旧条件会把「关了嫌疑插件 → 又死一次（无哨兵）」
> 读成「崩溃已过」⇒ 把插件全部恢复 ⇒ **亲手拆掉刚建立的隔离**，
> 崩溃循环原地复活。

修法是把判据从「有没有哨兵」改成直接问「上一轮是不是**干净退出**」，
并拆成纯函数 `shouldRestoreAfterBoot({ recovering, exitClass })`：

```ts
if (shouldRestoreAfterBoot({ recovering, exitClass }) && !crashedLastRun) { … }
```

拆成纯函数不是为了好看：内联在 `boot()` 里时，这条二阶缺陷**只能靠真机崩溃循环
才能暴露**（要多轮崩溃 + 人工观察）。抽出后 5 条单测就能钉住
（干净退出才恢复；异常终止 / 并发 / 热重载都不恢复）。

### 15.4 探活语义：`EPERM` 必须算「活着」

`pidAlive` 用 `process.kill(pid, 0)`（信号 0 不发送信号，只做存在性与权限检查）：

| 返回 | 含义 | 判定 |
|---|---|---|
| 不抛 | 进程存在 | 活着 |
| `ESRCH` | 进程不存在 | **已死**（我们要的信号） |
| `EPERM` | 存在但无权操作 | **活着** |
| 其它异常 | 平台不支持等 | 保守 `true`（看不清就不动手） |

把 `EPERM` 当「已死」是有权限边界的环境（容器、别的用户拥有的进程）里最常见的
误判形态 —— 而误判的代价是关掉**无辜插件**。假阴性（漏判一次崩溃）远比假阳性轻。

### 15.5 端到端验证（真机两次强杀）

| 轮次 | `abnormalExitSeq` | 判定 | 动作 |
|---|---|---|---|
| 1 | 1 | `rounds 1/2, act=false` | 只记录「观察中（残留标记也可能是人为杀进程，不动手）」 |
| 2 | 2 | `rounds 2/2, act=true` | 「连续 2/2 轮 ⇒ 行动，本轮关闭 1 个」 |

`autoDisabled` 两轮都为空，因为该沙箱**没有第三方插件**可关（只有 base / web-app /
guard 自身）—— 没有候选可关是诚实结果，不是失败。判定链（观察 → 升级）已完整走通。

### 15.6 一条方法论注记

这两条 P0（本节 + §14.5 的小地图冒泡/捕获）都是**只能靠真机 GUI 用户旅程**发现的：

- 单元测试环境没有 DOM ⇒ 指针捕获异常测不到；
- 单进程测试不会真的被 SIGKILL ⇒ 哨兵盲区测不到；
- 而「强杀」恰恰是开发者每天都在做的事（关窗口、任务管理器结束进程、容器重启）。

所以本轮把「源码门 + 变异自证」作为无 DOM 缺陷的替代证明手段，把
「真机强杀两轮」作为崩溃检测的验收动作，两者都写进了 CLAUDE.md 的教训清单。

## 16. v0.16.0：发布面收口（为什么 manifest 与文档也算设计）

### 16.1 起点缺陷：四个版本锚点各说各话

v0.16.0 开工时的现场：

| 锚点 | 值 |
| --- | --- |
| `package.json` | 0.14.0 |
| 最近一次提交信息 | v0.15.0 |
| 最新 git tag | v0.11.4 |
| npm `latest` | 0.12.1 |
| README 顶部 | v0.14.0 |

这不是"忘了改一个数字"，而是**锚点没有写进检验**：每个值单独看都合理，没有任何命令
会把它们放在一起比对。修法分两半：

1. 四锚点统一到 `0.16.0`（`package.json` / README / `docs/agents` 当前版本引用 / `dsh-plugin.json`）；
2. 把顺序写进 [conventions.md](./conventions.md) §6：**先改锚点 → build/test → tag → publish**。
   先 publish 后改锚点，会造出 npm 上存在、仓库里查不到的版本号；先 tag 后改锚点，
   tag 指向的提交里还是旧版本 —— 两种都让"用户装到的"与"你宣称的"永久对不上账。

### 16.2 `dsh-plugin.json` 的取舍：只写有代码依据的字段

社区 manifest（draft v0.15，schema 来自 dsh-std）不是 `package.json` 的复制品：
它声明的是**可审计的能力与权限**。本轮只写能逐条 grep 到依据的字段：

| 字段 | 依据 |
| --- | --- |
| `facets.host.entry: dist/index.js` | `package.json` 的 `main` + `scripts/build.mjs` 的产物名 |
| `requires.contracts: tools.dsh/v1alpha1 Tool (optional)` | `ctx.tools.register` + `@deepseek-ai/dsh-tools` peer 为 optional；`loadDefineTool()` 解析不到时降级 |
| `permissions[fs.read / fs.write]` | `store.ts` 读 profile 包与 node_modules、写 `.recency-guard/`；`patch.ts` 追加守护行 |
| `permissions[process.probe]` | `sentinel.ts` 的 `process.kill(pid, 0)`（EPERM 算活着） |
| `permissions[http.panel]` | `routes.ts` 的 `webServer.register`，前缀 `/recency-guard/api` |
| `contributes.x-tool-namespaces` | `TOOL_SURFACE.name = 'recency_guard'` |
| `contributes.x-components` | `client/index.ts` 的 `PANEL_ID = 'recency-guard'` 与 `main` / `sidebar.panellist` 两个 inject |
| `contributes.x-routes` | `ROUTE_PATHS` / `ROUTE_SURFACE` 的 9 条路径与暴露名 |
| `compat.hosts` | `package.json` 的 `dsh.compatibility.dshReleases` 三个发布线 |

**刻意不写**：`platforms` / `targets`（`package.json` 没有声明平台矩阵，写了就是编）、
`artifact`（尚未发布到市场产物）、`commands`（没有宿主命令面）、`panels`（schema 明确 maxItems: 0，
本插件的面板走 client 席位而不是 host panel）。

### 16.3 文档分层：README 回答"要不要装"，agents 回答"怎么改"

v0.16.0 把 README 从"发版小作文"改成用户文档：一句话 / 为什么 / 安装 / 三分钟上手 /
能力表（每条链到源码或测试）/ 面板与图谱 / CLI / 诚实边界 / 兼容 / 许可。
历史增量压成**一行版本记录**；长设计论证搬回本文件。

新增 [capabilities.md](./capabilities.md) 的理由：能力清单散落在 22 条 `CAPABILITY_SPECS`、
1 个工具名（8 action）、9 条路由与 2 个面板席位里。"有哪些能力、谁生产、谁消费"此前只能靠
人读代码回答 —— 而本项目已经证明过：**没有写进检验的结构会漂移**（客户端 11 处越界、
清单方向写反、锚点四值不一，都是同一类缺陷）。capabilities.md 把四组注册真值与 22 条能力
逐条对上，并把双向比对口径写成可执行命令。

### 16.4 并行改动的文档边界（本轮纪律）

v0.16.0 的 host 层（确定性冲突证据 / 贪心隔离 / 可写 rescue）与 client 层（图谱交互）
曾并行改动。当时文档遵守一条**保守表述**纪律：

- 描述**职责与不变量**（"崩溃时同步写决策"、"动作路由过期不执行"），不写具体内部函数名；
- 对外契约只写**注册表**里的名字（`TOOL_SURFACE` / `ROUTE_PATHS` / `PANEL_ID`），
  因为这些名字由契约测试双向核对，改它们必然先改测试；
- 若下一轮发现某段描述与实现不符，改文档而不是把实现迁就文档 —— 文档是投影，不是第二真相源。

这条纪律的代价是 README 少了一些"实现细节炫技"；收益是并行开发时文档不会先于代码说谎。
**最终形态**已在定稿后按代码复核并写入 §17（84/84 全绿时的实现）。

## 17. v0.16.0 定稿：确定性证据、贪心隔离与可写逃生（以最终代码为事实）

### 17.1 确定性冲突证据：finding 不是「猜测」，必须能回指原文

`guard/conflict-declarations.ts` 读插件自带的声明（`package.json` 的 `dshCompat`，
以及次级来源 `dsh-plugin.json`），`conflict-findings.ts` 只产生**四类** finding：

| kind | 判据 | 严重度 |
| --- | --- | --- |
| `declared-conflict` | A 声明与在场的 B 的某个版本范围冲突，且 B 的版本命中 | error |
| `duplicate-service` | 同一 service 名被 ≥2 个插件声明（只能有一个 provider 生效） | error |
| `dsh-version` | 声明里的 DSH 范围不满足当前宿主版本 | error |
| `missing-dependency` | `requires` 指向的包不在场 / 被禁用 | error（没装）/ warning（被禁用） |

三条诚实边界写进实现，而不是文档：

1. **没有声明 ⇒ 不产生 finding**。缺字段、形状非法、版本范围不可判定、对手不在场，
   一律沉默 —— 「没声明」与「声明了但成立」在输出上可分。
2. **每条 finding 带 `source{file,line}` + `declaration` 原文**，评审/用户能回指到声明本身。
3. **finding 不是隔离计划**。参考实现 compat-guardian 把 finding 直接算成 quarantine；
   本插件分开：finding 是事实，计划器（§17.2）才决定「关谁、关几个、能否治好」。
   合并会让「发现了冲突」被误读成「已经解决」。

### 17.2 贪心最小隔离：每一步都建立在上一轮的真实残局上

`guard/quarantine-plan.ts` 的循环是：取候选 → 标记停用（含依赖闭包） → 用新的在场集合
重算 error finding → 再取；终止于 error 清零、无候选、或配额上限。三个非显然决定：

- **为什么贪心而不是一次算完**：finding 是耦合的 —— 关掉 A 后 B 的 `declared-conflict`
  可能消失，而 C 的 `missing-dependency` 可能从 warning 变 error。一次挑一批再验证，
  会得到「关了 3 个还剩 2 条 error」的半成品。
- **依赖联动是硬需求，不是优化**：关 X 却留下 `requires X` 的 Y，等于制造一次新的加载失败
  （Y 在 `import 'X'` 处抛错），用户会以为「关插件反而更糟」。`dependentsClosure` 用反向邻接表
  求依赖者闭包；环状依赖由 `visited` 集合终止。
- **配额按整组判定**：关一半（leaf 关了、依赖它的 mid 留着）比不关更坏。整组放不进
  `maxAutoDisable` 就**一个都不动**，残余进 `unresolved`。

排序三条（`orderCandidates`）：已停用优先（再关一次零代价）→ `dshCompat.priority` 升序
（先关作者标记为低优先级的）→ 列表靠后（旧插件已稳定跑过，新装的是下一步排障主线索）。
**所有候选都未声明 ⇒ 直接返回输入顺序**，无声明 profile 的隔离顺序与旧实现（纯 recency）
逐位一致 —— 这是兼容性兜底，有双向排序夹具。

`unresolved` 是**数据面字段**，不是日志：它必须进 `status` / 面板快照 / `decision.json` /
`recover` 输出。静默吞掉会让用户以为隔离成功（「受保护组件/官方插件不许关」导致的残余，
恰恰是守护不该假装解决的那部分）。

### 17.3 崩溃路径只做一轮，启动后的 recover 做完整循环

崩溃路径没有 `await` 的余裕（进程正在死），`deterministicTargets` 只做**一轮**：把 error
finding 直接点名、且在嫌疑名单里、且不受保护的插件挑出来当目标。真正的
「取候选 → 标记 → 合并 → 重算」留给启动后的 `recover()`（异步、可多轮）。

两条不变式：

- **未命中声明 ⇒ 目标 = `pickSuspects` 的 recency 前缀**（旧行为逐位不变）；
- **命中了但计划为空**（全受保护）⇒ 不行动，不拿 recency 嫌疑人顶替确定性目标
  「装作解决」；残余进 `unresolved`。

`crash-decision.ts` 是这段四路输入（排名 / 崩溃历史 / findings / 依赖图）的纯组装函数，
`verdictPatch()` 让观察轮与行动轮共用同一份判定快照形状（否则面板在「观察中/已行动」
两种状态会显示不同字段 —— 用户会以为系统行为变了）。

### 17.4 可写 rescue：逃生通道的第一纪律是「默认不写」

v0.9 的 rescue 只读；但宿主崩到起不来时，「把决策里那个插件从 profile bundle 列表摘掉」
正是让它重新起来的手段。`bin/rescue.mjs` 因此新增写面，但把风险约束写进形态：

- **默认 dry-run**：`apply` / `restore` 不带 `--yes` 只打印计划，绝不写盘；
- **两阶段记录**：先写 `prepared`（含 `beforeHash` / `afterHash` / 每个 bundle 的原 index）→
  原子改 profile `package.json` → 标 `applied`；
- **中断恢复按哈希判定**：`restore --resume` 读到 `prepared` 后，当前哈希 == `afterHash`
  ⇒ 第二步其实已完成、按已生效回插；== `beforeHash` ⇒ 没发生、记录作废；两者都不是
  ⇒ 现场已变，**退出码 3 拒绝**，绝不硬改；
- **回插按原 index 升序**：一次只改一个位置，index 才不会互相挤位。

这不是第二个守护：rescue 不计算决策，只执行/回滚 `decision.json` 已有的事实，
并且只在面板/工具/路由全不可达时使用。

### 17.5 决策与启动编排提取 + 常态路径锁

`crash-decision.ts` / `boot-orchestration.ts` 是从 `index.ts` 的**纯搬家**（组合根复杂度治理）：
判据顺序（哨兵在 > 异常终止 > 恢复名单 > 干净启动）是语义，不是风格 —— 顺序一换，
「关了嫌疑 → 又死一次（无哨兵）」会被读成崩溃已过而把隔离亲手拆掉。

锁与原子写（`store.ts` 的 `writeDecisionLocked` / `updateDecisionLocked`、
`core/isolation.ts` 的 `writePartitionIndexLocked`、`data/lock-hygiene.ts`）：

- 崩溃路径仍**全同步**（异步写输给崩溃）；
- 常态路径（启动编排/恢复，已有 `await`）用跨进程文件锁做幂等提交，消除
  「4 个并发子进程 → 分区索引只剩 2 个」的丢条目窗口；
- 锁卫生清理**空/非 PID/死 PID 且年龄 > 5s** 的遗留锁：0 字节 `*.lock` 会让
  atomic-write 一直等待、超时后 `boot` 重抛 → 宿主 fatal load failure（真机连续 5 次）。
  `pid=0` 在 POSIX 上 `process.kill(0,0)` 成功，必须当「不完整记录」而不是「活进程持有」。

### 17.6 客户端可空契约：类型层放宽，渲染层诚实降级

跨分区只读视图会发 `null` / 整段省略（`metrics` / `capability` / `markov` / `revision` …），
而宿主类型声明非空；`Metric.defined === true` 也不保证子字段非空。修法**不是**在宿主侧
补一个假 0（不可判定 ≠ 零），而是在客户端 `snapshot-view.ts` 的 `PanelSnapshotView` 里
显式列出「已证明可空」的字段，渲染层降级；契约测试 `panel-snapshot-nullability` 守护清单。
同一条纪律：**类型不是运行时事实**。

### 17.7 验证与口径

- `npm test` **84/84**（Core 42 / Host 10 / Client 24 / Contract 8），
  `npx tsc --noEmit` 0、`npm run lint` 0、`npm run build` 双产物成功（2026-11-11 实测）。
- 新能力的文档落点：README 能力表（确定性冲突证据 / 贪心最小隔离）、
  [api.md](./api.md)（`conflicts` / `unresolved` / rescue 写面 / `decision.json`）、
  [capabilities.md](./capabilities.md)（22 条能力 id 未变，新模块是既有能力的实现拆分）。

### 17.8 竞态与对账（T14-08 真机修复）

两个真机复现的写竞态，共同形状：**崩溃路径是同步写（锁不住它），启动路径是异步写
（可能落后落地）**。只加锁修不了 —— 锁只能串行化遵守锁的写者。

#### 17.8.1 journal 改真追加（append-only）

旧实现是「整读 → 追加一行 → 原子写回」。启动期 `recordChanges` 的异步 append 先读到
一份**不含崩溃事件**的旧快照，随后进程崩溃、退出处理器同步写入 `crash-detected`，
而那个挂起的异步写最后落地，把整份 journal 覆盖回旧快照 —— 崩溃因果链在最需要的时刻
消失（实测约 1/9 概率，`missing-dep-required` 用例复现）。

修法不是给旧实现加锁，而是**换数据结构**：journal 本来就是 append-only 日志，
`appendSync` / `append` 改用 `appendFileSync` / `appendFile`（O(1)，无整文件替换），
任何写者都不可能用旧快照覆盖别人的新行。行数上限改由 `trimJournalIfNeeded()`
在**安全时机**（异步、加锁、幂等）执行；**崩溃路径永不 trim**。

残余边界（诚实登记）：trim 的「读最新 → 原子写回」仍可能吞掉恰好发生在写回窗口里的
一次 crash append；但它只在**超过 1000 行**时触发（每 1000 条事件一次），
而旧实现是**每次 append** 都处于该窗口。测试：
`journal-append-race.test.ts`。

#### 17.8.2 以决策文件为真相补账（state-reconcile）

症状：决策文件 `disable` 里有坏插件、journal 有 `crash-detected.suspects`，
但 `state.json` 的 `crashSeq=0` 且 `autoDisabled=[]`。根因是崩溃处理器「写完 decision
再写 state」之间，启动期那个挂起的「干净启动清零」`updateState` 落地，把刚写的状态
覆盖回旧快照。

修法：**决策文件是权威**（它决定下次启动拦谁），state 只是投影。下次启动若
**哨兵在场**（= 上一轮确实崩溃过）且 `reason === 'crash-recovery'` 且 `disable` 非空，
而 state 少了这些插件 / `crashSeq < 1` ⇒ 按决策文件补账，并写一条 journal note。

三条边界（不猜）：没有哨兵 ⇒ 不补（可能干净退出，决策是恢复流程发布的）；
`reason !== 'crash-recovery'` ⇒ 不补（恢复流程的 disable 不是崩溃证据）；
`disable` 为空 ⇒ 不补（观察轮本来就不关人）。补账幂等：一致时返回 null。
测试：`state-reconcile.test.ts`。

#### 17.8.3 CAS 清零

干净启动的「崩溃计数归零」只在**它没被本轮崩溃改过时**执行：
`updateState((s) => (s.crashSeq === state.crashSeq ? { ...s, crashSeq: 0 } : s))`。
boot 是异步的，其 `updateState` 可能在崩溃之后才拿到执行权；无条件写 0 会抹掉退出
处理器刚写下的 `crashSeq=1` —— 表现就是「关了插件但 crashSeq=0」，下一轮失去升级依据。
测试：`boot-crashseq-race.test.ts`。

#### 17.8.4 降级必须留可复核证据

`boot-orchestration.ts` 的三个 catch（分区索引加锁提交、`recordChanges`、官方实验观测）
原本只 `logger.warn` —— 重启后不可查。现在各自追加一条 journal `note`，并带机器可读字段
`degraded: true`：日志是给人当下看的，journal 是给事后排障与面板消费的。

同时新增**可选注入点** `commitPartitionIndex?`（默认就是 `writePartitionIndexLocked`，
缺省行为逐位不变）：它是启动路径上唯一的 IO 失败兜底分支，不注入就只能靠真把磁盘写坏
才能覆盖 —— 那测的是环境不是契约。测试：`boot-degradation.test.ts`。

#### 17.8.5 不可观测死分支：转成可观测再做断言

`quarantine-plan.ts` 的终止性上界原本是「每轮至少停用 1 个」推出来的隐式事实：
有限候选被逐个停用后必然落到 `no-candidate`，**循环体自己永远走不到预算耗尽** ——
这是一行没人能触发的死代码，变异体改坏它没有任何测试变红。

修法：导出 `roundBudget(pluginCount) = pluginCount + 1`，并允许
`PlanOptions.roundBudget` 注入更小预算，让「预算耗尽（`terminatedBy: 'cap'`）」
成为**可断言分支**。+1 的理由：最后一个候选被停用后，循环需要再走一轮才能观察到
`error` 已清零（否则会误报成预算耗尽）。

纪律：**不可观测的死分支要转成可观测再做断言，不要给它补假测试。**

## 18. 研究闭环状态（v0.17.0）

> 研究闭环的判据不是「机制实现了」，而是「**这个研究方向的产出，在生产路径上被谁消费**」。
> 没有消费者的机制就是孤岛 —— 本轮 cycle-15 就是为了修 RQ3 的孤岛状态。
> 每行四列：机制 / 生产消费 / 验证 / 诚实边界。

### 18.1 四问闭环表

| RQ | 机制 | 生产消费（谁读它） | 验证 | 诚实边界 / 闭环状态 |
| --- | --- | --- | --- | --- |
| **RQ1 归因更准** | 贝叶斯并行读数（[`risk-bayes.ts`](../../src/host/risk/risk-bayes.ts)）；确定性冲突证据（[`conflict-declarations.ts`](../../src/host/guard/conflict-declarations.ts) / [`conflict-findings.ts`](../../src/host/guard/conflict-findings.ts)）；因子快照（[`decision-evidence.ts`](../../src/host/guard/decision-evidence.ts)） | [`status-projections.ts`](../../src/host/surface/status-projections.ts) → `status` / 面板 `bayes`；[`crash-decision.ts`](../../src/host/guard/crash-decision.ts) 读 findings 决定隔离目标；面板读 `decisionSuspects` / `conflicts` | [`risk-bayes.test.ts`](../../tests/unit/risk-bayes.test.ts)、[`deterministic-evidence.test.ts`](../../tests/unit/deterministic-evidence.test.ts)、[`conflict-findings.test.ts`](../../tests/unit/conflict-findings.test.ts) | 贝叶斯**只并行显示**，不切换默认 `riskScore`；无真实崩溃样本时「Top-1 命中率提升 ≥5%」**未声称达成**；无声明 ⇒ 不产生 finding。**机制闭环 / 效果未证** |
| **RQ2 误伤更少** | 误伤校准（[`risk-calibration.ts`](../../src/host/risk/risk-calibration.ts)，只从观测到的用户撤销调整阈值）；`unresolved` 上屏；贪心最小隔离（[`quarantine-plan.ts`](../../src/host/guard/quarantine-plan.ts)） | 校准读数进面板/status；`unresolved` 进 `status` / `PanelSnapshot` / `recover` / `decision.json`；隔离计划决定 `recover` 实际关闭集 | [`risk-calibration.test.ts`](../../tests/unit/risk-calibration.test.ts)、[`unresolved-surfacing.test.ts`](../../tests/unit/unresolved-surfacing.test.ts)、[`quarantine-plan.test.ts`](../../tests/unit/quarantine-plan.test.ts) | 阈值**只升不降**且必须有观测到的用户撤销才动，无数据不动；`unresolved` 是「治不了」不是「已治好」；无真实误伤样本 ⇒ 误伤率下降**未声称达成**。**机制闭环 / 效果未证** |
| **RQ3 信号更早** | 预防性健康指标（[`preventive.ts`](../../src/host/observe/preventive.ts)）：启动频率 EWMA 控制带 + 配置变更 CUSUM | **v0.17 接通生产**：[`preventive-view.ts`](../../src/host/surface/preventive-view.ts) 是第一个生产消费者 → `PanelSnapshot.preventive`（以及本轮 status/面板消费）；此前 `grep "from.*preventive" src/` = 0，属**孤岛** | [`observability-math.test.ts`](../../tests/unit/observability-math.test.ts)（数学）、[`preventive-wiring.test.ts`](../../tests/unit/preventive-wiring.test.ts)（源码扫描：只预警、无关闭依赖） | **只预警、零行动**：`preventive` 绝不被 `recover()` / 决策读取；加载耗时用「启动频率」**代理**（journal 没有真实加载耗时），代理链写在数据面；样本不足 ⇒ `defined:false` + reason，不填 0；「预警提前量 ≥1 轮」**未声称达成**。**机制闭环（有生产消费者）/ 效果未证** |
| **RQ4 验证更硬** | 自动化变异（`scripts/mutation.mjs`）+ 故障注入 + `rescue.mjs` / `tool-text.ts` **跨实现 width 对拍** + 无直接测试清零与归因账本 | 工程门禁消费（G2 / E4.1）；变异报告与归因账本供交付审计；**不在运行时路径** | [`fault-injection.test.ts`](../../tests/fault-injection/fault-injection.test.ts)、[`width-parity.test.ts`](../../tests/contract/width-parity.test.ts)、[`mutation-report.md`](../../.cycles/verify/mutation-report.md)、[`mutation-equivalents.json`](../../.cycles/verify/mutation-equivalents.json) | 本轮实测：**72 变异体 / 60 断言杀死 / 12 已证等价 / 0 未归因**（有意义口径 100%，门禁 80% PASS）；无直接测试 **14 → 2**（`event-watch.ts` / `tool-registration.ts`）。杀灭率分母只是「工具生成的变异体」；等价体必须**有 proof 才剔除**；工具边界不冒充等价；无直接测试数是覆盖信号不是质量结论 |

### 18.2 「谁消费」总表（闭环判据）

| 产出 | 生产文件 | 生产消费者 |
| --- | --- | --- |
| 贝叶斯后验 / 可信区间 | `risk-bayes.ts` | `status-projections.ts` → `status` / 面板 |
| 确定性冲突 finding | `conflict-declarations.ts` / `conflict-findings.ts` | `crash-decision.ts` / `status-view.ts` / `snapshot.ts` / 面板 |
| 误伤校准读数 | `risk-calibration.ts` | `observability.ts` → 面板 / `status` |
| 贪心隔离计划 + `unresolved` | `quarantine-plan.ts` | `crash-decision.ts` / `recover` / `decision.json` / 面板 |
| 预防性预警 | `preventive.ts` | **`preventive-view.ts` → `PanelSnapshot.preventive` / status / 面板（v0.17 新增）** |
| 变异/对拍报告 | `scripts/mutation.mjs` + 测试 | 工程门禁与交付审计（非运行时） |

### 18.3 仍未闭环（如实登记）

- **RQ3 的「提前量」效果**：机制接了生产，但「预警提前量 ≥1 轮」需要真实崩溃前样本，
  当前只有机制与诚实边界，**不声称效果**。
- **RQ1 Top-1 / RQ2 误伤率**：模型已并行读数并上屏，但没有真实崩溃 / 误伤样本，
  改进幅度**不在本轮结论内**。
- **共现加权**：`cooccurrence.ts` 只给「可加权」判定（`mayWeightByCooccurrence`），
  决策权重仍为 0 —— 研究 09 §4.3 要求先验证再加权，本轮**有意不闭环**这一项，
  并在 README 诚实边界写明「只判定不加权」。
- **跨实现对拍只覆盖 width 函数**：`rescue.mjs` 与 `tool-text.ts` 的其他重复逻辑
  （CJK 对齐、截断格式）仍靠各自纪律，不声称「两份实现全等价」。
- **无直接测试仍余 2 个模块**：`event-watch.ts` 与 `tool-registration.ts`（事件订阅 / 组合根接线，
  需要集成夹具而不是纯函数测试）—— 不把「14→2」写成「已清零」。
- **TD-5**（journal 裁剪窗口）**v0.18 已关闭**：裁剪改**轮转**（rename，
  无读改写窗口）；TD-6（分区索引同步首写窗口）仍是**部分关闭**，见
  [tech-debt.md](./tech-debt.md)。

---

## 19. v0.18.0：级联刹车与崩溃前回滚（cycle-16 T16-12，用户场景驱动）

### 19.1 场景与缺陷

**场景（用户原话提炼）**：DSH + 桌面版下载插件后无法启动，安全模式、禁用插件、
救援工具都试过，还是崩溃。本插件的自动禁用在崩溃循环里**逐轮加深**：第
`confirmRounds` 轮关 1 个、+1 轮关 2 个、封顶 `maxAutoDisable`。封顶之后，
旧实现**永远停在「关 N 个」**——崩溃仍在继续，但插件不再有新的行动：

- 用户拿到的是「越关越空的 profile」，真正的问题插件被淹没在被误伤的插件里；
- 唯一的逃生是手动 `restore` 或走「清空本地工作区」的最后一计（风险提示：
  会清空会话记录、插件配置、登录状态、API Key）——**代价极高**。

用户要求：出现该场景后，重新使用本插件时要**自动启用崩溃前的插件启动状态，
有问题进行禁用**；本插件要**减少崩溃和崩溃后禁用重启的兜底**。

### 19.2 设计：级联刹车 + 崩溃前回滚

**判据（单源，两条通道共用）**：`escalationExhausted(seq, confirmRounds, maxAutoDisable)`
= `seq >= confirmRounds + maxAutoDisable`。升级步数（`over = seq - confirmRounds`）
用满一轮 ⇒ 刹车。哨兵通道（`assessConfidence`）与异常终止通道
（`abnormalExitDecision`）**共用同一判据**——两通道各写一套「到顶怎么办」
迟早漂移，用户拿到的行为取决于崩溃碰巧走了哪条通道。

**刹车后的决策**：不再新增禁用，决策 `disable` 名单收敛为「仅头号嫌疑」，
`phase: 'rollback'`，`state.lastRecoveryVerdict.rollback = true`，
`state.rollbackArmed = true`。**确定性证据不回滚**：唯一嫌疑 / 声明命中时
第 1 轮即行动（证据确凿的精准隔离不受「越关越空」问题影响）。

**回滚动作（`rollbackToPreCrash`）**：由**下一轮启动**的 boot 编排消费
`rollbackArmed` 执行 —— 崩溃路径（process exit 处理器）只有同步 IO 预算，
回滚要调插件管理器的 `setBundleEnabled`（异步、HMR 事务），与 autoRestore
的 1.5s 延后同源。回滚把 `autoDisabled` 里**除头号嫌疑**外的全部重新启用
（恢复崩溃前启动状态），头号嫌疑保持关闭；管理器拒绝的插件**如实留在
名单待重试**（不谎报回滚成功）。

**诚实边界**：
- 回滚后若头号嫌疑仍致崩，新一轮循环从干净状态重新升级 —— 不会因计数残留
  而立刻再次刹车；
- 回滚失败者留在 `autoDisabled`，下轮启动重试，绝不「假装回滚成功」；
- journal 新增 `rollback` kind（跨层词汇表四处同步：store / observations /
  FLOW_BY_KIND / LifecycleStepName）。

---

## 20. v0.18.0：执行操作记录（cycle-16 T16-14，用户要求「插件的执行一定要有操作记录」）

### 20.1 问题

插件有两类执行留痕：**journal 事件**（install/disable/enable/restore/
crash-detected…）与**状态机迁移**（stage 轨迹）。但两者都不回答
「这次执行动作本身做了什么、耗时多少、成败如何」：

- `recover()` 是核心执行动作（贪心隔离 / 回滚），**此前没有任何步骤留痕**
  —— 唯一没有 beginStep/endStep 包裹的核心动作；
- `lifecycle.steps`（StepSpan：name/startedAt/endedAt/durationMs/ok/reason）
  只进 `status` 工具输出，**面板不可见**。

### 20.2 设计

**留痕**：`recover()` 拆为外层包装（beginStep/endStep + 失败带原因）与
`recoverInner()`（原实现体）。动作开始前 beginStep、结束（无论成败）endStep
—— 与 restore/rollback/boot/loader 同形态，**没有「做完了但没记录」的通道**。

**上屏**：`PanelSnapshot` 增加 `steps: StepSpan[]`（`SnapshotInput.steps`
可选，旧调用方/测试夹具缺省为空数组 ⇒ 快照给出空数组，不构造假记录）。
面板生命周期卡新增「执行操作记录」区块，由纯函数 `stepRows` 投影：

- **三态诚实表达**：成功（ok + 耗时）、失败（failed + 原因摘要）、
  执行中（running、无耗时、无结果）——「还在跑」与「跑完了」是两回事；
- **数据层不截断**：投影消费调用方传入的完整数组；截尾（slice(-12)）
  是调用方的显示策略，投影层保持全量；
- **与迁移列表互补**：迁移回答「状态到哪了」，步骤回答「每次执行做了什么」——
  两层事实分开展示，用户不会把「阶段从 A 到 B」误读为「动作完成了」。

---

## 21. v0.19.0：命令窗口显示的根修复与三条诚实边界（cycle-17）

### 21.1 问题的根因（不是「显示不好看」，是「根本没被消费」）

宿主侧的 `ctx.tools.register` 支持三条投影钩子：`presentCall`（待执行卡片）、
`presentResult`（完成卡片）、`output.presentationMeta`（持久化的展示模型）。
本插件 v0.18 之前把它们构造得很完整 —— 有标题、有事实分区、有省略计数、
有截断指标（`tool-presentation.ts`）。

**但内置 Web Client 不消费 `presentCall` / `presentResult`。**
这两条钩子只服务于「有能力的 UI」（如 dsh-ops 自己的 TUI 面板）。
落到内置 Web Client 时，工具调用退化为 **generic 行** —— 用户在命令窗口
看到的是「一串参数 JSON + 一坨原始文本」。

这是**静默失效**：不报错、不降级、面板照常出数，只有命令窗口那一行是错的。
`dsh-anic` 在 cycle-107 实测踩到同一个坑（其
`src/client/integrations/ToolViewIntegration.ts:4-11` 记录了根因），
本插件沿用其修法。

### 21.2 设计：client 半部注册 `tool.call.toolview` keyed slot

唯一能被内置 Client 消费的扩展点是 `tool.call.toolview`：
宿主会话面板挂载时按**工具名**（key）查表，命中就用我们注册的组件渲染该行。

新增三个文件（`src/client/toolview/`）：

| 文件 | 职责 | 为什么独立 |
| --- | --- | --- |
| `ToolViewIntegration.ts` | 席位注册 + 幂等守卫 + 遥测 | 副作用面（注册） |
| `GuardToolCard.tsx` | 卡片渲染 + CSS 唯一真源 | 展示面（React） |
| `toolview-model.ts` | **零 React 依赖**的防御式抽取层 | 纯逻辑（可测） |

**三条纪律**（每条都对应一类真实缺陷）：

1. **注册必须在 `ctx.slots.inject('tool.call.toolview', cb)` 里** ——
   席位由宿主 ToolCallTree 声明，只在会话面板挂载时存在；提前 `register`
   会撞「向未声明 slot 注册」，整个 entry 失败（面板全灭）。
2. **幂等守卫用 `slots.entries()` 反查** —— 防热重载 / 双挂载。
   键已占用即跳过，不报错（键位替换是宿主契约，不是冲突）。
3. **注册计数必须是 getter** —— `inject` 回调是宿主**延迟**调用的
   （ToolCallTree 挂载时），`apply()` 返回瞬间注册数还是 0；
   静态快照 `{ count: 0 }` 会永远停在 0，与 DOM 实际渲染的卡片数脱钩
   （anic 实测：5 张卡片 vs count=0）。

### 21.3 诚实边界：卡片只转述 host 侧的事实

卡片**不重新解释**数据：

- `facts` / `sections` / `omitted` 只从 host 侧 `presentationMeta` 取，
  **不从正文里猜结构**；
- 分区默认折叠与否由 **host 侧**决定（`sections[].collapsed`）——
  卡片不重新决定，那会形成第二真相源（两边各写一套折叠策略，必然漂移）；
- 拿不到 `exitCode` / `durationMs` 就显示「未提供」，**绝不臆造 0**
  （`exit 0` 与「没有退出码」在命令窗口里长得几乎一样，但含义相反）。

### 21.4 三条新增的诚实边界（v0.19）

| 边界 | 现象 | 修法 |
| --- | --- | --- |
| **ANSI 负载残留** | 逐码点剥 ESC 会把 `[31m` 留成**可见字面量**（实测 `safe\u001b[31mRED` → `safe[31mRED`）—— 不是「安全了」，是「安全地留下了垃圾」 | `stripAnsiSequences()` **序列级**剥除（CSI / OSC / DCS / 两字符转义 / 孤立 ESC / 裸 CR），作为 `sanitizeText` 的**第一步** |
| **产物可能是旧的** | `link:` / `file:` 安装下改了 `src/**` 但忘了重建 ⇒ 宿主跑的是上一版产物，而插件照常加载、工具照常注册、面板照常出数 —— **只有行为是旧的，且不报错** | `build-freshness.ts`：构建指纹（sha256 组合）+ mtime 漂移判定，**三态**上屏（一致 / 已过期 / **无法判定**）。版本取自 `package.json`（不是从产物里正则捞 —— 产物里到处是 `0.9.0`，正则会捞到第一个匹配的 = 假事实） |
| **跨项目串扰** | 切换查看的分区时，**旧分区还在路上的响应**落地 ⇒ 画面显示旧分区事实。在一个专门做隔离的插件里，用户会据此对**别的项目**的插件做出关闭/恢复决策 | `epoch-guard.ts` 世代守卫：请求发起时记世代号，落地时比对，不匹配即丢弃。与既有的 `partitionMismatch` **不是同一道防线**（那个比对「请求 vs 响应自称」，这个比对「是否已过期」） |

### 21.5 为什么不用 AbortController 代替世代守卫

AbortController 能取消**传输**，未必能阻止已 resolve 的 promise 的 `then` 执行 ——
「取消」与「不落地」是两件事。世代守卫管的是后者，且它对**不可取消的注入实现**
（测试桩、旧宿主）同样有效。两者可叠加：AbortController 省带宽，世代守卫保正确性。
本仓选世代守卫，因为它是**纯函数**、可测、且不依赖 fetch 实现。

### 21.6 沙箱真机判据（cycle-17 实测）

| 判据 | 观测 | 结论 |
| --- | --- | --- |
| 插件加载 | 沙箱 `sb-rg-c17` 启动日志**无** `skipping profile bundle` | ✅ 未被兼容闸门跳过 |
| 面板注册 | `window.__RECENCY_GUARD__.registered === true`、`skipped === null`、`error === null` | ✅ 面板已注册 |
| **命令窗口卡片注册** | `window.__RECENCY_GUARD_TOOLVIEW__.count === 1`、`error === null` | ✅ keyed slot 命中 |
| 卡片样式 | `#rg-toolview-css` 在 DOM 内、含 5 类结构、只用 `--dsw-alias-*`、无裸 `var()` | ✅ 语义令牌合规 |
| 面板内容 | 5 个分组 / 17 张卡 / 22 节点 124 边 / 图谱 18 个工具控件 / 小地图 / 3 组图例 | ✅ 完整渲染 |
| **产物新鲜度上屏** | 诊断卡显示「产物新鲜度：产物与源码一致」 | ✅ 新字段生效 |
| 退避上屏 | 状态条「每 15 秒轮询 · 数据稳定，已放慢刷新」 | ✅ 自适应退避生效 |
| 图谱交互 | 点节点 ⇒ 详情侧栏打开（类型/引用/度数/影响面上游 0 · 下游 17 / 7 个消费方 / 居中定位） | ✅ 可交互 |
| 面板健康 | 无错误边界（`.rg-error-boundary`）、无降级提示（`.rg-notice-degraded`） | ✅ 无降级 |
| 崩溃检测 | 沙箱首个进程被强杀 ⇒ journal `crash-detected`（哨兵缺席通道）+ `abnormalExitSeq=1` + 刹车判据「观察中 1/2 轮，不动手」 | ✅ 双通道 + 概率证据不误伤 |
