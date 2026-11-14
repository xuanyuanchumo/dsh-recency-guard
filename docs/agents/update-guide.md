# 插件更新规范（dsh-recency-guard → 桌面端 dsh）

> 本文回答「改完这个仓库的代码后，怎么把新版装进桌面端 dsh」。
> 面向 agent 与维护者；所有命令都在本仓库根目录执行。

## 1. 发布前置检查（每次更新必跑）

```bash
npm test          # 四层分层测试（Core 42 / Host 10 / Client 24 / Contract 8 = 84）
npm run lint      # tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run build     # esbuild 双产物 dist/index.js + dist/client.js
npx tsc --noEmit  # 类型检查（lint 的超集验证）
```

四项全零错误才允许进入打包。宿主层测试需要 `runtime/`（`npm run extract-runtime` 可重建）。
发布面校验（四锚点 / manifest / 市场 YAML）见
[verification.md](./verification.md) §7。

## 2. 版本同步纪律（四锚点）

`package.json` 的 `version` 是**安装侧唯一真相源**，但发布面有四个必须同值的锚点：

| 锚点 | 文件 |
| --- | --- |
| 1 | `package.json` → `version` |
| 2 | `README.md` 顶部版本行 |
| 3 | `docs/agents/` 的当前版本引用（`api.md` / `design.md` / `architecture.md` 标题） |
| 4 | `dsh-plugin.json` → `version` |

**顺序固定**（反了会造出 npm 上不存在的版本）：

```text
改四锚点 → build/typecheck/lint/test 全绿 → git tag v<version> → npm publish → GitHub release
```

- 先 publish 后改锚点 ⇒ npm 上是新版本、仓库里是旧版本，用户按源码装到的东西与 npm 不一致；
- 先 tag 后改锚点 ⇒ tag 指向的提交里 `package.json` 还是旧值；
- 四锚点漏一个 ⇒ README / 安装器 / manifest 各说各话（v0.14.0 起点就是这个形态：
  `package.json 0.14.0` / 提交信息 `v0.15.0` / tag `v0.11.4` / npm `latest 0.12.1`）。

核对命令见 [conventions.md](./conventions.md) §6.2。每轮循环升一次 minor（功能）或 patch（修复）；
ANIC eval-runner 以版本变化作为评估缓存失效信号之一，版本没变会误用旧缓存。
文档同步点：`README.md`（版本记录一行）、`docs/agents/api.md`（契约变更一句话清单）、
`.cycles/intent/intent.md`（需求表，若本轮有需求变更）。

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
6. 版本号 patch +1（示例 0.11.1）→ **改四锚点** → 测试/构建 → `git tag v<version>` → npm publish → GitHub release
   （顺序见 §2；先 publish 后改锚点会造出仓库里不存在的版本）。

## 3.2 更新到桌面端 dsh（两种路径）

### 路径 A：npm 发布后更新（推荐，生产形态）

```bash
npm test && npm run build                 # 发布前置（§1）
git tag v0.17.0 && git push --tags       # 先 tag：指向已对齐四锚点的提交
npm publish                              # 再 publish：需 npm 令牌（凭证库 vault: npm → NPM_TOKEN）
```

发布后核对（registry 侧事实）：

```bash
npm view dsh-recency-guard version        # 应为刚发布的版本
npm view dsh-recency-guard dist-tags.latest
```

然后在桌面端 dsh：

```bash
dsh plugin --profile desktop add dsh-recency-guard
# 已安装时更新：
dsh plugin --profile desktop update dsh-recency-guard

# 锁定版本（推荐，避免 latest 落后/超前于文档）：
dsh plugin --profile desktop add dsh-recency-guard@0.20.0
```

### 路径 B：本地直装（开发验证形态）

```bash
npm run build
dsh plugin --profile desktop add file:/D/Projects/TraeProjects/dsh-recency-guard
```

本地直装**必须先 build**：`dsh plugin add file:` 只跑 `files` 里声明的产物拷贝，
不执行构建；`dist/` 过期会装进旧代码。

## 3.3 宿主起不来时的离线救火（可写 rescue，v0.16）

崩溃循环导致宿主起不来时，面板/工具/路由全不可达；用 rescue 离线把决策里的插件从
profile bundle 列表摘掉，让宿主能重新启动：

```bash
# 1) 先只读看现场（绝不写盘）
node bin/rescue.mjs status   --profile-dir "<profile目录>"
node bin/rescue.mjs decision --profile-dir "<profile目录>"
node bin/rescue.mjs rescues  --profile-dir "<profile目录>"

# 2) 看计划（dry-run，默认不写）
node bin/rescue.mjs apply --profile-dir "<profile目录>" --reason "崩溃循环止血"

# 3) 确认后落盘，再启动宿主
node bin/rescue.mjs apply --profile-dir "<profile目录>" --yes

# 4) 事后回插（按原 index 精确复原；中断后 --resume）
node bin/rescue.mjs restore --profile-dir "<profile目录>" --resume --yes
```

判据与纪律：

- 不带 `--yes` **绝不写** profile；不要手工编辑 `package.json` 绕过两阶段记录
  （restore 依赖记录里的原 index，手改会让回插位置错位）。
- 退出码 `3` = 现场已变 / 记录不可信 ⇒ **停下来人工核对**，不要反复重试。
- 记录在 `<profile>/.recency-guard/rescue/<uuid>.json`，`rescues` 可读；
  它们是审计事实，不要手动删除。

## 4. 热更新重载

- 改动只涉及 `dist/`（重新 build 后）时，可在桌面端会话调用 anic 同款重载面：
  插件管理器里 disable → enable 即重载 client bundle（无需重启宿主）。
- 改动涉及 `src/index.ts`（宿主半部）时，**必须重启 dsh**：宿主模块由 Loader
  在启动期 import，热重载不重跑 `apply()`。
- 重载纪律（本插件特有）：守护行、journal、分区索引全部在 profile 目录下，
  重载/重启都不丢；但**崩溃路径上的状态只认磁盘**——任何「先改内存再落盘」的
  改法都违反本插件的同步 IO 铁律。

## 4.1 归档重置（升级 / 事故复盘后重新开始）

- **何时做**：宿主代际升级后旧决策不可比；或一次事故复盘完成，要从**最新 node_modules 事实**
  重新推嫌疑（不继承旧结论）。
- **怎么做**：面板的「归档重置」按钮，或工具
  `{ "action": "archive", "reason": "升级宿主后重新基线" }`；
  HTTP 动作是 `POST /recency-guard/api/action/archive`（只接受 POST；带过期 `expectedRevision` 返回 409 且不执行）。
- **语义**：归档 = **搬走 + 留档**。manifest 必须在 rename **之前**读取（搬走后再读，摘要会永远报 0：
  crashSeq / autoDisabled / journalEvents 全空）；重置后从当前磁盘事实重建，不继承旧结论。
- **只读核对**（宿主活着 / 挂了都能用）：

  ```bash
  node bin/rescue.mjs archives --profile-dir "<profile目录>"
  ```

- **不要**手工删除 `.recency-guard/` 来"重置"：那会丢掉崩溃证据链与审计行，也让分区索引失配。
  归档是唯一保留证据的重置方式。

## 5. 更新后验证（最小用户旅程）

1. 重启/重载后打开面板（侧栏 → 插件守护）；
2. 诊断卡确认「插件版本」= 刚发布的版本号；
3. 跑 `recency_guard` 工具 `action=status`，确认 facts 里有「插件版本」「问题反馈」两行；
4. 若本轮改了守护行/决策逻辑：在沙箱 profile（sb-rg-*）跑一次崩溃注入旅程后再上桌面端。

## 6. 沙箱纪律

- 沙箱验证用独立 profile（`sb-rg-*` 前缀），绝不碰 desktop/web 主力 profile。
- 沙箱崩溃是预期行为（注入假插件触发守护），崩溃后检查 `.recency-guard/projects/<键>/`
  的 journal/decision/state 三件套与 rescue CLI 输出。
