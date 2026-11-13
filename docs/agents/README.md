# dsh-recency-guard 开发规范（docs/agents）

> 本目录是本插件的开发者文档基座：新会话 / 新 Agent 接手时**先读这里**。
> 版本基线 **0.19.0**（2026-11-13，北京时间）。事实基座纪律：本文引用的路径与命令全部在仓库内真实存在。

## 1. 项目一句话

dsh-recency-guard 是 DeepSeek Harness 的**插件崩溃恢复守护**：记录第三方 / 实验性
插件的安装与更新时间线，备份其配置；崩溃后按「最近更新优先」自动关闭嫌疑插件，
让 profile 能再次启动；稳定后自动恢复非嫌疑插件。

## 2. 文档地图

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [architecture.md](./architecture.md) | 两层结构（host / client）+ `shared/` 定义层；每条边界在防哪种缺陷；依赖方向与环判据 | 改目录 / 加模块前 |
| [capabilities.md](./capabilities.md) | 22 条能力的「注册 → 生产 → 消费」清单；工具 8 action / 路由 9 条 / 面板 2 席位的注册真值；双向比对口径 | 加能力 / 改注册面 / 排查"清单与实现不一致" |
| [api.md](./api.md) | 对外面：工具输出契约、HTTP 路由、面板快照、乐观并发 409、配置项 | 接入 / 消费本插件时 |
| [design.md](./design.md) | 设计决策链：模块地图、数据流、状态机、数学模型、守护行写入管线、崩溃信号演进、为什么否决某些方案 | 改核心逻辑前 |
| [conventions.md](./conventions.md) | 工程规范：注释、验证链、测试分层、版本同步纪律、宿主服务读取纪律、YAML 写入纪律、沙箱流程 | 写任何代码前 |
| [verification.md](./verification.md) | 验证手册：静态 / 沙箱 / 路由 / 用户旅程 / 对抗五层，全部可复现判据 | 声称"能用 / 能防崩溃"之前必读 |
| [update-guide.md](./update-guide.md) | 发布与升级：版本四锚点顺序、npm publish、桌面端更新、热重载边界、更新后最小验证 | 发布 / 更新安装时 |
| [tech-debt.md](./tech-debt.md) | **技术债状态表**：`.cycles/tech-debt/` 七条的「现象 / 本轮状态 / 证据 / 剩余风险」；关闭·部分关闭·保留的口径（TD-7 为本轮自查新增） | 每轮收口 / 评审技术债时 |
| [../research/](../research/) | 研究文档基座（十篇）：中文思维映射、数学模型、数据结构选型、语言范式、验证体系、应用泛化、迭代计划、候选方向评审、四方向合流、参考插件研究 | 做设计决策 / 评审候选方案前 |

### 2.1 研究文档与实现的关系（v0.13 起）

`docs/research/` 不是"背景材料"，而是**设计决策的依据链**。每一项落地都能追到具体一篇：

| 研究文档 | 落地的代码 | 被拒绝的原方案 |
| --- | --- | --- |
| 08 候选方向评审 / 09 四方向合流 | `decision-evidence.ts` / `cooccurrence.ts` / `riskFactors` / `hazardAdjustedRounds` | 方向① LRU-K（语义错配）、方向② 指数衰减（放过真缺陷）、方向④ 共现加权（数据基础不存在） |
| 10 参考插件研究 | 惰性加载可选 peer（对照 compat-guardian 不依赖 schemastery） | — |
| 02 数学模型白皮书 | `riskFactors` 三因子分解 / `hazardAdjustedRounds` 用已有 Weibull | — |
| 03 数据结构选型 | `graph-analysis.ts` 用度数排序而非中介数中心性 | — |
| 05 验证与可证伪体系 | 变异自证（两轮：decision-compat 恰 4 条 FAIL、install-resilience 恰 2 条 FAIL） | — |

**纪律**：新增设计决策时，先在 `docs/research/` 找到依据或补一篇；
「我觉得这样更好」不是依据。

## 3. 快速上手（命令）

```bash
npm install
npm run build           # esbuild 双产物：dist/index.js（宿主）+ dist/client.js（客户端）
npx tsc --noEmit        # 类型检查
npm run lint            # tsc --noEmit --noUnusedLocals --noUnusedParameters
npm test                # 分层统一运行器：Core 42 / Host 10 / Client 24 / Contract 8 = 84
npm run extract-runtime # 解出宿主运行时（Host 测试前置）
```

**两条硬前置**（不满足会直接失败，不会伪装通过）：

- `tests/host/journey-mount.test.ts` 在 `runtime/` 缺失时**退出非零** ——
  「无法评估 ≠ 通过」。
- `tests/contract/install-resilience.test.ts` 会检查**产物**里 optional peer
  是否被静态 import；`tests/contract/decision-compat.test.ts` 会检查守护行
  是否偷读 `evidence`。两条都有变异自证记录。

验证顺序固定：**build → typecheck → lint → test**，全部零错误才算完成。

## 4. 三条不可破坏的设计红线

1. **崩溃路径全同步**：守护行安装、启动记录、崩溃决策必须同步 IO——
   异步写在崩溃时来不及落盘，输给它要守护的那次崩溃。
2. **能力清单是投影不是第二真相源**：真相在注册处
   （`ctx.tools.register` / 路由注册），契约测试做双向比对。
3. **指标不可判定时为 `null`**（`Metric.defined=false`）：绝不把「无数据」当「零」。

## 5. 迭代流程（ANIC）

本项目用 `.cycles/` 工作流（ai-native-iteration-cycle 技能）做自举迭代：
每轮循环 `init-cycle → 评估基线 → 实施 → 测试报告落盘 → G0-G3 门禁 → 归档`。
门禁判定以 `.cycles/gates/ledger.json` 哈希链账本为准。

## 6. 发布面三件套

- [`../../dsh-plugin.json`](../../dsh-plugin.json)：社区 manifest（draft v0.15），字段逐条有代码依据；
  permissions 覆盖 fs 读/写（含可写 rescue 改 profile `package.json`）、进程探活、本地面板路由；
- [`../../package.json`](../../package.json)：npm 视角的 `dsh.bundle.patch` / `dsh.client` / `engines.dsh`；
- [`../market-submission.md`](../market-submission.md)：awesome-dsh-plugin 投稿 YAML 与**如实**自查清单。

三者版本必须与 `README.md`、`docs/agents/` 一起对齐 —— 顺序见
[conventions.md](./conventions.md) §6「版本同步纪律（四锚点）」。