# 插件更新规范（dsh-recency-guard → 桌面端 dsh）

> 本文回答「改完这个仓库的代码后，怎么把新版装进桌面端 dsh」。
> 面向 agent 与维护者；所有命令都在本仓库根目录执行。

## 1. 发布前置检查（每次更新必跑）

```bash
npm test          # 分层测试 11 文件（Core/Client/Contract/Host）
npm run lint      # tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run build     # esbuild 双产物 dist/index.js + dist/client.js
npx tsc --noEmit  # 类型检查（lint 的超集验证）
```

四项全零错误才允许进入打包。宿主层测试需要 `runtime/`（`npm run extract-runtime` 可重建）。

## 2. 版本号同步纪律

- `package.json` 的 `version` 是**唯一真相源**；发布 tag 必须是 `v<version>`。
- 每轮循环升一次 minor（功能）或 patch（修复）；绝不出现「代码变了版本没变」——
  ANIC eval-runner 以版本变化作为评估缓存失效信号之一，版本没变会误用旧缓存。
- 文档同步点：`README.md`（版本新增块）、`docs/agents/api.md`（契约变更一句话清单）、
  `.cycles/intent/intent.md`（需求表）。

## 3.1 紧急修复流程（v0.11.1 事故复盘，2026-11-08）

宿主自动升级后插件被移出 profile / 启动致命时按此顺序处理：

1. **先读崩溃日志**（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`），
   找 `fatal load failure` 的栈 —— 它直接指向是哪个插件、哪一行。
2. **核对宿主运行时版本**：`strings app.asar | grep '"@deepseek-ai/dsh-tools"'`，
   与 `engines.dsh` / peer 范围逐条对照（预发布版本必须显式分支）。
3. **止血**：插件管理器禁用崩溃嫌疑插件（`plugin_manager set_plugin`），
   并确认 profile `dsh.profile.bundles` 里本插件仍在（被闸门移除时手动补回）。
4. **修代码**（本次三类缺陷：预发布范围、boot 抛出、失效写锁）。
5. **干净沙箱验证**：用与宿主**完全相同**的 dsh 版本安装 + 启动 + 看 journal。
6. 版本号 patch +1（0.11.1）→ 测试/构建 → npm publish → GitHub tag/release。

## 3.2 更新到桌面端 dsh（两种路径）

### 路径 A：npm 发布后更新（推荐，生产形态）

```bash
npm publish          # 需 npm 令牌（凭证库 vault: npm → NPM_TOKEN）
```

然后在桌面端 dsh：

```bash
dsh plugin --profile desktop add dsh-recency-guard
# 已安装时更新：
dsh plugin --profile desktop update dsh-recency-guard
```

### 路径 B：本地直装（开发验证形态）

```bash
npm run build
dsh plugin --profile desktop add file:/D/Projects/TraeProjects/dsh-recency-guard
```

本地直装**必须先 build**：`dsh plugin add file:` 只跑 `files` 里声明的产物拷贝，
不执行构建；`dist/` 过期会装进旧代码。

## 4. 热更新重载

- 改动只涉及 `dist/`（重新 build 后）时，可在桌面端会话调用 anic 同款重载面：
  插件管理器里 disable → enable 即重载 client bundle（无需重启宿主）。
- 改动涉及 `src/index.ts`（宿主半部）时，**必须重启 dsh**：宿主模块由 Loader
  在启动期 import，热重载不重跑 `apply()`。
- 重载纪律（本插件特有）：守护行、journal、分区索引全部在 profile 目录下，
  重载/重启都不丢；但**崩溃路径上的状态只认磁盘**——任何「先改内存再落盘」的
  改法都违反本插件的同步 IO 铁律。

## 5. 更新后验证（最小用户旅程）

1. 重启/重载后打开面板（侧栏 → 插件守护）；
2. 诊断卡确认「插件版本」= 刚发布的版本号；
3. 跑 `recency_guard` 工具 `action=status`，确认 facts 里有「插件版本」「问题反馈」两行；
4. 若本轮改了守护行/决策逻辑：在沙箱 profile（sb-rg-*）跑一次崩溃注入旅程后再上桌面端。

## 6. 沙箱纪律

- 沙箱验证用独立 profile（`sb-rg-*` 前缀），绝不碰 desktop/web 主力 profile。
- 沙箱崩溃是预期行为（注入假插件触发守护），崩溃后检查 `.recency-guard/projects/<键>/`
  的 journal/decision/state 三件套与 rescue CLI 输出。
