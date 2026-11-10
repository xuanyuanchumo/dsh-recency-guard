# awesome-dsh-plugin 投稿材料（v0.13.0）

> 依据 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
> （2026-11-09 复核该文件当前内容后更新）
>
> **一个文件就是全部投稿**：向该仓库提交 PR，**只新增一个文件**
> `data/plugins/xuanyuanchumo__dsh-recency-guard.yml`，内容如下。
> 两个 README 由脚本从 `data/plugins/*.yml` 生成 —— **绝不手工编辑**，
> 也不要顺手改任何既有条目（CI 会列出 PR 改到的每个既有条目供追问）。

## 1. 投稿 YAML（PR 唯一文件）

```yaml
url: https://github.com/xuanyuanchumo/dsh-recency-guard
name: xuanyuanchumo/dsh-recency-guard
category: security
description:
  en: "Crash-recovery guard for DeepSeek Harness: records install and update recency, backs up plugin config, disables the most recently updated suspects before the next boot after a crash, and restores stable plugins afterwards. Two crash-detection channels cover kills and power loss that never run exit handlers. Ships a management panel with quantified observability, an interactive capability graph, per-project partition isolation, archive-and-reset on the latest facts, and an offline rescue CLI."
  zh: "DeepSeek Harness 的插件崩溃恢复守护：记录第三方与实验性插件的安装更新时序并备份配置，崩溃后在下一次启动前拦下最近更新的嫌疑插件，稳定后自动恢复。两条崩溃检测通道覆盖强杀与断电这类不会运行退出处理器的情形。带量化可观测性管理面板、可交互能力图谱、按项目分区隔离、按最新事实归档重置与离线救援 CLI。"
icon: https://raw.githubusercontent.com/xuanyuanchumo/dsh-recency-guard/main/assets/icon-256.png
```

三条格式规则（都是 contributing.md 明确写出的，容易踩）：

1. **描述里出现 `: `（冒号+空格）必须整段加引号**，否则 YAML 会读成嵌套键。
   上面两条都已经用双引号包住（英文描述里有多个 `:`）。
2. **不写 `tarball:`**：本包已发布 npm，预构建安装免 `allowBuilds` 授权；
   `latest/download/` 形式的 tarball 文件名若带版本号，发下一版就会静默 404。
3. **不写 `npm:` 键**：映射由 registry 自动采集，手写会被校验拒绝
   （已核实 registry 的 `repository.url` 指回本仓库，满足自动关联前提）。

## 2. 投稿前自查清单（逐条对照 contributing.md 的评审点）

- [x] `package.json` 声明 `dsh.bundle.patch`（`./cordis.patch.yml`）—— **被拒首因**已避开
      （只声明 `dsh.client` 不可安装；本仓库两者都有）。
- [x] 仓库根存在 `cordis.patch.yml`，且内含 `insert: [{ id, name }]` 声明。
- [x] 真实可用代码：22 个测试文件分层全绿（Core 8 / Host 3 / Client 10 / Contract 1）。
- [x] 仓库满 1 天（创建于 2026-11-07T07:44Z；CI 自动检查 repo age）。
- [x] 已加 `dsh-plugin` topic（另加 deepseek-harness / crash-recovery / plugin-guard）——
      经 GitHub API 复核：`["crash-recovery","deepseek-harness","dsh-plugin","plugin-guard"]`。
- [x] **描述逐句与代码核对**（评审第一件事就是核对「代码是否做了条目声称的事」）：
      - "records install and update recency" → `store.ts` journal `install`/`update` + `recency.ts` 排序；
      - "backs up plugin config" → `writeBackup` / `writeVersionedBackup`；
      - "disables the most recently updated suspects before the next boot" →
        `guarded-rows.ts` 守护行 + `decision.ts` 预启动决策；
      - "restores stable plugins afterwards" → `restoreDisabledExceptPrime`；
      - "Two crash-detection channels … never run exit handlers" → `sentinel.ts` 哨兵 +
        `abnormal-boot.ts` 残留标记通道（本轮 v0.12.1 新增，有真机两轮强杀证据）；
      - "management panel with quantified observability" → EWMA/CUSUM/Markov/Weibull/Shewhart
        （`observability.ts`、`markov.ts`、`survival.ts`、`control-band.ts`，均已单测）；
      - "interactive capability graph" → 22 节点/49 边真实数据面 + k 跳聚焦/小地图/方向键；
      - "per-project partition isolation" → `isolation.ts` + 分区索引；
      - "archive-and-reset on the latest facts" → `archive.ts` + `rerunWithCurrentFacts`；
      - "offline rescue CLI" → `bin/rescue.mjs`（零依赖、只读、语义化退出码 2）。
- [x] 描述**无营销词**（没有 "best/powerful/ultimate" 之类）。
- [x] category `security` 贴合实际做的事（崩溃防护/插件隔离）。若维护者认为
      `dev` 更贴切会直接改，不会打回 —— contributing.md 明确说明这点。
- [x] 官方 `@deepseek-ai/*` 全部在 `peerDependencies`，且**带显式预发布分支**：
      `>=0.2.1-rc.5 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || >=0.2.3-rc.1 <0.3.0-0`。
      这正是 contributing.md 用 ⚠️ 专门警告的那条（不带预发布分支会静默排除宿主全部
      预发布版本，用户撞 ERESOLVE）。`cordis` 范围已修为 `>=4.0.5 <5.0.0`
      —— 旧值 `~4.0.5` 不覆盖宿主真实的 4.1.0，会让 npm 安装被兼容闸门整体拒绝。
- [x] npm 已发布 `0.12.1`（`dist-tags.latest` 已指向它）；`repository` 指回本仓库。
- [x] `icon` 为 GitHub 托管位图（256×256 PNG）：`assets/icon-256.png`，raw URL 实测可访问。
- [x] `screenshots.json` 已声明（1 张，路径真实存在）；可按后续需要补充面板截图。
- [x] **真实、非占位**：无 TODO 式空实现；`bin/` 与 `src/` 全部有对应测试或真机证据。
- [ ] 提交 PR：**只加 `data/plugins/xuanyuanchumo__dsh-recency-guard.yml` 一个文件**，
      不碰任何既有条目、不碰生成的 README。

## 3. 发布事实（评审可自行核对）

| 项 | 值 |
|---|---|
| npm 包 | `dsh-recency-guard@0.12.1` |
| npm `latest` | `0.12.1` |
| tarball shasum | `06ccf0c0e5b12ad1f5d7d8b4c21d3a390f03f2c4` |
| GitHub | https://github.com/xuanyuanchumo/dsh-recency-guard （main 分支已推送） |
| 版本锚点 | `package.json` / `README.md` / `docs/agents/{api,design}.md` 均 0.12.1 |
| 许可 | MIT |

## 4. 安装方式（README 里对用户承诺的三条，均已实测）

```bash
# 从 npm（推荐；预构建，免构建授权）
dsh plugin --profile <profile名> add dsh-recency-guard

# 指定版本
dsh plugin --profile <profile名> add dsh-recency-guard@0.12.1

# 从本地源码（开发）
dsh plugin --profile <profile名> add file:/绝对路径/dsh-recency-guard
```

三种都以 `dsh plugin add` 走兼容闸门为前提；本轮已用 `@0.12.1` 在**全新 profile**
上实测通过（`+ dsh-recency-guard`），这是判断「别人能不能装上」的唯一可靠方式
（桌面端 `link:` 直连源码不经过闸门，本机看不出这类问题）。
