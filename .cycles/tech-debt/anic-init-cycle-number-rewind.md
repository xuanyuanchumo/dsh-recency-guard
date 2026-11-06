# 技术债：ANIC 技能 init-cycle 循环号回绕

## 元信息

| 字段 | 值 |
|---|---|
| 登记时间 | 2026-11-06 |
| 登记循环 | cycle-4（dsh-recency-guard） |
| 严重度 | P2（不阻塞功能，但会撞名混淆审计） |
| 归属 | `dsh-anic` 技能包（ai-native-iteration-cycle）——**非本插件代码**，不在本插件修复 |

## 现象

归档清空 `.cycles/cycles/` 后（`archive-cycle` 把已完成的循环目录搬进
`.cycles/archive/`），再运行 `init-cycle` 时循环号**从 1 重新开始**：
脚本用「现存目录的最大号 + 1」推算下一个循环号
（`scripts/init-cycle.mjs:23-30` 的 `getNextCycleNum`），目录空了就返回 1。

## 实测影响（cycle-4 开工时真实踩到）

1. 归档 cycle-1..3 后运行 `init-cycle`，得到 `cycle-1`——与已归档的
   `.cycles/archive/cycle-1` 撞名，产物目录语义混乱（「新 cycle-1」vs「归档 cycle-1」）。
2. `syncWorkflowState` 的防回拉分支（只前移不回拉）正确拒绝了状态机回退
   （`currentCycle` 仍是 cycle-3），所以状态没坏——但目录已建、模板已铺，
   产生了「目录说 cycle-1、状态说 cycle-3」的裂缝，需要人工清理后
   `--cycle 4` 显式重建。

## 根因

`getNextCycleNum` 只看**现存**目录，不看**归档**目录，也不参考
`workflow-state.json` 的 `currentCycle`。三个信号（现存目录、归档目录、
状态机）中它只用了最弱的一个。

## 建议修法（技能侧）

`getNextCycleNum` 改为取三个信号的最大值：
1. 现存目录号最大值 + 1；
2. `.cycles/archive/cycle-{N}` 解析出的最大 N + 1；
3. `workflow-state.json` 的 `currentCycle` 数值 + 1（若可解析）。

## 本插件侧的规避（已执行）

本轮用 `--cycle 4` 显式建号绕过；今后归档后开新循环一律显式传
`--cycle <archive 最大号 + 1>`。
