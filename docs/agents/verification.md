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
npm test               # 分层运行器：Core 42 / Host 10 / Client 24 / Contract 8 = 84
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

插件注册 **9 条路由**（5 条 GET + 4 条 POST），逐条探测（Bearer token 从启动日志取）：

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

POST 四条（`recover` / `reenable` / `archive` / `restore`）用最小合法 body 各打一次。

判据：**9/9 = 200**。任一 500 都会把面板整块拖黑，属于可观测性设施的可用性缺陷，
不是"小问题"。实测曾出现 `isolation` / `lifecycle` 双双 500（RouteContext 缺
provider），修复后 9/9 通过。

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
ctrlWheel(-240)                           // Ctrl/⌘ + 滚轮 才缩放（v0.7.1 起）
const afterWheel = g.getAttribute('transform')   // 必须变化
await sleep(7000)                         // 覆盖至少一个轮询周期
// 断言：g.getAttribute('transform') === afterWheel
```

判据：`ctrlWheelChangedZoom === true` 且 `zoomSurvivedPolling === true`。
实测：`scale 0.5245 → 0.6032`，7 秒轮询期间 **零变化**。

> 用 Playwright 的 `page.mouse.wheel` 配 `keyboard.down('Control')` 产生**可信**滚轮事件；
> 合成的 `WheelEvent` 不会触发浏览器默认滚动，测不出"普通滚轮能滚动"。

### 4.4 面板必须自己滚动（v0.7.1 实测缺陷）

**症状**：面板下半部分（指标、能力清单、归档）看不到，页面怎么滚都不动。

**根因**（实测链路）：

```text
.centerCol   { overflow-y: hidden }        ← 祖先把溢出裁掉
.mainPanel   { height: 714px; overflow: visible }
.rg-panel    { height: 3965px }            ← 内容自然高度，超出部分被裁
document     { scrollHeight == clientHeight == 714 }   ← 整页不滚
```

**判据**：

```js
const p = document.querySelector('.rg-panel')
p.scrollHeight > p.clientHeight + 1        // 必须为 true
p.scrollTop = p.scrollHeight               // 必须滚得动
Math.abs(p.scrollTop + p.clientHeight - p.scrollHeight) <= 2   // 必须到底
```

并且滚到底后能看到**最后一个区块**（归档）。实测：`clientH=714 / scrollH=4076`，
`scrollTop` 到 `3361`，底部出现「归档」与归档清单。

**修复要点**：`height:100%` + `min-height:0` + `overflow-y:auto` + `overscroll-behavior:contain`
四件套缺一不可（只写 overflow 不限高，flex 子项仍按内容撑开，滚不起来）。

### 4.5 滚轮语义判据（v0.7.1）

| 操作 | 期望 | 实测 |
|---|---|---|
| 指针在图谱上，**普通滚轮** | 面板滚动，缩放不变 | `scrollTop 3057→3362`，transform 不变 |
| 指针在图谱上，**Ctrl/⌘ + 滚轮** | 缩放变化，面板不滚 | `scale 0.5245→0.6032`，scrollTop 不变 |
| 数据轮询期间 | 滚动位置与缩放都不被重置 | 7 秒内 `scrollTop` 与 transform 均稳定 |

滚轮不再默认缩放，是因为面板很高而宿主槽位只有一屏：滚轮被图谱吞掉后，
指针停在图上就**再也滚不到下方数据**。缩放入口保留在工具栏三个按钮上。

### 4.6 控制台判据

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

---

## 7. 发布面校验（v0.16.0 新增）

每次发版前，除 §1 的四条命令外，再跑下面三条。**任何一条不通过都不许 tag / publish。**

### 7.1 四锚点同值

```bash
node -e "const a=require('./package.json'),b=require('./dsh-plugin.json');console.log('pkg',a.version,'manifest',b.version,a.version===b.version?'OK':'MISMATCH');if(a.version!==b.version)process.exit(1)"
grep -n "v0\.16\.0\|0\.16\.0" README.md docs/agents/api.md docs/agents/design.md docs/agents/architecture.md dsh-plugin.json
```

判据：`OK`，且 README / 三份 agents 文档 / manifest 全部命中当前版本。

### 7.2 manifest 可解析且符合 schema

```bash
node -e "JSON.parse(require('fs').readFileSync('dsh-plugin.json','utf8'));console.log('parse OK')"
```

完整 JSON Schema 校验（需要网络取 schema；`$schema` 字段里是同一 URL）：

```bash
node -e "(async()=>{const s=await (await fetch(require('./dsh-plugin.json').\$schema)).json();const Ajv=require('ajv');const v=new Ajv({strict:false,allErrors:true}).compile(s);const ok=v(require('./dsh-plugin.json'));console.log('schema',ok?'OK':'FAIL');if(!ok){console.log(JSON.stringify(v.errors,null,2));process.exit(1)}})()"
```

判据：`parse OK` + `schema OK`。字段增删前先想清楚：**写不出代码依据的字段不要写**
（见 [design.md](./design.md) §16.2）。

### 7.3 市场投稿 YAML 可解析

```bash
node -e "const fs=require('fs');const t=fs.readFileSync('docs/market-submission.md','utf8');const m=t.match(/\`\`\`yaml\n([\s\S]*?)\`\`\`/);if(!m)throw new Error('no yaml block');const YAML=require('yaml');const d=YAML.parse(m[1]);console.log('keys',Object.keys(d).join(','));console.log('category',d.category);console.log('url',d.url);console.log('en',typeof d.description.en,'zh',typeof d.description.zh)"
```

判据：

- 能解析出对象，`description.en` 是字符串（该字段是必填）；
- `category` ∈ awesome-dsh-plugin 的合法取值（本项目用 `security`）；
- `url` 与 `package.json` 的 `repository.url` 指向同一仓库；
- 描述里出现 `: `（冒号+空格）时整段**带引号**，否则 YAML 会读成嵌套键；
- **不写** `tarball:` / `npm:` 键（前者会因文件名带版本号而静默 404；后者手写会被校验拒绝）。

### 7.4 `screenshots.json` 路径真实存在

```bash
node -e "const fs=require('fs');const list=require('./screenshots.json');const bad=list.filter(p=>!fs.existsSync(p));console.log('screenshots',list.length,'missing',bad);if(bad.length)process.exit(1)"
```

判据：`missing []`。声明了却 404 的图比不声明更糟 —— 市场详情页会直接破图。

---

## 8. 确定性冲突 / 贪心隔离 / 可写 rescue（v0.16 定稿）

### 8.1 确定性证据必须能回指原文

```bash
npx tsx tests/unit/conflict-findings.test.ts
npx tsx tests/unit/deterministic-evidence.test.ts
npx tsx tests/unit/unresolved-surfacing.test.ts
```

判据：

- 四类 finding（`declared-conflict` / `duplicate-service` / `dsh-version` / `missing-dependency`）
  都有正例与**沉默例**：没声明、范围不可判定、对手不在场 ⇒ 输出里**不出现**；
- 每条 finding 带 `source.file` / `source.line` / `declaration`，可回指原文；
- `unresolved` 能出现在 `status` 输出、`decision.json` 与 `recover` 结果里
  （静默吞掉 = 假装治好）。

### 8.2 贪心隔离与依赖联动

```bash
npx tsx tests/unit/quarantine-plan.test.ts
npx tsx tests/unit/crash-decision.test.ts
```

判据：

- **无声明 ⇒ 纯 recency 顺序逐位不变**（有双向排序夹具）；
- 关 X 会连带关依赖它的插件（闭包；环状依赖不死循环）；
- 配额按**整组**判定：整组放不进 `maxAutoDisable` ⇒ 一个都不动，残余进 `unresolved`；
- 受保护（官方/本插件/只读行）永不隔离；命中但全受保护 ⇒ 不行动，不用 recency 顶替。

### 8.3 可写 rescue（dry-run → 两阶段 → 中断恢复）

```bash
# 默认 dry-run：不写盘，只打印计划（退出码 0）
node bin/rescue.mjs apply --profile-dir "<profile>" --bundle dsh-bad-plugin

# 真正落盘（需显式 --yes）
node bin/rescue.mjs apply --profile-dir "<profile>" --yes
node bin/rescue.mjs rescues --profile-dir "<profile>"     # 只读：记录清单

# 中断恢复
node bin/rescue.mjs restore --profile-dir "<profile>" --resume --yes
```

判据（`tests/unit/rescue-cli.test.ts` 覆盖）：

- 不带 `--yes` **绝不修改** profile `package.json`；
- `prepared` 记录含 `beforeHash` / `afterHash` / 原 index；`restore --resume` 按哈希判定第二步是否生效；
- 回插按原 index 升序，回插后 bundle 顺序与隔离前一致；
- 现场哈希不符 / 记录被篡改 ⇒ 退出码 **3** 拒绝，文件不变（不是"尽力改一下"）。

### 8.4 契约门（v0.16 新增）

```bash
npx tsx tests/contract/panel-snapshot-nullability.test.ts
npx tsx tests/contract/client-host-boundary.test.ts
```

判据：全部 PASS。可空清单只允许放宽**宿主已证明可空**的字段；
client 仍不得运行时 import host（`import type` 豁免）。

### 8.5 竞态与降级（T14-08 真机修复）

```bash
npx tsx tests/unit/journal-append-race.test.ts
npx tsx tests/unit/boot-crashseq-race.test.ts
npx tsx tests/unit/state-reconcile.test.ts
npx tsx tests/unit/boot-degradation.test.ts
npx tsx tests/unit/quarantine-plan.test.ts   # roundBudget / 预算耗尽分支
```

判据：

- **journal append-only**：并发写不会用旧快照覆盖崩溃事件（`crash-detected` 仍在）；
- **state 对账**：哨兵在场且决策文件有 `disable` 时，`crashSeq` / `autoDisabled`
  被补回；无哨兵 / 非 `crash-recovery` / 空名单 ⇒ **不补**（幂等、不猜）；
- **CAS 清零**：干净启动只归零未被本轮崩溃改过的计数；崩溃后的 `crashSeq` 不被覆盖；
- **降级留痕**：启动编排的 catch 落 journal `note` + `degraded:true`，
  `commitPartitionIndex` 注入点可稳定复现失败分支；
- **死分支可断言**：`roundBudget(P)=P+1`，注入更小预算可命中 `terminatedBy:'cap'`。

### 8.6 v0.17 新增门禁（RQ3 / RQ4 / TD）

```bash
npx tsx tests/unit/preventive-wiring.test.ts        # RQ3：生产消费者 + 关闭链路零依赖
npx tsx tests/client/preventive-card.test.ts        # 面板预警卡（诚实空态/不可判定）
npx tsx tests/client/poll-adaptive.test.ts           # 自适应轮询纯函数 + 接线结构
npx tsx tests/contract/width-parity.test.ts          # rescue vs host 宽度逐字符对拍
npx tsx tests/unit/pure-projections.test.ts          # schemaVersion 纯解析/投影
```

判据：

- **RQ3 有生产消费者**：`grep "from.*preventive" src/` > 0（`preventive-view.ts` 消费
  `preventive.ts`），且 `PanelSnapshot.preventive` / `status.preventive` / 面板卡片都能显示；
- **只预警不行动**：关闭决策链路（`crash-decision` / `quarantine-plan` / `recovery-*`）
  对 `preventive` **零依赖**（源码扫描断言）；`composeCrashDecision` 参数无 preventive 字段；
- **代理诚实**：`loadTime` 单位是 `per-minute` 启动频率（不是毫秒加载耗时），
  `source.note` 原样上屏；样本不足 ⇒ `defined:false` + `reason`，不填 0；
- **跨实现对拍**：同一语料下 `rescue.mjs` 与 `tool-text.ts` 的 `displayWidth` /
  `padWidth` 逐条相等，并校验**绝对期望值**（防止「一致地错」）；
- **schema 版本**：`schemaVersion===1` 正常、缺失按 v1、未知 ⇒ 安全空态/`null` +
  `degraded:true` note，且**原文件字节不被改写**；
- **自适应轮询**：5s→10s→15s 封顶、变化回 5s、夹紧 [3s,30s]；指纹剔除 `at` /
  `diagnostics.snapshotMs`；组件必须用递归 `setTimeout`（不是 `setInterval`）。

### 8.7 v0.19 新增判据（命令窗口 / ANSI / 新鲜度 / 退避 / 串扰）

#### 8.7.1 命令窗口卡片（TD-8）

**根因核验（改动前必须先做）**：

```bash
grep -rn "tool.call" src/ | wc -l        # 改动前必须是 0
grep -c "tool.call.toolview" dist/client.js   # 改动后必须 > 0
```

**契约层**（`tests/contract/toolview-contract.test.ts`）钉住 8 条：

- client 半部注册 `tool.call.toolview` 席位；
- key ≡ host 侧 `TOOL_SURFACE.name`（`recency_guard`）；
- 注册经由 `ctx.slots.inject`（**不是**裸 `register` —— 裸注册会撞
  「向未声明 slot 注册」，整个 entry 失败 ⇒ 面板全灭）；
- 幂等守卫存在（`slots.entries()` 反查）；
- **注册计数是 getter**（`get count()`）—— inject 回调是宿主延迟调用的，
  静态快照会永远停在 0；
- client 入口真的调用了 `integrateToolView`；
- CSS 单一样式真源（集成侧不得另持一份）；
- 抽取层零 React 依赖 + 是 `.ts` 文件（结构上不可能含 JSX）。

**真机判据**（沙箱 GUI，浏览器上下文执行）：

```js
({
  toolviewCount: window.__RECENCY_GUARD_TOOLVIEW__?.count,   // 必须是 1
  toolviewError: window.__RECENCY_GUARD_TOOLVIEW__?.error,   // 必须是 null
  toolviewSkipped: window.__RECENCY_GUARD_TOOLVIEW__?.skipped, // 必须是 null
  cssInDom: !!document.getElementById('rg-toolview-css'),    // 必须是 true
  panelRegistered: window.__RECENCY_GUARD__?.registered,      // 必须是 true
})
```

> **证据强度诚实标注**：上述判据证明「席位已注册 + 卡片样式已入 DOM + 抽取层
> 53 条断言全绿」，但**不等于**「卡片在命令窗口真的渲染过一次」——
> 那需要一次真实的工具调用（沙箱需配 provider）。本轮的最大证据缺口就在这里，
> 下一轮第一候选补齐。

#### 8.7.2 ANSI 序列级剥离（TD-9）

```bash
npx tsx tests/unit/ansi-strip.test.ts    # 24 条全绿
```

关键判据（**负载不残留**是核心）：

- `stripAnsiSequences('safe\u001b[31mRED\u001b[0m').text === 'safeRED'`
  —— **不是** `'safe[31mRED'`（逐码点剥除的缺陷形态）；
- OSC 必须有终止符（BEL 或 `ESC \`）—— 没有终止符时不能「匹配到 ESC] 就停」
  （那正是缺陷本身）；
- 两字符转义按 ECMA-48 是**三字节**（`ESC ( B` 全是序列，`B` 不是可见文本）；
- 正常包名 / 版本号 / 中文**逐字节不变**（`@scope/pkg`、`0.0.0-dev`）；
- 幂等：剥过一次再剥，文本不变且 `removed === 0`。

#### 8.7.3 产物新鲜度（TD-10）

```bash
npx tsx tests/unit/build-freshness.test.ts    # 19 条全绿
curl -s http://127.0.0.1:<port>/recency-guard/api/snapshot | grep -o '"buildFreshness":{[^}]*}'
```

判据：

- **三态严格区分**：`true` = 确认过期；`false` = 确认不旧；`null` = **无法判定**
  （发布态无 `src/` 可比）—— 绝不把「无法判定」显示成「正常」（那是假绿）；
- 版本取自 `package.json`（**不从产物正则捞** —— 产物里到处是 `0.9.0`，
  正则捞到第一个匹配 = 假事实）；
- 缺产物 ⇒ 指纹 `null`（**不伪造**）；
- 根定位**与 cwd 无关**（默认起点是模块自身位置 —— 插件的 cwd 是用户工作区）；
- 同毫秒的改动不算过期（严格大于）；
- 面板诊断卡显示该行（真机：`产物新鲜度：产物与源码一致`）。

#### 8.7.4 轮询失败退避 + 隐藏页暂停

```bash
npx tsx tests/client/poll-failure-backoff.test.ts    # 17 条全绿
```

- 阶梯 `5/10/20/40/60s`，封顶 60s；
- **`+Infinity` ⇒ 封顶档**（不是首档！失败无穷多次恰恰最该退避到底）；
- `NaN` ⇒ 首档（不可知 ≠ 很糟）；
- 所有延迟恒为**有限正数**（直接喂 `setTimeout`，NaN 会让轮询永久停摆）；
- 隐藏页不拉取；`visibilitychange` 转回可见时**立即补拉**（定时器不销毁）。

#### 8.7.5 跨分区在途串扰（TD-11）

```bash
npx tsx tests/client/epoch-guard.test.ts    # 15 条全绿
```

- **双向竞态顺序**都要过：旧响应**先到**与**后到**，画面最终都必须是最新选择；
- 过期响应**不落地**（`applyIfCurrent` 返回 false 且不调用落地函数）；
- 三处分区切换点统一走 `selectPartition()`（漏一处就是串扰入口）。

#### 8.7.6 归档重置（插件自身的动作）

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"reason":"验证"}' \
  http://127.0.0.1:<port>/recency-guard/api/action/archive
curl -s http://127.0.0.1:<port>/recency-guard/api/archives
curl -s http://127.0.0.1:<port>/recency-guard/api/snapshot
```

判据：

- archive 返回 `ok:true` + `count > 0` + **manifest 摘要非零**
  （`journalEvents > 0`）—— 「先读 manifest 再搬走」；
  （老坑：归档清单在搬走**之后**读 ⇒ 摘要永远报 0）；
- 重置后 `stage=idle`、`autoDisabled=[]`、`restored=[]` ⇒ **不继承旧结论**；
- `/archives` 能列出该归档。

#### 8.7.7 桌面主力热重载（不重启宿主）

```bash
# 插件管理器：关闭 ⇒ 路由 404；开启 ⇒ 200 且版本变新
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55312/recency-guard/api/snapshot
```

判据：切换后 `diagnostics.pluginVersion` 为新版本；`capability.total` 增加；
`buildFreshness.stale === false`。

### 8.8 全量基线

`npm test` = **95/95**（Core 46 / Host 10 / Client 29 / Contract 10）；
`npx tsc --noEmit` 0；`npm run lint` 0；`npm run build` 双产物成功。