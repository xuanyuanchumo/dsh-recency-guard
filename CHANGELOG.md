# Changelog

本项目的全部重要变更记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
此前版本（0.19.0 及更早）的叙述散落在 GitHub Release body 与
`docs/agents/design.md` 的各版本章节里；自 0.20.0 起统一收拢到本文件，
避免「三处版本叙述各说各话」。

## [Unreleased]

## [0.20.0] - 2026-11-14

本轮主题：**吸收参考插件精华补真实差距 + 发布链闭环**（cycle-18）。
取经来源：dsh-anic（重载三铁律）、dsh-compat-guardian（fsync 原子写 / CAS）、
dsh-ops（坏行容错 / 错误码词表）、dsh-context（seq 地板契约）。

### Added

- **热重载闭环**（取经 dsh-anic 三铁律）：新工具 action `reload` 与路由
  `POST /recency-guard/api/action/reload`。判据是「运行实例 revision ⇄ 当前
  dist revision」（不是 dist 是否比 src 旧）；三态 `scheduled / refused /
  unavailable` 诚实降级——headless 无 hmr 服务时返回 unavailable 且零写入。
  in-flight 握手先落盘再触发（跨实例状态机：重载后的新实例启动时把上一实例
  的请求补记为 reloaded，幂等）。史账有界 FIFO 50，损坏文件先备份 `.corrupt`
  再重建（静默销毁证据不允许）。
- **产物新鲜度判据升级**：apply 时记录本实例加载的 dist revision
  （内存 + 分区旁路文件双载体，TTL 24h），重载判据不再对 dist 重复确认。
- **journal 坏行计数（degraded 白盒）**（取经 dsh-ops fold.js）：解析层返回
  `malformed` 计数，面板诊断卡新增「事件日志完整性」行——三态严格区分
  `null`（旧宿主未报 = 未知）/ `0`（本次读取确认完整）/ `>0`（N 行读不出，
  行保留在盘上、轮转时自然愈合）。坏行不是消失，是计数。
- **seq 地板契约**（取经 dsh-context）：面板快照新增 `recentEventsFloor`——
  客户端由此如实表达「快照里第一条事件之前还有多少条被裁掉」。与省略计数
  互补：计数说「少了多少」，地板说「从哪开始」。数据流卡的 journal 环节
  显示地板数。
- **错误码 + 补救词表**（取经 dsh-ops bash-runtime-failure）：工具调用类错误
  升级为 `[RG_UNKNOWN_ACTION]` / `[RG_MISSING_BUNDLE]` 前缀 + 「补救：…」
  尾注——code 供模型/脚本按枚举分支，remedy 指名下一步。
- **图谱功能域维度**：能力节点携带 `domain`（observe/decide/recover/present/
  govern/tool，shared 契约层字段）；图例新增第四个正交开关「功能域」
  （chip 首字徽标 + 计数，计数取原始图不随过滤缩水）。
  `filterGraph` 支持 `hiddenDomains`。
- **防御修复**：`filterGraph` 的 `onlyConnectedWith` 收到运行时 `undefined`
  （JS 调用方/旧回放不受类型约束）时按 null（不过滤）归一，不再把 undefined
  当中心点取闭包导致整图静默滤空。

### Changed

- **原子写断电幸存三件**（取经 dsh-compat-guardian）：`writeFileAtomicSync`
  从「tmp + rename」升级为「`'wx'` 独占创建 + 循环写满 + `fsyncSync` + rename +
  0600 权限」。rename 原子性只保证名字换过去，不保证数据落盘——断电后
  rename 的目标可能是空文件；崩溃决策文件恰是断电后重启最需要完整的载荷。
  行为变更：故障点从 `writeFileSync`（EISDIR）挪到 `openSync('wx')`（EEXIST），
  相关测试断言已按新故障点更新（不变式不变：抛出的必须是原始错误码）。
- patch 三件套（patch / patch-yaml / patch-scalar）归位 `src/host/adapters/patch/`
  —— 它们就是 YAML↔patch-row 的外部格式适配器，adapter 层是语义归位而非
  迎合评估器（Q5「No adapter layer」的修复走的是真结构，不是应付）。
- 能力清单 24 → 25（新增 `guard.govern.reload`）；工具 action 8 → 9；
  路由 9 → 10；步骤名新增 `reload-self`（scheduled/refused 都留痕）。

### Fixed

- **Q5 循环依赖假阳性（根因修复）**：`patch.ts:143` 注释里的同形文本
  `` `from './patch.ts'` `` 被基于正则的 import 图工具当成 import 边构成自环。
  注释措辞改写消除假阳性；契约测试注释同步修正（此前的「basename 前缀匹配」
  归因是错的——判据自己也会骗人，归因必须来自实测）。
- **README 发布事实漂移**：npm shasum 更正为 registry 实况
  `ef564eb0…`（此前误抄本地 pack 的临时值）、发布日期更正为 2026-11-13、
  PR #14917 归属更正为 v0.18.1 描述更新。预防纪律：shasum/日期这类
  「发布后才存在的事实」一律以 registry 为源，不再手抄进 README。

### Security

- 原子写产物权限收紧到 0600（守护决策/指针文件含 profile 路径等本机信息）。

## [0.19.0] - 2026-11-13

cycle-17：命令窗口显示根修复（tool.call.toolview keyed slot 卡片 +
ANSI 序列级剥离）、产物新鲜度三态、失败退避阶梯、跨分区串扰双向竞态修复、
归档重置（manifest 先读后搬 + 不继承旧结论）、桌面热重载旅程。
详见 GitHub Release v0.19.0 与 `docs/agents/design.md` §21。

## [0.18.1] - 2026-11-12

描述修订版（无代码变更）；awesome-dsh-plugin 条目描述更新（PR #14917）。

## [0.18.0] - 2026-11-12

研究闭环落地 + 崩溃循环级联刹车兜底：刹车判据单源化
（`escalationExhausted`）、刹车豁免确定性证据、刹车回滚语义、
零依赖救援 CLI（bin/rescue.mjs + 宽度对拍）。

[Unreleased]: https://github.com/xuanyuanchumo/dsh-recency-guard/compare/v0.20.0...HEAD
[0.20.0]: https://github.com/xuanyuanchumo/dsh-recency-guard/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/xuanyuanchumo/dsh-recency-guard/compare/v0.18.1...v0.19.0
[0.18.1]: https://github.com/xuanyuanchumo/dsh-recency-guard/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/xuanyuanchumo/dsh-recency-guard/compare/v0.17.0...v0.18.0
