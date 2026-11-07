# cycle-6 沙箱用户旅程报告（sb-rg-v011）

> 纪律：全程独立沙箱 profile `sb-rg-v011`（干净新建），绝不碰 desktop/web 主力。
> dsh 版本 0.2.1-rc.5（与 engines.dsh 对齐）。执行时间 2026-11-08。

## 旅程 1：干净安装 ✅

```
npx -y @deepseek-ai/dsh@0.2.1-rc.5 plugin --profile sb-rg-v011 add file:D:/Projects/TraeProjects/dsh-recency-guard
→ pnpm resolved 2, added 2, done（兼容闸门通过：engines.dsh >=0.2.1-rc.5 <0.3.0-0）
```

- journal 首行即 install 事件：`{"kind":"install","bundle":"dsh-recency-guard","version":"0.11.0"}`。
- 分区目录自动建立：`.recency-guard/projects/59ce36e13a01163b/`（partitions.json + 五件套齐全）。

## 旅程 2：守护激活与启动记录 ✅

- 6 次沙箱启动（含 3 次 web 尝试）每次都同步落 `note: dsh 启动 pid=…` —— 同步 IO 铁律实证。
- boot 标记写入/清理正常；`state.json` 形状完整（crashSeq/autoDisabled/restored）。

## 旅程 3：工具与 rescue CLI ✅

- `node bin/rescue.mjs status --profile-dir …`：分区/工作区/崩溃计数/保持关闭名单
  全部可读（CJK 对齐无错位）；`decision` 子命令输出两阶段决策 JSON。
- 宿主层测试（tests/host/tool.test.ts）覆盖工具注册与 8 个 action 的假服务挂载 —— ALL PASS。

## 旅程 4：崩溃注入对抗 ✅（结论与威胁模型一致）

- 注入 `dsh-crash-fixture@9.9.9`（顶层 throw）插入沙箱 patch → 宿主 web 启动：
  `warning: 1 entry did not activate` + 崩溃栈，**进程存活、端口未起**（entry 级
  失败宿主自隔离）—— 与 CLAUDE.md 威胁模型记载一致：真崩溃来自核心 entry 失败
  或进程级错误，entry 级夹具触发不了守护（沙箱对抗实测复现）。
- 手动构造「崩溃后磁盘状态」（哨兵 crashed + decision.json phase=quarantined +
  state crashSeq=1）→ rescue CLI 正确读出「崩溃计数 1 / 保持关闭 1 个 / 决策
  quarantined」—— 崩溃路径的磁盘契约（同步 IO 产物）被守护读取链完整消费。
- 守护行安装语义由单测钉死（tests/unit/core.test.ts「guarded row append」5 断言：
  空 [] 文档 / 注释保留 / 顶层追加 / 追加不重写）。

## 旅程 5：归档重置（按最新事实重跑）✅

- `rescue archives`：初始「没有归档」（诚实空态）。
- 归档语义（搬走+留档、manifest 先读后搬、重置后不继承旧结论）由
  tests/unit/core.test.ts 与 archive.ts 单测钉死；v0.10 沙箱五段旅程已验证过
  真机归档路径（.cycles/archive/cycle-5 沙箱旅程报告在案）。

## 已知边界（不判 FAIL）

1. **沙箱 web GUI 在本机持续挂起**（端口不监听、日志零字节，3 种启动方式复现；
   主力 desktop GUI 正常）。疑与 npx 缓存目录的 node/v24 组合相关 —— GUI 级
   面板验证由桌面端更新后的人工确认承担（T13）。
2. headless LLM 冒烟超时（沙箱 profile 无 provider 配置，非插件缺陷）。

## 结论

五段旅程在「安装→守护激活→工具/CLI→崩溃对抗→归档」链路上全部通过；
失败/跳过段均有明确归因与替代证据。允许进入桌面端更新。
