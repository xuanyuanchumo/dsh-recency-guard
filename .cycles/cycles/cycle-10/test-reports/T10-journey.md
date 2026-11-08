# 测试报告 —— 用户旅程（沙箱 sb-rg-v012g，真机 GUI）

- 循环：cycle-10 ｜ 版本：v0.12.1
- 时间：2026-11-09 07:00（北京时间 Asia/Shanghai）
- 沙箱 profile：`sb-rg-v012g`（**干净隔离**：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-recency-guard`，
  无桌面 bundle 混入 —— 判别依据是日志里**没有** `[dsh-anic]` / `[codegraph:]`，且 `package.json` 的 bundles 只有三项）
- 宿主：dsh 0.2.2-rc.1（`dsh web: http://127.0.0.1:3092/?token=…`）

## 1. 旅程总览

| # | 旅程 | 结果 | 关键证据 |
|---|---|---|---|
| J1 | 安装（兼容闸门） | 通过 | `plugin add file:` → `+ dsh-recency-guard`，bundles 自动追加 |
| J2 | 启动激活 | 通过 | journal 落 `note(dsh 启动 pid)` + `install dsh-recency-guard 0.12.0` |
| J3 | 面板渲染 | 通过 | `__RECENCY_GUARD__.registered === true`，`panelMounted === true`，data-form=wide |
| J4 | 侧栏入口 | 通过 | 全局面板出现「插件守护」按钮 |
| J5 | 数据面（snapshot/graph） | 通过 | snapshot: 22 能力 / connectivity 1.00 / revision 12hex；graph: 22 节点 49 边 |
| J6 | 乐观并发 409 | 通过 | 过期凭证 → HTTP 409 + `{conflict:'stale-revision', current}`，动作未执行 |
| J7 | 乐观并发放行 | 通过 | 正确凭证 → HTTP 200 `{reenabled:[],keptDisabled:[]}` |
| J8 | 方法守卫 | 通过 | `GET /action/recover` → HTTP 405 |
| J9 | 图谱 k 跳聚焦 | 通过 | 22 节点 → **8 节点**（journal 的 1 跳邻域 = 自身+7 个消费方，与清单精确吻合） |
| J10 | 小地图渲染 | 通过 | 23 个 rect（22 节点 + 1 视口框） |
| J11 | 小地图导航 | 通过（**修后**） | 见 §3：修复前点击无反应，修复后 transform 变化且 0 未捕获异常 |
| J12 | 键盘方向键导航 | 通过 | 焦点移动到 `guard.recover.manual`；`aria-keyshortcuts` 含四向 + `+-0` + Esc + Enter |
| J13 | 诚实空态/不可判定 | 通过 | 「崩溃检出率 不可判定 / 没有崩溃样本」「平均恢复耗时 不可判定」「控制带 不可判定（样本<2）」 |
| J14 | 异常终止通道（哨兵盲区） | 通过（**修后**） | 见 §4：两轮强杀，第 1 轮观察、第 2 轮升级为行动 |
| J15 | 隔离归因 | 通过 | 面板显示 profile `sb-rg-v012g`、工作区 `d:/projects/…/dsh-recency-guard`、分区键 `59ce36e1…` |

## 2. J9：k 跳聚焦的真实数字（「点了没反应」缺陷的修复验证）

```
点击 guard.observe.journal 后开「只看关联」：
  nodesBeforeToggle: 22
  nodesAfterToggle:  8
  pressed: "true"
  rangeButtons: ["两跳", "只看关联"]
```

8 = 自身 + `guard.observe.metrics`、`guard.present.panel`、`guard.tool.history`、
`guard.recover.evidence`、`guard.decide.suspects`、`guard.govern.archive`、`guard.govern.revision`
（读 `CAPABILITY_SPECS` 中 `guard.observe.journal.consumedBy` 的 7 项 —— 逐项吻合）。

对照：**修复前是传递闭包**，在这张连通图上等于 22 → 用户看到「点了没反应」。

## 3. J11：小地图导航 —— 修前/修后的完整证据链

### 修前（真机实测缺陷）

合成 pointer 事件点小地图后：

```json
{"transformChanged": true, "before": "...", "after": "..."}   // 首次
{"navigationWorked": false}                                    // 缩小后再测
```

控制台：

```
[error] Uncaught NotFoundError: Failed to execute 'setPointerCapture' on 'Element':
        No active pointer with the given id is found.
[error] Uncaught NotFoundError: Failed to execute 'releasePointerCapture' ...
```

**根因**：`event.currentTarget.setPointerCapture?.(id)` 排在 `onNavigate(...)` **之前**，
而 `?.` 只保护「方法不存在」**不保护方法抛异常**。浏览器在 pointerId 失效时按规范抛
`NotFoundError` ⇒ 整条 handler 中断 ⇒ 点击小地图毫无反应。**一个只为「拖拽连续性」
存在的可选优化，否决了「定位到那一块」这个主功能。**

### 修后

- 代码：`setPointerCapture` / `releasePointerCapture` 各自包进 try，抽成
  `capturePointer` / `releasePointer` 封装，并注明「捕获失败只是拖出小地图后不再跟随，
  比点了没反应轻得多」。
- 门：`tests/client/minimap-gesture.test.ts` 新增 3 条源码断言
  （不得出现裸 `setPointerCapture?.(` / 不得出现裸 `releasePointerCapture?.(` /
  两者必须出现在 `try {` 内）。
- **门经变异自证**：把裸调用写回去 ⇒
  ```
  FAIL  不再有裸 setPointerCapture?.() —— 可选链不防抛异常（真机实测缺陷）
  1 个断言失败
  ```
  还原后复绿。
- 真机复验（同一段合成事件）：
  ```json
  {"navigationWorked": true, "uncaughtErrors": [], "nodesStillVisible": 22}
  ```

## 4. J14：异常终止通道 —— 用户旅程发现的 **P0 检测缺口**

### 缺口（实测，不是推演）

强杀沙箱（`Stop-Process -Force`，即 SIGKILL）后检查磁盘：

```
bootMarker = {"startedAt":"2026-11-08T22:57:13.657Z","pid":39576}
crashSeq   = 0
哨兵文件   = 不存在
```

旧逻辑只认哨兵 ⇒ 下一次启动会报「**启动时未发现上次崩溃**」（本次修复前面板正是这样显示的）。

**根因在信号源的覆盖面**：哨兵写在 `process.on('exit')` 里，而
SIGKILL / OOM killer / 断电 / 原生段错误**根本不运行 exit 处理器**。

危险的不是「少记一次」，而是**崩溃循环失去升级依据**：插件以原生方式撞死宿主时，
每一轮都只看到残留的 bootMarker、每一轮都被当成干净启动把计数清零 ⇒
永远停在「关 0 个」。这正是本插件存在的那个场景。

### 修复（沿用既有置信分级，不新造策略）

| 结局 | 判据 | 处理 |
|---|---|---|
| `clean` | 无残留标记 / 有哨兵 | 计数器归零（有哨兵时走既有通道，**不重复计数**） |
| `self-reload` | 残留 pid **== 本进程** | 计为 0 + 留痕「同一进程内重新加载守护」 |
| `concurrent` | 残留 pid 仍活着（且不是自己） | 计为 0 + 留痕「另一个实例在运行」 |
| `abnormal` | 残留 pid 已死 | 计数 +1，累计到 `confirmRounds` 才动手 |

为什么 `abnormal` 是**概率性**证据：残留标记同样可由「用户主动杀进程 / 关机」产生
（v0.9 分级早已把这类归为偶发不确定证据），所以第一轮只观察，不关插件。

`self-reload` 这一支是**实测后才加的**：装完新版后那个 pid 又写了一条启动记录
（`bootMarker.pid` 与当时进程相同），若归到 `concurrent` 会报「检测到另一个实例」——
让用户去查一个根本不存在的第二个进程。这是假归因，必须单独分出来。

### 端到端验证（两轮强杀）

第 1 轮：

```json
{"abnormalExitSeq": 1,
 "verdict": {"evidence":"probabilistic","rounds":1,"required":2,"act":false,
             "label":"异常终止观察中（1/2 轮）","headSuspect":null},
 "autoDisabled": []}
```

journal：
```
crash-detected  上次运行未留下退出码（哨兵缺席）—— 强杀/OOM/断电/原生崩溃之一；
                启动于 …（约 37s 前），pid 39576 已不存在，连续异常终止 1 轮
note            异常终止判定：观察中 1/2 轮（残留标记也可能是人为杀进程，不动手）
```

第 2 轮（再次强杀）：

```json
{"abnormalExitSeq": 2,
 "verdict": {"rounds":2,"required":2,"act":true,
             "label":"异常终止累计 2 轮 ⇒ 关闭 1 个","headSuspect":null},
 "autoDisabled": []}
```

journal：
```
note  异常终止判定：连续 2/2 轮 ⇒ 行动，本轮关闭 1 个（头号嫌疑 无）
```

**判定升级正确**（`act:false → act:true`）。`autoDisabled` 仍为空是因为**这个沙箱没有第三方插件**
（只有 base / web-app / guard 自身）—— 没有候选可关，属诚实结果，不是失败。

## 5. 红线核对

- 桌面主力进程（`DeepSeek Harness.exe`，pid 50656 / 47552）**自始至终未被触碰**，
  强杀前后计数均为 2。
- 所有强杀目标的 pid 都先用 `netstat → Get-CimInstance Win32_CommandLine` 核对过是
  `--profile sb-rg-v012g` 的沙箱子进程后才动手。
- 桌面 profile 的守护分区（`cef7279163b43942`）复核：`crashSeq=0`、`bootMarker=null`、
  `autoDisabled=[]`、无崩溃 journal 行 —— **未被本轮任何操作污染**。

## 6. 未覆盖（不计入通过）

| 缺口 | 原因 | 备注 |
|---|---|---|
| 面板「归档重置」按钮的 GUI 点击 | 会搬走当前沙箱产物，与后续旅程冲突 | 路由/工具两处入口均有 Host 层行为测试；GUI 按钮是薄调用 |
| 真正「第三方式插件崩溃」的完整闭环 | 沙箱无第三方插件可关（需先装夹具再注入崩溃） | 判定逻辑（第 1 轮观察 / 第 2 轮升级）已端到端验证；`recover()` 通道另有 Host 测试 |
| 截图 | 浏览器工具的写入根是 DSH checkout，不在本仓库 | 面板文本事实已用 a11y 快照逐条取证（§1 J3/J5/J13/J15） |
