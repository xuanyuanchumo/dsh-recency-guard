# 对外面 API（dsh-recency-guard v0.17.0）

> 本文件里的路由 / 工具签名 / 配置项从 `src/host/surface/routes.ts`、
> `src/host/surface/tool-registration.ts`、`src/host/capability/capability.ts`
> 与 `src/index.ts` 实抄；契约变更必须在这里留一行。

## 0.0h v0.17 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
| --- | --- | --- |
| **`PanelSnapshot.preventive` / `status.preventive`** | RQ3 预防性读数（启动频率 EWMA + 配置变更 CUSUM，`source{units,note}`）；**只预警不行动**，不可判定 ⇒ `defined:false`+`reason` | **纯追加**；关闭决策链路零依赖（源码扫描门） |
| **`PanelSnapshot.corrupt` / `status.corrupt`** | 未知 `schemaVersion` 的安全降级事实 `{state,decision}`；`status` 另带 `files` | **纯追加**；缺省按「无损坏」渲染 |
| **数据文件加 `schemaVersion`** | `state` / `decision` / 归档 manifest / cooccurrence 统一 `schemaVersion:1`；缺失按 v1 读、未知 ⇒ 安全空态 + `degraded:true` note + **不覆盖文件** | 兼容（v0.16 及更早文件无字段）；未知版本行为变严（有意的安全降级） |
| **面板自适应轮询** | 稳定 5s→10s→15s、变化回 5s、边界 [3s,30s]；`setTimeout` 递归；指纹剔除 `at` / `snapshotMs` | 客户端行为；动作路由 409 的「地图陈旧」窗口由 5s 变为最长约 15s |
| **journal 记录新增 `schemaVersion` 相关 `degraded:true` note** | 未知版本降级可查 | 兼容（`degraded` 纯追加；读方忽略未知字段） |

## 0.0g v0.16 契约变更一句话清单

| 变更 | 影响 | 兼容性 |
| --- | --- | --- |
| **新增 [`dsh-plugin.json`](../../dsh-plugin.json)（社区 manifest draft v0.15）** | 市场 / 权限审计可读到 host entry（`dist/index.js`）、consumed contract（Tool）、4 条 permissions、工具 / 面板席位 / 9 条路由 | **纯新增**（运行时不加载它；dsh 安装仍走 `package.json`） |
| **版本四锚点统一 0.16.0** | `package.json` / README / `docs/agents` / `dsh-plugin.json` 同值；npm `latest` 于 2026-11-11 发布后同为 `0.16.0` | 文档与元数据级，不影响运行时 API |
| **`package.json` 的 `files` 增补** `assets` / `screenshots.json` / `dsh-plugin.json` | npm 包内包含市场图标与 manifest（此前图标不会随包发布） | 打包内容变化，无 API 变化 |
| **README 面向用户重构 + `docs/agents/capabilities.md` 新增** | 能力"注册→生产→消费"有了独立清单与双向比对口径；README 的历史增量压缩为版本记录 | 纯文档 |
| **新增确定性冲突证据（`conflicts`）** | `status` / `PanelSnapshot` / `decision.json` 新增 `conflicts: ConflictFinding[]`：4 类 finding（`declared-conflict` / `duplicate-service` / `dsh-version` / `missing-dependency`），每条带 `source{file,line}` 与 `declaration` 原文 | **纯追加**（无声明 ⇒ 空数组，不猜；旧消费方忽略即可） |
| **新增未解决冲突（`unresolved`）与贪心隔离** | `decision.json` / `status` / `PanelSnapshot` / `recover` 输出新增 `unresolved`；`recover` 改为贪心最小隔离集（含依赖联动、`dshCompat.priority` 排序），残余必须上屏 | 行为变更：`maxAutoDisable` 语义收紧为**整组上限**；无声明时仍是纯 recency（逐位不变） |
| **`lastRecoveryVerdict` 新增可选 `deterministic`** | `{ findings, targets }`：为什么这次是确定性证据、关了谁 | 兼容（只增） |
| **`decision.json` 新增 `unresolved` 字段** | 守护行仍只读 `disable`；`unresolved` 是展示/审计字段 | 兼容（旧决策文件无该字段 ⇒ 空） |
| **常态路径写锁 + 锁卫生** | `writeDecisionLocked` / `updateDecisionLocked` / `writePartitionIndexLocked`；`data/lock-hygiene.ts` 清理 0 字节/死 PID 锁 | 内部（数据面更耐崩溃；无字段变化） |
| **rescue CLI 新增可写面** | `rescues`（只读）/ `apply` / `restore`（默认 dry-run，需 `--yes`；两阶段 prepared→applied + before/afterHash；`--resume` 按原 index 回插） | **新命令面**（旧命令语义不变；写命令默认不写） |
| **journal 真追加 + 降级标记** | journal 改为 append-only；启动编排的降级失败追加 `kind:'note'` 且带 `degraded: true`（重启后仍可查、面板/`history` 可消费） | 兼容（`degraded` 纯追加；读方忽略未知字段） |
| **状态对账 / CAS 清零** | 哨兵在场且决策文件有 `disable` 时，启动按决策补 `crashSeq`/`autoDisabled`；干净启动只在计数未被本轮崩溃改过时归零 | 内部（数据面更耐竞态；无字段变化） |
| **`PanelSnapshotView` 可空契约** | 客户端把宿主会发 `null`/省略的字段（`metrics` / `capability` / `markov` / `revision` 等）显式放宽；渲染层诚实降级 | 客户端类型层（对外 JSON 形状不变） |

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
| 新增 `src/host/guard/decision-evidence.ts` / `cooccurrence.ts` / `client/graph-analysis.ts` | 纯函数模块，各自带单测 | 新文件 |
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
| 新增 `src/host/observe/markov.ts` 模块 | 马尔可夫链视角的状态机分析（宿主侧拥有，客户端只渲染投影） | 新文件 |

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

### 参数 schema（实抄自 `tool-registration.ts`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | enum：`status` / `history` / `recover` / `restore` / `reenable` / `backups` / `archive` / `archives`（来自 `TOOL_SURFACE.actions`） |
| `bundle` | string | 否 | `reenable` 的目标插件名（包名） |
| `limit` | number | 否 | `history` 返回的事件条数，默认 40 |
| `reason` | string | 否 | `archive` 的归档原因（可选） |

`execute(args, exec)` 每次先 `exec.signal.throwIfAborted()`，再按 `action` 查
`TOOL_ACTIONS` 分派；未知 action 抛错（调用错误，不是业务失败）。

### actions

| action | 参数 | 行为 |
|---|---|---|
| `status` | — | 崩溃状态、嫌疑排名（**全量**，v0.8 起不再截断 10）、实验性名单、量化指标、**当前 `conflicts`（声明式冲突，带出处）与上次 `unresolved`（隔离后残余）**；输出带 `workspace` + `projectKey`（隔离归因）与「插件版本」「问题反馈」 |
| `history` | `limit?=40` | 安装/更新/崩溃/恢复事件时间线 |
| `recover` | — | 立即做一次恢复：按确定性冲突做**贪心最小隔离**（含依赖联动、优先级排序；无声明时退回纯 recency），返回 `disabled` + `unresolved` + `note` |
| `restore` | — | 重新启用非嫌疑插件，首要嫌疑保持关闭 |
| `reenable` | `bundle` | 手动重新启用某个插件 |
| `backups` | — | 配置备份清单 |
| `archive` | `reason?` | **v0.4 新增**：归档产物并重置（按最新事实重新自举）；**v0.12**：写动作先落审计行 |
| `archives` | — | **v0.4 新增**：历史归档清单；**v0.6**：每份归档带 `summary`（crashSeq/autoDisabled/journalEvents，取自 manifest —— 举他对照的事实基线） |

### 1.1 v0.12 命令窗口显示契约（最容易被漏掉的一层）

工具注册（`src/host/surface/tool-registration.ts`）必须同时接上**四条**显示通道，少接一条
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

前缀 `/recency-guard/api`，路径在 `src/host/surface/routes.ts` 为**字面量**（契约测试核对）。

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

宿主侧接线签名（实抄自 [`routes.ts`](../../src/host/surface/routes.ts) 的 `RouteContext`）：
`profileDir` / `workspace` / `profileName` / `projectKey` 四个事实字段，
以及 `snapshot()` / `snapshotPartition(key)` / `graph()` / `isolation()` / `lifecycle()` /
`archives()` / `archive(reason)` / `reenable(bundle)` / `restore()` / `recover()` 十个回调；
可选 `currentRevision?()`（缺席 ⇒ 跳过 409 核对）、`onRegister?(exposedName)`（注册成功回执）、
`logError?(message)`（桥接宿主 logger，缺席回落 console）。

### 2.1 v0.12 动作路由的乐观并发（409 语义）

面板按**自适应节奏**轮询快照（稳定时 5s→10s→15s，内容变化/用户操作立即回 5s），
用户点击时依据的地图最长可能陈旧约 15 秒。动作路由
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

客户端契约（`src/client/api/api.ts`）：非 2xx 也要解析 body，把
`reason/conflict/current/status` 透出 —— 此前这里写死 `HTTP ${status}` 把 body 丢了，
宿主给的 409 语义全部蒸发，闭环断在客户端。分支逻辑挂 `conflict` 字段
而不是挂 `reason` 文案（文案会改，分支不能跟着坏）。

### 2.2 离线 rescue CLI（v0.16 新增可写面）

宿主起不来时的零依赖逃生通道。**默认只读**；写命令不带 `--yes` 只打印计划（dry-run）。

| 命令 | 写盘 | 语义 |
| --- | --- | --- |
| `status` / `history` / `decision` / `archives` / `rescues` | 否 | 读守护产物；`rescues` 列出两阶段 rescue 记录 |
| `apply --profile-dir <dir> [--bundle a,b] [--reason <text>]` | 仅 `--yes` | 把决策 `disable` 名单（或 `--bundle`）从 profile 的 `dsh.profile.bundles` 摘掉 |
| `restore --profile-dir <dir> [--id <uuid>] [--resume]` | 仅 `--yes` | 按记录里的**原 index 升序**回插；`--resume` 做中断恢复 |

两阶段契约（记录在 `<profile>/.recency-guard/rescue/<uuid>.json`）：

```jsonc
{
  "id": "<uuid>",
  "status": "prepared" | "applied" | "restored",
  "beforeHash": "<sha256(profile/package.json 修改前)>",
  "afterHash": "<sha256(修改后)>",
  "removed": [{ "name": "...", "index": 3 }],
  "reason": "..."
}
```

- `prepared` + 当前哈希等于 `afterHash` ⇒ 第二步实际已完成，`restore --resume` 按已生效回插；
- 当前哈希等于 `beforeHash` ⇒ 第二步没发生，记录作废（不动 profile）；
- 哈希既不是 before 也不是 after / 记录被篡改 ⇒ **退出码 3 拒绝**，绝不硬改。
- 退出码：`0` 正常、`1` 参数错误、`2` 有未恢复崩溃、`3` 拒绝（现场已变）。

### 2.3 `decision.json` 形状（预启动决策，v0.16 增补）

```jsonc
{
  "capturedAt": "2026-11-11T…",
  "suspects": [/* DecisionSuspect：rank/risk/factors/streak/changeCount/source/evidence */],
  "disable": ["dsh-bad-plugin"],          // 守护行**只读**这个字段
  "reason": "crash-recovery" | "none",
  "crashSeq": 3,
  "phase": "prepared" | "quarantined" | "reconciled",
  "deterministicEvidence": {              // v0.16：为什么是确定性证据
    "findings": [/* ConflictFinding：kind/message/plugins/source/declaration */],
    "targets": ["dsh-bad-plugin"]
  },
  "unresolved": [/* v0.16：贪心隔离后仍治不了的 error finding */]
}
```

**兼容性**：`disable` 仍是唯一影响启动行为的字段；`deterministicEvidence` / `unresolved`
是纯追加的展示与审计事实（旧决策文件缺字段 ⇒ `undefined`，不是空数组）。
`deterministicEvidence` 同时镜像进 `state.json` 的
`lastRecoveryVerdict.deterministic{findings,targets}`，两侧同形。

### 2.4 `journal.jsonl` 记录（append-only，v0.16 定稿）

每行一条 JSON：

```jsonc
{
  "t": "2026-11-11T…",
  "kind": "install" | "update" | "crash-detected" | "disable" | "restore" | "note" | …,
  "bundle": "dsh-x",              // 视 kind 而定
  "detail": "…",                  // 人读
  "degraded": true,               // v0.16：启动编排降级（机器可读；普通事件无此字段）
  "audit": { "actor": "tool", "action": "recover", "justification": "…" }
}
```

- **真追加**：`appendSync`（崩溃路径）/ `append`（异步）都用 `appendFile*`，
  不整读整写；行数裁剪只在异步、加锁的安全时机执行（>1000 行），崩溃路径永不裁剪。
- `degraded: true` 目前来自启动编排的三处失败兜底（分区索引加锁提交、`recordChanges`、
  官方实验插件观测），以及**未知 schemaVersion** 的数据文件降级（TD-1）。
  它替代「只写 logger」——日志不进事后可查的数据面。
- 未知字段必须被读方忽略（向后兼容）；消费方不得依赖行序以外的结构。

### 2.5 数据文件 schema 版本（v0.17，TD-1）

`state.json` / `decision.json` / 归档 manifest / cooccurrence 统一用 `schemaVersion: 1`：

| 读到的值 | 行为 |
| --- | --- |
| `1` | 正常读 |
| **缺失** | 按 v1 宽容读（v0.16 及更早文件没有该字段，老 profile 必须能读） |
| **其它值** | **不覆盖、不解释**：`state` 返回安全空态 + `corrupt:true`；`decision` 返回 `null`；写一条 `degraded:true` journal note（同一 `(文件,版本)` 只写一次） |

- 为什么不能「尽力解释」：`crashSeq` / `autoDisabled` / `disable` 的语义可能已变，
  按旧语义解释会做出**错误的恢复决定**；保留现场 + 上屏损坏标记，才能让人判断。
- 对外投影：`PanelSnapshot.corrupt` 与 `status.corrupt` = `{state, decision}`；
  `status` 额外带 `files`（已知损坏文件路径）。
- 常量单一来源：[`schema-version.ts`](../../src/host/data/schema-version.ts) 的 `SCHEMA_VERSION`。

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
                             **v0.16**：可选 `deterministic{findings,targets}`（为什么是确定性证据）
conflicts?                   **v0.16**：当前仍成立的声明式冲突（kind/message/plugins/source/declaration）
unresolved?                  **v0.16**：上次隔离后仍治不了的 error finding（读 decision.json）
preventive                   **v0.17**：RQ3 预防性读数（loadTime 启动频率 EWMA + configChanges CUSUM，
                             source{units,note}）；**只预警不行动**，不可判定 ⇒ defined:false + reason
corrupt                      **v0.17**：`{state,decision}`，未知 schemaVersion 的安全降级事实
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

**v0.16 补充（客户端可空契约）**：跨分区投影还可能出现 `stabilityScore: null`、
`metrics: null`、`capability: null`、`markov: null`，以及**整段省略**
`decisionSuspects` / `calibration` / `bayes` / `cooccurrence`。客户端用
[`snapshot-view.ts`](../../src/client/panel/snapshot-view.ts) 的 `PanelSnapshotView`
显式放宽这些字段（只放宽、不复制契约），渲染层降级而不是把面板打进错误边界；
该清单由 [`panel-snapshot-nullability.test.ts`](../../tests/contract/panel-snapshot-nullability.test.ts) 守护。

**v0.17 补充**：

- `preventive` 的 `loadTime` **不是**真实加载耗时 —— journal 没有该事实，投影用「相邻启动时刻差的倒数
  （启动频率，per-minute）」做代理，`source.note` / `source.units` 必须原样显示，防止被读成性能指标；
  样本不足 ⇒ `defined:false` + `reason`，`value` 恒为 `null`。
- `corrupt` 是未知 `schemaVersion` 的安全降级事实；缺省（跨分区只读 / 旧宿主投影）按
  `{state:false,decision:false}` 渲染，不把「没读到」当成「文件坏了」。
- **只预警不行动**由源码扫描测试钉住：`crash-decision.ts` / `quarantine-plan.ts` /
  `recovery-*.ts` 等关闭决策链路零依赖 `preventive`（`tests/unit/preventive-wiring.test.ts`）。
对外 JSON 形状不变 —— 这是客户端类型层的修正，不是宿主发新字段。

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
  把 status/history 也记进去，面板按秒级节奏轮询会高频写日志、把崩溃因果链冲掉（信号被噪声淹没）。
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
- **自适应轮询（v0.17）**：`setTimeout` 递归而不是 `setInterval`；内容连续
  1 轮不变 ⇒ 10s、≥2 轮不变 ⇒ 15s 封顶；一旦变化/用户操作 ⇒ 回 5s；
  绝对边界 `[3s, 30s]`。指纹 = 稳定序列化（键排序）+ FNV-1a，且**剔除**
  `at` 与 `diagnostics.snapshotMs` 等每次请求都变的字段 —— 否则退避永不触发。
  暂停/卸载必须同时 `clearTimeout` + 置 `cancelled`，防止在途响应回来后再挂定时器。
- **图谱交互**（全部可由键盘/鼠标完成，均有 aria 标签）：
  Ctrl/⌘+滚轮缩放（指针锚）· 拖画布平移 · 拖节点重排（offsets 叠加层）·
  单击高亮追溯 · 双击视口居中 · 搜索定位（**v0.11：Enter 循环遍历 + 第 n/m 指示**）·
  类型图例开关（**v0.11：图例色跟随着色口径 + 形状通道入图例**）·
  **邻居导航（v0.6：详情侧栏上游/下游可点击跳转）** ·
  Esc 一次清空全部观察态 · **v0.11：重置按钮同时清拖拽偏移**。
- **曲线边**：二次贝塞尔 `curveEdgePath`；平行边按 `parallelIndexes` +
  `parallelCurvature` 奇偶交替弯曲；高亮边的生产/消费标签锚在
  `midpointOfQuadratic` 闭式中点。
- **v0.16 声明式冲突卡**：`conflicts`（当前仍成立）与 `unresolved`（上次隔离后治不了）
  **分区展示**，每条带 `kind / message / source{file,line} / declaration`；
  合并两者会让「有冲突」与「试过但治不了」无法区分，所以是两个字段、两个区。
- **v0.16 可空视图**：`PanelSnapshotView` 对宿主会发 `null`/省略的字段做类型层放宽，
  渲染层显示「不可判定 / 只读视图」而不是崩溃；契约门 `panel-snapshot-nullability`。
- **v0.16 图谱交互拆分**：交互意图（`graph-interaction.ts`）、布局（`graph-layout.ts`）、
  调色（`graph-palette.ts`）各自成模块；悬停 / 拖拽 / 键盘 / 图例 / fit 视图各有纯函数测试。

## 4. 能力清单（对 Agent 的承诺）

能力图见 `src/host/capability/capability-specs.ts`（22 条能力，12 条对外暴露）；
完整清单、生产/消费方向与双向比对口径见 [capabilities.md](./capabilities.md)。

对外暴露名共四组：

- **工具**：`recency_guard`（1 个注册名，8 个 action）；
- **读路由**：`recency-guard.panel` / `recency-guard.graph` / `recency-guard.isolation` /
  `recency-guard.lifecycle` / `recency-guard.archives`；
- **写路由**：`recency-guard.reset` / `recency-guard.reenable` /
  `recency-guard.restore` / `recency-guard.recover`；
- **面板席位**：`main`（keyed）+ `sidebar.panellist`（list），id 同为 `recency-guard`
  （客户端注册，不在宿主名称空间里）。

清单是投影：注册处为真相，契约测试双向比对（漏登 / 虚登都会响亮失败）。

## 5. 安装与配置

```bash
npx @deepseek-ai/dsh@<ver> plugin --profile <profile> add file:/绝对路径/dsh-recency-guard
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | false 时只记录不关闭 |
| `includeExperimental` | true | experimental 命名是否算嫌疑 |
| `maxAutoDisable` | 2 | 单次恢复最多停用数；**整组上限**（依赖联动可能一次关一组，整组放不进则不动） |
| `autoRestore` | true | 稳定后自动恢复非嫌疑 |
| `confirmRounds` | 2 | **v0.9**：多嫌疑行动阈值（唯一嫌疑不受限） |
| `versionedBackups` | true | **v0.8**：带版本的时间线备份开关 |
| `backupRetain` | 5 | **v0.8**：每插件备份份数 |
| `backupRoot` | '' | **v0.8**：备份自定义目录（环境变量优先） |
