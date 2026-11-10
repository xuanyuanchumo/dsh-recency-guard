# 对外面 API（dsh-recency-guard v0.13.0）

## 0.0f v0.13 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
|---|---|---|
| **`decision.json` 的 `suspects[]` 新增 `evidence` 字段** | 记录 `rank / risk / factors{recency,experimental,crashFrequency} / streak / changeCount / source`；回答「为什么是 A 而不是 B」 | **纯追加**（守护行只读 `disable`，老版本读到新字段不崩；有契约门） |
| **决策排序口径统一** | 概率性证据（多嫌疑）改按 `riskScore` 排序头号嫌疑；确定性证据（唯一嫌疑）保持时间戳序 | 行为变更（唯一嫌疑零变化） |
| **`riskScore` 拆出 `riskFactors`** | 三因子加权贡献可单独消费；`riskScore` 改为其组合 | 兼容（数值逐位不变，有对照断言） |
| **`RiskInput` 新增可选 `changeCount`** | 变更频率作为 recency 的调制乘数 `1+α·density`（α=0.5, cap=5） | 兼容（缺失 ⇒ 乘数 1 ⇒ 与 v0.12 逐位一致） |
| **`assessConfidence` 新增可选 `hazardDirection`** | 按崩溃间隔 Weibull 形状调整 `confirmRounds`（±1 轮） | 兼容（缺失/不可靠/撞边界 ⇒ 不调整） |
| **`status` 新增 `decisionEvidence` / `cooccurrence`** | 命令窗口携带三因子分解与共现验证结论 | 兼容（只增） |
| **面板快照新增 `decisionSuspects`** | 「决策因子」卡片的数据源（含 `hasEvidence` 诚实边界） | 兼容（只增） |
| **`Config` 改为惰性加载** | schemastery 缺失 ⇒ 纯对象 schema 降级（8 字段齐全）；dsh-tools 缺失 ⇒ 工具定义原样注册 + `degraded` 标记 | **修复安装即崩**（此前静态 import optional peer） |
| 新增 `src/decision-evidence.ts` / `cooccurrence.ts` / `client/graph-analysis.ts` | 纯函数模块，各自带单测 | 新文件 |
| 新增契约门 `install-resilience` / `decision-compat` | optional peer 不得静态 import；守护行不得读 `evidence` | 新门（含变异自证） |

**关键兼容性论证**：`evidence` 是**展示与回放**字段，不参与拦截判定。守护行仍只读
`disable` 数组 —— 若让它依赖 `evidence`，旧版决策文件（无该字段）会静默全放行
⇒ 崩溃重演。这条由结构门 + 行为门 + 变异自证三重钉住。

## 0.0e v0.11 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
|---|---|---|
| **动作路由新增方法守卫** | `/action/*` 非 POST 一律 405 + `allow: POST`（此前 GET 也会触发归档——P0 安全修复） | 破坏性收紧（此前 GET 行为是缺陷，不是契约） |
| **`/snapshot` 支持 `?partition=<key>`** | 请求其它分区返回只读磁盘投影（`readonly:true`，stage 恒 idle + 说明标签）；未知分区 `{available:false, reason}` | 兼容（无参数行为不变） |
| RouteContext 新增 `snapshotPartition(key)` 与 `projectKey` | 路由接线处必须提供（index.ts 已接） | 内部接口 |
| 新增 `/action/restore` 路由（POST） | 面板「恢复非嫌疑插件」按钮；`PanelAction` 联合类型加 `'restore'` | 兼容（只增） |
| 能力清单 `guard.recover.restore` 新增 `exposedAlsoAs: ['recency-guard.restore']` | 契约测试双向核对新路由名 | 兼容（只增） |
| 面板快照 `MarkovRowView` 新增 `exits: Array<{stage, percent}> \| null` | 跨阶段去向 top-2 徽标（此前只渲染自环——P0 展示缺口） | 兼容（只增） |
| 面板 i18n 新增 `panel.restore` / `panel.stale` / `graph.matchIndex` / `events.more` | zh/en 218+ 键同步 | 兼容 |
| 图谱图例色跟随着色口径（`legendColorOf`）+ 形状图例（`legendShapeOf`） | graph-model 新导出两个纯函数；GraphToolbar props 新增 `allNodes` / `matchIndex` / `onMatchNext` | 内部接口 |
| 新增 `tests/client/graph-model.test.ts` 与 `tests/host/routes.test.ts` | 测试 12→13 文件；HTTP 行为与图谱纯函数不再零覆盖 | 新文件 |
| **v0.11.3**：图谱边可交互（悬停/点击 → 边详情侧栏）+ 布局 transform 过渡 | `edgeDetailOf` 纯函数（graph-model）；`EdgeDetails` 组件（GraphParts）；边选中与节点详情互斥 | 兼容（只增交互） |

## 0.0d v0.10 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
|---|---|---|
| 面板快照新增 `markov: MarkovAnalysis` | 转移矩阵卡：阶段去向分布 + 幂法平稳分布；samples=0 时 stationary=null（不猜） | 兼容（只增） |
| `MetricsSnapshot` 新增 `controlBand`（休哈特单值-MR 控制带） | 指标卡新增「控制带」行；间隔 < 2 时 undefinedMetric | 兼容（只增） |
| 面板快照新增 `diagnostics` 投影 | 系统诊断卡：插件/宿主版本、平台、Node、分区键、快照耗时、repositoryUrl/issuesUrl（null = 隐藏，不放死链） | 兼容（只增） |
| package.json 新增 `repository` / `bugs` / `homepage` | 反馈入口的数据源（R18）；npm 与面板共用 | 兼容 |
| `status` 工具输出新增 `pluginVersion` / `issuesUrl`（可选） | 命令窗口 facts 带「插件版本」「问题反馈」行 | 兼容（可选字段） |
| `bin/rescue.mjs` status/history 输出按 CJK 显示宽对齐 | Windows 控制台不再错位（R10）；退出码契约不变 | 兼容（纯显示） |
| 新增 `src/markov.ts` 模块 | 马尔可夫链视角的状态机分析（宿主侧拥有，客户端只渲染投影） | 新文件 |

## 0.0c v0.9.1 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
|---|---|---|
| `status` 输出与面板快照新增 `lastRecoveryVerdict`（可选） | 命令窗口 facts 与面板生命周期卡片显示「观察中/已行动」判定；undefined = 本分区无崩溃决策史 | 兼容（可选字段） |
| `GuardState` 新增 `lastRecoveryVerdict`（可选） | 崩溃路径同步写入，重启后仍可读 | 兼容 |
| 事件流卡片 note 徽标派生 | detail 前缀（恢复判定/两阶段对账）→ warn/success 色调；存储词汇不变 | 兼容 |

## 0.0b v0.9 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
|---|---|---|
| Config 新增 `confirmRounds`（默认 2） | 多嫌疑恢复需连续 N 轮同头号嫌疑；唯一嫌疑不受限 | 兼容（confirmRounds=1 退化回旧行为） |
| `PrebootDecision` 新增 `phase?: 'prepared'\|'quarantined'\|'reconciled'` | 两阶段对账；守护行只认 disable 名单，语义不变 | 兼容（可选字段） |
| 面板快照新增 `backupPolicy` 投影 | 面板备份策略卡片数据源 | 兼容（只增） |
| 新增 `bin/rescue.mjs`（npm bin: recency-guard-rescue） | 宿主崩溃后的离线只读查询 | 新文件 |
| journal 观察轮记录 | act=false 轮写 note（恢复判定：…），crash-detected 链完整 | 兼容 |

## 0.0a v0.8 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
|---|---|---|
| `status.suspectRanking` 不再截断到 10，新增 `suspectTotal` | 消费方拿到全量排名 | 兼容（字段只增不减） |
| `backups` action 新增 `timelines` 数组（bundle/count/latestVersion/latestAt） | 消费方可展示时间线 | 兼容（可选字段） |
| Config 新增 `versionedBackups` / `backupRetain` / `backupRoot` | 备份策略可配 | 兼容（均有默认值） |
| journal 新增 kind `official-observe` | 官方实验插件观测事件 | 兼容（未知 kind 本就被容忍） |
| 新增 `observation-<name>.json` 观测快照文件 | 独立于 snapshot.json 的第二真相空间 | 新文件，无冲突 |
| 新增宿主事件订阅 `plugin-manager/changed`（500ms 防抖） | 变更即时入账；宿主缺席时静默降级 | 兼容 |

## 0.0 v0.7 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
|---|---|---|
| `patch.ts` 拆分为 `patch-scalar.ts` / `patch-yaml.ts` / `patch.ts` | 仅内部模块边界 | **兼容**：`patch.js` 继续再导出全部历史符号 |
| `appendPatchText()` 由 `void` 改为返回 `PatchAppendResult` | 追加可能被拒绝（非法 YAML / 重复 id） | **源码兼容**（忽略返回值仍可），语义变严 |
| `installGuardedRows()` 结果增 `blocked` / `warnings` | 调用方可区分"装上了"与"被校验拦下" | 仅新增可选字段 |
| 守护行文本改为全引号 | 落盘形态变化（`- id: 'x'`） | **YAML 语义兼容**，读取端已支持引号/裸值混排 |
| `readPatchRows()` 只认「顶层或 `insert:` 子项」的 `- id:` | 嵌套 config 的 `id:` 不再被当作行 id | 修正假阳性，属 Bug 修复 |

## 0.0e v0.12 契约变更一句话清单

| 变更 | 对外契约影响 | 兼容性 |
|---|---|---|
| **展示投影接线**：`presentCall` / `presentResult` / `output.presentationMeta` 真正接进 `defineTool`（此前三个纯函数写好了但没接线） | 命令窗口不再是「裸工具名 + 整坨参数 JSON」，而是人话标题 + 摘要 + 可折叠分区 | 兼容（只改显示，不改规范值形状） |
| 视图类型改用宿主词汇 `ToolCallView`/`ToolResultView`（`content` 是 `ContentBlock[]` 而非 `string`） | 消除本地第二真相源；宿主词汇演进时 tsc 阶段就失败 | 内部（对外 JSON 不变） |
| **`PanelSnapshot.revision`**（12 hex 哈希，由 state+decision+journal 尾派生） | 面板动作可携带 `expectedRevision`；过期 ⇒ **409 且动作不执行** | 只增字段；不带凭证的请求行为不变 |
| 跨分区只读快照 `revision: null` | 只读视图没有可改的事实，带凭证必然假冲突 ⇒ 显式 null 而非省略 | 兼容（消费方需区分 null 与 undefined） |
| **写动作审计行**（recover/restore/reenable/archive 各一条 `kind:note` + 结构化 `audit{actor,action,justification}`） | journal 尾部多审计行；读动作零噪声 | 兼容（复用 note，未新增 kind ⇒ 事件流消费链无需改） |
| 动作路由 `logError` 桥（子 fiber 的注册失败进宿主日志采集面） | 运维可见性提升 | 兼容 |
| `cordis` peer `~4.0.5` → `>=4.0.5 <5.0.0` | **修阻断级缺陷**：宿主实为 4.1.0，旧范围被兼容闸门整体拒绝（桌面端 `link:` 不走闸门所以一直没暴露） | 必要修复 |
| devDependencies 对齐装机代际 0.2.2-rc.1 | 测试跑的代际 == 装机的代际（INC-2026-11-08-01 深层形态） | 内部 |
| 新增 `dsh.compatibility.dshReleases` 逐发布线声明 | 市场索引/兼容闸门可逐版本判定，而不是只看 engines 区间 | 兼容 |
| 图谱：k 跳邻域聚焦（1/2/闭包三档）、小地图 Overview、边宽=连接度对数刻度、方向键二维导航 | 新增交互与档位；「只看关联」缺省从闭包改为 **1 跳** | 行为变更（闭包在连通图上等于不过滤，是缺陷修复而非回归） |
| 小地图几何独立成 `minimap-model.ts` | 无对外影响（内部拆分，避免复杂度越预算与循环依赖） | 兼容 |

## 0. 工具输出契约（v0.7）——双形态同源，最容易踩的一条

`recency_guard` 的 `execute()` 返回的是**规范 JSON 值**，不是字符串：

```ts
{
  action: 'status',
  ok: true,
  summary: '守护正常，无待处理崩溃',
  lines: [...],           // display.sections 的派生视图
  data: { profile, dshVersion, crashSeq, suspectRanking, experimentalSuspects, ... },
  display: { title, ok, summary, facts, sections, omitted, truncation },
  // 业务数据同时**摊平在顶层**（status.profile / status.suspectRanking 直接可取）
  profile: 'desktop',
  suspectRanking: [...],
  ...
}
```

规则：

1. **业务数据必须摊平在顶层**，同时保留在 `data` 下。历史上 `status.profile`
   一直是顶层字段；v0.7 重构 display 时漏掉摊平，宿主层测试立刻以
   `status.profile === undefined` 报出。模型与外部消费者只认顶层路径。
2. **`lines` 是 `display.sections` 的派生**，不是手写第二份 —— 手写两份必然漂移
   （"文本说 A、卡片说 B"）。
3. **兜底键顺序**：`...data` 在前，`action/ok/summary/lines/data/display` 在后，
   data 里即便出现同名键也顶不掉结构字段。
4. **命令窗口显示** 走 `output.render(args, value)` → `renderOutcome()`：
   摘要行 + 事实行（按列宽折行而非截断）+ 分区（含显式省略计数）。
   长内容必须折行/折叠，不允许出现超长单行。

## 1. Agent 工具：`recency_guard`

v0.4 起 `execute` 返回**规范 JSON 对象**（不再是字符串）：

```jsonc
{
  "action": "status",       // 回显
  "ok": true,               // 业务成功与否（业务失败不是异常）
  "summary": "…",           // 一行摘要
  "lines": ["…"],           // 人读明细
  "data": { … },            // 结构化数据（同时摊平到顶层）
  // data 字段同时摊平到顶层，便于模型直取
}
```

会话命令窗口显示的是 `output.render` 投影的人读文本（✔/✘ + 缩进明细行），
不是转义 JSON —— 结构化事实与人读文本**同源**。

### actions

| action | 参数 | 行为 |
|---|---|---|
| `status` | — | 崩溃状态、嫌疑排名（**全量**，v0.8 起不再截断 10）、实验性名单、量化指标；输出带 `workspace` + `projectKey`（隔离归因）与「插件版本」「问题反馈」 |
| `history` | `limit?=40` | 安装/更新/崩溃/恢复事件时间线 |
| `recover` | — | 立即按最近更新执行一次恢复关闭（crashSeq=1） |
| `restore` | — | 重新启用非嫌疑插件，首要嫌疑保持关闭 |
| `reenable` | `bundle` | 手动重新启用某个插件 |
| `backups` | — | 配置备份清单 |
| `archive` | `reason?` | **v0.4 新增**：归档产物并重置（按最新事实重新自举）；**v0.12**：写动作先落审计行 |
| `archives` | — | **v0.4 新增**：历史归档清单；**v0.6**：每份归档带 `summary`（crashSeq/autoDisabled/journalEvents，取自 manifest —— 举他对照的事实基线） |

### 1.1 v0.12 命令窗口显示契约（最容易被漏掉的一层）

工具注册（`src/tool-registration.ts`）必须同时接上**四条**显示通道，少接一条
宿主就退回通用回退卡片：

| 通道 | 位置 | 显示什么 | 缺席时的表现（就是曾经的缺陷） |
|---|---|---|---|
| `output.render` | tool-registration | 模型可见的人读文本（命令窗口正文） | 满屏转义 JSON |
| `output.presentationMeta` | tool-registration | 规范值 → **可回放**的 UI 卡片模型；宿主持久化在 `tool/result` 的 `meta` 上 | 卡片无标题无分区，回放时无法重建 |
| `presentCall(args)` | tool-registration | PENDING 卡片：人话标题（`崩溃守护状态`）+ 参数摘要（`history · 最多 40 条`） | 标题是裸工具名 `recency_guard`、正文是整坨原始参数 JSON |
| `presentResult(args, result)` | tool-registration | COMPLETED 卡片：`插件崩溃守护 · <动作>` + 与命令窗口同源的正文 | 完成态没有语义标题，只剩 raw content |

三条纪律（都有测试钉住）：

1. **类型必须用宿主词汇**。本地曾自声明 `GenericResultView { content: string }`，
   而宿主是 `content?: ContentBlock[]` —— 函数没接线时 tsc 碰不到它，
   漂移就长期潜伏。接线当场撞出来，改为 `import type { ToolCallView, ToolResultView }
   from '@deepseek-ai/dsh-tools'`（纯类型 import，编译期擦除，不引入运行面依赖）。
2. **`presentCall` 只依赖 args**：宿主在「实时流式」与「会话日志回放」两条路径上
   调用同一个投影；依赖结果值会让两条路径给出不同卡片。
3. **args 不合法时返回 undefined**（宿主 `defineTool` 先 `validate` 再调用），
   让 UI 走通用回退而不是渲染一张错卡片。

反漂移两道门（缺任何一道，「写好纯函数但没接线」这类缺陷都能全绿过关）：

- 源码门 `tests/contract/capability.test.ts`：核对注册文件里出现
  `presentCall:` / `presentResult:` / `presentationMeta:` 三条接线。
- 行为门 `tests/host/tool.test.ts`：对**注册出来的工具对象**断言三个方法是函数，
  并走宿主同一条数据流 `execute → presentationMeta → presentResult`，
  含 meta 缺席（旧版本记录回放）的诚实降级。

## 2. HTTP 路由（面板数据面）

前缀 `/recency-guard/api`，路径在 `src/routes.ts` 为**字面量**（契约测试核对）。

| 路由 | 方法 | 语义 |
|---|---|---|
| `/snapshot` | GET | 面板快照（状态/指标/排名/能力矩阵/事件流，一次成型）；**v0.11**：支持 `?partition=<key>` 跨分区只读查看 |
| `/graph` | GET | 图谱数据（节点/边/缺口/分层布局/连通分量） |
| `/isolation` | GET | 项目隔离视图（分区列表 + 当前分区 + 产物路径对照） |
| `/lifecycle` | GET | 生命周期步骤流 + 迁移史 + 被拒迁移 |
| `/archives` | GET | 历史归档清单 |
| `/action/archive` | POST | `{reason, expectedRevision?}` → 归档重置；**v0.11**：非 POST 一律 405；**v0.12**：凭证过期 409 |
| `/action/reenable` | POST | `{bundle, expectedRevision?}` → 重新启用；缺 bundle 400；**v0.12**：400 优先于 409 |
| `/action/restore` | POST | **v0.11 新增**：恢复非嫌疑插件（面板按钮）；**v0.12**：`{expectedRevision?}` 过期 409 |
| `/action/recover` | POST | 手动恢复；**v0.11**：非 POST 一律 405；**v0.12**：`{expectedRevision?}` 过期 409 |

缺席即诚实：数据不可用时返回 `{available:false, reason}`，不返回空数组假装没问题。

### 2.1 v0.12 动作路由的乐观并发（409 语义）

面板每 5s 轮询一次快照，用户点击时依据的地图最长可能陈旧 5 秒。动作路由
因此在**执行前**核对 `body.expectedRevision` 与当前真值（`Guard.currentRevision()`）：

| 请求 | 判定 | 响应 | 动作 |
|---|---|---|---|
| 不带 `expectedRevision` | 放行（结构上标记 `unchecked`） | 200 + 结果 | **执行** |
| 带了且等于当前值 | 相符 | 200 + 结果 | **执行** |
| 带了但不等 | 状态已变 | **409** `{ok:false, conflict:'stale-revision', reason, current}` | **不执行** |
| 缺必填参数（如 reenable 无 bundle） | 请求本身不合法 | 400 | 不执行（**400 优先于 409**） |

四条设计取舍：

- **409 时动作绝不执行**：冲突了还照做，等于没有这道门。
- **400 优先于 409**：必错的请求不该占用冲突判定 —— 否则调用方会以为
  「刷新一下就能成功」，而实际上参数永远不对。
- **`currentRevision` 缺席时降级放行**：回落路径（无 `ctx.plugin` 的直接注册形态）
  与旧桩都可能不带它；可选能力缺席不该让动作失效（本插件一贯纪律）。
- **`currentRevision()` 而不是复用 `snapshot()`**：快照要算指标/风险排名/能力图/
  马尔可夫矩阵（几十毫秒），而核对只需要那枚哈希；每次 POST 都重跑投影是错配。
  两处用**同一个** `computeRevision` 与同一组事实字段 ⇒ 「面板看到的那枚」与
  「宿主核对的那枚」结构上同源，不可能各自漂移。

`revision` 是**哈希而不是计数器**：计数器需要一个单调持久化位点，崩溃时它可能
落后于状态（假冲突/假放行）；哈希直接从被保护的事实派生（state + decision +
journal 尾），无额外状态、崩溃重启后同一份事实必得同一枚 —— 幂等，也就不会被崩溃污染。
列表编码带**长度前缀**，避免 `["a","b,c"]` 与 `["a,b","c"]` 塌缩成同一串；
`autoDisabled` **保留原序**（先关谁是因果信息，排序会把两种事实当成一种）。

客户端契约（`src/client/api.ts`）：非 2xx 也要解析 body，把
`reason/conflict/current/status` 透出 —— 此前这里写死 `HTTP ${status}` 把 body 丢了，
宿主给的 409 语义全部蒸发，闭环断在客户端。分支逻辑挂 `conflict` 字段
而不是挂 `reason` 文案（文案会改，分支不能跟着坏）。

## 3. 面板快照契约（PanelSnapshot 摘要）

```
at / profile / projectKey / stage / stageLabel
transitions[]                状态机迁移史（原因+时刻）
metrics                      crashRate / crashPressure（v0.6 EWMA 崩溃压力）
                             / meanRecoveryTime / detectionRate
                             / isolationPurity / intervals / changePoint
                             （全部 Metric<T>：null = 不可判定，带 reason）
risks[]                      嫌疑排名（bundle/risk/label/experimental）
capability                   total/exposed/connected/connectivity/gaps[]/byStage
graphConnectivity            components/largest/isolated
partitions[]                 项目分区（key/label/workspace/lastSeenAt）
autoDisabled[] / restored[]  关闭与恢复名单
recentEvents[]               **v0.4 新增**：journal 尾部投影（事件流卡片数据源）
eventFlow[]                  **v0.10**：事件流/状态流转时序（stage/action/flow/source）
markov                       **v0.10**：转移矩阵（rows[].probabilities/stationary/samples）
backupPolicy                 **v0.9**：备份策略投影（versionedBackups/retain/root…）
lastRecoveryVerdict?         **v0.9.1**：最近恢复判定（观察中 N/M 轮 或 已行动）
revision                     **v0.12**：乐观并发凭证（12 hex，从 state+decision+journal 尾派生）
                             —— 动作请求带 `expectedRevision` 回传它；跨分区只读视图恒 null
diagnostics                  **v0.10**：插件/宿主版本、平台、快照耗时、repositoryUrl/issuesUrl
```

跨分区查看（v0.11）：`GET /snapshot?partition=<key>` 返回**只读磁盘投影**
（`readonly: true`、workspace、journal 尾部、autoDisabled/restored/备份根）；
运行时字段如实降级（stage 恒 `idle` + stageLabel 说明「跨分区只读视图」，
metrics/capability/markov 为 null —— 那些是当前进程的状态机事实，不能替
对方分区编造）。未知分区返回 `{available:false, reason}`。

**v0.12 补充**：跨分区投影的 `revision` 恒为 `null`（不是省略字段）。
只读视图没有可改的事实，而动作只作用于当前分区 —— 拿对方的凭证去核对
必然产生假冲突。用 null 而不是 undefined 是为了让「这个版本没有凭证」与
「跨分区没有凭证」两种事实可区分（缺席要可归因）。

### 3.0a v0.12 L4 审计线（journal 的机器可读部分）

四个写动作（`recover` / `restore` / `reenable` / `archive`）在**执行之前**
各落一条审计行：

```jsonc
{
  "kind": "note",                                     // 复用既有通道，不新增 kind
  "detail": "审计 · tool/recover · <理由或可审计默认>", // 人读
  "audit": { "actor": "tool", "action": "recover", "justification": "…" } // 机器读
}
```

三条取舍：

- **先写后执行**：崩溃可能发生在动作中间，那时「谁、以什么理由发起了这件事」
  必须已经在盘上。反过来（先执行后记录）会让最需要审计的那次失败恰好没有审计。
- **只审计写动作**：L4 全自主 = 人类只在事后审计，要记的是「改了什么」。
  把 status/history 也记进去，面板每 5s 轮询会把崩溃因果链冲掉（信号被噪声淹没）。
- **复用 `kind: note` 而不是新开 `audit` kind**：journal 的 kind 是一张跨层词汇表
  （store 的 JournalKind、observations 的 FlowAction、eventFlow 渲染映射、面板着色
  分组都要跟着改）。新开 kind 而漏掉任一处，审计行就在事件流里**静默消失** ——
  那条线比「少一个语义标签」危险得多。真要独立成 kind，应作为一次完整的词汇表演进。
- **写审计行失败不阻塞动作**：它是可观测性设施，不该有否决守护动作的权力。
- **理由缺席时写「调用方未提供理由」而不是空串**：空理由不是「没有理由」，
  是「调用方没写」；默认文案让审计时不会把后者误读成前者。

## 3.1 面板与图谱客户端行为（v0.5 + v0.6）

- **KPI 条**：稳定性圆环 / 阶段 / 崩溃率 / **崩溃压力（v0.6）** / 趋势 /
  CUSUM 变点置顶；不可判定的指标显示「不可判定」而非 0（诚实边界进 UI）。
- **隔离归因（v0.6）**：header 显示可读项目名（分区 label）+ 完整工作区
  路径（悬停 title 兜底长路径）。
- **归档卡片（v0.6）**：消费 `/archives` 的 `summary` 字段，显示每次归档
  的崩溃次数 / 事件数 / 曾关插件（旧归档无摘要时诚实省略）。
- **折叠卡片**：折叠态存 localStorage 键 `recency-guard-collapsed`
  （JSON 数组）；读取失败退化为全展开 —— 不抛异常。
- **轮询开关**：暂停 = 不再发 fetch，画面停在暂停时刻；
  按钮文字/边框双通道区分（aria-pressed + `.rg-button-paused`）。
- **图谱交互**（全部可由键盘/鼠标完成，均有 aria 标签）：
  Ctrl/⌘+滚轮缩放（指针锚）· 拖画布平移 · 拖节点重排（offsets 叠加层）·
  单击高亮追溯 · 双击视口居中 · 搜索定位（**v0.11：Enter 循环遍历 + 第 n/m 指示**）·
  类型图例开关（**v0.11：图例色跟随着色口径 + 形状通道入图例**）·
  **邻居导航（v0.6：详情侧栏上游/下游可点击跳转）** ·
  Esc 一次清空全部观察态 · **v0.11：重置按钮同时清拖拽偏移**。
- **曲线边**：二次贝塞尔 `curveEdgePath`；平行边按 `parallelIndexes` +
  `parallelCurvature` 奇偶交替弯曲；高亮边的生产/消费标签锚在
  `midpointOfQuadratic` 闭式中点。

## 4. 能力清单（对 Agent 的承诺）

能力图见 `src/capability-specs.ts`；对外暴露：
`recency-guard.panel` / `recency-guard.graph` / `recency-guard.reset` /
`recency-guard.isolation` / `recency_guard`（工具，承载 status/recover/archive 等）。
清单是投影：注册处为真相，契约测试双向比对（漏登/虚登都会响亮失败）。

## 5. 安装与配置

```bash
npx @deepseek-ai/dsh@<ver> plugin --profile <profile> add file:/绝对路径/dsh-recency-guard
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | false 时只记录不关闭 |
| `includeExperimental` | true | experimental 命名是否算嫌疑 |
| `maxAutoDisable` | 2 | 单次恢复最多关闭数 |
| `autoRestore` | true | 稳定后自动恢复非嫌疑 |
| `confirmRounds` | 2 | **v0.9**：多嫌疑行动阈值（唯一嫌疑不受限） |
| `versionedBackups` | true | **v0.8**：带版本的时间线备份开关 |
| `backupRetain` | 5 | **v0.8**：每插件备份份数 |
| `backupRoot` | '' | **v0.8**：备份自定义目录（环境变量优先） |
