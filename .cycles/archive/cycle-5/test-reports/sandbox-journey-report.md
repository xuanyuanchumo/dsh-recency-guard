# 沙箱用户旅程报告（cycle-5 · v0.10.0 · sb-rg-c5）

> 沙箱纪律：独立 profile sb-rg-c5（link 挂载本仓库），主力 desktop/web 未被触碰。
> 宿主版本 0.2.1-rc.5；启动命令 `npx -y @deepseek-ai/dsh@0.2.1-rc.5 --profile sb-rg-c5 --port 3155 --no-open`。

## 旅程 1：GUI 全卡片渲染（正向）

带 token 打开 `http://127.0.0.1:3155/?token=…` → 侧栏「插件守护」：

| 检查项 | 结果 |
|---|---|
| 12 张卡片全部渲染（lifecycle/metrics/backup-policy/decisions/capabilities/risks/partitions/events/**markov**/**dataflow**/**diagnostics**/archives） | ✅ |
| 转移矩阵卡 6 行（六阶段）+ 平稳分布芯片 | ✅ |
| 数据流卡 4 环（journal→投影→语义流动→渲染）带计数 ∞/24/39/39 | ✅ |
| 系统诊断卡：插件版本 0.10.0 / 宿主 0.2.1-rc.5 / win32·node v24.14.0 / 分区键 59ce36e1… / 仓库链接 | ✅ |
| 「问题反馈」按钮 → https://github.com/xuanyuanchumo/dsh-recency-guard/issues | ✅ |
| 能力图谱 21 节点 41 边，点击选中 → 详情卡弹出 | ✅ |
| i18n 键同步（zh/en 218 键一致；修复 dataflow.renderDetail 缺键） | ✅ |

## 旅程 2：崩溃 → 拦截 → 恢复（核心正向链路）

| 步骤 | 事实（journal/state/decision 证据） |
|---|---|
| 注入夹具 dsh-crash-test@1.0.0（setTimeout 未捕获异常） | journal: `已安装守护行：dsh-crash-test` + install 事件 |
| 第 1 次启动 → 1.5s 后崩溃 | `dsh: fatal uncaught exception: crash-test` → 端口无人监听 |
| 崩溃检出与决策（崩溃退出那一刻同步落盘） | journal: `恢复判定：唯一嫌疑 dsh-crash-test：确定性证据，第 1 轮即行动` + `crash-detected 退出码 1`；decision.json phase=quarantined，disable=[dsh-crash-test]；state.crashSeq=1 |
| 第 2 次启动 → 预启动拦截生效 | 守护行 disabled 表达式（指针文件→决策→名单命中）⇒ 夹具未加载；宿主正常起来（3155 LISTENING） |
| 快照反映隔离态 | autoDisabled=[dsh-crash-test(1)]，stage 正常 |

## 旅程 3：重新启用（反向）

POST `/recency-guard/api/action/reenable` {bundle: dsh-crash-test} →
`{"reenabled":true}` → journal `enable` 事件 → autoDisabled=0。（注：动作路由在
`/api/action/*` 前缀下；第一次打 `/api/reenable` 得 405 是路径用错，不是缺陷。）

## 旅程 4：归档重置（R15）

POST `/recency-guard/api/action/archive` reason="journey: cycle-5 sandbox verification archive" →
`{ok:true, count:7, manifest.summary:{crashSeq:1, journalEvents:49}}`；
归档后快照 autoDisabled=0、事件仅剩 2 条 —— **重置后不继承旧结论** ✅；
rescue archives 读到 manifest 摘要（崩溃 1 次 · 事件 49 条 · 原因留档）✅。

## 旅程 5：命令窗口显示（R10 真机）

- `rescue status`：中文键值对齐（崩溃计数/上次运行/保持关闭同列起）
- `rescue history`：kind 列固定宽，中文 subject 不挤歪时间列
- `rescue archives`：归档摘要表格式输出

## 负向/边界观察

- 宿主 skip 警告：初次挂载夹具缺 `dsh.bundle` 声明被跳过（`skipping profile bundle`）——
  守护自身未受影响（0 崩溃误报），日志可读，符合「跳过 ≠ 崩溃」的语义分层。
- schedule 单元版本警告（stored version 2 != expected 1）为宿主侧既有现象，与本插件无关。
- pnpm 对 `file:` 依赖做拷贝而非链接：夹具更新 manifest 后需手动同步 —— 旅程夹具
  的操作问题，与本插件无关。

## 结论

五段旅程全部通过；v0.10.0 允许更新到桌面端 dsh。
