# 对外面 API（dsh-recency-guard v0.9.1）

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
| `status` | — | 崩溃状态、嫌疑排名（top10）、实验性名单、量化指标；**v0.6**：输出带 `workspace` + `projectKey`（隔离归因） |
| `history` | `limit?=40` | 安装/更新/崩溃/恢复事件时间线 |
| `recover` | — | 立即按最近更新执行一次恢复关闭（crashSeq=1） |
| `restore` | — | 重新启用非嫌疑插件，首要嫌疑保持关闭 |
| `reenable` | `bundle` | 手动重新启用某个插件 |
| `backups` | — | 配置备份清单 |
| `archive` | `reason?` | **v0.4 新增**：归档产物并重置（按最新事实重新自举） |
| `archives` | — | **v0.4 新增**：历史归档清单；**v0.6**：每份归档带 `summary`（crashSeq/autoDisabled/journalEvents，取自 manifest —— 举他对照的事实基线） |

## 2. HTTP 路由（面板数据面）

前缀 `/recency-guard/api`，路径在 `src/routes.ts` 为**字面量**（契约测试核对）。

| 路由 | 方法 | 语义 |
|---|---|---|
| `/snapshot` | GET | 面板快照（状态/指标/排名/能力矩阵/事件流，一次成型） |
| `/graph` | GET | 图谱数据（节点/边/缺口/分层布局/连通分量） |
| `/archives` | GET | 历史归档清单 |
| `/action/archive` | POST | `{reason}` → 归档重置 |
| `/action/reenable` | POST | `{bundle}` → 重新启用 |
| `/action/recover` | POST | 手动恢复 |

缺席即诚实：数据不可用时返回 `{available:false, reason}`，不返回空数组假装没问题。

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
recentEvents[]               **v0.4 新增**：journal 尾部 24 条（事件流卡片数据源）
```

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
  滚轮缩放（指针锚）· 拖画布平移 · 拖节点重排（offsets 叠加层）·
  单击高亮追溯 · 双击视口居中 · 搜索定位（Enter 第一个）·
  类型图例开关 · **邻居导航（v0.6：详情侧栏上游/下游可点击跳转）** ·
  Esc 一次清空全部观察态。
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
