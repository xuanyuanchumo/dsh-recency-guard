## v0.10 新增（可观测性数学增强 + 洞察卡 + 插件信息/反馈入口）

- **转移矩阵卡（马尔可夫链）**：阶段行为的「去向分布」——monitoring 是健康值守
  （80% 留在自己）还是高危巡逻（40% 掉进 crashed）一眼可见；幂法迭代求平稳分布
  （ε=1e-9，L∞ 判敛），回答「长期来看守护停在哪个阶段」。样本不足时诚实显示
  「不可判定」，白名单外迁移被丢弃且如实计数。
- **控制带（休哈特单值-MR）**：崩溃间隔的 x̄±3σ̂（σ̂=MR̄/1.128）控制带，
  区分「偶然波动」与「特殊原因」——哪一次间隔越界（崩溃变密）被点名到序号；
  与 CUSUM 变点、回归斜率、生存分析互为视角（趋势看方向，控制带看单点越界）。
- **数据流卡**：journal 原文 → 事件投影 → 语义流动 → 面板渲染的四环链路白盒，
  每环带说明与计数 —— 「画面上的事实从哪来、经过什么变换」不再靠猜。
- **系统诊断卡 + 插件信息面板 + 反馈入口（R18）**：插件版本 / 宿主版本 / 运行环境 /
  **分区键** / 数据面状态 / 快照耗时一卡尽览；仓库链接来自 package.json 的
  `repository`/`bugs`，「问题反馈」按钮直达 GitHub Issues（未登记时隐藏按钮，
  绝不放死链）；工具 `status` 的命令窗口输出同步携带这两条。
- **命令窗口显示修复（R10）**：`rescue.mjs` 的 status/history 输出按 CJK 显示宽
  （全角 2 列）对齐 —— 中文标签与英文值混排不再错位（rescue 零依赖纪律不变，
  宽度判定内联实现）。

## v0.9.1 新增（判定可视化）

- **恢复判定条**：崩溃后的分级判定现在到达用户可见面 —— 面板生命周期卡片顶部
  显示「观察中 / 已行动」标签 + 完整判定理由 + 进度（第 N/M 轮，act=false 虚线中性色，
  「观察中」不是错误）；工具 `status` 的 facts 同步携带。undefined（从未崩溃过）
  不渲染假判定。
- **事件流高亮两阶段**：观察轮/恢复判定/两阶段对账的 journal note 在事件流卡片
  用 warn/success 徽标区分（识别 detail 前缀派生语义，存储词汇不变）。

## v0.9 新增（恢复置信分级 + 两阶段提交 + CLI 逃生通道 + 卡片限高）

- **恢复置信分级**：唯一嫌疑是确定性证据（第 1 轮即关闭）；多嫌疑是概率性证据，
  同一头号嫌疑连续 N 轮（默认 2，可配 `confirmRounds`）复现才自动关闭。
  偶发崩溃不再误伤无辜插件 —— 观察轮的崩溃证据链完整保留，供下次判定。
- **两阶段提交 + 重启对账**：关闭动作分 prepared（记录待执行）→ quarantined
  （已生效）两阶段；崩溃打断时下次启动按磁盘现状对账（confirmed/reverted），
  不留半成品状态。
- **CLI 逃生通道**：`node bin/rescue.mjs status|history|decision|archives
  --profile-dir <dir>` —— 宿主起不来时离线读取守护产物（零依赖、只读、
  语义化退出码 2 = 有未恢复崩溃，供脚本联动）。
- **面板备份策略卡片**：时间线备份开关/保留份数/备份根/配置编辑服务可用性
  一目了然（只读投影；改配置走宿主设置页）。
- **卡片固定高度 + 扩大**：每张展开卡片内容区限高 240px 内部滚动（窄侧栏
  180px），视口密度均匀；卡片头部 ⤢ 按钮临时解除限高摊开阅读，与折叠态独立。

## v0.8 新增（备份增强 + 官方实验插件观测 + 事件驱动）

- **时间线备份**：插件更新时自动把「更新前」的配置快照存为 `<版本>@<时刻>.json`，
  每插件默认保留 5 份（可配），更新前后的配置可逐版对账 —— 回答「升级后行为变了，
  是配置变了还是 bug」。工具 `action=backups` 同时报告最近备份与每插件时间线。
- **自定义备份目录**：配置 `backupRoot` 或环境变量 `RECENCY_GUARD_BACKUP_ROOT`；
  自定义根下仍按分区键分层，多项目隔离不因集中存放而失效。
- **官方实验插件观测**：`@deepseek-ai/dsh-experimental-*` 只记录不关闭
  （journal `official-observe` 事件 + 整组状态的时间线备份）。它们是官方的
  实验场，崩溃概率最高，但自动关闭官方组件的风险不可接受 —— 现在崩溃归因时
  能回答「当时装了哪些实验组件、什么版本、什么状态」。
- **事件驱动变更检测**：订阅宿主 `plugin-manager/changed` 事件（500ms 防抖），
  GUI/工具路径的安装更新**立即**进时间线与嫌疑面，不用等重启。CLI/手工编辑
  不发此事件，仍由每次启动的同步 diff 兑底 —— 事件是加速器，不是唯一真相。
- **嫌疑排名显示修复**：数据层不再截断（曾 slice(0,10) 且渲染又 limit 5，
  「报 N 只列 5」）；命令窗口列 15 条带省略计数，面板默认 15 条 + 「展开其余 N 个」。

# dsh-recency-guard

**插件崩溃恢复守护** —— 解决"添加或更新第三方/实验性插件导致 DSH 崩溃、必须禁用所有插件再逐个添加"的问题。

当某个插件把 DSH 拖垮时，本插件会在崩溃的那一刻记录下"谁最可疑"，并在**下一次启动时、在崩溃插件的代码被加载之前**把它挡在门外。反复崩溃时，关闭的插件会逐个增加（第 1 次关最近更新的 1 个，仍崩溃则关最近更新的 2 个）。稳定之后，除首要嫌疑外，其余被关闭的配置会自动恢复。

## v0.11.2 紧急修复（恢复诚实性 + 启动恢复时序）

- **恢复结果白盒化（P0 假绿修复）**：`reenable` 此前**无条件**返回
  `reenabled: true` 并从 `autoDisabled` 移除 —— 实测管理器返回
  `application: 'failed'`（HMR 嵌套事务）时，state 仍记「已恢复」，面板/工具
  显示成功而插件实际仍关闭。现在只有**真的 applied** 才算成功；失败者保留在
  自动关闭名单待下轮重试，journal/note 如实列出「未启用（管理器拒绝）」。
- **启动恢复延后到 HMR 事务之外**：boot 阶段 Loader 自身可能正处在事务中，
  恢复调用会报 `HMR transactions cannot be nested`。自动恢复改为 boot 后
  1.5s 执行（定时器 unref，不拖住宿主退出），失败由诚实结果兜底。
- 回归：host 工具测试新增「管理器拒绝 ⇒ reenable 报失败」断言；14/14 全绿。

## v0.11.1 紧急修复（宿主兼容 + 启动崩溃 · 2026-11-08）

**事故背景**：桌面端 DSH 自动升级到 `dsh 0.2.2-rc.1` 后连续崩溃（5 次/3 分钟），
守护插件被兼容闸门移出 profile、不再保护；重新挂载后又因遗留写锁把宿主拖进
`fatal load failure`。本版本修复三处，全部是「守护不能拖垮宿主」的底线问题。

- **宿主预发布版本兼容（P0）**：`engines.dsh` 与全部 `@deepseek-ai/dsh-*`
  peer 范围改为显式预发布分支
  `>=0.2.1-rc.5 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || >=0.2.3-rc.1 <0.3.0-0`。
  原因：node-semver 只放行「与范围中某个比较符 **major.minor.patch 元组相同**
  且自身带预发布标签」的预发布版本 —— 旧范围 `>=0.2.1-rc.5 <0.3.0-0` 会
  静默排除 `0.2.2-rc.1`，插件被兼容闸门判为不兼容并从 profile 移除。
  已在 `dsh 0.2.2-rc.1` 干净沙箱（sb-rg-v0111）实测安装 + 启动 + 守护激活通过。
- **启动绝不抛出（P0）**：`boot()` 失败改为**降级留痕**（步骤记失败 + 警告
  日志），不再 rethrow。此前一个可恢复的写锁超时会把宿主变成
  `dsh: fatal load failure`（退出码 1）—— 观测/恢复设施不能拖垮主流程。
- **失效写锁自愈（P0）**：新增 `cleanStaleLocks`（Store.init 启动时清理 +
  `updateState` 超时后清理重试一次）。判据：锁内容为空/非正整数 PID（不完整
  记录，atomic-write 永远无法接管）/ PID 对应进程已死，且文件年龄 > 5s
  （避开锁创建与写 PID 之间的零字节窗口，绝不抢活锁）。
  真机事故：崩溃恰好发生在锁创建与写 PID 之间，遗留 0 字节
  `state.json.lock`，此后每次启动都等满超时并致命。
- **连续崩溃兜底升级（P0）**：`assessConfidence` 新增安全网 —— 累计崩溃
  `crashSeq ≥ 3` 时即使概率计数未达 `confirmRounds` 也强制行动；同时
  `readCrashHistory` 跳过启动时的「无嫌疑 crash-detected」记录。实测该记录
  每轮打断连续计数，导致 crashSeq 涨到 3 仍停在「观察中 1/2 轮」，崩溃循环
  永远无法自愈。
- 测试：新增 `tests/unit/store-lock.test.ts`（锁自愈 11 断言）与契约层
  预发布范围守卫；14/14 全绿（Core 7 / Host 2 / Client 4 / Contract 1）。

## v0.11 新增（数据面安全 + 图谱图例一致性 + 马尔可夫去向可见 + 市场准备）

- **动作路由方法守卫（P0 安全修复）**：`/action/archive|reenable|restore|recover`
  此前不检查 HTTP 方法 —— `GET /recency-guard/api/action/archive` 也会执行归档重置
  （浏览器预取/爬虫/误点链接都可能触发）。现在非 POST 一律 405 + `allow: POST`。
- **`?partition=` 真正生效（P0）**：客户端一直拼分区查询参数，但数据面此前从不读它
  —— 跨分区查看永远静默返回当前分区。现在快照路由在宿主侧实现分区感知：
  请求其它分区返回**只读磁盘投影**（状态/日志/决策/备份），运行时字段如实标注
  归属，未知分区返回 `available:false`（绝不假绿）。
- **面板动作面补齐**：新增 `/action/restore` 路由 + 面板「恢复非嫌疑插件」按钮
  （工具早有此动作，路由此前缺失）；暂停轮询时 footer 显示「数据已停留 N 分钟」。
- **图谱图例一致性（P0）**：图例颜色此前固定语义色调色板，切到「按类型」口径时
  与节点实际颜色不一致；现在图例色**跟随当前着色口径**（legendColorOf），并直接
  绘制节点形状（形状=第二编码通道，图例不展示它就只对知道映射的人可读）。
- **搜索循环跳转**：多匹配时回车依次遍历（第 n/m 指示可见），不再永远停在第一个；
  「重置」按钮现在同时清掉拖拽偏移（此前节点拖飞后只能刷新页面）。
- **马尔可夫跨阶段去向（P0）**：矩阵卡此前只渲染自环概率条 —— `monitoring → 崩溃
  40%` 这类核心去向分布（README 宣称的）在界面上根本看不到。现在每行带 top-2
  跨阶段去向徽标。
- **事件流展开**：默认 12 条 + 「展开其余 N 条」显式计数（与嫌疑排名同款纪律，
  数据层给全量、显示层管截断）。
- **测试盲区补齐**：新增 `tests/client/graph-model.test.ts`（过滤共源/布局确定性/
  图例同源/平行边曲率）与 `tests/host/routes.test.ts`（方法守卫/partition/参数
  校验/请假语义）—— 文件头「已由测试钉死」的注释如今成真。13/13 全绿。
- **参考插件取长补短**：系统研究 dsh-ops（输出 notice 三要素）、dsh-compat-guardian
  （reconcile 自愈/原子写/乐观锁）、dsh-context（工作预算/资源自适应）、
  dsh-cookie-guard（独立救援 CLI）后按审计清单采纳落地；研究报告见
  `.cycles/cycles/cycle-6/参考插件研究报告.md`。
- **插件市场准备**：仓库 topics（dsh-plugin 等）补齐、256px 图标、screenshots.json
  声明、投稿 YAML 按 awesome-dsh-plugin contributing.md 形态定稿。

## v0.7 新增（崩溃级修复 + 可交互图谱 + 可观测性白盒化）

**先说最要紧的一条：v0.6 会把 profile 写崩。**

- **崩溃级修复：守护行 YAML 注入**。v0.6 写入守护行时 `name:` 没有加引号，
  而 YAML 把 `@` 列为保留指示符 —— 于是任意 scoped 包（`@linxin666/...`）
  都会让**整份 `cordis.patch.yml` 不可解析**，DSH 起不来。真机桌面 profile
  已中招（第 185/189/193 行）。v0.7 改为「永远引号 + 写前校验 + 原子回滚 +
  pristine 备份」三层防线，并提供 `npm run repair-patch` 修复既有污染。
- **静默失效修复**：`apply` 里直接读未 `inject` 的 `ctx.configEditor` 会抛错，
  表现为「端口在听、UI 能开，但插件根本没激活」（日志只有一行
  `warning: 1 entry did not activate`）。改走 `tryReadService` 后消失。
- **可交互图谱**：hover 高亮 + tooltip、点击选中联动详情、搜索过滤、
  布局切换、缩放平移钳制；**fit 只做一次**，数据轮询不重置用户缩放
  （实测 7 秒轮询零变化）。滚轮改用原生非 passive 监听，
  修掉「缩放时页面跟着滚」。
- **面板自己滚动（v0.7.1）**：宿主槽位是 `overflow:hidden` 且整页不滚，
  面板内容约 4000px 被裁到一屏 —— 下方指标/能力清单/归档根本看不到。
  面板改为自带滚动容器（`height:100%` + `min-height:0` + `overflow-y:auto`
  + `overscroll-behavior:contain`），实测可滚到 `scrollTop=3361` 并看到底部归档区。
  滚轮分工同步调整：**普通滚轮滚动面板，Ctrl/⌘ + 滚轮缩放图谱**
  （缩放入口仍在工具栏三个按钮上）。
- **可观测性白盒化**：每个指标都带 `formula` / `inputs` / `sampleSize` /
  `confidence`；不可判定时 `defined=false` 且**给原因**（"没有崩溃样本"），
  绝不把无数据当 0。CUSUM 变点按**相邻崩溃间隔**回归（不是时间戳、不是累计计数）。
- **能力闭环**：能力清单与注册处双向比对；`consumes`/`consumedBy` 方向修正；
  21 项能力、对外暴露 12、连通率 100%、孤立 0（面板可见）。
- **8 条数据面路由全部可用**（曾出现 `isolation` / `lifecycle` 500，
  根因是 RouteContext 缺 provider）。
- **模块拆分降复杂度**：`patch.ts` 142 → `patch-scalar.ts`(87) + `patch-yaml.ts`
  + `patch.ts` 门面，band-detector `Status: OK`。

## v0.6 新增

- **崩溃压力（EWMA）**：新增 KPI「崩溃压力」——EWMA 平滑的近期崩溃密度
  （半衰期 5 次启动）。同样 1/3 的崩溃率，崩溃集中在最近时压力更高，
  这是整体崩溃率给不出的时间局部性。无观测样本时诚实显示「不可判定」。
- **归档摘要**：归档清单（工具 `archives` / 面板归档卡片）现在带 manifest
  摘要——那次归档时的崩溃次数、事件数、被关插件。「举他对照」时能看到
  基线事实，而不只是「归过档」。
- **隔离可见性**：工具 `status` 输出新增「工作区 · 分区」行，命令窗口可
  对账「这次守护是哪个项目的事实」；面板 header 显示可读项目名 +
  完整工作区路径（悬停全文），哈希前缀退居兜底。
- **图谱邻居导航**：节点详情侧栏新增上游（生产方）/下游（消费方）邻居
  列表，点击即跳转定位——度数回答「有几条边」，邻居回答「连到谁」。

## v0.5 新增

- **图谱交互二次增强**：节点拖拽重排（布局偏移跨轮询保持）、搜索定位（id/标签/引用三级优先匹配，回车跳第一个）、节点详情侧栏（完整 id + 度数 + 定位按钮）、双击节点视口居中、贝塞尔曲线边（同一对端点的平行边奇偶交替弯曲，方向可辨）、高亮边带生产/消费语义标签。
- **面板现代化**：KPI 摘要条置顶（稳定性 SVG 圆环、当前阶段、崩溃率、趋势判定、CUSUM 变点一览）；崩溃间隔统计（中位/CV）与 CUSUM 变点接入指标卡片；轮询暂停/恢复开关（调试截图时画面不再跳动）；卡片可折叠（折叠态记入 localStorage，跨会话保持）。
- **性能债清理**：图谱 id→node 索引由「每条边重建一次」改为「每个节点数组建一次」（O(E·V) → O(V)），节点上百时轮询不再卡顿。

## v0.3 新增

- **能力闭环可证**：能力清单（注册/生产/消费）与实际注册面双向比对（契约测试 100% 层），三类缺口（消费断链/过度生产/孤立）可检出。
- **生命周期状态机**：六阶段白名单迁移（idle/monitoring/crashed/deciding/stabilizing/recovered），非法迁移被拒且不改状态，迁移历史带原因与时刻。
- **可量化可观测**：崩溃率/平均恢复耗时/检出率/隔离纯度/稳定性评分/风险评分/崩溃趋势七个读数，**不可判定时为 null 而非 0**。
- **管理面板 + 可交互图谱**：`main` 与侧栏双席位，滚轮缩放以指针为锚、拖拽平移、点击高亮追溯（BFS）、Esc 一次退出；响应式（窄屏单列）、主题变量驱动。
- **多项目隔离**：状态按**项目目录**分区（哈希键），A 项目崩溃不影响 B；守护行经指针文件搭桥。
- **归档重置 + 举他**：归档 = 搬走 + 留档（manifest 先读后搬），重置后不继承旧结论、按最新 node_modules 事实重推嫌疑；另一工作区可只读清单作对照。
- **质量评审体系**：Core/Host/Client/Contract 四层测试 + 类型/lint/构建/依赖审计全零门禁（npm audit high:0 critical:0）。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [工具](#工具recency_guard)
- [数据文件](#数据文件)
- [恢复流程](#恢复流程)
- [安全边界](#安全边界)
- [开发与测试](#开发与测试)

---

## 它解决什么问题

在 DSH 里添加或更新一个第三方 / 实验性插件后，DSH 可能直接崩溃退出：

```
dsh: fatal uncaught exception: Error: ...
```

崩溃发生在插件启动阶段，所以此时**插件本身已经无法运行**，也就无法自己写任何恢复逻辑。传统做法是：手动禁用所有插件 → 重启 → 逐个加回 → 每次重启验证。这既慢又容易再次踩坑。

本插件把这件事自动化：

| 步骤 | 传统做法 | 本插件 |
| --- | --- | --- |
| 记录安装/更新日期 | 靠记忆 | 自动写入日志（崩溃也不丢） |
| 备份插件配置 | 靠手动复制 | 自动备份到 `.recency-guard/backups/` |
| 崩溃后定位嫌疑 | 靠猜 | 按"最近更新"排序 |
| 禁用插件 | 手动改配置 | 自动写入决策文件，重启即生效 |
| 反复崩溃 | 重复手工操作 | 第 2 次崩溃自动多关一个 |
| 恢复配置 | 手动逐个加回 | 非首要嫌疑自动恢复 |

---

## 工作原理

### 1. 崩溃是怎么发生的

DSH 的 Loader 会捕获插件 `apply` 中抛出的错误，让该插件失效但不影响其它部分。真正致命的是**未被捕获的 rejection / 未捕获的异常**：Harness 的 fail-loud 处理器会把它们变成一次 `exit(1)`，整个 DSH 随之退出。

这意味着恢复**必须发生在崩溃插件被加载之前**，而不是之后。

### 2. 崩溃检测：进程级哨兵

Harness 在**正常退出和崩溃时都会**释放插件的 fiber，所以插件的 `dispose` 回调无法区分二者。能区分的是**退出码**：正常退出是 0，崩溃是 1。

因此本插件在**进程级**注册 `process.on('exit')`（不是 fiber 级 —— cordis 的 disposer 逆序执行，fiber 级的监听器会在进程真正退出前被移除）：

- 退出码非 0 → 写入 `.recency-guard/crashed` 哨兵文件
- 同时**同步**写出 `.recency-guard/decision.json` 恢复决策

### 3. 恢复决策：在插件被加载之前生效

Loader 支持给 patch 行写一个 `disabled: !!js "<表达式>"`。关键在于：**Loader 在导入该行的模块之前就会求值这个表达式**。

本插件为每个第三方插件在 profile 的 `cordis.patch.yml` 中写入这样一行（安装时自动完成）：

```yaml
- id: some-third-party-plugin
  name: dsh-some-third-party-plugin
  disabled: !!js "(() => { try { const fs = process.getBuiltinModule('fs'); const profile = ctx.get('profileContext'); if (!profile || !profile.dir) return false; const file = profile.dir + '/.recency-guard/decision.json'; if (!fs.existsSync(file)) return false; const decision = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(decision.disable) && decision.disable.includes('dsh-some-third-party-plugin'); } catch { return false } })()"
```

表达式读取上一轮崩溃时写下的决策文件，命中就把该插件挡在门外 —— **崩溃插件的代码根本不会被加载**，崩溃自然不会重演。

> 表达式运行在 Loader 的 `with (ctx) { eval(expr) }` 作用域里：有 `ctx` 和 `process`，没有 `require`。`process.getBuiltinModule('fs')` 在该作用域可用，因此表达式能同步读到决策文件。

### 4. 为什么要"崩溃时"而不是"下次启动时"写决策

Loader 并发创建各个行。如果等到下次启动、守护插件自己加载时才写决策，决策可能**晚于**嫌疑插件那一行的求值，竞态会让嫌疑插件照常加载。

所以决策在**崩溃退出的那一刻**就写好：那时决策文件已经在磁盘上，下一次启动的第一个被求值的就是它。

### 5. 嫌疑排序

嫌疑 = profile 里声明的、**非官方**（`@deepseek-ai/*` 除外）、且**不是本插件自己**的依赖。排序依据：

1. 日志中的安装/更新事件（权威）
2. `node_modules` 的 mtime（首次运行时兜底）

排除官方包是为了保证恢复机制永远不会误伤 harness 自身；排除本插件自己，是因为关掉它就等于关掉恢复机制。

---

## 安装

### 在主力 profile 中安装

```bash
dsh plugin --profile <profile名> add dsh-recency-guard
```

安装后重启 DSH。本插件会在启动时自动：

- 在 profile 的 `cordis.patch.yml` 中为每个第三方插件写入守护行
- 开始记录安装 / 更新日志

> **安装顺序**：`dsh-recency-guard` 必须排在被守护插件**之前**，这样它才能在启动阶段完成守护行的安装。请在 profile 的 `package.json` 中确认：
>
> ```json
> "dsh": { "profile": { "bundles": [
>   "@deepseek-ai/dsh-base",
>   "dsh-recency-guard",
>   "dsh-你的插件"
> ] } }
> ```

### 从本地源码安装（开发）

```bash
dsh plugin --profile <profile名> add file:/绝对路径/dsh-recency-guard
```

### 插件市场

本插件已提交 [awesome-dsh-plugin](https://github.com/xuanyuanchumo/awesome-dsh-plugin) 收录（`security` 分类），
收录后即可在 dsh 0.2.1+ 的 **Plugins → Discover** 中搜索到（索引源
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`），也可通过
[dsh-market](https://github.com/dsh-market/dsh-market#readme) 一键安装。
npm 发布后市场索引会自动携带 npm 版本；GitHub-only 期间用上面的命令安装。

---

## 配置

在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: recency-guard
  name: dsh-recency-guard
  config:
    enabled: true              # 总开关；false 时只记录，绝不自动关闭
    includeExperimental: true  # 是否把 experimental/beta 命名的包算作嫌疑
    maxAutoDisable: 2          # 单次恢复最多关闭几个嫌疑插件
    autoRestore: true          # 稳定后自动恢复非首要嫌疑的配置
    confirmRounds: 2           # 概率性证据的行动阈值（唯一嫌疑不受限）
    versionedBackups: true     # 插件更新时写带版本的时间线备份
    backupRetain: 5            # 每插件保留几份时间线备份
    backupRoot: ''             # 备份自定义目录（留空=profile 内分区目录）
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后插件只记录日志，永不自动禁用任何插件 |
| `includeExperimental` | `true` | 实验性/beta 命名的包是否算嫌疑 |
| `maxAutoDisable` | `2` | 单次恢复最多关闭几个。崩溃次数递增，但封顶于此值 |
| `autoRestore` | `true` | 稳定启动后自动重新启用非首要嫌疑 |
| `confirmRounds` | `2` | 多嫌疑时同一头号嫌疑连续 N 轮崩溃才自动关闭（唯一嫌疑第 1 轮即行动） |
| `versionedBackups` | `true` | 插件更新时写「带版本的时间线备份」，可逐版对账 |
| `backupRetain` | `5` | 每个插件保留的备份份数（超出删最旧） |
| `backupRoot` | `''` | 备份自定义目录；环境变量 `RECENCY_GUARD_BACKUP_ROOT` 优先 |

---

## 工具：`recency_guard`

| action | 作用 |
| --- | --- |
| `status` | 查看崩溃状态、嫌疑排名、被自动关闭的插件、备份列表；输出带「工作区 · 分区」行（多项目时对账归因） |
| `history` | 查看安装 / 更新 / 崩溃 / 关闭 / 恢复的完整日志 |
| `recover` | 立即按"最近更新"执行一次恢复关闭（无需等崩溃） |
| `restore` | 重新启用被自动关闭的非首要嫌疑插件 |
| `reenable` | 手动重新启用指定插件（`bundle` 参数） |
| `backups` | 列出配置备份 |
| `archive` | 归档当前产物并重置（按最新事实重新开始） |
| `archives` | 列出历史归档，带 manifest 摘要（崩溃次数 / 事件数 / 曾关插件） |

示例：

```json
{ "action": "status" }
```

---

## 数据文件

全部位于 profile 目录下：

```
<profile>/.recency-guard/
├── current.json          # 指针文件：当前分区键（守护行的 disabled 表达式经它搭桥）
├── partitions.json       # 分区索引：项目 → 分区键（多项目隔离的登记处）
├── projects/<分区键>/    # 每个项目的分区目录（状态/日志/决策完全独立）
│   ├── journal.jsonl     # 只追加的事件日志：install / update / crash-detected / disable / restore …
│   ├── snapshot.json     # 上次观测到的 { 插件名: 版本 }，用于识别更新
│   ├── state.json        # 崩溃计数、被自动关闭的插件、已恢复的插件
│   ├── decision.json     # 本轮要拦截的插件（守护行的表达式读它）
│   ├── crashed           # 崩溃哨兵：非零退出码时写下
│   ├── observation-*.json # 观测快照（启动事实，量化指标的数据源）
│   ├── archive/          # 本分区的历史归档（搬走+留档）
│   └── backups/          # 关闭前备份的配置（versionedBackups 时带版本）
└── …
```

---

## 恢复流程

```
第 1 次崩溃
   └─ 退出码非 0 → 写哨兵 + 决策（关闭最近更新的 1 个嫌疑）
第 2 次启动
   └─ 决策文件已就位 → 嫌疑插件的模块不被加载
      ├─ 仍然崩溃 → 关闭数 +1（最近更新的 2 个）
      └─ 启动成功 → 视为恢复
第 3 次启动（稳定）
   └─ 自动重新启用除首要嫌疑外的插件
      └─ 首要嫌疑保持关闭，等你确认后用 reenable 手动开启
```

**首要嫌疑**（最后被关闭的那个）会一直保持关闭，直到你明确用 `reenable` 开启它 —— 避免刚恢复就再次崩溃。

---

## 安全边界

本插件在设计上刻意保守：

- **只碰第三方插件**：`@deepseek-ai/*` 官方包永远不是嫌疑，harness 核心不会被关掉。
- **不碰自己**：`dsh-recency-guard` 永远不在嫌疑名单里。
- **决策文件缺失 / 损坏时一律放行**：表达式在任何异常下都返回 `false`，插件照常加载。守护机制**永远不会**把 profile 锁死在插件之外。
- **无法读取时不影响启动**：所有文件操作都包在 `try/catch` 中，失败只记录日志。
- **官方包与 harness 组件不受影响**：崩溃检测只影响"用户自己加的插件"这一层。

---

## 开发与测试

```bash
npm install
npm run build        # esbuild 双产物：dist/index.js（宿主）+ dist/client.js（客户端）
npm run typecheck    # tsc --noEmit
npm test             # 分层测试（Core/Host/Client/Contract）
```

工具行为测试需要 DSH 运行时包（harness 由应用提供，不在 profile 的 node_modules 中）：

```bash
npm run extract-runtime   # 从 DSH 安装目录解出运行时包到 .tmp/runtime
```

### 沙箱验证

开发时务必在独立沙箱 profile 中验证，不要动主力 profile：

```bash
dsh plugin --profile sb-recency-guard add file:/绝对路径/dsh-recency-guard
dsh --profile sb-recency-guard --help
```

---

## 许可证

MIT
