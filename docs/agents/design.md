# 架构与设计（dsh-recency-guard v0.7）

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
├── patch-scalar.ts     YAML 标量层（发射 / 读取 / plain-scalar 合法性）
├── patch-yaml.ts       YAML 文档层（按缩进扫描 → 行结构 + 子集校验）
├── patch.ts            profile patch 行寻址 + 守护行文本 + 备份（门面，再导出标量层）
├── guarded-rows.ts    守护行安装（同步）+ 追加的校验/原子/回滚
├── recency.ts          嫌疑分类与最近更新排序
└── client/
    ├── index.ts        席位注册（main + sidebar.panellist）
    ├── GuardPanel.tsx  管理面板（KPI 条 + 可折叠卡片 + 图谱 + 归档）
    ├── GuardGraph.tsx  可交互图谱（曲线边/拖拽/搜索/详情侧栏/双击居中）
    ├── viewport.ts     视口原语（纯函数）+ 曲线边/平行边/搜索/居中
    ├── api.ts          数据面客户端（形状校验，诚实失败）
    └── i18n.ts         自持字典（zh/en，递归 Dict，回退链可见）
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

### 10.1 马尔可夫转移矩阵（src/markov.ts）

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
  与 src/tool-text.ts 的同名原语语义一致但不共享代码 —— 崩溃现场 node_modules
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
