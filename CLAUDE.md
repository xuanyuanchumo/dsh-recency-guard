# dsh-recency-guard

## Commands
- Build: `npm run build`（esbuild 双产物：dist/index.js 宿主 + dist/client.js 客户端）
- Test: `npm test`（分层统一运行器：Core/Host/Client/Contract）
- Lint: `npm run lint`（tsc --noEmit --noUnusedLocals --noUnusedParameters）
- Typecheck: `npx tsc --noEmit`
- 解出宿主运行时（Host 测试前置）: `npm run extract-runtime`
- 依赖审计: `npm audit --json`（走 .npmrc 官方 registry）

## Verifying your work
- 依次跑 build → typecheck → lint → test，全部零错误才算完成。
- 宿主层测试需要 runtime/（由 extract-runtime 产出）；缺失时先解出再跑。
- 贴出命令输出作为证据；「无法评估」≠「通过」。
- 沙箱验证用独立 profile（sb-rg-*），绝不碰 desktop/web 主力 profile。

## Conventions
- **架构两层**：`src/index.ts`（host 入口）+ `src/host/<domain>/` + `src/client/<area>/` + `src/shared/`。依据 dsh 规范：先按运行时切（`client`/`host` 是不同 bundle），再按功能域分。详见 `docs/agents/architecture.md`。
- **`client/` 不得 import `src/host/**` 与 `node:*`**（`import type` 豁免）。由 `tests/contract/client-host-boundary.test.ts` 守护 —— 它抓到过 11 处真实越界。
- **跨运行时共享的东西放 `src/shared/`**（类型 / 纯常量 / 无副作用纯函数）。`shared/` 不得 import `host/` 或 `client/`。两份定义必然漂移：`LAYOUT` 各写一份会让小地图点击整体偏移且不报错。
- **类型环不算架构违例，值环算**。类型在编译期擦除；值依赖会让「换实现」变连锁改动。
- 中文注释必须说明「为什么这样写」，不复述代码在做什么。
- 能力清单（capability-specs.ts）是**投影，不是第二真相源**；真相在注册处，契约测试做双向比对。
- 指标不可判定时为 `null`（Metric.defined=false），绝不把「无数据」当「零」。
- 状态机迁移用白名单表；非法迁移返回 false 不抛异常（观测设施不拖垮守护流程）。
- 只用 `--dsw-alias-*` / `--dsw-radius-*` 主题变量；硬编码颜色仅限 SVG 图形本身。
- Loader 四件套（name/inject/Config/apply）之外不导出任何东西。
- webServer 依赖放在独立路由子插件（routes-plugin.ts），避免 headless 下 fiber 挂起。
- 路由路径必须是 src/routes.ts 里的**字面量**（契约测试核对）。
- 守护行安装、启动记录、崩溃决策全部**同步 IO**（异步会输给崩溃）。
- 归档 = 搬走 + 留档（manifest 先读后搬）；重置后不继承旧结论。
- dist/、.tmp/、runtime/、.dsh/ 不入库（.gitignore）。

## Things the agent gets wrong
- **崩溃趋势回归时间戳或累计计数都是错的**：必须回归**相邻崩溃间隔**——只有间隔携带「变密/变稀」方向（斜率恒 1 / 方向丢失是实测踩过的坑）。
- **归档清单在搬走之后读状态会让摘要永远报 0**：manifest 里的 crashSeq/autoDisabled 必须在 rename 前读取。
- **consumes/consumedBy 方向写反**：consumes = 我消费谁；consumedBy = 谁消费我。旧字段名 consumers/producers 方向相反，已实测修正。
- **守护行的 disabled 表达式拿不到分区键**：分区键由 cwd 算出，表达式只有 ctx + process ⇒ 必须用指针文件（.recency-guard/current.json）搭桥。
- **bundleMtimes 等兜底数据要同步变体**：崩溃路径上 await 之后进程已死。
- **图谱 fit 不能在每次数据轮询时重跑**：必须 ref 守卫只 fit 一次，否则用户缩放被重置。
- **一个包的守护行只装第一行**（代表行），装多行会在 Loader 重复 id 抛错。
- **评估器把 test-reports 目录不存在判 FAIL**：每轮循环要落盘 test-reports/*.md，别只跑测试不写报告。

- **数据层不做显示截断**：工具 status 曾 slice(0,10) 只报 10 个嫌疑，渲染层又 limit 5 —— 「报 N 只列 5」。截断是渲染策略：数据给全量，显示层显式省略计数（面板给展开按钮）。
- **官方实验插件（@deepseek-ai/dsh-experimental-*）只观测不关闭**：isOfficialExperimental = 官方 scope + experimental 命名；进 journal(official-observe) 与时间线备份，绝不进嫌疑面（关官方组件等于卸宿主半边）。
- **事件加速器，启动兜底**：ctx.on('plugin-manager/changed') 覆盖 GUI/工具安装（CLI/手工编辑不发事件）；变更检测永远保留启动时同步 diff —— 事件是加速器不是唯一真相（compat-guardian 纯轮询 + recency 启动 diff 双源实证）。
- **不做高频轮询**：变更检测只跑启动时 + 事件触发（防抖 500ms）；mtime 扫描是启动路径最贵动作，绝不进定时器（compat-guardian 每 30s 全量爬 node_modules 是反例）。
- **威胁模型锚定 requiredStartupEntryIds**：entry 级 apply 抛错宿主只是 warning（自隔离），不崩进程 —— 评估守护能力别用这类失败；真崩溃来自 8 个核心 entry 失败或进程级错误（沙箱对抗实测：夹具的顶层代码根本没被 import）。

## 沙箱与真机（v0.12 实测新增）
- **崩溃信号只有哨兵 = 漏掉一半死法**：哨兵写在 `process.on('exit')` 里，而 SIGKILL/OOM/断电/原生崩溃**不跑 exit 处理器**。强杀后 `bootMarker` 残留而 `crashSeq=0`，面板照报「未发现上次崩溃」，崩溃循环因此失去升级依据（永远停在关 0 个）。第二条通道：残留标记 + `pidAlive` + 累计到 `confirmRounds` 才动手（概率性证据，人为杀进程也是这个形状）。
- **boot 重入 ≠ 并发实例**：热重载会在**同一 pid** 里重跑 boot 并再写一条启动记录。只看「pid 还活着」就会报「检测到另一个实例」——让人去查一个不存在的进程。必须先判 `残留 pid == 本进程 ⇒ self-reload`。
- **`?.` 不防抛异常**：`setPointerCapture?.(id)` 在 pointerId 失效时按规范抛 `NotFoundError`；它排在 `onNavigate` 之前 ⇒ 点击小地图毫无反应（真机实测）。可选优化不得排在主功能之前，且这类调用必须 try 包裹。
- **从 dsh 会话内起子 dsh 会继承 `DSH_PROFILE/DSH_PROFILE_DIR`**，它们压过 `--profile`；`env -u` 在本执行器下无效。正确形态是 `dsh --profile <name> <app>`（profile 在 app 名之前），且用 `--from-default-profile web` 建干净沙箱。
- **`dsh web --profile X` 是错的**：launcher 会给非 flag 首参自动前置 `--profile` ⇒ `--profile web --profile X` ⇒ "select a profile only once"。子 dsh 实际跑的是 shipped `web` profile（判别证据：日志里出现 `dsh-anic`/`codegraph`）。
- **pnpm 对同版本 `file:` 安装按版本去重**：`plugin add` 报 "Already up to date" 时沙箱副本**没刷新**（改完代码要 `remove` + `add`，或用 `link:`）。验证方式：在沙箱 `node_modules` 里 grep 新代码特征。
- **测试追加到 `process.exit` 之后 = 静默假绿**：core.test.ts 里追加的断言块落在 `main()` 的 `process.exit` 之后，从不执行，而文件照样打印 ALL PASS。追加断言必须插在汇总行**之前**，且看到 PASS 要确认它真的打印出来了。
- **平台事实不是不变式**：`pidAlive(1) === true` 在 Linux 成立（init），Windows 根本没有 PID 1（System Idle 是 0）。测试别把平台事实写成断言。

## 变异测试与断言质量（v0.14 实测新增）

- **关注点缺失不等于代码错误**：`if (omitted > 0)` 改成 `>= 0` 后**没有任何测试变红** ⇒「省略提示是否真的出现」从未被断言。变异测试的第一价值不是那个百分比，而是**指出哪些纪律其实没人守**。
- **断言的锚点必须与实现文案同源**：曾用 `/省略/` 匹配提示，而真实输出是 `其余 N 项未展开` —— 函数里没有「省略」二字。**新测试全绿、变异体却存活**，等于在测一个不存在的字符串。写文案断言要抄被测常量，不要凭印象猜近义词。
- **测试文件的 import 后缀会影响工具的归属判定**：`scripts/mutation.mjs` 按 `${module}.js` 匹配「直接测试」，写 `.ts` 会让该模块的变异体**从未被评估**，而报告只显示「无直接测试文件」——指标没覆盖的东西，指标不会告诉你它没覆盖。**统一用 `.js`**。
- **等价变异体必须归因，不能混进杀灭率**：`i < len` → `i <= len` 在 `arr[i] ?? 0` 兜底下行为不变；`crashSeries` 先 filter 再 sort，使「负间隔」分支**不可达**。把这类算成「测试缺口」会让指标系统性谎报，修工具而不是补假测试。
- **变异体绝不能留在仓库**：用内存保存原文（不落 `.bak`）+ 每个变异体跑完立即恢复 + 四道闸口（SIGINT/SIGTERM/uncaughtException/exit）。中途被强杀时残留从 N 降到 0~1。
- **`\s*` 会跨行**：`i >\n return` 被正则当成一次比较，生成不可解析的变异体，抬高「语法杀死」率。比较运算符周围用 `[ \t]*`。
- **正则切标识符会改错对象**：只写「前一个字符不是运算符」时，`length > 0` 会被从中间切成 `ength > 0`。标识符必须有 `(?<![\w$.])` / `(?![\w$])` 双向边界。

## 数学实现（v0.14 实测新增）

- **`lgamma` 对 x∈(0,1) 用反射式会无限递归**：反射式 `Γ(x)Γ(1−x)=π/sin(πx)` 里 1−x 仍在 (0,1) ⇒ 栈溢出。**只在传入小数 Beta 参数（如 Jeffreys 先验 Beta(0.5,0.5)）时触发**，整数参数的 142 条断言全绿也抓不到。用伽马递推式 `lnΓ(x)=lnΓ(x+1)−ln x`。
- **自证全绿不等于正确，交叉验证才抓得住冷门输入下的定义域缺陷**：上一条是「对 `ln B(1/2,1/2)=ln π` 打点」暴露的，不是自证暴露的。数值代码必须对**闭式解析解**做独立对照。
- **MAD 在 ≥50% 样本同值时退化为 0** ⇒ 控制带带宽为 0 ⇒ 阶跃被静默判成「完全规则，不预警」。需要 IQR → 平均绝对偏差三级后备，并把用了谁写进 `sigmaEstimator` 字段（白盒）。
- **尺度会被待检漂移自己污染**：用整段样本的 MAD/IQR 标准化时，一次 60 倍阶跃被摊进离散度，实测 S 只到 3.4 < h=5 ⇒ 检测器对它要抓的漂移**结构性失明**。改用差分型移动极差（MR̄/1.128，与 control-band 同口径）后 S=21.86 正常越界。
- **EWMA 控制带的带宽必须乘 `√(λ/(2−λ))`**：不乘等于把 σ̂ 直接当带宽，带会宽约 3 倍，漂移永远报不出来。

## 架构重构（v0.15 实测新增）

- **只改目录不改边界 = 白改**：把文件挪进 `src/<domain>/` 之后，`client/graph/graph-model.ts` 仍然直接 `import '../../host/capability/graph-data.ts'`（11 处越界）。目录是给人看的，**边界必须写成测试**（`tests/contract/client-host-boundary.test.ts`）才成立。
- **`export { X } from` 不会把名字带进本文件作用域**：lifecycle.ts 只写转发导致 30+ 处 `TS2304`。要同时写 `import` 与 `export` 两行。
- **`require.resolve('../package.json')` 隐含「本文件在包根下一层」**：搬到 `src/core/` 后 `..` 变成 `src/`，`readSelfPackage()` 静默降级为全 null（面板诊断卡空白，测试直跑源码才暴露）。改成「向上找到 name 与本包一致的 package.json」，两种形态都对。
- **`readdirSync(dir)` 只读一层**：client 分成子目录后，i18n 扫描集变空、变异池变 0 —— 都是**静默**的。凡「扫描源码」的代码必须递归，且要有「扫到了 N 个」的下界断言。
- **重构会同时打断三类隐式路径**：`await import('...')`（没有 `from`，正则漏改）、`join(process.cwd(),'src',...)` 字符串拼接、子进程里拼的模块路径。改完必须 `tsc` + 全量测试双验证，别只看 tsc 绿。

## 团队协作（v0.14 实测新增）

- **并发起 Bash 会触发 dsh-ops 0.5.1 的链接竞争**（`EXECUTOR_UNAVAILABLE`，`effects: none`）。4 个 teammate 并行时高频出现；这不是代码问题，重试即可，别把它当失败证据。
- **teammate 报「tsc/lint 红」要先核对时序**：他们看到的常常是**别人接线中间态**的报错。让每个人 `grep` 自己的文件范围确认再下结论。
- **写入范围必须显式声明并互斥**：4 个 teammate 同时改 `src/observability.ts` / `src/snapshot.ts` / `src/index.ts` 会产生中间态假红。旁路事实拆出独立文件（`status-projections.ts` / `preventive.ts`）既是复杂度纪律也是并发纪律。

## 真机与并发（v0.16 实测新增）

- **长驻 bash 后台 job 会拖垮整个 executor**：`EXECUTOR_UNAVAILABLE` 的真正根因不是「队友并发多」，而是**长时间活着的 bash job**（沙箱 web server）占住 dsh-ops 的 exec-tree。实测连杀 4 次长驻 job 后每次立即恢复。要跑常驻服务 → 用计划任务/独立进程，不要用 agent 的后台 job。
- **变异工具与评估绝不能并发**：变异工具跑每个变异体时**临时改写 `src/**`**，eval-runner 的并行预热同时跑 `npm test` ⇒ 测试读到变异体 ⇒「产品有 bug」的假红（本轮实测 evaluate 因此误判 E3/E8）。已用 `.tmp/mutation.inflight` + `tests/run.ts` 拒绝出结论；**假红比没有红更危险**。
- **「不可复现 ≠ 不存在」**：verify 曾把 `fault-injection` 的偶发红判成"时序抖动"，evidence 用失败保留现场 + `FI_ONLY` 30 轮复现，实锤两个真实竞态（journal 整读整写覆盖崩溃事件；crashSeq 被启动期清零覆盖）。**先保留现场，再谈概率**。
- **`defined: true` 不代表子字段非空**：宿主 `Metric` 的 `defined` 只表示「这个读数可判定」，`intervals.cv` 仍可能是 `null`（附 `cvReason`）。客户端 formatter 写死 `cv: number` + `as never` ⇒ 真机整块白屏。**用泛型 `T | null` 让 tsc 兜底，别用 `as never` 关掉类型检查**。
- **跨运行时类型必须有一张"可空契约"**：宿主会发 `null` 的字段（`partition-snapshot.ts` 的 `key: null`）必须与客户端视图声明一致，并写成契约测试（`panel-snapshot-nullability.test.ts` 静态对码宿主产出）。否则只有用户打开面板时才会炸。
- **几何/排版缺陷只有真机截图能发现**：单测 + tsc 全绿时，初始视图仍会把节点切出视口、`70vh` 在宿主 slot 里不生效、卡片标题被压成竖排。**首屏完整性不变式**（任何节点不得切出视口）要写成纯函数断言，不能靠"看着还行"。
- **变异工具必须按"生成偏移"施加变异**：`indexOf` 会把变异打进**更早出现的注释同形文本** ⇒ 假存活。每条工具修复都要有变异体级自证。
- **「死分支」要先转成可观测再断言**：`quarantine-plan` 的轮数上界原本不可达 ⇒ 任何 off-by-one 变异都等价、杀不死。导出 `roundBudget(P)=P+1` + 可注入 `roundBudget` 后，`cap` / `no-candidate` / `no-error` 三向对照才成为真断言。**别为死分支补假测试**。
- **兜底不能只写日志**：启动路径三处 catch 原来只有 `ctx.logger.warn`（重启后不可查）⇒ 现在各落一条 journal `note` + 机器可读 `degraded: true`。观测设施必须可复核，"降级了但没人知道"等于没降级。
- **等价判定不能照抄上一轮**：`store.ts pid<=0` 原证明引用的是 sentinel 的 `pidAlive`，而 store 侧是另一份 `processAlive`；实测 `process.kill(0,0)` 成功 ⇒ 变异版会保留 pid=0 的锁。**等价理由的 proof 必须来自同一实现**。
