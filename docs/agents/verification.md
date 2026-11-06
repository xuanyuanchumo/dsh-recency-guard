# 验证手册（dsh-recency-guard）

> 本文件回答一个问题：**「怎么证明这个插件真的能防崩溃」**。
> 只写可执行的命令与可复现的判据。凡不能复现的结论，都不写进来。

## 0. 一句话

本插件的验证必须覆盖三层：**单元/契约层**（逻辑对不对）、**沙箱运行层**
（插件能不能在真实 dsh 里激活）、**对抗层**（崩溃时到底拦不拦得住）。
只跑第一层就宣布"能防崩溃"，是自欺。

---

## 1. 静态与单元层（每次改动必跑）

```bash
npm run build          # esbuild 双产物：dist/index.js + dist/client.js
npx tsc --noEmit       # 类型
npm run lint           # 类型 + 未使用符号
npm test               # 分层运行器：Core / Host / Client / Contract
```

判据：**四条全零错误**。分批跑会掩盖相互影响，必须顺序跑完。

补充：复杂度预算（Q7）

```bash
node .dsh/skills/ai-native-iteration-cycle/scripts/band-detector.mjs "<repo>" --threshold 0.15
```

判据：`Status: OK`（单文件复杂度不超过预算 100，上限带 115）。
`patch.ts` 曾因校验器膨胀到 142 被判 OVER_BUDGET，拆分见
[design.md](./design.md) §7。

---

## 2. 沙箱运行层（安装与激活）

### 2.1 沙箱必须用 shipped 模板创建，**不要手写版本 pin**

```bash
dsh sb-rg-c5 --from-default-profile web --help    # 只建 profile，不启动
dsh plugin --profile sb-rg-c5 add "link:D:/Projects/TraeProjects/dsh-recency-guard"
dsh --profile sb-rg-c5 --port 3081 --no-open
```

> **为什么不能手写 `@deepseek-ai/dsh-base: 0.2.1-rc.5`**：桌面端运行时是
> `0.2.2-rc.1`，而 0.2.1-rc.5 的官方包与它**不兼容**。实测启动日志会刷出
> 二十余行
> `dsh: disabling profile plugin row "…": Plugin …@0.2.1-rc.5 is incompatible with dsh 0.2.2-rc.1`
> —— 插件不是崩了，而是**整排被静默禁用**。这比崩溃更难查：进程活着、端口在听，
> 功能全没了。
>
> shipped 模板的 `package.json` 里 `dependencies` 是空的，官方 bundle 由运行时
> 自己解析 —— 不存在版本 pin 漂移问题。

### 2.2 启动判据（逐条看日志，缺一不可）

| 判据 | 通过 | 失败意味着什么 |
|---|---|---|
| 无 `dsh: skipping profile bundle` | 必须 | peer 不兼容，插件静默失效 |
| 无 `dsh: disabling profile plugin row` | 必须 | 与运行时版本不兼容 |
| 无 `dsh: warning: N entry did not activate` | 必须 | `apply` 抛异常，整插件未激活 |
| 端口可探活、有 token 行 | 必须 | 没起来 |

**实测踩过的坑**：`apply` 里直接读 `ctx.configEditor`（未写进 `inject`）会抛
`cannot get property "configEditor" without inject`。日志只有一行
`warning: 1 entry did not activate`，端口照常监听 —— 极容易当成"启动成功"。
读可选服务必须包在 try 里，见 [conventions.md](./conventions.md) §5.1。

### 2.3 挂载方式

用 `link:`（Windows 上落成 Junction）。改 `dist/` 后**重启沙箱即生效**，
不必反复 `plugin add`。`file:` 会拷贝，源码改了不生效。

---

## 3. 路由层（运行时数据面）

插件注册 8 条路由，逐条探测（Bearer token 从启动日志取）：

```powershell
$t = "<token>"
$gets = @('/recency-guard/api/snapshot','/recency-guard/api/graph',
          '/recency-guard/api/isolation','/recency-guard/api/lifecycle',
          '/recency-guard/api/archives')
foreach ($p in $gets) {
  $r = Invoke-WebRequest "http://127.0.0.1:3081$p" -Headers @{Authorization="Bearer $t"} -UseBasicParsing
  "$p -> $($r.StatusCode)"
}
```

POST 三条（`recover` / `reenable` / `archive`）用最小合法 body 各打一次。

判据：**8/8 = 200**。任一 500 都会把面板整块拖黑，属于可观测性设施的可用性缺陷，
不是"小问题"。实测曾出现 `isolation` / `lifecycle` 双双 500（RouteContext 缺
provider），修复后 8/8 通过。

---

## 4. 用户旅程（GUI，浏览器自动化）

### 4.1 步骤

1. 打开 `http://127.0.0.1:<port>/?token=<token>`。
2. **先关掉"预览版说明"对话框**（`button` 文本含「继续」），否则 `#root[inert]`
   会让所有点击超时（`element is inert`）。
3. 点侧栏 `button[aria-label="插件守护"]` 打开面板。

### 4.2 判据（DOM 文本直接对账，比截图更可核对）

| 区块 | 判据 |
|---|---|
| 头部 | 含 `插件守护` + profile 名 + 工作区路径 |
| 生命周期 | 含阶段名（空闲/监控中/崩溃/决策中/稳定中/已恢复）与迁移次数 |
| 量化指标 | 可判定项显示数值；**不可判定项必须显示原因**（"没有崩溃样本"等），不能显示 0 |
| 崩溃决策 | 有记录则列插件，无记录则显示空态文案 |
| 能力清单 | 能力总数 / 对外暴露 / 连通率 / 连通分量 + 注册·生产·消费表 |
| 缺口 | `没有发现能力缺口` |
| 项目隔离 | 分区列表 + 「数据面由宿主按当前工作区返回」说明 |

### 4.3 铁律验证：轮询不得重置用户缩放

```js
// 在页面上下文执行
const g = document.querySelector('svg g[transform]')
const before = g.getAttribute('transform')
dispatchWheel(-240)                       // 用户缩放
const afterWheel = g.getAttribute('transform')   // 必须变化
await sleep(7000)                         // 覆盖至少一个轮询周期
// 断言：g.getAttribute('transform') === afterWheel
```

判据：`wheelChangedZoom === true` 且 `userZoomSurvivedPolling === true`。
实测：`scale 0.5245 → 0.6032`，7 秒轮询期间 **零变化**。

### 4.4 控制台判据

看**本次导航之后**的错误（`all: false`），不是整个页面生命周期：

```
Total messages: 0 (Errors: 0, Warnings: 0)
```

历史错误会混入（服务重启导致的 `ERR_CONNECTION_REFUSED`），不要误判。
真实缺陷例：滚轮 `preventDefault` 在 passive 监听器里失效 →
`Unable to preventDefault inside passive event listener invocation`，
后果是缩图同时滚页面。修复见 [conventions.md](./conventions.md) §5.2。

---

## 5. 对抗层（崩溃安全）

### 5.1 写入永远可解析

```powershell
node --import tsx scripts/repair-patch.mjs "$env:USERPROFILE\.dsh\profiles\<p>" --dry-run
```

判据：`现状：校验通过`。若非通过，dry-run 会列出待修行；去掉 `--dry-run` 后
自带 `.bak-<时间戳>` 备份并回读复核。

### 5.2 非法追加必须被拦下且文件不变

`tests/unit/patch-safety.test.ts` 已覆盖（`an invalid append is refused` +
`the file is byte-identical after the refusal`）。手工复核：

```ts
appendPatchText(patchPath, '- id: evil\n  name: @evil/pkg\n')   // => ok:false
```

### 5.3 崩溃重演（需要可崩溃的插件）

1. 在沙箱装一个**故意抛异常**的插件（`apply` 里 `throw`）。
2. 启动 → 进程退出、哨兵写入。
3. 再次启动 → 守护行的 `disabled` 表达式应在模块导入**之前**返回 true。
4. 判据：日志无该插件的崩溃栈，且 `.recency-guard/current.json` 指向的
   `decision.json` 里 `disable` 含该包名。

> 这一项目前由 `.cycles/verify/verify-report.md` 记录，尚未固化为自动化用例 ——
> 属于已知缺口，别当成"已验证"。

---

## 6. 证据归档

每轮循环把执行输出落到 `.cycles/cycles/cycle-<n>/test-reports/*.md`。
**只跑测试不写报告会被评估器判 Q2 FAIL**（`No test reports`），这是实测踩过的坑。