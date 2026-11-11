# 技术债 TD-6：分区索引的同步首写窗口（TD-4 残差）

| 字段 | 值 |
|---|---|
| 登记时间 | 2026-11-11 |
| 登记循环 | cycle-14（T14-05） |
| 严重度 | P3（只影响「分区可读性」，不影响守护与恢复判定） |
| 归属 | `src/host/core/isolation.ts` 的 `writePartitionIndex()` / `writePartitionIndexLocked()` |
| 状态 | 已收窄（boot 期加锁幂等提交），同步首写窗口仍在 |

## 现场

`apply()` 是**同步**函数（Cordis 对 `apply` 的返回不强制等待），所以它内部的
分区登记只能走同步的 `writePartitionIndex()`：

- 第 1 层：`writeFileAtomicSync`（临时文件 + rename）⇒ 读者不会读到 0 字节；
- 第 2 层：写入前与**落盘最新索引按 key 求并集** ⇒ 把丢失窗口从「整个
  read-modify-write 周期」压缩到「最后一次读 → rename」的极短区间。

跨进程实测（isolation-parallel）：4 个子进程并发登记时，条目数曾出现
4/4、3/4、2/4 —— 第 2 层把丢条目的概率显著降低，但没有消除。

## 本轮修法（T14-05）

`bootInner()` 阶段已经有 `await`，于是新增 `writePartitionIndexLocked()`：
在 `withFileLock` 内**重读最新索引 → 归并 → 原子写回**，把这一段真正串行化。
由于归并是幂等的（同 key 覆盖、新 key 追加），重复提交不放大任何事实。

实测：`tests/unit/decision-concurrency.test.ts` 用 4 个真实子进程 × 6 轮
并发登记 ⇒ 4/4 分区全部在场、索引 JSON 始终可解析。

## 残余缺陷（诚实登记）

1. **同步首写仍在**：`apply()` 里的那一写发生在 boot 的加锁提交**之前**；
   若进程在 apply 之后、boot 提交之前被强杀，且恰好踩中「读最新 → rename」
   窗口，仍可能丢一条（只丢「这个工作区曾被登记」这一条引用）。
2. **两条路径并存**：同步版与加锁版对同一文件写两次（幂等，但增加一次 IO）。
3. 真正根治需要结构变化：**每分区一个引用文件 + 读取时合成**（无共享
   read-modify-write 结构），这也是 TD-4 最初建议的方向。

## 为什么不现在做

「每分区一个引用文件」要改三处读者（`readPartitionIndex`、
`partition-snapshot.ts`、rescue CLI 的 `pickPartition`），并且要保留
`partitions.json` 的向后兼容读取（老 profile 里已有该文件）。
这是一次独立的结构迁移，塞进 v0.16.0 会与 panel/docs 的并行改动冲突。

## 判据（真做时的验收）

- 跨进程并发登记 N 个工作区 ⇒ 读回 N 条（不是 N-1）；
- 老 profile（只有 `partitions.json`）仍能读出全部分区；
- `npx tsx tests/host/isolation-parallel.test.ts` 与
  `tests/unit/decision-concurrency.test.ts` 双绿。