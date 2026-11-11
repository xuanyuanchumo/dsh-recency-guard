# 变异测试报告（M4 / RQ4）
**生成时间**：2026-11-11T10:57:05.624Z
**命令**：`node scripts/mutation.mjs --metric meaningful --min-kill-rate 0.8`
## 1. 汇总（双口径）
| 项 | 值 |
|---|---|
| 变异体总数 | 72 |
| 断言杀死 | 60 |
| 语法杀死（不计入杀灭率） | 0 |
| 存活 | 12 |
| ├ 已证等价（账本剔除） | 12 |
| └ 未归因（留在分母 = 真实缺口/未证等价） | 0 |
| **原始口径杀灭率** | **83.3%**（60/72） |
| **有意义口径杀灭率** | **100.0%**（60/60） |
| 门禁采用口径 | `meaningful` |
| 门禁阈值 / 结果 | 80.0% / PASS（meaningful 口径） |
| 账本有效条目 | 12（.cycles/verify/mutation-equivalents.json） |
| 账本 STALE-EQUIVALENT | 0 |
| 账本被拒条目（缺 reason/proof） | 0 |
| 账本未生效条目 | 0 |
| 无直接测试的源码文件 | 2 |
| 基线自检（变异前） | PASS（49 个直接测试文件，整表重跑 1 次） |
> 判定口径：只有「变异体可解析、且被断言抓住」才计入杀灭率；语法杀死不计入。
> **原始口径**不剔除任何存活体；**有意义口径**只剔除账本中已证等价、且本轮源码核对通过的存活体。
> `--min-kill-rate` 自 cycle-13 起**默认按有意义口径判定**（此前为原始口径）；`--metric raw` 可显式切回。
> 未归因的存活体一律留在分母里 —— **存疑不等于等价**，否则治理会变成自我豁免。
## 2. 等价体剔除明细
| 文件:行 | 变异子 | 变异 | 等价理由（为什么行为不变） | 证明（钉住不可达性的断言） |
|---|---|---|---|---|
| `src/host/observe/control-band.ts:38` | comparison | 比较方向 < → <=（i <= crashTimes） | 多出的一轮取 i === crashTimes.length：crashTimes[i] 为 undefined，被 ?? 0 兜底成 0，于是 gap = 0 − 最后一个时刻 = 负值；紧接着的 gap > 0 守卫把它过滤，gaps 数组与后续全部断言不变。 | tests/unit/observability-math.test.ts:倒序时间戳 ⇒ 诚实不可判定（负间隔全过滤）—— 该断言钉住「负间隔会被 gap > 0 过滤」这个等价性的承重事实。 |
| `src/host/risk/risk-bayes.ts:147` | comparison | 比较方向 < → <=（x <= 1） | 唯一分歧点是 x === 1。变异版本走递推 lgamma(2) − log(1) = lnΓ(2) − 0；Γ(2) = 1 ⇒ lnΓ(2) = 0。原路径 lnΓ(1) = 0。数学上恒等；实现上 z=1 与 z=0 两条 Lanczos 路径的数值差约 1e-15，远小于先验断言的 1e-8 容差，故可观测行为不变。 | tests/unit/risk-bayes.test.ts:先验 95% 下界 = 0.025（均匀分布的解析分位）与 先验均值 = 0.5（均为 1e-8/1e-12 容差）—— 先验 Beta(1,1) 的 logBeta(1,1) 三次走 lgamma(1)，容差钉住该处 x=1 的数值不变。 |
| `src/host/observe/survival.ts:116` | comparison | 比较方向 > → >=（zeros >= 0） | 进入该分支的必要条件是 gaps 含非有限值或 ≤ 0 的间隔。crashSeries 先 filter(Number.isFinite) 再 sort，因此 gaps 恒 ≥ 0 ⇒ 只有「零间隔」能触发该分支 ⇒ zeros > 0 在分支内恒真。改成 >= 0 只替换了不可达分支（非有限/负间隔）的文案，返回的 Metric 与原因不变。 | tests/unit/observability-math.test.ts:乱序时间戳会被排序 ⇒ 不产生负间隔（故负间隔分支不可达）—— 这条断言就是为钉住该不可达性而加的（见 mutation-attribution.md §3.4）。 |
| `src/host/guard/decision.ts:126` | try-catch | 删除 try/catch 兜底（保留 try 体） | 唯一调用 writeSafe 自带同粒度 try/catch（decision.ts:189），writeFileAtomicSync 的异常在那里已被吞掉；JSON.stringify 的输入是纯数据对象（无环），不会抛。因此删除外层 try 后没有任何异常能到达它 —— 两层防御删掉一层，可观测行为不变。 | tests/unit/core.test.ts:决策写失败不冒泡（内层 writeSafe 已兜底）—— 把分区路径占成文件后调用 writeDecision，断言不抛出，钉住内层兜底存在。 |
| `src/host/guard/guarded-rows.ts:105` | try-catch | 删除 try/catch 兜底（保留 try 体） | try 体只调用四个自带兜底的函数：readPatchRows（patch.ts:63 catch 返回 []）、readDeclaredDependencies（store.ts:766 catch 返回 []）、resolveBundlePatch（本文件:74 catch 返回 undefined）、appendPatchText（本文件:158/208/223 catch，失败返回 {ok:false}）。正常与损坏输入下 try 体都无可抛异常 ⇒ 删除外层 try 不改变返回值。 | tests/unit/core.test.ts:损坏的包清单被跳过（钉住 resolveBundlePatch 的兜底）＋ 备份写失败不冒泡（钉住 appendPatchText/ensurePatchBackup 的兜底）；tests/unit/resilience-fallback.test.ts 另有「写入被校验拦下时返回 blocked」与「不可写 patch 返回 ok:false」。 |
| `src/host/risk/risk-calibration.ts:315` | comparison | 比较方向 < → <=（i <= events） | 唯一分歧点是 i === events.length：events[i] 为 undefined，紧接着的 `if (!event) continue` 直接跳过，marks/byBundle/run/stats 全部不变。删除该守卫才会改变行为，而本次变异没有动守卫。 | tests/unit/core.test.ts:journal 尾部的 undefined 洞被跳过（统计与没有它逐字段一致）—— 用一个显式 undefined 事件钉住 `if (!event) continue` 的跳过语义，不可达的越界项走同一条守卫。 |
| `src/host/risk/risk-calibration.ts:350` | comparison | 比较方向 < → <=（i <= events） | 唯一分歧点是 i === events.length：events[i] 为 undefined，紧接着的 `if (!event) continue` 直接跳过，marks/byBundle/run/stats 全部不变。删除该守卫才会改变行为，而本次变异没有动守卫。 | tests/unit/core.test.ts:journal 尾部的 undefined 洞被跳过（统计与没有它逐字段一致）—— 用一个显式 undefined 事件钉住 `if (!event) continue` 的跳过语义，不可达的越界项走同一条守卫。 |
| `src/host/data/journal-io.ts:46` | comparison | 比较方向 > → >=（limit >= 0） | 唯一分歧点是 limit === 0：原式 Math.min(Math.floor(0), lines.length) = 0；变异式走 `: 0` 分支也得到 take = 0。`lines.slice(lines.length - 0)` 在两种写法下都是 []。limit 为负数/非有限时两侧同样得到 0。 | tests/unit/core.test.ts:readJournal(0) 读 0 行（Store.readJournal 委托 parseJournalLines，钉住 limit===0 的取值是 0 而不是「全部」）＋ readJournal(1) 读 1 行（钉住同一表达式的上界行为）。 |
| `src/host/data/store.ts:320` | try-catch | 删除 try/catch 兜底（保留 try 体） | try 体唯一的调用 cleanStaleLocks 自身是全函数：readdirSync 有 catch（返回空报告）、每个条目的 statSync/readFileSync/rmSync 各有 catch、processAlive 的 process.kill 有 catch。因此正常与残缺输入下 try 体都无可抛异常，删除外层 try 不改变 init 的结果（init 的硬要求只有 mkdir 备份目录）。 | tests/unit/core.test.ts:目录不存在时返回空报告（不抛）＋ 内容为 "0" 的锁必须被清理 ＋ 死进程 pid 的锁必须被清理 —— 三条断言都直接调用 cleanStaleLocks 并断言不抛、且给出确定报告。 |
| `src/host/core/metric.ts:113` | comparison | 比较方向 < → <=（sampleSize <= 1） | 唯一分歧点是 sampleSize === 1。原式命中守卫直接 return 1；变异式落到底部公式 Math.max(1, Math.min(4, Math.round(Math.log10(1) + 0.5))) = Math.max(1, Math.round(0.5)) = 1。两条路径同为 1，n<1 与 n>1 的行为完全相同。 | tests/unit/core.test.ts:displayDigits(1) = 1（n=1 与守卫分支同值）；同类边界由 tests/unit/observability-math.test.ts 的 displayDigits(0)===1 / displayDigits(3)===1 钉住。 |
| `src/host/core/self-describe.ts:113` | comparison | 比较方向 < → <=（depth <= 6） | 唯一分歧是循环多走一层。自身 package.json 在两种产物形态下都在 ≤3 层被找到（dist/ 与 src/<domain>/），第 7 层只有在「包根不在 ≤6 层」的异常布局下才可达；该布局在产物里不存在。多出的一层读取只是多一次失败的开文件，返回值不变。 | tests/unit/self-describe.test.ts:版本与现场 package.json 一致 + 版本非空 —— 钉住「循环在触到上界之前已找到自身清单」这个承重事实（若上界被触到会返回全 null）。 |
| `src/host/profile/patch-yaml.ts:88` | comparison | 比较方向 < → <=（i <= lines） | 唯一分歧是循环多走一轮：`lines[i]` 为 undefined，正则 `openable.exec(undefined)` 会先把参数转成字符串 "undefined" ⇒ 不匹配 ⇒ `continue`，本轮不写任何字符；`out` 与 `i` 的后续状态和「直接结束循环」一致，返回值不变。 | tests/unit/patch-yaml.test.ts:空文本 `foldQuotedContinuations("")` 与原样返回未闭合引号的两条断言 —— 钉住「越界轮不产生任何输出变更」这个承重事实（若有写入，原样返回会变）。 |
## 3. 账本自检（腐烂必须可见）
### 3.1 STALE-EQUIVALENT
> 条目指向的 file:line 当前已无法由同一变异子生成同一变异（行号漂移或文本改写）。
> 这些条目**不参与剔除**，必须在下一次改动账本时修正 —— 否则账本会悄悄失效。
无 —— 所有账本条目的 file:line 均可复核。
### 3.2 被拒条目（缺 reason/proof，不登记）
无 —— 账本内所有条目字段齐全。
### 3.3 未生效条目（有效但与存活体不匹配）
无。
## 4. 存活变异体
已证等价 12 个（已从有意义分母剔除）；未归因 0 个（留在分母，按纪律不剔除）。
- `src/host/observe/control-band.ts:38` [comparison] 比较方向 < → <=（i <= crashTimes） 【已证等价 → 剔除】
- `src/host/risk/risk-bayes.ts:147` [comparison] 比较方向 < → <=（x <= 1） 【已证等价 → 剔除】
- `src/host/observe/survival.ts:116` [comparison] 比较方向 > → >=（zeros >= 0） 【已证等价 → 剔除】
- `src/host/guard/decision.ts:126` [try-catch] 删除 try/catch 兜底（保留 try 体） 【已证等价 → 剔除】
- `src/host/guard/guarded-rows.ts:105` [try-catch] 删除 try/catch 兜底（保留 try 体） 【已证等价 → 剔除】
- `src/host/risk/risk-calibration.ts:315` [comparison] 比较方向 < → <=（i <= events） 【已证等价 → 剔除】
- `src/host/risk/risk-calibration.ts:350` [comparison] 比较方向 < → <=（i <= events） 【已证等价 → 剔除】
- `src/host/data/journal-io.ts:46` [comparison] 比较方向 > → >=（limit >= 0） 【已证等价 → 剔除】
- `src/host/data/store.ts:320` [try-catch] 删除 try/catch 兜底（保留 try 体） 【已证等价 → 剔除】
- `src/host/core/metric.ts:113` [comparison] 比较方向 < → <=（sampleSize <= 1） 【已证等价 → 剔除】
- `src/host/core/self-describe.ts:113` [comparison] 比较方向 < → <=（depth <= 6） 【已证等价 → 剔除】
- `src/host/profile/patch-yaml.ts:88` [comparison] 比较方向 < → <=（i <= lines） 【已证等价 → 剔除】
> 未归因 ≠ 已确认测试缺口：其中可能包含「需要 IO 故障注入才能判定」的边界
> （删除 try/catch 类，见 `.cycles/verify/mutation-attribution.md`），以及「行为可能等价但无断言钉住」的条目。
> 二者都留在分母里，因为**工具判定不了不等于等价**。
## 5. 断言杀死明细
| 文件:行 | 变异子 | 变异 | 杀死者 |
|---|---|---|---|
| `src/host/core/atomic-sync.ts:48` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/core/atomic-sync.ts:53` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/core/isolation.ts:175` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/host/isolation-parallel.test.ts` |
| `src/host/core/isolation.ts:214` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/host/isolation-parallel.test.ts` |
| `src/host/core/lifecycle.ts:253` | comparison | 比较方向 >= → >（i > 0） | `tests/unit/lifecycle-steps.test.ts` |
| `src/host/core/lifecycle.ts:432` | comparison | 比较方向 <= → <（changeCount < 1） | `tests/unit/deterministic-evidence.test.ts` |
| `src/host/core/metric.ts:95` | comparison | 比较方向 <= → <（sampleSize < 0） | `tests/unit/core.test.ts` |
| `src/host/core/self-describe.ts:19` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/self-describe.test.ts` |
| `src/host/core/self-describe.ts:33` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/self-describe.test.ts` |
| `src/host/data/archive.ts:106` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/data/archive.ts:114` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/data/journal-io.ts:49` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/journal-io-parsing.test.ts` |
| `src/host/data/journal-io.ts:71` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/journal-trim-injection.test.ts` |
| `src/host/data/lock-hygiene.ts:88` | comparison | 比较方向 <= → <（pid < 0） | `tests/unit/core.test.ts` |
| `src/host/data/lock-hygiene.ts:42` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/data/lock-hygiene.ts:67` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/data/store.ts:388` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/guard/boot-orchestration.ts:76` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/boot-degradation.test.ts` |
| `src/host/guard/boot-orchestration.ts:150` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/boot-degradation.test.ts` |
| `src/host/guard/conflict-declarations.ts:289` | comparison | 比较方向 < → <=（index <= 0） | `tests/unit/conflict-declarations.test.ts` |
| `src/host/guard/conflict-declarations.ts:123` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/conflict-declarations.test.ts` |
| `src/host/guard/conflict-declarations.ts:174` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/conflict-declarations.test.ts` |
| `src/host/guard/decision-evidence.ts:57` | comparison | 比较方向 >= → >（i > 0） | `tests/unit/decision-evidence.test.ts` |
| `src/host/guard/decision-views.ts:51` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/guard-observe-dispatch.test.ts` |
| `src/host/guard/decision-views.ts:128` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/guard-observe-dispatch.test.ts` |
| `src/host/guard/decision.ts:113` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/resilience-fallback.test.ts` |
| `src/host/guard/guarded-rows.ts:74` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/guard/official-observe.ts:92` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/guard-observe-dispatch.test.ts` |
| `src/host/guard/official-observe.ts:101` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/guard-observe-dispatch.test.ts` |
| `src/host/guard/quarantine-plan.ts:280` | comparison | 比较方向 < → <=（round <= maxRounds） | `tests/unit/quarantine-plan.test.ts` |
| `src/host/guard/recovery-actions.ts:138` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/guard/recovery-actions.ts:144` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/guard/recovery-policy.ts:123` | comparison | 比较方向 < → <=（abnormalSeq <= required） | `tests/unit/recovery-policy.test.ts` |
| `src/host/guard/recovery-policy.ts:276` | comparison | 比较方向 >= → >（i > 0） | `tests/unit/deterministic-evidence.test.ts` |
| `src/host/guard/sentinel.ts:79` | comparison | 比较方向 <= → <（pid < 0） | `tests/unit/core.test.ts` |
| `src/host/guard/sentinel.ts:43` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/resilience-fallback.test.ts` |
| `src/host/guard/sentinel.ts:54` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/guard/startup-record.ts:71` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/startup-record.test.ts` |
| `src/host/observe/control-band.ts:40` | comparison | 比较方向 > → >=（gap >= 0） | `tests/unit/observability-math.test.ts` |
| `src/host/observe/cooccurrence-store.ts:61` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/cooccurrence-store.test.ts` |
| `src/host/observe/cooccurrence-store.ts:86` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/cooccurrence-store.test.ts` |
| `src/host/observe/markov.ts:122` | comparison | 比较方向 > → >=（samples >= 0） | `tests/unit/observability-math.test.ts` |
| `src/host/observe/markov.ts:184` | comparison | 比较方向 < → <=（i <= a） | `tests/unit/markov-norm.test.ts` |
| `src/host/observe/observability.ts:197` | comparison | 比较方向 < → <=（i <= this） | `tests/unit/observability-math.test.ts` |
| `src/host/observe/observability.ts:204` | comparison | 比较方向 <= → <（limit < 0） | `tests/unit/observability-math.test.ts` |
| `src/host/observe/preventive.ts:101` | comparison | 比较方向 > → >=（sigma >= 0） | `tests/unit/observability-math.test.ts` |
| `src/host/observe/preventive.ts:107` | comparison | 比较方向 > → >=（iqr >= 0） | `tests/unit/observability-math.test.ts` |
| `src/host/observe/survival.ts:113` | comparison | 比较方向 <= → <（g < 0） | `tests/unit/observability-math.test.ts` |
| `src/host/profile/patch-yaml.ts:101` | comparison | 比较方向 < → <=（j <= lines） | `tests/unit/patch-yaml.test.ts` |
| `src/host/profile/patch.ts:76` | comparison | 比较方向 < → <=（i <= scanned） | `tests/unit/core.test.ts` |
| `src/host/profile/patch.ts:90` | comparison | 比较方向 < → <=（j <= scanned） | `tests/unit/core.test.ts` |
| `src/host/profile/patch.ts:63` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/resilience-fallback.test.ts` |
| `src/host/profile/patch.ts:127` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/core.test.ts` |
| `src/host/risk/risk-bayes.ts:146` | comparison | 比较方向 <= → <（x < 0） | `tests/unit/core.test.ts` |
| `src/host/surface/preventive-view.ts:176` | comparison | 比较方向 > → >=（gap >= 0） | `tests/unit/preventive-wiring.test.ts` |
| `src/host/surface/tool-dispatch.ts:107` | try-catch | 删除 try/catch 兜底（保留 try 体） | `tests/unit/guard-observe-dispatch.test.ts` |
| `src/host/surface/tool-render.ts:196` | comparison | 比较方向 > → >=（omitted >= 0） | `tests/host/display-truncation.test.ts` |
| `src/host/surface/tool-render.ts:199` | comparison | 比较方向 > → >=（extra >= 0） | `tests/host/display-truncation.test.ts` |
| `src/host/surface/tool-text.ts:198` | comparison | 比较方向 < → <=（i <= text） | `tests/unit/core.test.ts` |
| `src/host/surface/tool-text.ts:238` | comparison | 比较方向 > → >=（w >= budget） | `tests/unit/core.test.ts` |
## 6. 语法杀死明细
> 这些变异体把源码改成了不可解析形态。它们不计入杀灭率，但值得记录 ——
> 若某类变异子的语法杀死率长期偏高，说明该变异子的文本变换需要收窄。
无。
## 7. 无直接测试的源码文件
- `src/host/guard/event-watch.ts`
- `src/host/surface/tool-registration.ts`
