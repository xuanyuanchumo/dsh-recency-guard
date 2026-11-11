# 技术债：状态文件 schemaVersion

- 登记时间：2026-11-08（cycle-6）
- 来源：参考插件研究（dsh-compat-guardian `lib/index.js:410` 状态文件带
  schemaVersion，非法格式报错而非静默重建）
- 现状：`state.json` / `decision.json` / 归档 manifest 无版本字段；
  读取端用 `{...emptyState(), ...parsed}` 宽容合并 —— 字段演进安全，
  但「文件被外力写坏成相似形状」无法与「旧版本文件」区分。
- 建议：GuardState 增加 `v?: 1`；读取端对不认识的 `v` 报错进 journal
  （不静默重建，保留现场）；归档 manifest 同理。
- 影响面：store.ts / archive.ts / 读取兼容测试。
- 优先级：P2（下一次破坏性字段演进时顺手做）。

---

## 收口记录（cycle-15 / v0.17.0，状态：**关闭**）

### 做了什么
1. **字段选型**：统一用 `schemaVersion: 1`（不是更短的 `v`）—— 与
   `cooccurrence-store.ts`、归档 manifest 同一字段名；三个数据文件一个口径，
   代价是每次崩溃多写 17 字节。
2. **写端**：`writeState` / `writeStateSync` / `markCrashedSync` /
   `writeDecisionSync` / `updateDecisionLocked` / `resetArtifacts` 全部盖章。
3. **读端**（`src/host/data/schema-version.ts` 纯判据）：
   - `=1` ⇒ 正常；
   - **缺失** ⇒ 按 v1 宽容读（v0.16 及更早文件没有该字段，老 profile 必须能读）；
   - **未知** ⇒ 安全空态 + `corrupt:true` + **不覆盖文件** + journal
     `degraded:true` note（同文件同版本每进程只报一条，避免快照轮询刷屏）。
4. **可见面**：`Store.corruptionReport()` → status 输出 `corrupt` 与
   `PanelSnapshot.corrupt`，避免「未知版本 ⇒ 空态」被误读成干净启动。
5. **归档 manifest**：`readArchiveManifest` 未知版本返回 `null`；
   `listArchives` 回调留痕（`Guard.archives` 写 degraded note）。
6. **判据隔离**：`corrupt` **不参与任何关闭决策**，由
   `tests/unit/preventive-wiring.test.ts` 的 `[no-corrupt] …` 源码扫描 +
   `crash decision carries no corrupt field` 钉死。

### 证据
- `tests/unit/schema-version.test.ts`：v=1 / 无 v / v=999 三条 +
  「未知版本文件读后**逐字节不变**」（state 与 decision 各一条）+ 幂等去重 +
  manifest 同族 + 直接驱动纯判据。
- `npx tsc --noEmit` 0 行；`tests/run.ts` 全绿。

### 剩余风险（诚实登记）
- **未知版本的留痕只在首次读**：同一文件+版本每进程一条；跨进程重启会再记
  一条（有意：每次启动都该看到）。
- `corrupt` 只上屏、不做恢复分支 —— 这是有意的（见上「判据隔离」）；
  若将来要让「数据损坏」影响恢复，必须是一次显式的策略变更并补回归锁。
- 旧版本（无 `schemaVersion`）与「被外力删掉该字段的新文件」不可区分 ——
  这是宽容读的固有代价，接受的理由是「老 profile 必须能读」优先于
  「能识别这种特定篡改」。
