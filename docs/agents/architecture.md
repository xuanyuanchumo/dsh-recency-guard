# 架构与功能域划分（v0.20.0）

> 本文回答一件事：**`src/` 为什么这样分**。
> 它不是目录说明书，而是「每条边界在防哪种缺陷」的论证。
> v0.16.0 新增的 host / client 模块都落在既有域内（确定性冲突与贪心隔离进 `guard/`、
> 锁卫生进 `data/`、可空视图与图谱交互进 `client/`）；发布面收口（`dsh-plugin.json` /
> README / 文档）不改变代码边界。

## 1. 规范依据（dsh 插件开发知识库）

| 来源 | 规定了什么 | 本文如何落地 |
|---|---|---|
| `extra/cookbook/adding-a-package.zh.md` | `packages/<group>/<pkg>/`；**group 是纯容器**（无 `package.json`、无源文件），包恰好在下一层；group 词表含 `client` / `host` / `core` / `util` | 本包是单 package，映射为 `src/<layer>/<domain>/`；`src/index.ts` 是包入口（Loader 四件套必须在包根） |
| 同上 | 「`packages/client/*` 包…声明 `dsh.client`、导出 `./client`」 | 本包 `package.json` 已有 `exports["./client"]` 与 `dsh.client` ⇒ **client 是独立 bundle**，故第一层必须按运行时切分 |
| `site/develop/practice/index.md` | 能力 seam 三角色：**Definition / Provider / Consumer**，Provider 与 Consumer **互不依赖**，两者都依赖 Definition | `src/shared/` 就是 Definition 层：图契约与阶段词汇由 host 与 client 共同依赖，两者互不依赖 |
| `extra/architecture.zh.md` | seam 可替换的前提是「接口稳定、实现可换」 | `shared/` 只放类型 + 纯常量 + 无副作用纯函数 |

## 2. 两层结构

```
src/
├── index.ts                     # host bundle 入口：四件套 name/inject/Config/apply
├── host/                        # 只在宿主进程运行（可用 node:fs / 进程 / 路由 / IO）
│   ├── core/                    #   基础原语：生命周期状态机、revision、分区键、自描述、同步原子写、路径安全投影
│   │                            #     + 产物新鲜度（build-freshness，v0.19）
│   │                            #     + 热重载闭环（reload-self + reload-history，v0.20：
│   │                            #       三铁律取经 anic；史账=跨实例握手状态机）
│   ├── data/                    #   持久化与归档：Store、archive、锁卫生（lock-hygiene）、
│   │                            #     journal 文本层（journal-io，v0.20：坏行计数 degraded 白盒）、
│   │                            #     schema 版本判据（schema-version）
│   ├── adapters/                #   外部格式适配器（v0.20 归位）：patch/ = YAML↔patch-row 三件套
│   │                            #     （patch / patch-yaml / patch-scalar，自 host/profile/ 迁入——
│   │                            #       它们就是外部格式适配器，adapter 层是语义归位）
│   ├── guard/                   #   崩溃守护主线：决策、恢复、信号、异常终止、守护行安装
│   │                            #   + 确定性冲突（conflict-*）、贪心隔离（quarantine-plan）、
│   │                            #     决策组装（crash-decision）、启动编排（boot-orchestration）、
│   │                            #     状态对账（state-reconcile）
│   ├── observe/                 #   观测与数学模型：指标、生存分析、控制带、预防性预警、转移矩阵、共现
│   ├── risk/                    #   风险与归因：新近性、贝叶斯并行读数、误伤校准
│   ├── capability/              #   能力模型与图谱（产出方；v0.20：节点带 domain 域段）
│   └── surface/                 #   对外面：工具注册/分派/渲染、路由、状态投影、面板快照、预防性投影
├── client/                      # 只在浏览器运行（禁止 node:*，禁止 import host）
│   ├── panel/                   #   面板：容器、卡片、洞察、投影、可空视图、错误边界、自适应轮询
│   │                            #     + 在途世代守卫（epoch-guard，v0.19）
│   ├── graph/                   #   图谱：渲染、模型、分析、小地图、视口、交互/布局/调色
│   │                            #     （v0.20：功能域第四过滤维度 hiddenDomains + 域图例）
│   ├── toolview/                #   命令窗口终端卡（v0.19）：tool.call.toolview 席位注册
│   │                            #     + 卡片渲染 + 零 React 依赖的抽取层
│   ├── api/                     #   客户端取数的唯一出口
│   └── i18n/                    #   自持字典
└── shared/                      # 跨运行时契约层（Definition）：只放类型 + 纯常量
```

### 2.1 仓库根的两份 manifest（v0.17.0）

| 文件 | 谁消费 | 声明什么 |
| --- | --- | --- |
| [`../../package.json`](../../package.json) | npm + dsh 安装器 | `main` / `exports["./client"]` / `dsh.bundle.patch` / `dsh.client` / `engines.dsh` / peer 范围 |
| [`../../dsh-plugin.json`](../../dsh-plugin.json) | 社区 manifest 生态（draft v0.15） | `facets.host.entry` / `requires.contracts` / `permissions` / `contributes`（工具、面板席位、路由） |

两者**不是**替换关系：`package.json` 是安装契约，`dsh-plugin.json` 是可审计的能力与权限声明。
版本必须同源（`0.16.0`），且 `dsh-plugin.json` 里每个字段都要能在代码里 grep 到依据——
写不出依据的字段宁可删掉，也不编。

## 3. 每条边界在防什么（不是装饰）

### 3.1 `client/` 与 `host/` 之间 —— 防「浏览器 bundle 误引宿主能力」

**真实缺陷（重构中被抓到的）**：`client/graph/graph-model.ts` 与 `minimap-model.ts`
原本直接 `import { LAYOUT } from '../../host/capability/graph-data.ts'`。
这在开发期不报错（tsx 跑源码时 host 模块随手可引），但 client bundle 一旦打包，
`node:*`／进程 API 会进浏览器图，且**只有当用户真的打开面板时才炸**。

**防线**：`tests/contract/client-host-boundary.test.ts` 做两条静态断言：
1. client 源码不得有 `node:*` 的**运行时** import；
2. client 源码不得 import `src/host/**` 的**运行时**模块。
`import type` 显式豁免（编译期擦除，不进 bundle）——类型可以跨边界，值不行。
该测试还带一条**反向自检**：用合成违规样例验证判据真的会响，
防止正则写错后「永远 0 违例」的假绿。

### 3.2 `shared/` —— 防「两份定义必然漂移」

**真实缺陷**：`LAYOUT`（列宽/行高/节点尺寸）与 `GraphNode` 等类型原本住在 host。
client 的小地图点击换算依赖同一组数字；若 client 各写一份，
host 调列宽后小地图的点击会整体偏移，**而且不会报错**（只是点不准）。
同理 `GuardStage` 与 `STAGE_LABELS` 同时被状态机与面板消费。

**防线**：`shared/graph-contract.ts` 是唯一定义处；host 与 client 都从这里取，
host 侧文件只做 re-export。`shared/` 的纪律写在文件头：只放类型/纯常量/纯函数，
不得 import `host/` 或 `client/`（否则定义层变成第二个实现）。

### 3.3 `host/` 内部的功能域 —— 防「一个文件承担多个领域」

拆分判据是**变化原因**，不是文件大小：
- `observe/` 里的模型（生存/控制带/CUSUM/马尔可夫）都改「怎么度量」；
- `guard/` 里都改「怎么决策与恢复」；
- `risk/` 里都改「谁的嫌疑更大」；
- `surface/` 里都改「怎么把事实呈现出去」。

一个函数如果同时要动「度量方式」和「呈现格式」，说明它跨域了 —— 应该拆。

### 3.4 `index.ts` 留在包根 —— Loader 契约

Loader 从 `package.json` 的 `main` 取入口，`apply` 与 `name/inject/Config` 必须
在入口模块的顶层导出。把它放进 `host/` 会让 bundle 入口变成 `dist/host/index.js`，
偏离规范（也违反项目自己的「Loader 四件套之外不导出任何东西」）。

### 3.5 宿主 ↔ 客户端快照类型 —— 防「声明非空、运行时可空」

**真实缺陷（v0.16 真机）**：宿主 `PanelSnapshot` 把 `stabilityScore` / `metrics` /
`capability` 声明为非空，但跨分区只读视图会发 `null`，且 `Metric<T>.defined === true`
不等于子字段非空（`intervals.value.cv` 在样本 < 2 时是 null）。客户端照抄宿主类型后，
一次 `.toFixed(...)` 就把面板整块打进错误边界。

**防线**：客户端不复制契约，而是用
[`snapshot-view.ts`](../../src/client/panel/snapshot-view.ts) 的 `PanelSnapshotView`
对**已证明可空**的字段做显式放宽（单一「可空清单」），渲染层诚实降级；
[`panel-snapshot-nullability.test.ts`](../../tests/contract/panel-snapshot-nullability.test.ts)
守护这份清单，防止宿主新增可空字段后客户端又回到「类型说非空、运行时炸」。

这条边界的教训与 §3.1 同源：**类型不是运行时事实**，跨层契约必须有测试把「实际可能为 null」
写下来。

### 3.6 `client/toolview/` —— 防「能力实现了但没人消费」

**真实缺陷（v0.19 用户报告「命令窗口显示问题」的根因）**：宿主侧把
`presentCall` / `presentResult` / `presentationMeta` 构造得很完整，
`tests/contract/capability.test.ts` 也有「注册处必须接线」的源码门 ——
**接线是接上了，只是接到了没人消费的那一头**。

官方契约：**内置 Web Client 不消费 `presentCall` / `presentResult`**
（它们只服务于有能力的 UI，如 dsh-ops 自己的 TUI 面板）。落到内置 Client 时，
工具调用退化成 generic 行（参数 JSON + 一坨原始文本），**且不报错、不降级**。

**因此新增一个 client 域**：`tool.call.toolview` keyed slot（key = 工具名）。
宿主会话面板挂载时按工具名查表，命中就用我们注册的组件渲染该行。

这个域的三条边界：

| 边界 | 防什么 | 约束 |
| --- | --- | --- |
| 抽取层零 React | 抽取逻辑要能对着**敌对输入**（null / 数组 / 缺字段 / NaN）做单测 | `toolview-model.ts` 不得 import react（契约测试钉住） |
| 卡片只转述 host 侧事实 | 卡片自己解析正文 ⇒ 结构漂移（两边各写一套） | `facts` / `sections` / `omitted` 只从 `presentationMeta` 取；折叠态也不重新决定 |
| 注册计数用 getter | `inject` 回调是宿主**延迟**调用的（ToolCallTree 挂载时），静态快照会永远停在 0（anic 实测：5 卡片 vs count=0） | `get count()` 而非 `{ count }` |

**元教训**：契约测试能证明「我调了这个钩子」，但证明不了「宿主会消费它」。
凡是「宿主侧投影」类能力，验收必须有一条**消费侧**断言 ——
本轮落成 `tests/contract/toolview-contract.test.ts` + 真机判据
`__RECENCY_GUARD_TOOLVIEW__.count === 1`。

## 4. 依赖方向（唯一允许的方向）

```
            index.ts
               │
           host/**
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
 client/**   shared/**  （client 只依赖 shared，不依赖 host）
               ▲
               └── host/** 也依赖 shared
```

**规则**：`shared/` 不依赖任何层；`client/` 只依赖 `shared/`；`host/` 依赖 `shared/` 与自身域。
`client → host` 与 `host → client` 都是违例，前者有契约测试守着。

## 5. 循环依赖：值图已证明无环，类型环允许

### 5.1 曾经的两个真实环（已修）

```
observability → survival      → observability
observability → control-band  → observability
```

根因不是「模型互相引用」，而是**度量契约与统计原语和具体模型住在同一个文件**：
`survival` / `control-band` 要用 `Metric` 契约、`definedMetric`、`round4`，而它们
只存在于 `observability` ⇒ 只能反向 import ⇒ 环。eval 的 Q5 把它判为 FAIL。

**修法**：把破环所必需的最小集下沉到 `src/host/core/metric.ts` ——
`Metric` / `MetricMeta` 类型、两个构造器、`sampleConfidence` / `displayDigits` /
`round4` / `variance`、以及 `CrashSeries` / `crashSeries`。模型改为依赖原语，
原语不依赖任何模型。`observability` 保留 re-export，既有调用方不必全量改 import。

> 只搬了 10 个符号，没有把 300 行整批搬家 —— 前一次「整批下沉」的尝试因为
> 搬运脚本把私有辅助 `pct` 一起卷走、且把类型与值写进同一个 `export {}`
>（tsx 运行时报 `does not provide an export named 'Metric'`）而回滚。
> 教训：**搬运要按最小必要集 + 类型/值分开导出**。

### 5.2 判据由测试给出，不由评审器的启发式给出

`tests/contract/import-graph.test.ts` 解析 `src/` 全部相对 import，区分**值边**与
**类型边**，用 DFS 找环：

- **值边有环 ⇒ FAIL**（换实现会连锁改动，属架构违例）；
- **类型边有环 ⇒ 允许**（编译期擦除，不产生运行时耦合）。

实测结论：**值依赖图无环**；存在的 1 个类型环是
`surface/tool-render.ts ↔ surface/tool-presentation.ts`（互相引用对方的**类型**），
按上述判据合法，已在测试输出里显式 INFO 记录。

该测试还带反向自检（合成 A→B→A 必须被判出、单向链不得误判、类型回边不算值环），
防止 DFS 写错后「永远 0 环」的假绿。

### 5.3 关于 eval Q5 的结论（v0.20 已闭环）

Q5 两条 FAIL 依据在 v0.20 分别闭环（cycle-18 实测）：

| Q5 的说法 | v0.20 处置 | 结论 |
|---|---|---|
| 「1 circular dependency: `host/profile/patch.ts`」 | **实锤为评估器假阳性**：`patch.ts:143` 注释里的同形文本 `` `from './patch.ts'` `` 被 importGraph 正则当成 import 边构成**自环**（不是此前的「basename 前缀匹配」猜测——归因必须来自实测）。注释措辞改写后假阳性消失（复跑 0 环）；契约测试注释同步修正 | **已修复**（改注释不改判据；判据仍是 anic 上游的，注释同形文本教训已登记 tech-debt 待上游修复） |
| 「No adapter layer found」 | patch 三件套归位 `src/host/adapters/patch/` —— 它们本来就是 YAML↔patch-row 的**外部格式适配器**，adapter 层是语义归位，不是迎合评估器 | **已修复**（真结构归位；引用面 6 文件同步更新，96/96 全绿） |

按 R07（不条件通过）**没有把判据调松**。两条修复都是把真实结构做对，
评估器自然转绿 —— 这也是本节保留完整推理链的原因。

## 6. 验证方式

```bash
npx tsc --noEmit                              # 类型
npm run lint                                  # 未使用导出/参数
npm run build                                 # 双产物（host + client）
npm test                                      # 78 个测试，含边界与可空契约
npx tsx tests/contract/client-host-boundary.test.ts   # 单跑边界门
npx tsx tests/contract/panel-snapshot-nullability.test.ts  # 可空清单门
npx tsx tests/contract/width-parity.test.ts                # 跨实现宽度对拍
npx tsx tests/unit/preventive-wiring.test.ts               # RQ3 只预警不行动（源码扫描）
npx tsx tests/unit/journal-append-race.test.ts            # journal 真追加
npx tsx tests/unit/boot-crashseq-race.test.ts             # CAS 清零
node scripts/mutation.mjs --dry-run           # 变异池是否覆盖新布局（递归）
```

发布面另有两道可核对项（不属于 `src/`，但同属"结构必须写成检验"的纪律）：

```bash
node -e "JSON.parse(require('fs').readFileSync('dsh-plugin.json','utf8'))"   # manifest 可解析
node -e "const a=require('./package.json'),b=require('./dsh-plugin.json'); if(a.version!==b.version) process.exit(1)"  # 版本锚点同源
```