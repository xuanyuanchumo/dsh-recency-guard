# awesome-dsh-plugin 投稿材料（v0.17.0）

> 依据 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>
> （2026-11-11 复核该文件当前内容）。
>
> **一个文件就是全部投稿**：该条目上一轮已收录（`data/plugins/xuanyuanchumo__dsh-recency-guard.yml`）。
> 本轮提交的是**更新自己那一条**的 PR（去掉过期 tarball、刷新描述），内容如下。
> 两个 README 由脚本从 `data/plugins/*.yml` 生成 —— **绝不手工编辑**，
> 也不要顺手改任何既有条目（CI 会列出 PR 改到的每个既有条目供追问）。
>
> 本文件同时是**如实自查表**：没做的项不勾，发布事实按 2026-11-11 的 registry / GitHub 实际值记录。

## 1. 投稿 YAML（PR 唯一文件）

```yaml
url: https://github.com/xuanyuanchumo/dsh-recency-guard
name: xuanyuanchumo/dsh-recency-guard
category: security
description:
  en: "Crash-recovery guard for DeepSeek Harness: records install/update recency plus declared compatibility metadata, backs up plugin config, disables the offending suspects before the next boot after a crash (declaration-conflict targets when declared, otherwise the most recently updated), and restores stable plugins afterwards. Two crash-detection channels cover kills and power loss that never run exit handlers; journal writes are append-only and crash state is reconciled against the decision file. Ships a management panel with quantified observability, deterministic conflict findings with file-and-line provenance, greedy minimal quarantine with dependency linkage, and preventive early-warning readings that only warn and never trigger disabling. The panel refreshes adaptively (5s to 15s backoff while stable, immediate return on change), and also provides an interactive capability graph, per-project partition isolation, archive-and-reset, and an offline rescue CLI that can apply or restore a quarantine (dry-run by default, two-phase with hash checks). Optional peers are lazily resolved so an incomplete host environment can never make the plugin fail to load."
  zh: "DeepSeek Harness 的插件崩溃恢复守护：记录安装更新时序与声明的兼容元数据、备份插件配置，崩溃后在下一次启动前拦下问题嫌疑插件（有兼容声明时按确定性冲突取证，否则按最近更新排序），稳定后自动恢复。两条崩溃检测通道覆盖强杀与断电这类不会运行退出处理器的情形；journal 真追加，崩溃状态按决策文件对账。带量化可观测性管理面板、带文件行号出处的确定性冲突证据、含依赖联动的贪心最小隔离，以及只预警不触发关闭的预防性预警读数。面板自适应刷新（稳定时 5s 退避到 15s，内容变化立即回 5s），并提供可交互能力图谱、按项目分区隔离、归档重置，以及可离线执行/回插隔离的救援 CLI（默认 dry-run，两阶段 + 哈希校验）。可选 peer 惰性解析，宿主环境不完整也不会导致插件加载失败。"
icon: https://raw.githubusercontent.com/xuanyuanchumo/dsh-recency-guard/main/assets/icon-256.png
```

三条格式规则（都是 contributing.md 明确写出的，容易踩）：

1. **描述里出现 `: `（冒号+空格）必须整段加引号**，否则 YAML 会读成嵌套键。
   上面两条都用了双引号（英文描述里有多个 `:`）。
2. **不写 `tarball:`**：本包发布在 npm，预构建安装免 `allowBuilds` 授权；
   `latest/download/` 形式的 tarball 文件名若带版本号，发下一版就会静默 404。
3. **不写 `npm:` 键**：映射由 registry 自动采集，手写会被校验拒绝
   （`repository.url` 指回本仓库，满足自动关联前提 —— 见 §4）。

校验命令（可复现，来自 [verification.md](./agents/verification.md) §7.3）：

```bash
node -e "const fs=require('fs');const t=fs.readFileSync('docs/market-submission.md','utf8');const m=t.match(/\`\`\`yaml\n([\s\S]*?)\`\`\`/);if(!m)throw new Error('no yaml block');const YAML=require('yaml');const d=YAML.parse(m[1]);console.log('keys',Object.keys(d).join(','));console.log('category',d.category);console.log('url',d.url);console.log('en',typeof d.description.en,'zh',typeof d.description.zh)"
```

判据：能解析出对象；`description.en` 是字符串（该字段是必填）；`category` ∈ 合法取值。

## 2. 描述逐句与代码核对

评审第一件事是核对「代码是否做了条目声称的事」。逐句对账（路径均可点击）：

| 描述断言 | 代码依据 | 验证 |
| --- | --- | --- |
| records install and update recency | [`store.ts`](../src/host/data/store.ts) 的 journal `install` / `update`；[`recency.ts`](../src/host/risk/recency.ts) 排序 | [`core.test.ts`](../tests/unit/core.test.ts) |
| backs up plugin config | `store.ts` 的 `writeBackup` / `writeVersionedBackup` | [`versioned-backup.test.ts`](../tests/unit/versioned-backup.test.ts) |
| disables the offending suspects before the next boot (declaration-conflict targets when declared, otherwise the most recently updated) | [`guarded-rows.ts`](../src/host/guard/guarded-rows.ts) 守护行 + [`decision.ts`](../src/host/guard/decision.ts) 预启动决策；声明路径见 [`crash-decision.ts`](../src/host/guard/crash-decision.ts) | [`patch-safety.test.ts`](../tests/unit/patch-safety.test.ts)、[`revision-source.test.ts`](../tests/host/revision-source.test.ts)、[`crash-decision.test.ts`](../tests/unit/crash-decision.test.ts) |
| restores stable plugins afterwards | [`recovery-actions.ts`](../src/host/guard/recovery-actions.ts) 的 `restoreDisabledExceptPrime` | [`core.test.ts`](../tests/unit/core.test.ts) |
| reads declared compatibility metadata (dshCompat / dsh-plugin.json) to emit deterministic conflict findings with file-and-line provenance | [`conflict-declarations.ts`](../src/host/guard/conflict-declarations.ts)（读声明 + 版本范围可判定性）、[`conflict-findings.ts`](../src/host/guard/conflict-findings.ts)（四类 finding，带 `source.file/line` + `declaration` 原文） | [`conflict-findings.test.ts`](../tests/unit/conflict-findings.test.ts)、[`deterministic-evidence.test.ts`](../tests/unit/deterministic-evidence.test.ts) |
| computes a greedy minimal quarantine set with dependency linkage; unresolved conflicts surface | [`quarantine-plan.ts`](../src/host/guard/quarantine-plan.ts)（循环重算 / 依赖闭包 / 整组配额 / `unresolved`）、[`crash-decision.ts`](../src/host/guard/crash-decision.ts)（决策组装） | [`quarantine-plan.test.ts`](../tests/unit/quarantine-plan.test.ts)、[`crash-decision.test.ts`](../tests/unit/crash-decision.test.ts)、[`unresolved-surfacing.test.ts`](../tests/unit/unresolved-surfacing.test.ts) |
| Journal writes are append-only and crash state is reconciled against the decision file, so a concurrent write cannot erase the crash record | [`store.ts`](../src/host/data/store.ts)（`append` / `appendSync` 真追加 + 安全时机 trim）、[`state-reconcile.ts`](../src/host/guard/state-reconcile.ts)（以决策文件为真相补账）、[`boot-orchestration.ts`](../src/host/guard/boot-orchestration.ts)（CAS 清零 + `degraded:true` 留痕） | [`journal-append-race.test.ts`](../tests/unit/journal-append-race.test.ts)、[`boot-crashseq-race.test.ts`](../tests/unit/boot-crashseq-race.test.ts)、[`state-reconcile.test.ts`](../tests/unit/state-reconcile.test.ts)、[`boot-degradation.test.ts`](../tests/unit/boot-degradation.test.ts) |
| Two crash-detection channels … never run exit handlers | [`sentinel.ts`](../src/host/guard/sentinel.ts) 哨兵 + [`abnormal-boot.ts`](../src/host/guard/abnormal-boot.ts) 残留标记通道 | [`fault-injection.test.ts`](../tests/fault-injection/fault-injection.test.ts)、[`reload-journey.test.ts`](../tests/host/reload-journey.test.ts) |
| management panel with quantified observability | [`observability.ts`](../src/host/observe/observability.ts)、[`markov.ts`](../src/host/observe/markov.ts)、[`survival.ts`](../src/host/observe/survival.ts)、[`control-band.ts`](../src/host/observe/control-band.ts) | [`observability-math.test.ts`](../tests/unit/observability-math.test.ts)、[`hazard-threshold.test.ts`](../tests/unit/hazard-threshold.test.ts) |
| decision-factor breakdown / co-occurrence verification / structural graph insights | [`decision-evidence.ts`](../src/host/guard/decision-evidence.ts)、[`cooccurrence.ts`](../src/host/observe/cooccurrence.ts)、[`graph-analysis.ts`](../src/client/graph/graph-analysis.ts) | [`decision-evidence.test.ts`](../tests/unit/decision-evidence.test.ts)、[`cooccurrence.test.ts`](../tests/unit/cooccurrence.test.ts)、[`graph-analysis.test.ts`](../tests/client/graph-analysis.test.ts) |
| preventive early-warning readings that only warn and never trigger disabling | [`preventive.ts`](../src/host/observe/preventive.ts)（EWMA 控制带 / CUSUM）、[`preventive-view.ts`](../src/host/surface/preventive-view.ts)（生产投影） | [`observability-math.test.ts`](../tests/unit/observability-math.test.ts)、[`preventive-wiring.test.ts`](../tests/unit/preventive-wiring.test.ts)（源码扫描：关闭链路零依赖）、[`preventive-card.test.ts`](../tests/client/preventive-card.test.ts) |
| panel refreshes adaptively (5s→15s backoff while stable, immediate return on change) | [`poll-adaptive.ts`](../src/client/panel/poll-adaptive.ts)（指纹 + 退避）、[`GuardPanel.tsx`](../src/client/panel/GuardPanel.tsx)（递归 setTimeout + cancelled） | [`poll-adaptive.test.ts`](../tests/client/poll-adaptive.test.ts) |
| interactive capability graph | [`GuardGraph.tsx`](../src/client/graph/GuardGraph.tsx) + [`graph-data.ts`](../src/host/capability/graph-data.ts) | [`graph-model.test.ts`](../tests/client/graph-model.test.ts)、[`graph-focus.test.ts`](../tests/client/graph-focus.test.ts) |
| per-project partition isolation | [`isolation.ts`](../src/host/core/isolation.ts) + 分区索引 | [`isolation-journey.test.ts`](../tests/host/isolation-journey.test.ts) |
| archive-and-reset on the latest facts | [`archive.ts`](../src/host/data/archive.ts)（manifest 先读后搬） | [`core.test.ts`](../tests/unit/core.test.ts) |
| offline rescue CLI that can also apply or restore a quarantine (dry-run by default, two-phase with hash checks) | [`rescue.mjs`](../bin/rescue.mjs)（零依赖；只读命令 + `apply`/`restore`；`prepared→applied`、before/afterHash、`--resume` 原 index 回插；退出码 0/1/2/3） | [`rescue-cli.test.ts`](../tests/unit/rescue-cli.test.ts) |
| Optional peers are lazily resolved so an incomplete host environment can never make the plugin fail to load | [`tool-registration.ts`](../src/host/surface/tool-registration.ts) 的 `loadDefineTool` + [`index.ts`](../src/index.ts) 的 `loadSchemastery` | [`install-resilience.test.ts`](../tests/contract/install-resilience.test.ts) |

**数字口径**：`npm test` = **84/84 通过**（Core 42 / Host 10 / Client 24 / Contract 8），
`npx tsc --noEmit` 0 错误（2026-11-11 实测）。描述里没有出现「46 tools / 六大领域」
这类需要逐项计数的数字，避免与实现漂移。

## 3. 投稿前自查清单（逐条对照 contributing.md 的评审点）

- [x] `package.json` 声明 `dsh.bundle.patch`（`./cordis.patch.yml`）—— **被拒首因**已避开。
- [x] 仓库根存在 `cordis.patch.yml`，且内含 `insert: [{ id, name }]` 声明。
- [x] 真实可用代码：**84 项**测试分层全绿（Core 42 / Host 10 / Client 24 / Contract 8）。
- [x] 描述里的新能力可逐句核对：确定性冲突四类 finding 带出处；贪心最小隔离含依赖联动与
      `unresolved` 上屏；rescue 写面默认 dry-run + 两阶段哈希；预防性预警只上屏、关闭链路零依赖
      （源码扫描测试）；自适应刷新有纯函数 + 接线测试（见 §2）。
- [x] `dsh-plugin.json` 权限已复核：**无新增权限**。`fs.read` 覆盖读插件自带的
      `package.json` / `dsh-plugin.json` 声明；`fs.write`（scope `profile`）覆盖
      `.recency-guard/`、`cordis.patch.yml` 与 rescue 对 profile `package.json` 的修改。
- [x] 仓库满 1 天：创建于 `2026-11-07T07:44:06Z`（GitHub API，2026-11-11 复核）。
- [x] 已加 `dsh-plugin` topic：GitHub API 复核
      `["crash-recovery","deepseek-harness","dsh-plugin","plugin-guard"]`。
- [x] **描述逐句与代码核对**（见 §2）。
- [x] 描述**无营销词**（没有 "best / powerful / ultimate" 之类）。
- [x] `category: security` 贴合实际做的事（崩溃防护 / 插件隔离）；
      若维护者认为 `dev` 更贴切会直接改，不会打回。
- [x] 官方 `@deepseek-ai/*` 全部在 `peerDependencies`，且**带显式预发布分支**：
      `>=0.2.1-rc.5 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || >=0.2.3-rc.1 <0.3.0-0`；
      `cordis` 范围 `>=4.0.5 <5.0.0`（宿主实际 4.1.0）。
- [x] `icon` 为 GitHub 托管位图（256×256 PNG）：`assets/icon-256.png`，
      raw URL 于 2026-11-11 实测 HTTP 200。
- [x] `screenshots.json` 已声明（1 张：`assets/icon-256.png`，路径真实存在）。
- [x] 真机竞态修复可复现：journal 真追加（旧快照不覆盖崩溃事件）、按决策文件对账补 state、
      CAS 清零、启动降级落 `degraded:true` note —— 对应 4 个单测文件（见 §2）。
- [x] **真实、非占位**：无 TODO 式空实现；`bin/` 与 `src/` 全部有对应测试或真机证据。
- [x] 仓库内新增 `dsh-plugin.json`（社区 manifest draft v0.15），字段逐条有代码依据。
- [x] **npm 已发布 0.16.0** —— 2026-11-11 完成。registry 直查 `latest = 0.16.0`、
      版本集合含 `0.16.0`；tarball shasum `1d49e8a7b15d0d5a1708b5a110863a105a6533ec`（见 §4）。
- [ ] 面板 / 图谱截图 —— **未提供**。`screenshots.json` 目前只有市场图标；
      真机截图里含用户会话列表，未脱敏不放仓，不拿图冒充。
- [x] **提交 PR**：本条目上一轮已收录；上一轮提交的是**更新自己那一条**（去掉了过期的
      `v0.11.4` 固定 tarball、刷新描述），未碰任何既有条目、未手工编辑生成的 README：
      <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14245>
- [ ] **0.17.0 发布后再提一次「只改自己条目」的 PR**：补预防性预警（只预警不行动）与
      自适应刷新；不改既有条目、不手工编辑生成的 README —— **未做**（等 0.17.0 发布）。

> 未勾的是截图（隐私 + 不造图）与 0.17.0 的条目更新 PR，不是遗漏。

## 4. 发布事实（2026-11-11 核对，评审可自行复核）

| 项 | 值 |
| --- | --- |
| npm 包 | `dsh-recency-guard` |
| npm `latest` | **0.16.0**（0.17.0 尚未发布；`https://registry.npmjs.org/dsh-recency-guard/latest`） |
| latest tarball shasum | `1d49e8a7b15d0d5a1708b5a110863a105a6533ec`（204.8kB / 12 文件） |
| 本仓库源码版本 | **0.17.0**（四锚点：`package.json` / README / `docs/agents` / `dsh-plugin.json`） |
| GitHub | <https://github.com/xuanyuanchumo/dsh-recency-guard>（main；最新 tag 为 `v0.16.0`） |
| GitHub Release | <https://github.com/xuanyuanchumo/dsh-recency-guard/releases/tag/v0.16.0>（`v0.17.0` 发布后新增） |
| 市场条目 | `data/plugins/xuanyuanchumo__dsh-recency-guard.yml`（已收录） |
| 更新 PR | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14245> |
| 仓库创建时间 | `2026-11-07T07:44:06Z`（满足 1 天门槛） |
| topics | `crash-recovery`、`deepseek-harness`、`dsh-plugin`、`plugin-guard` |
| 许可 | MIT |

> 仓库四锚点已统一为 **0.17.0**；npm `latest` 仍为 **0.16.0**，发布 0.17.0 后再同步本表。
> 条目不再保留 `tarball:` —— 已发布 npm，预构建安装免 `allowBuilds` 授权；
> registry 映射自动采集，不手写 `npm:` 键。0.17.0 发布后需再提一次**只改自己条目**的 PR，
> 把描述更新为「预防性预警（只预警不行动）+ 自适应刷新」。

## 4.1 本轮对既有条目的改动（只改自己那一条）

| 字段 | 旧值（上一轮收录时） | 新值 | 理由 |
|---|---|---|---|
| `tarball` | `…/releases/download/v0.11.4/dsh-recency-guard-0.11.4.tgz` | **删除** | 指向已过期产物；已发 npm，权威来源改为 registry |
| `description.en/zh` | 描述 0.16.x 的能力面 | 补预防性预警（只预警不行动）与自适应刷新；保留确定性冲突证据 / 贪心隔离 / append-only journal + 对账 / 可写 rescue | 描述必须与代码一致（评审逐句核对） |
| `url` / `name` / `category` / `icon` | 不变 | 不变 | — |

## 5. 安装方式（README 对用户承诺的三条）

```bash
# 从 npm（推荐；预构建，免构建授权）
dsh plugin --profile <profile名> add dsh-recency-guard

# 指定版本（发布 0.16.0 后）
dsh plugin --profile <profile名> add dsh-recency-guard@0.16.0

# 从本地源码（开发）
dsh plugin --profile <profile名> add file:/绝对路径/dsh-recency-guard
```

三种都以 `dsh plugin add` 走兼容闸门为前提。历史实测记录：`@0.12.1` 曾在**全新 profile**
上安装通过（桌面端 `link:` 直连源码不经过闸门，本机看不出这类问题）。
本轮（0.17.0）源码侧已跑通 `npm test` **84/84**；**未重新做 npm 全新 profile 安装实测**，
因此不声称"0.16.0 的 npm 安装已验证"。