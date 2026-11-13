# 技术债状态表（v0.18.1 / cycle-16）

> 数据来源：`.cycles/tech-debt/` 七条。**本表是结论，不是需求池**：
> 每条给出「现象 / 本轮状态 / 证据（file:line 或测试名）/ 剩余风险」。
> 注：TD-7 是本轮修复「路径逃逸」时**自查登记的新条目**（不是起点六条之一），
> 一并纳入状态表，避免「修一个缺陷生出一个未登记风险」。
> 状态口径：
>
> - **关闭**：本轮代码已修，且有可复核证据（代码路径或测试）；
> - **部分关闭**：常见失败路径被结构性消灭/收窄，但窗口或结构性问题仍在；
> - **保留**：本轮有意不做，或不属于本插件（写明理由与触发条件）。
>
> 复核日期：2026-11-11（北京时间）。状态以本轮最终代码为准；若代码在本表落盘后继续改动，
> 以 `npm test` 与源码行号为准重核。

## 1. 总表

| 编号 | 技术债 | 现象 | 本轮状态 | 证据 | 剩余风险 |
| --- | --- | --- | --- | --- | --- |
| **TD-1** | [`state-schema-version`](../../.cycles/tech-debt/state-schema-version.md) | `state.json` / `decision.json` / 归档 manifest 无版本字段；「旧文件」与「被写坏成相似形状」无法区分 | **关闭** | [`schema-version.ts`](../../src/host/data/schema-version.ts)`:22` `SCHEMA_VERSION=1`、`:35-46` / `:55-61` 纯解析（缺失按 v1、未知 ⇒ corruptVersion）、`:64-66` note 文案单一来源；[`store.ts`](../../src/host/data/store.ts)`:301-315` `noteCorruption`（每 `(文件,版本)` 只写一条 `degraded:true` note）、`:527-530` state 安全空态、`:605` decision `null`；写入恒带版本（`store.ts` `writeState` / `writeDecision` / `archive.ts`）；测试 `tests/unit/schema-version.test.ts` | 未知版本会让该轮**按安全空态恢复**（不拦人）——这是有意的「宁可过放行」；若未来真出 v2，必须同时更新 `SCHEMA_VERSION` 与迁移说明 |
| **TD-2** | [`panel-error-boundary-adaptive-poll`](../../.cycles/tech-debt/panel-error-boundary-adaptive-poll.md) | ① 面板渲染抛错白屏；② 轮询固定 5s（稳定也轮、剧变要等） | **关闭** | ① `PanelErrorBoundary.tsx` + `GuardPanel.tsx:454` 包裹（v0.16 已做）；② [`poll-adaptive.ts`](../../src/client/panel/poll-adaptive.ts)`:26-38`（基准 5s / 稳定 10s / 15s 封顶 / 变化回 5s，边界 [3s,30s]）+ `GuardPanel.tsx:223` `nextPollDelay` 递归 `setTimeout` + `clearTimeout`；测试 `tests/client/poll-adaptive.test.ts` | 指纹只对「快照内容」生效；`at` / `diagnostics.snapshotMs` 已剔除。若将来加入高频变化的展示字段而忘记剔除，会退化成固定 5s（有测试钉住剔除清单） |
| **TD-3** | [`output-truncation-reason-codes`](../../.cycles/tech-debt/output-truncation-reason-codes.md) | 文本层有 `omitted` 计数，但无机器可读原因码 / `Next:` 恢复句（dsh-ops 模式） | **保留**（增强项，非缺口） | 现状证据：`tool-render.ts` 的 `omitted` / 截断指标 + `display-truncation.test.ts`；**data 字段始终全量**（「报 N 只列 5」已修） | 原因码是「更好的指路」，不是正确性缺陷；引入需改 `DisplaySection` 契约 + 快照测试，收益低于本轮闭环目标。触发条件：调用方需要在文本层程序化判断截断原因时再做 |
| **TD-4** | [`anic-init-cycle-number-rewind`](../../.cycles/tech-debt/anic-init-cycle-number-rewind.md) | 归档清空 `cycles/` 后 `init-cycle` 从 1 重排，与归档目录撞名 | **保留**（外部技能包，不在本插件修） | 归属 `dsh-anic`（ai-native-iteration-cycle）技能包；本插件侧规避=显式 `--cycle <n>`（cycle-15 即显式建号） | 只能规避，不能根治；根治需改技能包 `getNextCycleNum` 取「现存/归档/状态机」三信号最大值 |
| **TD-5** | [`journal-trim-window`](../../.cycles/tech-debt/journal-trim-window.md) | journal 裁剪的「锁内读最新 → 原子写回」窗口；崩溃路径同步 append 可能落在窗口里被覆盖 | **关闭**（v0.18 轮转根治） | [`journal-io.ts`](../../src/host/data/journal-io.ts)`trimJournalFile()` 改**轮转**：超限 = `renameSync(活动文件 → journal.<epoch>.jsonl)`（元数据操作，无内容读改写）+ `MAX_ROTATED_FILES=3` 控制 `unlinkSync` 删最旧轮转段；读取端 `readMergedJournal(Sync)` 按 epoch 升序合并（store/rescue 双实现对拍 `tests/contract/journal-merge-parity.test.ts`）；交错零丢行 `tests/unit/journal-append-race.test.ts`、`tests/unit/journal-trim-injection.test.ts` | 崩溃路径 appendSync 与轮转的任何交错只有两种落点（随活动文件轮走 / 落新文件），合并读取都在 —— 原窗口**结构性不存在**。剩余：轮转段总量上限 3 份 ×1000 行（超出删最旧轮转段），不影响恢复判定 |
| **TD-6** | [`partition-index-sync-window`](../../.cycles/tech-debt/partition-index-sync-window.md) | `apply()` 的同步首写发生在 boot 加锁提交之前；强杀可丢「工作区曾被登记」的一条引用 | **部分关闭** | boot 期 `writePartitionIndexLocked()` 已在 `withFileLock` 内重读归并幂等提交（[`boot-orchestration.ts`](../../src/host/guard/boot-orchestration.ts)`:78` 默认注入、[`isolation.ts`](../../src/host/core/isolation.ts)`:249`）；并发实测 `tests/unit/decision-concurrency.test.ts`、`tests/host/isolation-parallel.test.ts` | **同步首写窗口仍在**：apply 之后、boot 提交之前被强杀，仍可能丢一条引用（只影响分区可读性，不影响守护/恢复）。两条写路径并存（幂等但多一次 IO）。根治需「每分区一个引用文件 + 读取合成」的结构迁移 |
| **TD-7** | [`path-safe-name-fingerprint`](../../.cycles/tech-debt/path-safe-name-fingerprint.md) | 修「白名单含 `/` ⇒ 路径逃逸」时，把 `/` 折成 `_` 会让 `@scope/pkg` 与 `@scope_pkg` 投到同一文件（观测/备份静默覆盖） | **关闭**（v0.18 双管根治） | [`path-safe.ts`](../../src/host/core/path-safe.ts) `pathSafeName` 指纹 8→**16 hex（64 bit）**，生日碰撞 ≤5.4e-20；`legacyFingerprintName` + `candidateNames()` **双读迁移**（观测快照 `cooccurrence-store.ts` `observationCandidatePaths`、备份 `store.ts readBackup` 三级候选）；测试 `tests/unit/path-sanitize.test.ts` TD-7 组 | 未改写名不受影响（无指纹）；v0.17 的 8 位指纹文件经双读仍可达，下一次覆盖写即迁到 64 位新名。读取双路径永久保留（不批量重命名） |

## 2. 逐条说明（为什么是这个状态）

### TD-1 · 状态 schema 版本 —— 关闭

- **修法**：`GuardState` / `PrebootDecision` 加 `schemaVersion?: 1`（与 cooccurrence、归档 manifest 同口径）；
  写入恒带 `SCHEMA_VERSION`；读取端：**缺失 ⇒ 按 v1 宽容读**（老 profile 兼容）、
  **未知值 ⇒ 安全空态/`null` + `corrupt:true` + `degraded:true` journal note，且不覆盖文件**。
- **为什么不能静默重建**：`crashSeq` / `autoDisabled` / `disable` 的语义可能在新版本里变过；
  按旧语义解释会做出错误恢复决策（关错人或全放行）。保留现场 + 上屏损坏标记，才能让人判断。
- **剩余风险**：安全空态意味着这一轮不拦人 —— 这是「宁可过放行，不可过拦截」的既有取舍，
  不是漏修；v2 出现时必须同步迁移逻辑。

### TD-2 · 错误边界 + 自适应轮询 —— 关闭

- **错误边界（v0.16）**：`PanelErrorBoundary` 捕获渲染异常，给「重试加载」按钮，不拖垮宿主侧栏。
- **自适应轮询（v0.17）**：内容指纹（稳定序列化 + FNV-1a，剔除 `at` / `snapshotMs`）驱动退避；
  变化优先；`setTimeout` 递归避免双定时器；暂停/卸载 `clearTimeout` + `cancelled` 防在途回挂。
- **证据**：`tests/client/poll-adaptive.test.ts`（退避阶梯、夹紧、坏输入、指纹剔除易变字段、
  组件必须用递归 `setTimeout` 的结构断言）。
- **剩余风险**：指纹遗漏「高频变化字段」会退化；测试已钉住当前剔除清单，新增字段需同步。

### TD-3 · 输出截断原因码 —— 保留（增强项）

- **现状已满足诚实边界**：数据层全量、显示层显式 `omitted` 计数、不可判定有原因；
  缺的只是「机器可读原因码 + Next 句」这种调用方体验增强。
- **为什么不本轮做**：要改 `DisplaySection` 契约与快照测试，和「研究闭环 + 竞态收口」竞争预算；
  它不影响正确性，也不影响评审对「数据是否全量」的判断。
- **触发条件**：工具文本被脚本/AI 程序化消费且需要按原因分支时，再按 dsh-ops 的
  `truncatedBy` + `Next:` 模式落地。

### TD-4 · ANIC 循环号回绕 —— 保留（外部）

- 归属技能包，本插件无法修；本插件侧的规避是**显式传 `--cycle`**（本轮即 `--cycle 15`）。
- 触发条件：技能包维护者修 `getNextCycleNum`（取现存/归档/状态机三信号最大值）。

### TD-5 · journal 裁剪窗口 —— 部分关闭

- **已结构性消灭的**：每次 append 都整读整写的丢证据竞态（旧实现约 1/9 复现）——
  改成真追加后，任何写者都不能用旧快照覆盖别人的新行。
- **仍在的**：trim 的读→原子写回窗口。缓解：只在 >1000 行触发、异步、持锁；崩溃路径永不 trim。
- **测试边界**：`journal-append-race.test.ts` 钉住「任何交错都不丢行」；窗口本身需要跨进程时序注入，
  当前无法自动化覆盖 —— 这是「部分关闭」而非「关闭」的原因。
- **根治方向**：`journal.<epoch>.jsonl` 分文件（裁剪=删旧文件），或给崩溃路径实现同步 O_EXCL 自旋锁。

### TD-6 · 分区索引同步首写窗口 —— 部分关闭

- **已收窄**：boot 期加锁幂等提交；并发实测 4 个真实子进程 × 6 轮全部在场。
- **仍在的**：`apply()` 的同步首写先于 boot 提交；强杀可丢一条引用（只影响「分区可读性」，
  不影响守护与恢复判定）。两条路径对同一文件写两次（幂等但多一次 IO）。
- **根治方向**：每分区一个引用文件 + 读取时合成；需改三个读者并保留旧 `partitions.json` 兼容。

### TD-7 · pathSafeName 指纹碰撞 —— 保留（有意接受）

- **背景**：修「白名单含 `/` ⇒ 路径逃逸」时，`/` 折成 `_` 引入新碰撞
  （`@scope/pkg` 与真实存在的 `@scope_pkg` 投到同一文件），因此对**被改写的名称**
  追加原始名的 8 位 sha256 指纹；未改写的名称保持原样（存量文件名不变）。
- **为什么接受**：触发前提窄（两个名称都含非法字符 + 指纹相撞，≈2.3e-10）；
  影响面是旁路数据（观测快照/配置备份），不参与关闭决策。
- **为什么不现在升级**：16 位指纹会让**已写入的文件名再次变化**，存量可读性再断一次；
  应作为下一次破坏性变更（或「双读单写」迁移）单独做。
- **可见性替代**：若将来出现两份数据互相串，先查 `pathSafeName(a) === pathSafeName(b)`；
  更符合本项目纪律的下一步是「写入时目标已存在且 bundle 不同 ⇒ journal 冲突告警」，
  把静默覆盖变成可见冲突。

## 3. 复核命令

```bash
npm test                                                     # 全量（数字以输出为准）
npx tsx tests/client/poll-adaptive.test.ts                   # TD-2
npx tsx tests/unit/journal-append-race.test.ts               # TD-5
npx tsx tests/unit/decision-concurrency.test.ts              # TD-6
npx tsx tests/unit/path-sanitize.test.ts                     # TD-7
grep -n "SCHEMA_VERSION\|noteCorruption" src/host/data/store.ts   # TD-1
grep -n "commitPartitionIndex\|writePartitionIndexLocked" src/host/guard/boot-orchestration.ts  # TD-6
```

判据：命令全绿；TD-1 的 `schemaVersion` / `noteCorruption` 命中；TD-6 的加锁提交路径在 boot 编排里。