# 事故记录：宿主升级 0.2.2-rc.1 后插件被移除 + 启动致命（2026-11-08）

## 1. 摘要

| 字段 | 值 |
|---|---|
| 事故编号 | INC-2026-11-08-01 |
| 严重度 | P0（DSH 宿主连续崩溃、守护失效） |
| 发现时间 | 2026-11-08T00:13Z（北京 08:13） |
| 修复发布 | v0.11.1（02:0xZ）与 v0.11.2（03:3xZ） |
| 影响范围 | 桌面端 desktop profile；插件 crasSeq 5；3 分钟内 5 次退出码 1 |
| 逃逸度量 | 从首个崩溃到修复发布 ≈ 2 小时（含根因定位与沙箱验证） |

## 2. 时间线（UTC）

1. 08:12 用户在桌面端执行一次插件安装（providers-hub 源码重建，pnpm prepare）。
2. 08:13:50 宿主首次崩溃（exit 1）；守护写入 `crash-detected`、观察轮判定
   `dsh-codegraph-visualizer 复现 1/2 轮`。
3. 08:14-08:16 再崩 4 次（共 5 次）；守护每轮都停在「观察中 1/2 轮」，
   不关闭任何插件。
4. 08:20 宿主重启后**本插件未被加载**：`dsh.profile.bundles` 中已无
   `dsh-recency-guard`（14 个 bundle）。
5. 11:12（03:12Z）人工把插件补回后，本插件启动即致命：
   `dsh: fatal load failure: Error: atomic-write: timed out waiting for the
   writer lock at ...state.json.lock`。
6. 11:22（03:22Z）修复代码（boot 不抛 + 锁自愈）后插件启动成功、写入 24 条守护行；
   稳定后自动恢复把 codegraph 又打开了（HMR 嵌套事务导致恢复实际失败却记录成功）。
7. 11:32 重新禁用 codegraph；11:33 发布 v0.11.2（恢复诚实化 + 延迟恢复）。

## 3. 根因（四条，互相独立）

1. **预发布版本 semver 陷阱（主因）**：宿主运行时升级到 `0.2.2-rc.1`，
   而 `engines.dsh` / peer 范围是 `>=0.2.1-rc.5 <0.3.0-0`。node-semver 只放行
   「与范围中某比较符 major.minor.patch 元组相同且自身带预发布标签」的预发布
   版本 —— `0.2.2-rc.1` 不在任何比较符的元组上，被**静默排除**。兼容闸门因此
   判定插件不兼容，从 profile bundles 移除 → 守护消失 → 崩溃循环失去保护。
2. **崩溃遗留的 0 字节写锁**：08:13 的崩溃恰好发生在锁文件创建（`wx`）与写入
   PID 之间，留下空的 `state.json.lock`。atomic-write 的接管要求锁内**有可读
   PID 且进程已死**；记录不完整的锁会被一直等待，超时抛错。
3. **boot 把可恢复错误变成致命**：`Guard.boot()` 捕获后 **rethrow**；异常冒到
   Loader 成为 `dsh: fatal load failure`，宿主退出码 1 —— 观测设施拖垮了主流程。
4. **连续计数被打断 + 恢复谎报**：启动时写的 `crash-detected`（无 suspects）
   被历史读取当作决策记录，打断连续计数（crashSeq 涨到 3 仍 1/2 轮）；
   `reenable` 无条件返回成功，管理器 `application: 'failed'` 时仍记「已恢复」。

## 4. 修复（v0.11.1 / v0.11.2）

| # | 修复 | 版本 | 证据 |
|---|---|---|---|
| 1 | engines/peer 显式多分支范围（覆盖 0.2.2-rc / 0.2.3-rc） | 0.11.1 | 契约测试守卫 + 沙箱 sb-rg-v0111（dsh 0.2.2-rc.1）安装/启动通过 |
| 2 | `cleanStaleLocks`（空/非 PID/死 PID 且 >5s）+ init 清理 + updateState 超时清理重试 | 0.11.1 | tests/unit/store-lock.test.ts（11 断言） |
| 3 | `Guard.boot()` 失败只降级留痕、绝不外抛 | 0.11.1 | 真机 03:22 boot 成功（journal 有启动与守护行记录） |
| 4 | 历史跳过无嫌疑启动记录 + `crashSeq ≥ 3` 兜底升级 | 0.11.1 | tests/unit/recovery-policy.test.ts（+4 断言） |
| 5 | `reenable` 只有 applied 才算成功；失败保留名单待重试 | 0.11.2 | tests/host/tool.test.ts（管理器拒绝 ⇒ 报失败） |
| 6 | boot 期自动恢复延后 1.5s（避开 HMR 嵌套事务，timer unref） | 0.11.2 | 真机 journal 复现错误后修复；14/14 全绿 |

## 5. 验证

- 干净沙箱 `sb-rg-v0111`（dsh 0.2.2-rc.1）：`plugin add file:` 成功 →
  启动 → journal 记录 `dsh 启动` + `install 0.11.1`，无 `skipping/incompatible`。
- 真机：修复后 boot 成功、写入 24 条守护行；10:48Z 之后**无新崩溃日志**。
- 14/14 分层测试全绿；build/typecheck/lint 零错误。
- 桌面端 profile：bundles 含本插件（23 个）、`node_modules` link 正常、
  codegraph 以 `disabled: true` 单行持久禁用（无重复 id）。

## 6. 预防（已编码化）

- `docs/agents/conventions.md` §3.2：预发布范围必须显式分支、boot 绝不外抛、
  写锁卫生、连续计数不得被启动记录打断、恢复结果必须 white-box 诚实。
- 契约测试守卫每个 `@deepseek-ai/dsh-*` peer 含 `>=0.2.2-rc.1` 分支。
- `docs/agents/update-guide.md` §3.1：紧急修复流程（读 crash 日志 → 核版本 →
  止血 → 修代码 → 同版本沙箱验证 → patch 发布）。
- 市场投稿注意：仓库创建 2026-11-07T07:44Z，contributing 要求满 1 天，
  最早可投稿时间 **2026-11-08T07:44Z（北京 15:44）** 之后。