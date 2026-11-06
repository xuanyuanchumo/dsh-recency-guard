# 沙箱用户旅程报告 —— cycle-4（v0.6.0）

## 1. 环境与红线

| 项 | 值 |
|---|---|
| 沙箱 profile | `sb-rg-5`（既有沙箱复用；绝不碰 desktop/web 主力 profile） |
| dsh 版本 | 0.2.1-rc.5 |
| 插件挂载 | `file:D:/Projects/TraeProjects/dsh-recency-guard`（junction 直连源码） |
| 端口 | 3081（主力 3181 之外的空闲高位端口） |
| 进程管理 | 全程 agent 自主启停（`Stop-Process` 核对 PID 后执行） |

## 2. 沙箱修复记录（真实踩坑）

1. **陈旧拷贝**：`node_modules/dsh-recency-guard` 是 11-05 的**真实目录拷贝**（v0.5.0），
   不是 junction——file: 依赖在 pnpm 某些路径下会落盘拷贝。修复：删除后
   `mklink /J` 建立指向源码仓库的 junction，改 dist 后重启即生效。
2. **bundle 层未选择**：插件以**依赖**身份安装，但 profile 的
   `dsh.profile.bundles` 只列了 dsh-base/dsh-web-app——bundle patch 层从不
   组合，插件静默不激活（无 skipping 警告、无错误，404 路由是唯一线索）。
   修复：把 `dsh-recency-guard` 加入 bundles 列表。
3. **DSH_PROFILE 环境继承**：本会话运行在 desktop profile 内，
   `DSH_PROFILE=desktop` 会让 `--profile sb-rg-5` 报
   「select a profile only once」。启动沙箱前必须清掉该环境变量。
4. **启动命令形态**：0.2.1-rc.5 的正确形态是
   `dsh --profile sb-rg-5 --port 3081 --no-open`（`web` 不是子命令参数）。

## 3. 旅程清单（全部通过）

| # | 旅程 | 验证方式 | 结果 |
|---|---|---|---|
| J1 | 插件加载不崩 | 启动日志无 recency-guard 错误栈、无 skipping | PASS |
| J2 | 快照 API（v0.6 crashPressure 字段在快照中） | GET /recency-guard/api/snapshot → 200，metrics.crashPressure.defined=true | PASS |
| J3 | 图谱 API | GET /graph → 200，16 节点 / 25 边 / 6 列 | PASS |
| J4 | 归档重置（动作面） | POST /action/archive → 200，manifest.summary（crashSeq/journalEvents）落盘 | PASS |
| J5 | 归档摘要消费（v0.6 T02） | GET /archives 返回 summary 字段 | PASS |
| J6 | 归档后重置语义 | 快照 stage=idle、事件清零、crashPressure 诚实「不可判定」 | PASS |
| J7 | 手动恢复动作 | POST /action/recover → 200（无嫌疑时空关闭，note 明确） | PASS |
| J8 | 多项目隔离 | partitions.json 双分区（项目目录 vs 临时目录）互不污染 | PASS |
| J9 | 客户端 bundle 组合 | combo 脚本 2.1MB 含 v0.6 三标记（crashPressure/neighborsUp/新 CSS 类） | PASS |
| J10 | 面板 GUI | 侧栏「插件守护」入口 → 面板渲染：KPI 六项（含崩溃压力 EWMA）、七卡片、16 图谱节点 | PASS |
| J11 | 隔离显示（v0.6 T03） | header 显示可读项目名 `dsh-recency-guard` + 完整路径 `d:/projects/traeprojects/dsh-recency-guard` | PASS |
| J12 | 图谱邻居导航（v0.6 T04） | 点击「安装更新日志」→ 侧栏「下游（消费方）：管理面板/配置备份与证据链/嫌疑排序」→ 点击邻居跳转聚焦成功 | PASS |
| J13 | 契约自检零缺口 | 快照 capability.gaps=0, connectivity=1 | PASS |

## 4. 证据截图

- 面板全景（KPI 条 + 生命周期 + 量化指标 + 事件流）：见会话内截图
  （KPI「崩溃压力（EWMA）」、header 项目名与完整路径、迁移历史均可见）。

## 5. 启动日志噪声（非本插件）

`schedule (@deepseek-ai/dsh-schedule): StorageError: unit 'schedule':
stored version 2 != expected 1` —— 沙箱 schedule 存储版本噪声，
与本插件无关（官方 dsh-schedule 的存储迁移问题），不影响任何旅程。
