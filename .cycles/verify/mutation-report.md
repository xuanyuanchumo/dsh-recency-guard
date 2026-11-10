# 变异测试报告（M4 / RQ4）
**生成时间**：2026-11-10T12:14:51.842Z
**命令**：`node scripts/mutation.mjs`
## 1. 汇总
| 项 | 值 |
|---|---|
| 变异体总数 | 40 |
| 断言杀死 | 19 |
| 语法杀死（不计入杀灭率） | 0 |
| 存活 | 21 |
| **断言杀灭率** | **47.5%**（19/40） |
| 无直接测试的源码文件 | 18 |
> 判定口径：只有「变异体可解析、且被断言抓住」才计入杀灭率。
> 语法杀死说明变异把文件改坏了，测试失败不构成测试强度的证据（07 §5.2）。
## 2. 断言杀死明细
| 文件:行 | 变异子 | 变异 | 杀死者 |
|---|---|---|---|
| `src/decision-evidence.ts:57` | comparison | 比较方向 >= → >（i > 0） | `tests/unit/decision-evidence.test.ts` |
| `src/decision.ts:112` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/resilience-fallback.test.ts` |
| `src/isolation.ts:172` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/resilience-fallback.test.ts` |
| `src/lifecycle.ts:435` | comparison | 比较方向 <= → <（changeCount < 1） | `tests/unit/risk-frequency.test.ts` |
| `src/markov.ts:122` | comparison | 比较方向 > → >=（samples >= 0） | `tests/unit/observability-math.test.ts` |
| `src/observability.ts:109` | comparison | 比较方向 <= → <（sampleSize < 0） | `tests/unit/observability-math.test.ts` |
| `src/patch.ts:76` | comparison | 比较方向 < → <=（i <= scanned） | `tests/unit/patch-safety.test.ts` |
| `src/patch.ts:90` | comparison | 比较方向 < → <=（j <= scanned） | `tests/unit/patch-safety.test.ts` |
| `src/patch.ts:63` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/resilience-fallback.test.ts` |
| `src/preventive.ts:116` | comparison | 比较方向 > → >=（sigma >= 0） | `tests/unit/observability-math.test.ts` |
| `src/preventive.ts:122` | comparison | 比较方向 > → >=（iqr >= 0） | `tests/unit/observability-math.test.ts` |
| `src/recovery-policy.ts:123` | comparison | 比较方向 < → <=（abnormalSeq <= required） | `tests/unit/recovery-policy.test.ts` |
| `src/recovery-policy.ts:230` | comparison | 比较方向 >= → >（i > 0） | `tests/unit/hazard-threshold.test.ts` |
| `src/sentinel.ts:79` | comparison | 比较方向 <= → <（pid < 0） | `tests/unit/core.test.ts` |
| `src/sentinel.ts:43` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/resilience-fallback.test.ts` |
| `src/store.ts:166` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/store-lock.test.ts` |
| `src/survival.ts:113` | comparison | 比较方向 <= → <（g < 0） | `tests/unit/observability-math.test.ts` |
| `src/tool-render.ts:196` | comparison | 比较方向 > → >=（omitted >= 0） | `tests/host/display-truncation.test.ts` |
| `src/tool-render.ts:199` | comparison | 比较方向 > → >=（extra >= 0） | `tests/host/display-truncation.test.ts` |
## 3. 存活变异体（测试缺口）
- `src/archive.ts:105` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/archive.ts:113` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/control-band.ts:38` [comparison] 比较方向 < → <=（i <= crashTimes）
- `src/control-band.ts:40` [comparison] 比较方向 > → >=（gap >= 0）
- `src/decision.ts:125` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/guarded-rows.ts:74` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/guarded-rows.ts:105` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/isolation.ts:184` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/lifecycle.ts:256` [comparison] 比较方向 >= → >（i > 0）
- `src/markov.ts:166` [comparison] 比较方向 < → <=（i <= a）
- `src/observability.ts:120` [comparison] 比较方向 < → <=（sampleSize <= 1）
- `src/patch.ts:127` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/risk-bayes.ts:146` [comparison] 比较方向 <= → <（x < 0）
- `src/risk-bayes.ts:147` [comparison] 比较方向 < → <=（x <= 1）
- `src/risk-calibration.ts:266` [comparison] 比较方向 < → <=（i <= events）
- `src/risk-calibration.ts:293` [comparison] 比较方向 < → <=（i <= events）
- `src/sentinel.ts:54` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/store.ts:212` [comparison] 比较方向 <= → <（pid < 0）
- `src/store.ts:688` [comparison] 比较方向 > → >=（limit >= 0）
- `src/store.ts:191` [try-catch] 删除 try/catch 兜底（保留 try 体）
- `src/survival.ts:116` [comparison] 比较方向 > → >=（zeros >= 0）
## 4. 语法杀死明细
> 这些变异体把源码改成了不可解析形态。它们不计入杀灭率，但值得记录 ——
> 若某类变异子的语法杀死率长期偏高，说明该变异子的文本变换需要收窄。
无。
## 5. 无直接测试的源码文件
- `src/abnormal-boot.ts`
- `src/boot-notes.ts`
- `src/change-guard.ts`
- `src/cooccurrence-store.ts`
- `src/decision-views.ts`
- `src/event-watch.ts`
- `src/observations.ts`
- `src/official-observe.ts`
- `src/partition-snapshot.ts`
- `src/patch-yaml.ts`
- `src/recovery-actions.ts`
- `src/self-describe.ts`
- `src/startup-record.ts`
- `src/status-view.ts`
- `src/tool-dispatch.ts`
- `src/tool-presentation.ts`
- `src/tool-registration.ts`
- `src/tool-text.ts`
