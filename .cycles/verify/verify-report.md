# 独立验证报告 —— dsh-recency-guard v0.7.0 / ANIC cycle-1

> 判据原则：每条只写 **PASS / FAIL / UNKNOWN** + 原始输出或可复现命令。
> **「无法评估」不等于「通过」** —— 未验证项一律标 UNKNOWN 并写明原因。

| 字段 | 值 |
|---|---|
| 验证时间 | 2026-11-06 17:35 (+08:00) |
| 验证对象 | `dsh-recency-guard@0.7.0`（link 挂载，junction） |
| 宿主运行时 | dsh `0.2.2-rc.1`（桌面端 Electron 同源运行时） |
| 沙箱 profile | `sb-rg-c5`（`--from-default-profile web` 生成，非手写 pin） |
| 端口 | 3081（主工作区）/ 3082（第二工作区，验证隔离） |
| 验证者 | lead（本循环承担 verifier 职责；owner 的报告不作为通过依据） |

---

## 1. 静态与单元层

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1.1 | `npm run build` | **PASS** | `dist/index.js` + `dist/client.js` 生成，`build: host + client ready` |
| 1.2 | `npx tsc --noEmit` | **PASS** | 零输出 |
| 1.3 | `npm run lint` | **PASS** | 零输出 |
| 1.4 | `npm test` 分层 | **PASS** | `全部通过（6/6）`：Client 1/1、Contract 1/1、Core 3/3、Host 1/1 |
| 1.5 | 复杂度预算（Q7） | **PASS** | band-detector `Status: OK`（总 1447，预算 100/上限带 115） |

## 2. 沙箱安装与激活

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 2.1 | 零 `skipping profile bundle` | **PASS** | 启动日志无该行 |
| 2.2 | 零 `disabling profile plugin row` | **PASS** | 用 shipped 模板重建后无该行（此前手写 0.2.1-rc.5 pin 时刷 20+ 行） |
| 2.3 | 零 `entry did not activate` | **PASS** | 修复 `ctx.configEditor` 未 inject 读取后消失（此前必现） |
| 2.4 | 端口探活 + token 行 | **PASS** | `dsh web: http://127.0.0.1:3081/?token=…` |
| 2.5 | 客户端产物被宿主提供 | **PASS** | bundle URL 列表含 `dsh-recency-guard/client.js` |
| 2.6 | 分区数据面落盘 | **PASS** | `.recency-guard/partitions.json` + `projects/<key>/{journal,state,snapshot}.json` |

## 3. 路由层（数据面）

| # | 路由 | 结果 | 证据 |
|---|---|---|---|
| 3.1 | `GET /snapshot` | **PASS** | `200` len=4672，`projectKey=59ce36e13a01163b`，`stage=monitoring` |
| 3.2 | `GET /graph` | **PASS** | `200` len=8829 |
| 3.3 | `GET /isolation` | **PASS** | `200` len=909（修复前 500） |
| 3.4 | `GET /lifecycle` | **PASS** | `200` len=689（修复前 500） |
| 3.5 | `GET /archives` | **PASS** | `200` len=15 |
| 3.6 | `POST /action/recover` | **PASS** | `200` `{"disabled":[],"note":"已关闭最近更新的嫌疑插件…"}` |
| 3.7 | `POST /action/reenable` | **PASS** | `200` `{"bundle":"dsh-third-party","reenabled":true,"hasConfigBackup":false}` |
| 3.8 | `POST /action/archive` | **PASS** | `200` `count=5`，归档目录 `…/projects/59ce36e13a01163b/archive/2026-11-06T08-31-29-269Z/artifacts` |

## 4. 用户旅程（真实 GUI）

| # | 步骤/判据 | 结果 | 证据 |
|---|---|---|---|
| 4.1 | 「预览版说明」对话框需先关闭 | **PASS** | 未关闭时 `#root[inert]`，Playwright 报 `element is inert`；点「继续」后 root 解除 inert |
| 4.2 | 侧栏入口存在 | **PASS** | `button[aria-label="插件守护"]` in slot `sidebar.panellist` |
| 4.3 | 面板打开且 header 完整 | **PASS** | 文案含 `插件守护` / `崩溃恢复与可观测性 · sb-rg-c5 · dsh-recency-guard` / 工作区路径 |
| 4.4 | 生命周期区 | **PASS** | 6 阶段图 + `监控中` + `迁移次数 1` + `启动时未发现上次崩溃 09:04:30` |
| 4.5 | 量化指标区（含不可判定原因） | **PASS** | `崩溃率 0.0%`、`崩溃压力 0.00（半衰期 5 次启动）`、`崩溃检出率 不可判定/没有崩溃样本`、`CUSUM 变点 不可判定/至少需要两次崩溃才能检测密度变化` |
| 4.6 | 崩溃决策区 | **PASS** | `0 个插件处于关闭态` + `尚无崩溃决策记录`（空态有解释） |
| 4.7 | 能力清单 | **PASS** | `21 项`、`对外暴露 12`、`连通率 100%`、`连通分量 1 · 孤立 0`、注册/生产/消费表 |
| 4.8 | 缺口分析 | **PASS** | `没有发现能力缺口` |
| 4.9 | 嫌疑排名 | **PASS** | `共 0 个` + `当前没有嫌疑插件` |
| 4.10 | 项目隔离区 | **PASS** | 分区列表 + `数据面（快照/图谱/归档）始终由宿主按当前工作区返回` |
| 4.11 | 图谱可交互（滚轮缩放） | **PASS** | wheel 后 `scale 0.5245 → 0.6032`，transform 变化 |
| 4.12 | **铁律：轮询不重置缩放** | **PASS** | 7 秒（覆盖 ≥1 个轮询周期）内 transform **零变化**，`userZoomSurvivedPolling=true` |
| 4.13 | 控制台零错误（本次导航后） | **PASS** | `Total messages: 0 (Errors: 0, Warnings: 0)`；修复前有 `Unable to preventDefault inside passive event listener` |

## 5. 项目隔离（第二工作区实测）

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 5.1 | 两工作区得到不同分区键 | **PASS** | 3081 → `59ce36e13a01163b`（dsh-recency-guard）；3082 → `7958769b4a5ed675`（dsh-anic） |
| 5.2 | 分区目录互不混写 | **PASS** | `projects/` 下两个独立目录，`lastSeenAt` 各自独立 |
| 5.3 | `/isolation` 各自报告 current + others | **PASS** | 3081 的 `current=dsh-recency-guard`、`others=[dsh-anic…]`；3082 反之 |
| 5.4 | 显示不污染 | **PASS** | 面板 header 项目名/路径随宿主工作区变化，不串 |

## 6. 崩溃安全（对抗层）

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 6.1 | 守护行发射永远合法 YAML | **PASS** | 真实 js-yaml 解析 8 个真实包名（含 4 个 scoped）全部成功，`disabled` 表达式逐字往返一致 |
| 6.2 | 非法追加被拦下且文件字节不变 | **PASS** | `an invalid append is refused` + `the file is byte-identical after the refusal` |
| 6.3 | 重复行 id 拒绝 | **PASS** | `re-appending the same row id is refused` |
| 6.4 | pristine 备份 | **PASS** | `<profile>/.recency-guard/cordis.patch.yml.orig` = 追加前原文 |
| 6.5 | 真机桌面 profile 已修复且可解析 | **PASS** | 修复 3 行后 js-yaml `PARSED OK, rows=37`；当前 dry-run `校验通过` |
| 6.6 | 折行标量（第三方 dumper 重写）不再误判 | **PASS** | 桌面 patch 15:45 被重写为折行形态，校验由 FAIL→PASS；新增回归段 6 条断言 |
| 6.7 | 崩溃重演（杀进程→守护行拦截→重启） | **UNKNOWN** | 需要可崩溃插件与独占沙箱进程；本轮未构造。**不当作已验证**（见 verification.md §5.3） |

## 7. 证据链一致性

| # | 检查 | 结果 |
|---|---|---|
| 7.1 | 评估 16/16 维度通过 | **PASS** |
| 7.2 | 门禁 G0/G1/G2/G3 + 质量维度全 PASS | **PASS** |
| 7.3 | 任务清单 19 项全部「完成」 | **PASS** |
| 7.4 | 测试报告落盘 `.cycles/cycles/cycle-1/test-reports/` | **PASS** |
| 7.5 | 版本三锚点一致（package.json / README / api.md = 0.7.0） | **PASS** |

## 8. 结论

**可以交付**。唯一 UNKNOWN 是 6.7「真实崩溃重演」，已明确记录为已知缺口，不作为通过依据。

交付前置条件（必须由用户执行）：
**桌面端 dsh 需重启一次**，才会加载 v0.7.0 的 `dist/` 并生效。
桌面 profile 已核验：junction 指向本仓库、读到版本 `0.7.0`、`cordis.patch.yml` 校验通过。