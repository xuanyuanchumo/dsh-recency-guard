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
