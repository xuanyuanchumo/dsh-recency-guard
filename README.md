# dsh-recency-guard

**v0.18.0** · [GitHub](https://github.com/xuanyuanchumo/dsh-recency-guard) · [问题反馈](https://github.com/xuanyuanchumo/dsh-recency-guard/issues) · MIT

> DeepSeek Harness 的**插件崩溃恢复守护**：记录第三方 / 实验性插件的安装与更新时序并备份配置；
> 崩溃后的**下一次启动之前**，把最近更新的嫌疑插件挡在门外；稳定启动后，再把非首要嫌疑放回来。
>
> 版本基线（2026-11-13，北京时间）：**0.18.0**。版本四锚点（`package.json` / 本 README /
> `docs/agents/` / [`dsh-plugin.json`](dsh-plugin.json)）一致。
> 测试分四层，当前 **87/87 全绿**（Core 43 / Host 10 / Client 25 / Contract 9）。

---

## 它解决什么问题

在 DSH 里安装或更新一个第三方 / 实验性插件后，宿主可能直接退出：

```
dsh: fatal uncaught exception: Error: ...
```

崩溃发生在插件加载阶段，**插件自己已经来不及运行** —— 它的恢复逻辑、工具、面板都不可达。
手动流程是：禁用所有插件 → 重启 → 逐个加回 → 每次重启验证。慢，而且容易再踩一次。

本插件把这件事自动化成三步：

| 步骤 | 手动做法 | 本插件 |
| --- | --- | --- |
| 记录 | 靠记忆 | 安装 / 更新事件写进 `journal.jsonl`（崩溃也不丢） |
| 拦截 | 手动改配置 | 崩溃瞬间**同步**写决策文件；Loader 在 import 嫌疑插件**之前**求值守护行 |
| 恢复 | 逐个加回 | 稳定启动后恢复非首要嫌疑；首要嫌疑留给你确认 |

**它不做什么**：不修复宿主自身缺陷、不处理依赖版本不兼容、不阻止 entry 级 `apply` 抛错
（那是宿主的自隔离 warning，不是进程崩溃）。见下文「诚实边界」。

---

## 安装

### npm（推荐）

```bash
dsh plugin --profile <profile名> add dsh-recency-guard
```

安装后**重启 dsh**。启动时本插件会自动：

- 在 profile 的 `cordis.patch.yml` 中为每个第三方插件写入守护行；
- 开始记录安装 / 更新事件与配置备份。

锁定版本：

```bash
dsh plugin --profile <profile名> add dsh-recency-guard@0.18.0
```

> 版本对应：本 README 描述 **0.18.0**；npm `latest` 已发布为 **0.18.0**
> （2026-11-11，shasum `b667bd20b6ea82d294dbc28e4eab1290b07dd963`），可直接安装。
> 版本纪律见 [`docs/agents/conventions.md`](docs/agents/conventions.md) §6。

### 插件市场

投稿材料已按 [awesome-dsh-plugin contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
备好（[`docs/market-submission.md`](docs/market-submission.md)）：一个条目文件、`category: security`。
**当前状态：条目已收录（PR #14245）；0.17.0 描述更新已推到同一 PR 分支（v0.18.0 将随合并后下一 PR 更新）（HEAD `94ade1e`），
等待复核/合并。** 收录后可在 dsh 的 **Plugins → Discover** 或 dsh-market 中搜索 `recency-guard` 安装。

### 手动 / 本地源码（开发）

```bash
git clone https://github.com/xuanyuanchumo/dsh-recency-guard.git
cd dsh-recency-guard
npm install
npm run build          # 必跑：dsh plugin add file: 只拷贝 files 声明的产物，不执行构建
dsh plugin --profile <profile名> add file:/绝对路径/dsh-recency-guard
```

开发期反复改代码时用 `link:`（Windows 落 Junction），改完 `npm run build` 重启即生效：

```bash
dsh plugin --profile <profile名> add link:/绝对路径/dsh-recency-guard
```

### 安装顺序

本插件必须排在被守护插件**之前**，才能在启动阶段完成守护行安装。确认 profile 的 `package.json`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "dsh-recency-guard",
      "dsh-你的插件"
    ]
  }
}
```

---

## 三分钟上手

1. **重启 dsh 后打开面板**：侧栏图标「插件守护」→ 中央面板。首屏三块：生命周期、崩溃决策、能力清单。
2. **用工具看状态**（会话里让模型调用，或直接看命令窗口）：

   ```json
   { "action": "status" }
   ```

   输出包含崩溃次数、嫌疑排名（全量）、自动关闭名单、声明式冲突（每条带
   `文件:行号` 与声明原文）、上次隔离后仍治不了的 `unresolved`、隔离分区与量化指标；
   不可判定的指标显示**原因**，不显示 0。
3. **看磁盘事实**：`<profile>/.recency-guard/projects/<分区键>/` 下的
   `journal.jsonl` / `state.json` / `decision.json` 是全部真相，面板只是它们的投影。
4. **想验证拦截**：不要在主 profile 做。用独立沙箱 profile 装一个**故意抛异常**的插件，
   启动 → 崩溃 → 再启动，观察决策文件与日志。步骤见
   [`docs/agents/verification.md`](docs/agents/verification.md) §5.3。

---

## 能力表

每条能力的代码位置与验证入口都可点击核对。能力清单本身是**投影**，真相在注册处
（工具注册、路由注册、事件发射），由契约测试双向比对。

| 能力 | 你能看到什么 | 代码 | 验证 |
| --- | --- | --- | --- |
| 安装 / 更新时间线 | `history`、`journal.jsonl` | [`store.ts`](src/host/data/store.ts) | [`core.test.ts`](tests/unit/core.test.ts) |
| 嫌疑排序（最近更新 + 实验性标记 + 变更频率） | `status.suspectRanking`（全量） | [`recency.ts`](src/host/risk/recency.ts) | [`risk-frequency.test.ts`](tests/unit/risk-frequency.test.ts)、[`official-experimental.test.ts`](tests/unit/official-experimental.test.ts) |
| 风险评分与误伤校准（并行读数） | 面板「决策因子」卡 | [`risk-bayes.ts`](src/host/risk/risk-bayes.ts)、[`risk-calibration.ts`](src/host/risk/risk-calibration.ts) | [`risk-bayes.test.ts`](tests/unit/risk-bayes.test.ts)、[`risk-calibration.test.ts`](tests/unit/risk-calibration.test.ts) |
| **确定性冲突证据** | status / 面板「声明式冲突」（带 文件:行号） | [`conflict-declarations.ts`](src/host/guard/conflict-declarations.ts)、[`conflict-findings.ts`](src/host/guard/conflict-findings.ts)（[`conflict-metadata.ts`](src/host/guard/conflict-metadata.ts) 转发） | [`conflict-findings.test.ts`](tests/unit/conflict-findings.test.ts)、[`deterministic-evidence.test.ts`](tests/unit/deterministic-evidence.test.ts) |
| **贪心最小隔离 + 依赖联动** | `recover` 关闭整组、残余 `unresolved` 上屏 | [`quarantine-plan.ts`](src/host/guard/quarantine-plan.ts)、[`crash-decision.ts`](src/host/guard/crash-decision.ts) | [`quarantine-plan.test.ts`](tests/unit/quarantine-plan.test.ts)、[`crash-decision.test.ts`](tests/unit/crash-decision.test.ts) |
| 崩溃决策 + 守护行 | 下次启动前拦截 | [`crash-decision.ts`](src/host/guard/crash-decision.ts)、[`decision.ts`](src/host/guard/decision.ts)、[`guarded-rows.ts`](src/host/guard/guarded-rows.ts)、[`patch.ts`](src/host/profile/patch.ts) | [`patch-safety.test.ts`](tests/unit/patch-safety.test.ts)、[`core.test.ts`](tests/unit/core.test.ts)、[`revision-source.test.ts`](tests/host/revision-source.test.ts) |
| 双通道崩溃检测（哨兵 + 残留标记） | 强杀 / 断电也能被发现 | [`sentinel.ts`](src/host/guard/sentinel.ts)、[`abnormal-boot.ts`](src/host/guard/abnormal-boot.ts) | [`fault-injection.test.ts`](tests/fault-injection/fault-injection.test.ts)、[`reload-journey.test.ts`](tests/host/reload-journey.test.ts) |
| 降级留痕与状态对账 | 重启后仍可查；「关了但 crashSeq=0」会被补账 | [`boot-orchestration.ts`](src/host/guard/boot-orchestration.ts)、[`state-reconcile.ts`](src/host/guard/state-reconcile.ts)、[`store.ts`](src/host/data/store.ts) | [`boot-degradation.test.ts`](tests/unit/boot-degradation.test.ts)、[`state-reconcile.test.ts`](tests/unit/state-reconcile.test.ts)、[`journal-append-race.test.ts`](tests/unit/journal-append-race.test.ts)、[`boot-crashseq-race.test.ts`](tests/unit/boot-crashseq-race.test.ts) |
| 恢复与配置备份 | `restore` / `backups` | [`recovery-actions.ts`](src/host/guard/recovery-actions.ts)、[`recovery-policy.ts`](src/host/guard/recovery-policy.ts) | [`core.test.ts`](tests/unit/core.test.ts)、[`versioned-backup.test.ts`](tests/unit/versioned-backup.test.ts) |
| 生命周期状态机 | 生命周期卡 + 迁移史 | [`lifecycle.ts`](src/host/core/lifecycle.ts) | [`lifecycle-steps.test.ts`](tests/unit/lifecycle-steps.test.ts) |
| 量化指标与数学模型 | 指标卡 / 控制带 / 转移矩阵 | [`observability.ts`](src/host/observe/observability.ts)、[`markov.ts`](src/host/observe/markov.ts)、[`control-band.ts`](src/host/observe/control-band.ts) | [`observability-math.test.ts`](tests/unit/observability-math.test.ts)、[`hazard-threshold.test.ts`](tests/unit/hazard-threshold.test.ts) |
| **预防性预警（只预警不行动）** | 面板/`status` 的启动频率控制带与配置变更 CUSUM；不可判定显示原因 | [`preventive.ts`](src/host/observe/preventive.ts)、[`preventive-view.ts`](src/host/surface/preventive-view.ts) | [`observability-math.test.ts`](tests/unit/observability-math.test.ts)、[`preventive-card.test.ts`](tests/client/preventive-card.test.ts) |
| **自适应刷新** | 稳定时 5s→10s→15s 退避，变化立即回 5s；暂停即真停 | [`poll-adaptive.ts`](src/client/panel/poll-adaptive.ts)、[`GuardPanel.tsx`](src/client/panel/GuardPanel.tsx) | [`poll-adaptive.test.ts`](tests/client/poll-adaptive.test.ts) |
| 管理面板 | 中央面板 + 侧栏图标 | [`GuardPanel.tsx`](src/client/panel/GuardPanel.tsx)、[`snapshot-view.ts`](src/client/panel/snapshot-view.ts)、[`PanelShell.tsx`](src/client/panel/PanelShell.tsx) | [`panel-v014.test.ts`](tests/client/panel-v014.test.ts)、[`panel-scroll.test.ts`](tests/client/panel-scroll.test.ts)、[`panel-null-snapshot.test.ts`](tests/client/panel-null-snapshot.test.ts) |
| 可交互能力图谱 | 节点 / 边 / 缺口 / 小地图 | [`GuardGraph.tsx`](src/client/graph/GuardGraph.tsx)、[`graph-interaction.ts`](src/client/graph/graph-interaction.ts) | [`graph-model.test.ts`](tests/client/graph-model.test.ts)、[`graph-focus.test.ts`](tests/client/graph-focus.test.ts)、[`graph-keyboard.test.ts`](tests/client/graph-keyboard.test.ts) |
| 项目隔离 | 隔离卡 + `?partition=<key>` | [`isolation.ts`](src/host/core/isolation.ts) | [`isolation-journey.test.ts`](tests/host/isolation-journey.test.ts)、[`isolation-parallel.test.ts`](tests/host/isolation-parallel.test.ts) |
| 归档与重置 | `archive` / `archives` | [`archive.ts`](src/host/data/archive.ts) | [`core.test.ts`](tests/unit/core.test.ts)、[`resilience-fallback.test.ts`](tests/unit/resilience-fallback.test.ts) |
| 工具 `recency_guard`（8 个 action） | 命令窗口卡片与文本 | [`tool-registration.ts`](src/host/surface/tool-registration.ts)、[`tool-dispatch.ts`](src/host/surface/tool-dispatch.ts)、[`tool-render.ts`](src/host/surface/tool-render.ts) | [`tool.test.ts`](tests/host/tool.test.ts)、[`display-truncation.test.ts`](tests/host/display-truncation.test.ts) |
| 写动作乐观并发（409 不执行） | 面板冲突提示 | [`change-guard.ts`](src/host/core/change-guard.ts)、[`routes.ts`](src/host/surface/routes.ts) | [`change-guard.test.ts`](tests/unit/change-guard.test.ts)、[`routes.test.ts`](tests/host/routes.test.ts)、[`api-conflict.test.ts`](tests/client/api-conflict.test.ts) |
| 能力清单双向比对 | 能力缺口卡 | [`capability-specs.ts`](src/host/capability/capability-specs.ts) | [`capability.test.ts`](tests/contract/capability.test.ts) |
| 离线逃生 CLI | 宿主起不来时查现场 / 止血 / 回插 | [`rescue.mjs`](bin/rescue.mjs) | [`rescue-cli.test.ts`](tests/unit/rescue-cli.test.ts) |

---

## 面板与图谱

### 管理面板

- **数据面**：`GET /recency-guard/api/snapshot`。**自适应轮询**：内容稳定时 5s→10s→15s
  退避，内容变化/用户操作立即回 5s，绝对边界 [3s, 30s]；暂停按钮按下后**不再发请求**
  （画面停在暂停时刻，而不是继续跳）。
- **卡片**：稳定性 / 阶段 / 崩溃率 / 崩溃压力 / CUSUM 变点、**预防性预警**（启动频率控制带、
  配置变更 CUSUM；**只预警不行动**，不可判定显示原因）、崩溃决策与因子分解、
  **声明式冲突**（每条带 `文件:行号` 与声明原文）、**未解决冲突**（上次隔离后仍治不了的部分，
  与「现在有冲突」分开显示）、量化指标（不可判定显示原因）、能力清单与缺口、项目隔离、归档、事件流。
- **可空契约**：宿主在跨分区只读视图会发 `null` / 整段省略的字段，由
  [`snapshot-view.ts`](src/client/panel/snapshot-view.ts) 的 `PanelSnapshotView` 显式放宽，
  渲染层诚实降级，不把面板整块打进错误边界（契约测试
  [`panel-snapshot-nullability.test.ts`](tests/contract/panel-snapshot-nullability.test.ts) 守护）。
- **折叠记忆**：折叠态存 `localStorage` 的 `recency-guard-collapsed`，读取失败退化为全展开，不抛异常。
- **动作**：恢复非嫌疑插件、重新启用某个插件、归档重置 —— 都携带快照的 `revision`；
  过期返回 **409 且动作不执行**，面板提示重读后再决定。
- **滚动**：面板自己滚（`height:100% + min-height:0 + overflow-y:auto`），页面不被撑高。
- **真机视觉验收**：卡片标题单行；数据流 4 步完整；面板已无渲染崩溃 ——
  此前 `intervals.cv=null` 会让整块白屏，现由客户端可空视图 + 契约测试钉住（见上）。

### 可交互图谱

- **缩放**：`Ctrl/⌘ + 滚轮`（指针为锚），或工具栏 `+` / `-`；普通滚轮滚面板，不吞手势。
- **默认 fit-all**：首帧优先铺满全图；内容多时文字会偏小，可点工具栏「放大视图」。
  22 节点规模下首帧会自动放大到可读比例。
- **放大视图**：高度按**像素**（不是 `vh`），窗口变化不挤压图形；收起后**保留缩放**，
  不把用户视角打回默认。
- **平移 / 拖拽**：拖画布平移；拖节点做**用户叠加层**位移，数据轮询不会重置它。
- **选择**：单击节点高亮上下游；双击节点居中；点击边看边详情（可与节点详情互斥收起）。
- **搜索**：输入定位；`Enter` 在匹配项间循环并显示第 n / m 个。
- **图例**：按着色口径自动跟色（改配色图例跟着变），形状通道同样入图例。
- **小地图**：显示全图范围与当前视口，可点击 / 拖拽跳转。
- **键盘**：方向键在节点/边之间二维导航，`+` / `-` / `0` 缩放与复位，`Esc` 一次清空全部观察态，
  `Enter` 循环搜索结果（以 [`GuardGraph.tsx`](src/client/graph/GuardGraph.tsx) 的 `aria-keyshortcuts` 为准）。
- **轮询不重置视口**：fit 只跑一次（有守卫），数据刷新不会把用户缩放打回默认。

> 本文**不贴截图**：仓库的 [`screenshots.json`](screenshots.json) 目前只声明了市场图标，
> 没有面板 / 图谱截图。宁可写清交互，也不放一张不存在的图。

---

## 工具：`recency_guard`

`execute` 返回**规范 JSON**（业务数据摊平在顶层），人读文本由 `output.render` 投影，
命令窗口另接 `presentCall` / `presentResult` / `presentationMeta` 三条卡片通道。

| action | 参数 | 行为 |
| --- | --- | --- |
| `status` | — | 崩溃状态、嫌疑排名（全量）、自动关闭、**声明式冲突（带出处）**、**未解决冲突**、指标、工作区 / 分区归因 |
| `history` | `limit?=40` | 安装 / 更新 / 崩溃 / 恢复事件时间线 |
| `recover` | — | 按确定性冲突与依赖联动做**贪心最小隔离**；未命中声明时退回「按最近更新关闭」；残余 `unresolved` 上屏 |
| `restore` | — | 重新启用非首要嫌疑，首要嫌疑保持关闭 |
| `reenable` | `bundle` | 手动重新启用指定插件 |
| `backups` | — | 配置备份清单（含版本时间线） |
| `archive` | `reason?` | 归档当前产物并重置（先写审计行，再执行） |
| `archives` | — | 历史归档清单（带 manifest 摘要） |

所有写 action 在执行**之前**先落一条审计行（`kind: note` + 结构化 `audit{actor,action,justification}`）；
审计写失败不阻塞动作。读 action 不写日志。

---

## CLI 逃生通道

宿主起不来时，面板、工具、路由全都不可达 —— 这时用零依赖的 rescue CLI 直接读磁盘。
**默认只读**；写操作必须显式 `--yes`，且是两阶段、可精确回插的。

### 只读命令（默认绝不写盘）

```bash
node bin/rescue.mjs status   --profile-dir "<profile目录>" [--project <key|label>]
node bin/rescue.mjs history  --profile-dir "<profile目录>" [--limit 40]
node bin/rescue.mjs decision --profile-dir "<profile目录>"
node bin/rescue.mjs archives --profile-dir "<profile目录>"
node bin/rescue.mjs rescues  --profile-dir "<profile目录>"
```

### 可写命令（崩溃救火，默认 dry-run）

```bash
# 1) 先看计划：把 decision.json 的 disable 名单（或 --bundle）从 profile bundles 摘掉
node bin/rescue.mjs apply --profile-dir "<profile目录>" [--bundle a,b] [--reason "事故说明"]

# 2) 确认后真正落盘
node bin/rescue.mjs apply --profile-dir "<profile目录>" --yes

# 3) 回插：默认取最新一条可回插记录；中断后用 --resume
node bin/rescue.mjs restore --profile-dir "<profile目录>" [--id <uuid>] [--resume] --yes
```

- **两阶段**：先写 `prepared` 记录（含 `beforeHash` / `afterHash` / 每个 bundle 的原 index），
  再原子改 profile 的 `package.json`，最后标 `applied`；记录在
  `<profile>/.recency-guard/rescue/<uuid>.json`。
- **中断恢复**：`restore --resume` 读 `prepared` 记录，用哈希判定第二步是否已生效 ——
  `afterHash` 相符 ⇒ 按已生效回插；`beforeHash` 相符 ⇒ 第 2 步没发生，记录作废、不动 profile。
  回插按**原 index 升序**执行，不会互相挤位。
- **拒绝而不是硬改**：现场哈希不符 / 记录被篡改 ⇒ 退出码 `3`，不覆盖。
- **退出码**：`0` 正常；`1` 参数错误；`2` 发现未恢复的崩溃状态；`3` 拒绝（现场已变）。
- npm 安装后也可用 bin 名：`recency-guard-rescue status --profile-dir ...`。

Windows 示例：

```bash
node bin/rescue.mjs status --profile-dir "%USERPROFILE%\.dsh\profiles\desktop"
```

---

## 诚实边界

**概率性判定（会观察、可能不立刻行动）**

- 第二条崩溃通道（残留 bootMarker + 该 pid 已不在）是**概率性证据**：
  人为强杀也会产生同样形状。因此第 1 轮只观察，同一头号嫌疑累计到 `confirmRounds`（默认 2）才动手；
  **唯一嫌疑**走确定性证据，第 1 轮即行动。
- 幻影「另一个实例」已单独归类为 `self-reload`（同 pid 热重载），不按并发实例处理。

**写安全与对账（真机竞态修复）**

- **journal 是 append-only**：崩溃路径同步追加、绝不整文件回写；行数裁剪只在异步、
  加锁的安全时机做。并发写不会再用旧快照覆盖 `crash-detected`（此前真机约 1/9 复现）。
- **以决策文件为真相补账**：哨兵在场且决策文件有非空 `disable` 时，state 缺失的
  `autoDisabled` / 被清零的 `crashSeq` 会在下次启动补回；无哨兵 / 非崩溃决策 / 空名单
  一律不补（不猜）。
- **清零是 CAS**：干净启动只归零「本轮启动后没被崩溃改过」的计数，晚到的异步写
  不会抹掉崩溃路径刚写下的 `crashSeq`。
- **降级可查**：启动编排的分区索引提交 / 变更记录 / 官方实验观测失败，都会落一条
  journal `note` 并带 `degraded: true` —— 不只写 logger，重启后仍可查。

**研究边界（避免误读）**

- **预防性预警只预警、不行动**：启动频率 EWMA 与配置变更 CUSUM 只进观测面
  （面板/`status`），**不被任何关闭决策读取**；样本不足 ⇒ `defined:false` + 原因，不填 0。
  `loadTime` 是「启动频率（次/分钟）」的**代理**，不是真实加载耗时 —— 面板会原样显示代理说明。
- **共现信号只判定、不加权**：`mayWeightByCooccurrence` 只在满足研究
  [09 §4.3](docs/research/09-整合研究-四方向与既有研究的合流.md) 的条件时给出「可加权」判定，
  默认决策权重仍为 0；面板显示判定与理由，不把共现当成已生效权重。

**明确不拦 / 不修的**

- **entry 级 `apply` 抛错**：宿主只 warning 并自隔离该 entry，进程不崩 —— 不属于本插件的拦截面。
  真崩溃来自进程级未捕获异常 / rejection。评估守护能力时别用 entry 级失败当夹具。
- **官方组件**：`@deepseek-ai/*` 永远不是嫌疑；官方实验包（`@deepseek-ai/dsh-experimental-*`）
  只观测、**绝不自动关闭**（关官方组件等于卸宿主半边）。
- **宿主自身缺陷 / 依赖版本不兼容**：本插件不修，也不假装能修。按
  [`docs/agents/update-guide.md`](docs/agents/update-guide.md) 的紧急流程处理。
- **指标不可判定时为 `null`，不是 0**：没有真实崩溃样本时，贝叶斯后验、预防性预警不编数字；
  研究文档里的「Top-1 命中率提升 ≥5%」「预警提前量 ≥1 轮」两条效果判据**尚未声称达成**
  （机制已就位，效果待真机样本）。
- **跨分区只读视图**：`GET /snapshot?partition=<key>` 的运行时字段（stage / metrics / markov）
  如实降级为 `null` / `idle`，不替别的分区编造状态；`revision` 恒为 `null`。
- **声明式冲突只在有声明时产生**：插件没写 `dshCompat` / `dsh-plugin.json`、版本范围不可判定、
  对手不在场 ⇒ **不产生 finding**（不猜）。`conflicts` 空数组 = 扫过且没有，不是没扫。
- **`unresolved` 不静默**：受保护组件（官方 / 本插件）/ 无候选 / 配额不足导致治不了的冲突会单独上屏；
  不会用 recency 嫌疑人顶替确定性目标来「装作解决」。
- **`maxAutoDisable` 是整组上限**：依赖联动可能一次关一组；整组放不进配额则**一个都不动**
  （不让依赖者半关着在下一次启动时再崩一次）。
- **rescue 写模式不是自动的**：默认 dry-run，不带 `--yes` 绝不写；两阶段 + 哈希校验，
  现场已变时退出码 `3` 拒绝而不是硬改 profile。

---

## 配置

在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: recency-guard
  name: dsh-recency-guard
  config:
    enabled: true              # 总开关；false 时只记录，绝不自动关闭
    includeExperimental: true  # 实验性 / beta 命名是否算嫌疑
    maxAutoDisable: 2          # 单次恢复最多停用几个（整组上限，含依赖联动）
    autoRestore: true          # 稳定后自动恢复非首要嫌疑
    confirmRounds: 2           # 概率性证据的行动阈值（唯一嫌疑不受限）
    versionedBackups: true     # 更新时写带版本的时间线备份
    backupRetain: 5            # 每插件保留几份
    backupRoot: ''             # 备份自定义目录（环境变量 RECENCY_GUARD_BACKUP_ROOT 优先）
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后只记录，永不自动禁用 |
| `includeExperimental` | `true` | 实验性 / beta 命名的包是否算嫌疑 |
| `maxAutoDisable` | `2` | 单次恢复最多停用数，**整组上限**（依赖联动可能一次关多个；整组放不进则不动） |
| `autoRestore` | `true` | 稳定启动后自动恢复非首要嫌疑 |
| `confirmRounds` | `2` | 多嫌疑时同一头号嫌疑连续 N 轮才自动关闭（唯一嫌疑第 1 轮行动） |
| `versionedBackups` | `true` | 写「带版本的时间线备份」，可逐版对账 |
| `backupRetain` | `5` | 每个插件保留的备份份数（超出删最旧） |
| `backupRoot` | `''` | 自定义备份目录；`RECENCY_GUARD_BACKUP_ROOT` 优先 |

---

## 兼容范围

| 项 | 范围 | 依据 |
| --- | --- | --- |
| dsh 宿主 | `>=0.2.1-rc.5 <0.2.2-0 \|\| >=0.2.2-rc.1 <0.2.3-0 \|\| >=0.2.3-rc.1 <0.3.0-0` | [`package.json`](package.json) 的 `engines.dsh` |
| 开发 / 测试代际 | `0.2.2-rc.1` | `devDependencies` 与 `peerDependencies` 对齐 |
| `@deepseek-ai/cordis` | `>=4.0.5 <5.0.0` | 宿主实际 `4.1.0`；旧 `~4.0.5` 会被兼容闸门整体拒绝 |
| 官方包 | 全部 `peerDependencies` + `optional: true` | 缺 `dsh-tools` / `schemastery` 时降级加载，不 require 崩 |
| 社区 manifest | draft **v0.15**（[`dsh-plugin.json`](dsh-plugin.json)） | 与 dsh 安装契约（`package.json`）并存，不是替换 |
| Node | 开发与测试环境 `v24.14.0`；`package.json` 未声明 `engines.node` | 不声称未验证的 Node 版本 |
| 平台 | Windows 真机实测（桌面端 dsh） | Linux / macOS 未做真机崩溃注入验证 —— 未声称 |

> 预发布分支为什么要写显式 `||`：node-semver 只允许「范围里某个比较符与该版本的
> `major.minor.patch` 元组一致、且自身带预发布标签」时才放行预发布版本。
> 写成 `>=0.2.1-rc.5 <0.3.0-0` 会**静默排除** `0.2.2-rc.1`，用户安装直接撞 `ERESOLVE`。

## 数据文件

全部在 profile 目录下，按工作区分区（项目 A 的崩溃不影响项目 B）：

```
<profile>/.recency-guard/
├── current.json           # 指针：当前分区键（守护行表达式经它搭桥）
├── partitions.json        # 分区索引：项目 → 分区键
├── rescue/<uuid>.json     # 两阶段 rescue 记录（profile 级；apply/restore 用）
└── projects/<分区键>/
    ├── journal.jsonl      # 只追加：install / update / crash-detected / disable / restore / note
    ├── snapshot.json      # 上次观测到的 { 插件名: 版本 }
    ├── state.json         # 崩溃计数、自动关闭 / 已恢复名单
    ├── decision.json      # 本轮要拦截的插件 + unresolved 残余（守护行表达式读 disable）
    ├── crashed            # 崩溃哨兵（非零退出码时写下）
    ├── observation-*.json # 观测快照（指标数据源）
    ├── archive/           # 历史归档（搬走 + 留档）
    └── backups/           # 关闭前备份的配置（versionedBackups 时带版本）
```

---

## 开发与测试

```bash
npm install
npm run build           # esbuild 双产物：dist/index.js（宿主）+ dist/client.js（客户端）
npx tsc --noEmit        # 类型
npm run lint            # 类型 + 未使用符号
npm test                # 分层运行器：Core 42 / Host 10 / Client 24 / Contract 8 = 84
npm run extract-runtime # Host 层测试前置（runtime/ 缺失时先解出）
```

- 当前基线：`npm test` **84/84 通过**、`npx tsc --noEmit` 0 错误（2026-11-11 实测）。
- 验证顺序固定：**build → typecheck → lint → test**，全部零错误才算完成。
- 文档体系与写码纪律见 [`docs/agents/`](docs/agents/README.md)；
  发布 / 升级 / 热重载见 [`docs/agents/update-guide.md`](docs/agents/update-guide.md)。

---

## 版本记录

| 版本 | 一句话 |
| --- | --- |
| **0.18.0**（2026-11-13） | 研究落地补完与崩溃循环兜底：配置未知键 fail-loud（学习 dsh-ops）、journal 裁剪改**轮转**（读改写窗口结构性消灭 + 零依赖对拍）、路径指纹 64 位 + 双读迁移（TD-7 根治）、生存分析/失配检测/恢复残余上屏（三个观测孤岛接入消费）、图谱**影响面**接入详情侧栏（impactedBy/reachableFrom 首个 UI 消费者）；**级联刹车**：崩溃循环升级到顶后自动回滚到崩溃前启动状态（仅保留头号嫌疑），不再「越关越空」；**执行操作记录可视化**：recover 补步骤留痕 + 面板新增执行记录区块（三态：成功/失败/执行中）；技术债状态见 [`docs/agents/tech-debt.md`](docs/agents/tech-debt.md) |
| **0.17.0**（2026-11-11） | 技术栈清理与研究闭环：预防性预警（RQ3）接入生产且**只预警不行动**、面板自适应刷新、状态文件 schema 版本（未知版本保留现场）、路径逃逸修复（`pathSafeName` 单一实现 + 指纹）、变异 72 突变体 / 0 未归因 + 无直接测试 14→2 + rescue/宿主宽度跨实现对拍；技术债状态见 [`docs/agents/tech-debt.md`](docs/agents/tech-debt.md) |
| **0.16.0**（2026-11-11） | 确定性冲突证据（4 类 finding + 出处）、贪心最小隔离与依赖联动、可写两阶段 rescue、常态路径锁卫生、PanelSnapshotView 可空契约；新增社区 manifest [`dsh-plugin.json`](dsh-plugin.json)，README 面向用户重构，版本四锚点统一 |
| 0.15.0 | 架构重构：`host/` + `client/` + `shared/` 分层，client→host 越界与值依赖环写成契约测试 |
| 0.14.0 | 误伤反馈闭环、贝叶斯风险并行读数、预防性健康指标（EWMA / CUSUM）、自动化变异测试 |
| 0.13.0 | 决策因子快照、决策与展示排序口径统一、可选 peer 惰性解析（修安装即崩）、图谱结构洞察 |
| 0.12.1 | 崩溃信号第二条通道：哨兵盲区（SIGKILL / 断电）与 self-reload 判别 |
| 0.12.0 | 命令窗口显示接线、动作路由乐观并发（409）、L4 审计线、依赖代际对齐 |
| 0.11.x | 数据面安全（动作路由方法守卫）、跨分区只读快照、图谱交互补齐（边 / 小地图 / 触屏） |
| 0.10.0 | 马尔可夫转移矩阵、休哈特控制带、诊断投影与反馈入口 |
| 0.9.0 | 恢复置信分级（`confirmRounds`）、两阶段提交、离线 rescue CLI |
| 0.8.0 | 备份增强（版本时间线）、官方实验插件只观测、事件驱动变更检测 |
| 0.7.0 | 崩溃级修复（守护行 YAML 写入管线）、可交互图谱、可观测性白盒化 |
| 0.3–0.6 | 能力闭环双向比对、生命周期状态机、量化指标、多项目隔离、面板与图谱基础 |

长设计论证（为什么这样决策、数学模型、踩过的坑）已迁到
[`docs/agents/design.md`](docs/agents/design.md)，不再堆在 README。

---

## 许可

MIT。见 [`LICENSE`](LICENSE)。