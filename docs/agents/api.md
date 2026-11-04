# 对外面 API（dsh-recency-guard v0.4）

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
| `status` | — | 崩溃状态、嫌疑排名（top10）、实验性名单、量化指标 |
| `history` | `limit?=40` | 安装/更新/崩溃/恢复事件时间线 |
| `recover` | — | 立即按最近更新执行一次恢复关闭（crashSeq=1） |
| `restore` | — | 重新启用非嫌疑插件，首要嫌疑保持关闭 |
| `reenable` | `bundle` | 手动重新启用某个插件 |
| `backups` | — | 配置备份清单 |
| `archive` | `reason?` | **v0.4 新增**：归档产物并重置（按最新事实重新自举） |
| `archives` | — | **v0.4 新增**：历史归档清单 |

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
metrics                      crashRate / meanRecoveryTime / detectionRate
                             / isolationPurity / intervals / changePoint
                             （全部 Metric<T>：null = 不可判定，带 reason）
risks[]                      嫌疑排名（bundle/risk/label/experimental）
capability                   total/exposed/connected/connectivity/gaps[]/byStage
graphConnectivity            components/largest/isolated
partitions[]                 项目分区（key/label/workspace/lastSeenAt）
autoDisabled[] / restored[]  关闭与恢复名单
recentEvents[]               **v0.4 新增**：journal 尾部 24 条（事件流卡片数据源）
```

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
