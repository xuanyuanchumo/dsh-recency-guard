# 技术债 TD-5：journal 裁剪窗口（append-only 之后的唯一残余）

| 字段 | 值 |
|---|---|
| 登记时间 | 2026-11-11 |
| 登记循环 | cycle-14（T14-08） |
| 严重度 | P3（罕见、只影响最旧 1 条证据，不影响恢复判定） |
| 归属 | `src/host/data/store.ts` 的 `trimJournalIfNeeded()` |
| 状态 | 已收窄，未根治 |

## 背景：旧实现是「每次写都处于丢证据窗口」

旧 `append()` 是「整读 → 追加 → 原子整写」。它与崩溃路径的同步 `appendSync()`
构成真实竞态（cycle-14 故障注入实测复现，约 1/9）：

1. 启动期 `recordChanges()` 的异步 append 读到一份**不含崩溃事件**的旧快照；
2. 进程崩溃，退出处理器同步写入 `crash-detected`；
3. 那个挂起的异步整写最后落地，把 journal **覆盖回旧快照** ⇒
   `crash-detected.suspects` 消失，而 decision/state 还在 —— 「关了谁」对、
   「为什么关」丢了。

## 本轮修法（结构替换，不是加锁）

`append` / `appendSync` 改为 `appendFile` **真追加**（O(1)、无整文件替换）。
任何写者都不可能再用旧快照覆盖别人的新行 ⇒ 丢证据的常见路径被**结构性消灭**。

行数上限（`JOURNAL_MAX_LINES = 1000`）改由 `trimJournalIfNeeded()` 在
异步路径、**持 `withFileLock`** 执行，且只在真的超过上限时触发。

## 残余缺陷（诚实登记）

`trimJournalIfNeeded()` 的「锁内读最新 → 原子写回」本身仍有一个窗口：
若崩溃路径的同步 append（**不持锁**）恰好落在读与写回之间，那一行会被
裁剪覆盖掉。

- **频率**：只有文件超过 1000 行才触发 ⇒ 每 ~1000 条事件一次，而不是旧实现
  的**每条**都处在窗口里；
- **影响面**：只可能丢最旧的极少条；`crashSeq`/`autoDisabled` 的恢复判定
  不依赖 journal（它们走 state + decision），所以不会回到崩溃循环；
- **不可用索引修**：这会破坏 append-only 的顺序语义与 `journal.jsonl` 的
  可读性（人排障时直接 `cat` 它）。

## 下一轮候选修法

1. **按大小分文件**（`journal.<epoch>.jsonl`，读取时按序合并）⇒ 裁剪 = 删旧文件，
   彻底没有「读改写」；
2. 或给崩溃路径也提供一个**同步文件锁**（当前 `withFileLock` 是 async，
   而 exit 处理器只有同步能完成 —— 需要自己实现 O_EXCL 自旋，风险高）；
3. 保留现有形态并在 `trim` 时先 `append` 一条「trim 开始/结束」标记，
   让丢失可被发现（比静默好，但仍会丢）。

## 复现方式

`tests/unit/journal-append-race.test.ts` 钉住新的「任何交错都不丢行」不变式；
裁剪窗口本身**未被自动化覆盖**（它需要跨进程时序注入），因此本条目保留。