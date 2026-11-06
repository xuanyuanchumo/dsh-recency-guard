# dsh-recency-guard

**插件崩溃恢复守护** —— 解决"添加或更新第三方/实验性插件导致 DSH 崩溃、必须禁用所有插件再逐个添加"的问题。

当某个插件把 DSH 拖垮时，本插件会在崩溃的那一刻记录下"谁最可疑"，并在**下一次启动时、在崩溃插件的代码被加载之前**把它挡在门外。反复崩溃时，关闭的插件会逐个增加（第 1 次关最近更新的 1 个，仍崩溃则关最近更新的 2 个）。稳定之后，除首要嫌疑外，其余被关闭的配置会自动恢复。

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
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后插件只记录日志，永不自动禁用任何插件 |
| `includeExperimental` | `true` | 实验性/beta 命名的包是否算嫌疑 |
| `maxAutoDisable` | `2` | 单次恢复最多关闭几个。崩溃次数递增，但封顶于此值 |
| `autoRestore` | `true` | 稳定启动后自动重新启用非首要嫌疑 |

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
├── journal.jsonl        # 只追加的事件日志：install / update / crash-detected / disable / restore …
├── snapshot.json        # 上次观测到的 { 插件名: 版本 }，用于识别更新
├── state.json           # 崩溃计数、被自动关闭的插件、已恢复的插件
├── decision.json        # 本轮要拦截的插件（守护行的表达式读它）
├── crashed              # 崩溃哨兵：非零退出码时写下
└── backups/             # 关闭前备份的配置
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
npm run build        # esbuild 打包到 lib/
npm run typecheck    # tsc --noEmit
npm test             # 单元测试 + 工具行为测试
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
