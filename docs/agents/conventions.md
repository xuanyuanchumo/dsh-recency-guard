# 工程规范（dsh-recency-guard）

> 每条规范都来自实测教训 —— 违反它们的代价已经付过一次，不要再付一次。

## 1. 中文注释纪律

注释必须说明「**为什么这样写**」，不复述代码在做什么。
好注释回答的是「为什么不用显而易见的另一种写法」—— 那个被否决的方案
通常就是下一个维护者想改回去的方案。

## 2. 验证链（固定顺序，全零错误才算完成）

```bash
npm run build && npx tsc --noEmit && npm run lint && npm test
```

- 宿主测试前置：`npm run extract-runtime`（runtime/ 缺失先解出）。
- 「无法评估」≠「通过」：贴命令输出作为证据。
- 每轮 ANIC 循环必须落盘 `.cycles/cycles/cycle-N/test-reports/*.md`
  （评估器把目录不存在判 FAIL）。

## 3. 测试分层（tests/run.ts）

| 层 | 目录 | 覆盖 |
|---|---|---|
| Core | tests/unit/ | 纯逻辑：能力图/状态机/指标/隔离/归档/工具渲染 |
| Host | tests/host/ | 插件入口 + 工具注册与 action（假服务挂载）+ **路由 HTTP 行为（v0.11）** |
| Client | tests/client/ | 视口原语/布局/形状/i18n/形状校验（纯函数）+ **graph-model 纯函数（v0.11）** |
| Contract | tests/contract/ | 能力清单 ↔ 注册处双向比对 + 包清单 |

新增能力的检查单：清单条目（capability-specs）→ 注册处 noteRegistered →
契约测试 → 快照字段 → 面板/工具消费点。五处缺一即缺口。

## 3.1 v0.11 新增纪律（cycle-6 实测）

- **动作路由必须过方法守卫**：`rejectWrongMethod(req, res)` 是 handler 第一行 ——
  破坏性动作不把「请求方法」当建议（GET 预取曾能触发归档）。
- **跨分区视图是磁盘投影**：`partition-snapshot.ts` 只读对方分区目录；
  运行时字段（stage/metrics/markov）如实降级为 null/idle，绝不冒充。
- **图例必须与着色同源**：改 KIND_COLOR/STAGE_COLOR 时图例自动跟随
  （legendColorOf），新增形状映射时不复制 —— 代表形状从实际数据多数票导出。
- **语言文件最小 diff**：locale/*.json 用 `json.dumps(indent=2)` 原行尾重写
  （Python json.dump 会改全文件行尾 ⇒ 542 行假 diff 实测发生过）。

## 3.2 v0.11.1 紧急修复纪律（宿主兼容与启动健壮性）

- **预发布版本范围必须写显式分支**：`>=0.2.1-rc.5 <0.3.0-0` 会**静默排除**
  `0.2.2-rc.1`（node-semver 规则）；宿主升级即被兼容闸门移出 profile。
  新范围：`>=0.2.1-rc.5 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || >=0.2.3-rc.1 <0.3.0-0`；
  契约测试守卫 `>=0.2.2-rc.1` 分支存在。
- **boot 绝不外抛**：`Guard.boot()` 失败只降级留痕。任何异常冒到 loader
  都会变成 `dsh: fatal load failure`（宿主退出码 1）——守护不能拖垮主流程。
- **写锁卫生**：崩溃可能留下 0 字节 `*.lock`（创建与写 PID 之间被杀），
  atomic-write 无法接管不完整记录。启动先 `cleanStaleLocks`（空/非 PID/
  死 PID 且年龄 > 5s），`updateState` 超时后清理重试一次。
- **连续计数不得被启动记录打断**：`crash-detected` 有两种来源（启动检测
  无 suspects / 崩溃决策带 suspects）；历史只认后者，另有 crashSeq ≥ 3
  兜底升级（安全网）。

## 4. 宿主纪律（dsh 插件通用）

- Loader 四件套（name/inject/Config/apply）之外不导出任何东西。
- webServer 依赖放独立路由子插件（headless 下硬依赖会让 fiber 挂起）。
- 路由路径必须是 `src/host/surface/routes.ts` 里的**字面量**。
- 只用 `--dsw-alias-*` / `--dsw-radius-*` 主题变量；硬编码颜色仅限 SVG 图形。
- 守护路径（崩溃决策/启动记录/守护行）**同步 IO**。
- 崩溃路径上的兜底数据用**同步变体**（bundleMtimesSync 等）——
  `await` 之后进程可能已经死了。
- 工具输出双形态：规范 JSON 给模型（`execute` 返回值），人读文本进
  `output.render`（会话命令窗口）。裸 `JSON.stringify` 是 v0.3 的显示问题根源。

## 5. 已知陷阱（真实踩坑，勿重蹈）

| 陷阱 | 正确做法 |
|---|---|
| 崩溃趋势回归时间戳 | 回归**相邻崩溃间隔**（只有间隔携带变密/变稀方向） |
| 归档 manifest 在搬走后读 | rename **前**读取（否则摘要永远报 0） |
| consumes/consumedBy 方向写反 | consumes = 我消费谁；consumedBy = 谁消费我 |
| 守护行表达式拿不到分区键 | 用指针文件（.recency-guard/current.json）搭桥 |
| 图谱 fit 在每次轮询重跑 | ref 守卫只 fit 一次（否则用户缩放被重置） |
| 一个包装多行守护行 | 只装第一行（代表行），多行在 Loader 重复 id 抛错 |
| 评估器判 test-reports 缺失 FAIL | 每轮循环落盘测试报告 |
| CUSUM 用中位数当基准 | 用 P75（中位数让一半样本天然低于基准，检测器失明） |
| clipToRect 取最大 t 交点 | 取**最小 t**（进入点）；B 在矩形内时最大 t 就是 B 自己 |
| 边的 filter/map 回调里重建 id→node 索引 | 索引 useMemo 与节点数组绑定（每数组一次）；回调内重建是 O(E·V) 实测债 |
| locale 字典写 `kind.x` 字面量键 | 用**嵌套对象**（`kind: { x: … }`）—— `t()` 按点号路径逐层下钻，字面量键查不到会回退键本身 |
| i18n 字典类型按一层嵌套声明 | `Dict` 必须递归（`string | Dict`），否则两层分组过不了类型检查 |
| 守护行 `name:` 不加 YAML 引号 | **永远加引号**（`@` 是 YAML 保留指示符，scoped 包名会把整份 profile patch 写死） |
| 契约测试只用 `exposedAs` 比对 | 用 `declaredExposedNames()`（主名称 ∪ 别名），否则多路由能力被误报缺口 |
| 在 `apply` 里直接读可选服务 | `tryReadService` 包一层：未 inject 的追踪代理会抛错，整插件不激活 |
| Reflect `formatXxx` 只返回渲染结构 | 数据必须摊平到顶层（`execute` 返回规范值），渲染只是 `output.render` 的投影 |
| React `onWheel` 里 `preventDefault` | 用原生 `addEventListener('wheel', h, {passive:false})`（React 的是 passive，无效） |

## 5.1 宿主服务读取纪律（v0.7 实测崩溃级）

**症状**：沙箱启动后日志只有一行

```
dsh: warning: 1 entry did not activate
recency-guard (dsh-recency-guard): Error: cannot get property "configEditor" without inject
```

端口照常监听、Web UI 照常打开 —— 极易误判为"启动成功"，实际**插件整体未激活**。

**根因**：Cordis 的 `ctx` 是可追踪代理。读取**没有写进 `inject` 的服务**会抛异常，
而异常发生在 `apply` 里就等于整插件加载失败。

**规则**：

1. 必需服务 → 写进 `inject`（Loader 会等它就绪）。
2. 可选服务 → **只**用 `tryReadService(ctx, name)` 读（内部 try/catch，读不到即"不在场"），
   并用 `ctx.inject([...], child => …)` 挂子 fiber 延迟接上。
3. 契约自检的 `injectedServiceNames` 也必须走 `tryReadService` —— 它本来就是
   "以实际可读为准"的探针，直接读会把探针自己炸掉。

## 5.2 交互事件纪律（v0.7 实测 UX 缺陷）

**症状**：控制台 `Unable to preventDefault inside passive event listener invocation`；
后果是滚轮缩放图谱时**页面跟着滚**，图被滚出视野。

**根因**：React 17+ 把 `wheel`/`touch*` 挂在 root 上且注册为 **passive**，
组件里的 `event.preventDefault()` 被浏览器忽略。

**规则**：需要 `preventDefault` 的手势（滚轮缩放、拖拽、触摸）一律用
`useEffect` + `ref.addEventListener(type, handler, { passive: false })` 原生挂载，
并用 `handlerRef` 桥接最新闭包，避免视口变化反复解绑重绑。

## 5.3 数据面契约纪律（v0.7 集成复验）

`tool.execute()` 返回的规范值里，**业务数据必须摊平在顶层**
（`status.profile`、`status.suspectRanking` 等），同时保留在 `data` 下便于遍历；
`display` 只是渲染模型。三者同源、单一构造点（`buildOutcome`），不允许任何
formatter 自己再拼一份。v0.7 重构 display 时漏掉摊平，宿主层测试立刻以
`status.profile === undefined` 报出 —— 注释与实现漂移的典型，别再犯。

## 6. 版本同步纪律（四锚点）

**四个锚点必须同值**（当前 `0.16.0`）：

| 锚点 | 位置 | 谁读它 |
| --- | --- | --- |
| 1 | [`package.json`](../../package.json) 的 `version` | npm / 安装器 / dsh 兼容闸门 |
| 2 | [`README.md`](../../README.md) 顶部版本行 | 人（用户第一眼看到的版本） |
| 3 | `docs/agents/` 内的当前版本引用（`api.md` / `design.md` / `architecture.md` 标题等） | 开发者 / 评审 |
| 4 | [`dsh-plugin.json`](../../dsh-plugin.json) 的 `version` | 社区 manifest 生态 |

### 顺序（反了就会造出 npm 上不存在的版本）

```text
改四锚点 → build/typecheck/lint/test 全绿 → git tag v<version> → npm publish → GitHub release
```

- **先 tag 后改锚点**：tag 指向的提交里 `package.json` 还是旧版本，用户按 tag 装到的是旧代码；
- **先 publish 后改锚点**：npm 上出现一个仓库里查不到的版本号，"源码 / 发布"从此对不上账；
- **锚点漏一个**：市场 manifest、安装器、README 各说各话 —— 本项目 v0.14.0 起点的
  `package.json 0.14.0 / 提交信息 v0.15.0 / tag v0.11.4 / npm latest 0.12.1` 就是这个缺陷的实例。

### 发版前核对（可复制）

```bash
node -e "const a=require('./package.json'),b=require('./dsh-plugin.json'); console.log('pkg',a.version,'manifest',b.version,a.version===b.version?'OK':'MISMATCH')"
grep -n "v0\.16\.0\|0\.16\.0" README.md dsh-plugin.json docs/agents/api.md docs/agents/design.md docs/agents/architecture.md
```

判据：四处全部命中 `0.16.0`；历史版本号（如 `v0.11.1`）只允许出现在"历史 / 复盘"语境里。

能力清单新增 exposed 能力时，`capability-specs.ts`、`api.md`、`capabilities.md`、README 能力表
四处同步更新（漏一处，用户视角就等于没有这个能力）。

## 6.1 客户端状态纪律（v0.5）

- **用户调整是叠加层**：节点拖拽偏移（offsets）、折叠态、视口都是用户事实，
  数据轮询**不得重置**它们 —— 轮询只是数据刷新，不是布局重置。
- **localStorage 键统一前缀**：`recency-guard-*`（当前 `-lang`、`-collapsed`）；
  读写全部 try/catch 退化，storage 缺席不影响功能。
- **暂停即真停**：轮询开关暂停时不再发任何 fetch；「画面还在跳」与
  「按钮显示暂停中」矛盾就是缺陷。

## 6.2 生态插件借鉴（跨插件学习，cycle-4 沉淀）

对照 `dsh-ops` 0.4.4 与 `dsh-context` 0.81.0 的实现（均以发布包为事实），
与本插件现有纪律互补的三条：

| 借鉴点 | 来源 | 本插件对应/采用 |
|---|---|---|
| **safeDispose 隔离注销**：一个抛异常的 disposer 不得阻断同列表其余清理（权限泄漏/守卫卡死的根因） | dsh-ops `lib/teardown.js` | routes.ts 的注销循环已逐条 try/catch（同语义）；后续新增多 disposer 列表时抽 `safeDisposeAll` 复用 |
| **NDJSON 折叠 + 有界数据**：append-only 日志（崩溃安全）+ turn 边界折叠成 JSON 快照 + `maxBytes` 封顶丢弃并计数 | dsh-ops `lib/panel/collect.js` | 本插件 journal.jsonl 即同形态；后续若 journal 无限增长，按此模式加「折叠 + 封顶 + 丢弃计数」而非静默截断 |
| **公开面最小化**：宿主侧只导出 name/inject/Config/apply，`lib/index.d.ts` 只暴露投影类型 | dsh-context（656KB client 单文件 bundle，公开 d.ts 仅 14KB 投影面） | 已执行（契约测试守卫 Loader 四件套）；面板数据契约（PanelSnapshot/GraphData）保持窄投影 |

不采用的：dsh-context 的 zod 双运行时校验（本插件用手写形状校验 isSnapshot/isGraph，
零依赖纪律优先）；dsh-ops 的多模式 applyMode 装配（单职责插件不需要）。

## 6.3 v0.12 新增纪律（真机旅程沉淀）

### 6.3.1 崩溃信号必须有两条通道

单靠哨兵（`process.on('exit')`）会漏掉 SIGKILL / OOM / 断电 / 原生崩溃。
第二条通道判据 = 「`bootMarker` 残留 且 那个 pid 已不在」，且必须是**概率性证据**
（第 1 轮只观察、累计到 `confirmRounds` 才动手）——残留标记同样可由人为杀进程产生。

- **有哨兵时第二条通道必须归零**，否则一次崩溃记两笔、`crashSeq` 翻倍、隔离面被放大。
- **同进程重入（热重载）必须单独成一类**（`self-reload`），不能并入 concurrent：
  否则会报「检测到另一个实例」，让用户去查一个不存在的进程。
- **`!crashedLastRun` 是「没有哨兵」，不是「活过了启动」**。这两者在新通道下不再等价，
  恢复分支必须直接判 `exitClass === 'clean'`（见 `shouldRestoreAfterBoot`）。

### 6.3.2 可选优化不得排在主功能之前，且必须 try 包裹

`setPointerCapture?.(id)` 的真实教训：
1. `?.` 只保护「方法不存在」，**不保护方法抛异常**（pointerId 失效时按规范抛
   `NotFoundError`）；
2. 它排在 `onNavigate(...)` 之前 ⇒ 一个只为「拖拽连续性」的可选优化，
   把「定位到那一块」这个主功能整个吞掉，症状是「点了没反应」（只有控制台有痕迹）。

纪律：捕获/释放这类浏览器 API 一律 `try` 包裹；调用顺序上**主功能先于可选优化**。

### 6.3.3 无 DOM 缺陷用「源码门 + 变异自证」替代行为测试

React 合成事件冒泡、指针捕获异常、手势互斥，在纯函数测试环境里**测不到**。
做法：把不变式写成对源码的断言（如「`GraphMinimap` 的六个手势处理器各自含
`stopPropagation`」），然后**故意破坏它一次**，确认门真的会响（变异自证）。
只会通过、不会失败的门等于没有门。

### 6.3.4 追加断言必须插在汇总行之前

`core.test.ts` 的结构是 `main()` → 汇总 → `process.exit`。把断言块追加到文件末尾
（`process.exit` 之后）会**永不执行**，而文件照样打印 `ALL PASS` —— 这是最难发现的
假绿：测试"通过"了，但新加的断言从来没跑过。追加后必须看到断言自己的 PASS 行。

### 6.3.5 沙箱：环境变量会压过 `--profile`

从 dsh 会话内起动子 dsh 会继承 `DSH_PROFILE` / `DSH_PROFILE_DIR`，它们优先于
`--profile`；`env -u` 在本执行器下不生效。正确形态：
`dsh --profile <name> <app>`（profile 在 app 名之前），并用
`--from-default-profile web` 建干净沙箱。**判别是否真的隔离**：日志里出现
`dsh-anic` / `codegraph` 就说明跑的是 shipped `web` profile，不是你的沙箱。

## 6.4 v0.16 新增纪律（确定性证据 / 贪心隔离 / 可写逃生 / 可空契约）

**确定性冲突证据**

- **finding 必须能回指原文**：每条带 `source{file,line}` + `declaration`；
  没有声明 / 范围不可判定 / 对手不在场 ⇒ **不产生 finding**（不猜）。
- **finding 不是计划**：发现冲突 ≠ 已解决。计划器单独算「关谁、关几个、能否治好」；
  把两者合并会让「发现」被误读成「解决」。
- **`unresolved` 必须上屏**：受保护组件/官方插件/无候选/配额不足导致治不了的冲突，
  要进 `status` / 面板快照 / `decision.json` / `recover` 输出；静默 = 假装治好。
- **禁止用 recency 目标顶替确定性目标**：命中 finding 但计划为空时，不行动，
  残余进 `unresolved`。

**贪心隔离**

- **依赖联动是硬需求**：关 X 必须连带关依赖它的插件，否则制造新的加载失败。
  用反向邻接表求闭包（环状依赖有 `visited` 终止），不要字符串改名。
- **配额按整组判定**：整组放不进 `maxAutoDisable` 就一个都不动；半关比不关更坏。
- **无声明保持原序**：所有候选都未声明 ⇒ 返回输入顺序（纯 recency 逐位不变），
  兼容性兜底必须有双向排序夹具。
- **崩溃路径只做一轮**（同步、无 `await` 余裕），启动后的 `recover()` 才做完整循环；
  两条路径共用 `verdictPatch` 形状，避免观察/行动两态字段漂移。

**写安全**

- **崩溃路径全同步原子写**（守护行/启动记录/决策），异步写输给崩溃。
- **常态路径用锁做幂等提交**（`writeDecisionLocked` / `updateDecisionLocked` /
  `writePartitionIndexLocked`）：已有 `await` 的地方才允许用锁，且合并必须幂等。
- **锁卫生清理判据**：空内容 / 非正整数 PID / 死 PID，且年龄 > 5s；
  `pid=0` 是「不完整记录」不是「活进程持有」（POSIX 上 `kill(0,0)` 成功）。

**可写 rescue**

- **默认 dry-run**：不带 `--yes` 绝不写盘；写命令只在显式授权时执行。
- **两阶段 + 哈希**：`prepared`（beforeHash/afterHash/原 index）→ 原子改 → `applied`；
  `--resume` 按哈希判定第二步是否生效，现场已变 ⇒ 退出码 3 拒绝，不硬改。
- **回插按原 index 升序**，一次只改一个位置。

**客户端可空契约**

- 宿主声明非空 ≠ 运行时不发 `null`。客户端只在 `snapshot-view.ts` 的
  `PanelSnapshotView` 放宽**已证明可空**的字段，禁止照抄宿主类型后 `.toFixed()` 硬算。
- **禁止假 0**：不可判定显示原因 / null，不补一个看起来正常的数字。
- 新增可空字段必须同时更新 `panel-snapshot-nullability` 契约测试。

**竞态与对账（T14-08）**

- **journal 只准真追加**：`appendFileSync` / `appendFile`，禁止「整读 → 追加 → 原子写回」
  —— 旧快照会覆盖崩溃路径刚写的 `crash-detected`（真机约 1/9 复现）。
  行数上限由 `trimJournalIfNeeded()` 在异步/加锁/幂等时机裁剪；**崩溃路径永不 trim**。
- **以决策文件为真相补账**：哨兵在场 + `reason==='crash-recovery'` + `disable` 非空时，
  state 少了被关插件或 `crashSeq<1` ⇒ `state-reconcile` 幂等补回；三个条件缺一不补（不猜）。
- **清零必须 CAS**：干净启动只在 `s.crashSeq === 启动时读到的值` 时归零；
  异步 boot 的旧快照不得覆盖崩溃路径刚写的计数。
- **降级要可复核**：启动编排的 catch 除了 logger，必须落一条 journal `note` 且带
  `degraded: true`（重启后仍可查、面板可消费）；失败兜底分支要留可选注入点，
  别靠“把磁盘写坏”来测。
- **不可观测死分支先转成可观测，再断言**：如 `roundBudget(P)=P+1` + `PlanOptions.roundBudget`
  注入小预算，让「预算耗尽」成为可断言分支；**不要给死分支补假测试**。

当前基线：`npm test` **84/84**，`npx tsc --noEmit` 0，`npm run lint` 0。

## 6.5 v0.17 新增纪律（研究闭环 / schema 版本 / 自适应轮询）

- **研究机制必须有生产消费者**：新增模型/指标时同时给出「谁读它」。只有单测直接 import
  = **孤岛**（RQ3 的 `preventive` 曾是零消费者）。接线后要用**源码扫描**钉住依赖方向，
  例如「关闭决策链路不得 import `preventive`」——只预警不行动不能靠口头承诺。
- **schema 版本不是装饰**：`state` / `decision` / manifest 统一 `schemaVersion: 1`；
  **缺失按 v1 宽容读**（老 profile 兼容），**未知值 ⇒ 安全空态 + `degraded:true` note，
  且不覆盖原文件**（静默重建 = 掩盖损坏）。
- **自适应轮询的指纹必须剔除易变字段**（`at` / `diagnostics.snapshotMs`）；否则永远判变化、
  退避永不触发。用递归 `setTimeout`（不是 `setInterval`），暂停/卸载 `clearTimeout` + `cancelled`。
- **跨实现重复逻辑必须有对拍测试**：`rescue.mjs` 的零依赖宽度实现 vs `tool-text.ts`，
  同一语料逐字符相等 + **绝对期望值**（防「一致地错」）。独立实现不加对拍必然漂移。
- **无直接测试的模块要补直接测试，不要靠间接覆盖**：变异工具的归属判据是「直接 import」，
  没直接测试的模块变异体永不进池 —— 指标没覆盖的东西，指标不会告诉你它没覆盖。
- **等价/未归因口径不放松**：删除死分支前先把它转成可观测（注入点/参数），再断言；
  未归因存活体留在分母并书面归因，不靠「看起来等价」豁免。

技术债的逐条状态见 [tech-debt.md](./tech-debt.md)。

## 7. 发布与沙箱流程

1. 验证链全绿 + ANIC 门禁 G0-G3 通过。
2. **沙箱验证**（绝不碰主力 profile）：
   `npx @deepseek-ai/dsh@<ver> plugin --profile sb-rg-* add file:/…/dsh-recency-guard`
   → 后台启动 web → 看日志（无 skipping 警告）→ 冒烟 → 用户旅程。
3. 通过后才更新主力 profile（由用户重启主力 dsh）。
4. 归档重置后不继承旧结论；「举他」用最新项目事实。

## 7.1 沙箱部署三坑（cycle-4 实测，详见 archive/cycle-4 旅程报告）

| 坑 | 指纹 | 正确做法 |
|---|---|---|
| `file:` 依赖静默落盘拷贝 | 改源码沙箱无变化；`Get-Item <pkg>.LinkType` 非 Junction | 删掉重链 `mklink /J`；挂载后**必查 LinkType** |
| bundle 层未选择 | 无任何警告；路由 404 + cordis.patch.yml 无守护行 | 插件必须同时出现在 dependencies 与 `dsh.profile.bundles` |
| 会话内启动沙箱 | `error: select a profile only once` | 先 `Remove-Item Env:DSH_PROFILE`（会话继承 desktop 的 profile 标记） |

## 7.2 沙箱必须用 shipped 模板（v0.7 实测，比上面三坑更隐蔽）

| 坑 | 指纹 | 正确做法 |
|---|---|---|
| **手写官方包版本 pin** | 启动日志刷 `disabling profile plugin row "…": … 0.2.1-rc.5 is incompatible with dsh 0.2.2-rc.1`，二十余行 | **不要写 pin**：`dsh sb-rg-c5 --from-default-profile web` 生成模板，官方 bundle 由运行时解析 |
| 把「端口在听」当启动成功 | 有 token 行、能开 UI，但只有一行 `warning: N entry did not activate` | 逐条核对 §2.2 四条判据，见 [verification.md](./verification.md) §2.2 |
| 沙箱 profile 里残留 Junction 时用 `Remove-Item -Recurse` 删目录 | **会跟进链接删掉源码仓库** | 先 `Remove-Item <junction> -Force`（只删链接）→ 再 `cmd /c rmdir /s /q <dir>`；删完立刻 `Test-Path src/index.ts` 复核 |

## 8. YAML 写入纪律（v0.7 崩溃级缺陷沉淀）

守护行是**追加**到用户的 `cordis.patch.yml` 里的，因此写入路径必须自证清白：

1. **发射必引号**：`yamlScalar()` 单引号（唯一转义 `''`）；`!!js` 表达式用
   `yamlDoubleQuoted()` 完整转义 `\` 与 `"`。绝不用 plain scalar。
2. **校验后提交**：`validatePatchText()` 检查整份文档；不通过就**保持原样**返回
   `ok:false`。宁可少一行守护行，不可让 profile 起不来。
3. **原子落盘**：同目录 `.rg-tmp` + rename，崩溃在写入中途也不会得到半截文件。
4. **一次性 pristine 备份**：`<profile>/.recency-guard/cordis.patch.yml.orig`，
   有界（不增长），是回答"守护插件到底改了我什么"的唯一凭据。
5. **重复行 id 直接拒绝**：Loader 遇 `duplicate loader entry id` 会抛错，
   这必须在写入前拦下，不能指望调用方记得去重。

修复既有污染用 `npm run repair-patch -- <profile 目录> [--dry-run]`。
