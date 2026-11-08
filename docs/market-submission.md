# awesome-dsh-plugin 投稿材料（v0.12.1）

> 依据 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
> 「一个文件就是全部投稿」：向该仓库提交 PR，新增 `data/plugins/xuanyuanchumo__dsh-recency-guard.yml`，
> 内容如下（README 由脚本生成，绝不手工编辑）。

## 投稿 YAML（PR 唯一文件）

```yaml
url: https://github.com/xuanyuanchumo/dsh-recency-guard
name: xuanyuanchumo/dsh-recency-guard
category: security
description:
  en: >-
    Crash-recovery guard for DeepSeek Harness. Records install and update
    recency of third-party and experimental plugins, backs up their config,
    and after a crash automatically disables the most recently updated
    suspects so the profile boots again; stable boots restore non-suspects.
    Ships a management panel with quantified observability (EWMA crash
    pressure, CUSUM change point, Markov transition matrix, Weibull survival
    fit, Shewhart control band), an interactive capability graph, per-project
    partition isolation, archive-and-reset on the latest facts, and an
    offline rescue CLI. Crash detection has two channels: an exit-code
    sentinel plus a leftover-boot-marker check that catches SIGKILL, OOM
    kills, power loss and native crashes, which never run exit handlers.
  zh: >-
    DeepSeek Harness 的插件崩溃恢复守护。记录第三方与实验性插件的安装更新
    时间线并备份配置；崩溃后按「最近更新优先」自动关闭嫌疑插件让 profile
    能再次启动，稳定后自动恢复非嫌疑。带量化可观测性管理面板（EWMA 崩溃
    压力、CUSUM 变点、马尔可夫转移矩阵、Weibull 生存拟合、休哈特控制带）、
    可交互能力图谱、按项目分区隔离、按最新事实归档重置与离线救援 CLI。
    崩溃检测有两条通道：退出码哨兵 + 残留启动标记复核（覆盖强杀/OOM/断电/
    原生崩溃 —— 这些死法不会运行 exit 处理器）。
icon: https://raw.githubusercontent.com/xuanyuanchumo/dsh-recency-guard/main/assets/icon-256.png
```

## 投稿前自查清单（contributing.md 的评审点逐条对照）

- [x] `package.json` 声明 `dsh.bundle.patch`（不只 `dsh.client`）—— 被拒首因已避开。
- [x] 仓库根有 `cordis.patch.yml`。
- [x] 真实可用代码（13/13 分层测试、沙箱五段用户旅程）。
- [x] 仓库满 1 天：仓库创建于 **2026-11-07T07:44Z**，contributing 要求满 1 天，
      **最早可投稿时间 2026-11-08T07:44Z（北京 15:44）之后** —— 提前提交会被
      CI 的 repo-age 门禁拒绝（该结论已写入 INC-2026-11-08-01）。
- [x] `dsh-plugin` topic 已加（另加 deepseek-harness / crash-recovery / plugin-guard）。
- [x] 描述只说功能无营销词；每个数字与 API 名都与代码核对（8 个工具 action、
      9 条路由、五类数学模型均在仓库真实存在）。
- [x] category 选 `security`（崩溃防护/插件隔离属于安全与稳定范畴；如维护者认为
      `dev` 更贴切会被直接改，不会打回）。
- [x] 官方 `@deepseek-ai/*` 包全部在 `peerDependencies`（且带显式预发布分支
      `>=0.2.1-rc.5 <0.3.0-0`，符合 semver 预发布匹配规则）。
- [x] npm 已发布（`npm view dsh-recency-guard` 可查，`repository` 字段指回本仓库
      —— 市场自动关联下载量）。
- [x] `icon` 为 GitHub 托管位图（256×256 PNG，raw.githubusercontent.com）。
- [x] `screenshots.json` 已声明（assets/icon-256.png；后续可补面板截图）。
- [ ] 提交 PR：只加 `data/plugins/xuanyuanchumo__dsh-recency-guard.yml` 一个文件，
      不碰任何既有条目与生成的 README。
