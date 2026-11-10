# dsh-recency-guard 开发规范（docs/agents）

> 本目录是本插件的开发者文档基座：新会话/新 Agent 接手时**先读这里**。
> 事实基座纪律（R14）：本文引用的路径与命令全部在仓库内真实存在。

## 1. 项目一句话

dsh-recency-guard 是 DeepSeek Harness 的**插件崩溃恢复守护**：记录第三方/实验性
插件的安装与更新时间线，备份其配置；崩溃后按「最近更新优先」自动关闭嫌疑插件，
让 profile 能再次启动；稳定后自动恢复非嫌疑插件。

## 2. 文档地图

| 文档 | 内容 | 何时读 |
|---|---|---|
| [design.md](./design.md) | 架构与设计：模块地图、数据流、状态机、数学模型、守护行写入管线、备份增强设计、宿主能力接入 | 改核心逻辑前 |
| [api.md](./api.md) | 对外面：工具 action、工具输出契约（execute vs render）、HTTP 路由、面板数据契约、契约变更清单 | 接入/消费本插件时 |
| [conventions.md](./conventions.md) | 工程规范：注释、验证链、测试分层、已知陷阱、宿主服务读取纪律、交互事件纪律、YAML 写入纪律、沙箱流程 | 写任何代码前 |
| [verification.md](./verification.md) | 验证手册：静态/沙箱/路由/用户旅程/对抗四层，全部可复现判据 | 声称"能用/能防崩溃"之前必读 |
| [update-guide.md](./update-guide.md) | 插件更新规范：发布前置检查、版本号纪律、更新到桌面端的两条路径、热更新重载边界、更新后最小验证 | 发布/更新安装时 |
| [../research/](../research/) | **研究文档基座（九篇 + 参考插件研究）**：中文思维映射、数学模型白皮书、数据结构选型、语言范式、验证体系、应用泛化、迭代计划、候选方向评审、四方向合流、参考插件取长补短 | 做设计决策 / 评审候选方案前 |

### 2.1 研究文档与实现的关系（v0.13 起）

`docs/research/` 不是"背景材料"，而是**设计决策的依据链**。v0.13 的每一项落地
都能追到具体一篇：

| 研究文档 | 落地的代码 | 被拒绝的原方案 |
|---|---|---|
| 08 候选方向评审 / 09 四方向合流 | `decision-evidence.ts` / `cooccurrence.ts` / `riskFactors` / `hazardAdjustedRounds` | 方向① LRU-K（语义错配）、方向② 指数衰减（放过真缺陷）、方向④ 共现加权（数据基础不存在） |
| 10 参考插件研究 | 惰性加载可选 peer（对照 compat-guardian 不依赖 schemastery） | — |
| 02 数学模型白皮书 | `riskFactors` 三因子分解 / `hazardAdjustedRounds` 用已有 Weibull | — |
| 03 数据结构选型 | `graph-analysis.ts` 用度数排序而非中介数中心性 | — |
| 05 验证与可证伪体系 | 变异自证（两轮：decision-compat 恰 4 条 FAIL、install-resilience 恰 2 条 FAIL） | — |

**纪律**：新增设计决策时，先在 `docs/research/` 找到依据或补一篇；
「我觉得这样更好」不是依据。

## 3. 快速上手（命令）

```bash
npm run build           # esbuild 双产物：dist/index.js（宿主）+ dist/client.js（客户端）
npx tsc --noEmit        # 类型检查
npm run lint            # tsc --noEmit --noUnusedLocals --noUnusedParameters
npm test                # 分层统一运行器：Core/Host/Client/Contract
npm run extract-runtime # 解出宿主运行时（Host 测试前置）
```

**v0.13 起的两条硬前置**（不满足会直接失败，不会伪装通过）：

- `tests/host/journey-mount.test.ts` 在 `runtime/` 缺失时**退出非零** ——
  「无法评估 ≠ 通过」。
- `tests/contract/install-resilience.test.ts` 会检查**产物**里 optional peer
  是否被静态 import；`tests/contract/decision-compat.test.ts` 会检查守护行
  是否偷读 `evidence`。两条都有变异自证记录。

验证顺序固定：**build → typecheck → lint → test**，全部零错误才算完成。
宿主层测试需要 `runtime/`（由 extract-runtime 产出），缺失先解出再跑。

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
