# 架构与功能域划分（v0.15.0 重构）

> 本文回答一件事：**`src/` 为什么这样分**。
> 它不是目录说明书，而是「每条边界在防哪种缺陷」的论证。

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
│   ├── core/                    #   基础原语：生命周期状态机、revision、分区键、自描述、同步原子写
│   ├── data/                    #   持久化与归档：Store、archive
│   ├── guard/                   #   崩溃守护主线：决策、恢复、信号、异常终止、守护行安装
│   ├── profile/                 #   profile patch 读写与标量改写
│   ├── observe/                 #   观测与数学模型：指标、生存分析、控制带、预防性预警、转移矩阵、共现
│   ├── risk/                    #   风险与归因：新近性、贝叶斯并行读数、误伤校准
│   ├── capability/              #   能力模型与图谱（产出方）
│   └── surface/                 #   对外面：工具注册/分派/渲染、路由、状态投影、面板快照
├── client/                      # 只在浏览器运行（禁止 node:*，禁止 import host）
│   ├── panel/                   #   面板：容器、卡片、洞察、投影
│   ├── graph/                   #   图谱：渲染、模型、分析、小地图、视口
│   ├── api/                     #   客户端取数的唯一出口
│   └── i18n/                    #   自持字典
└── shared/                      # 跨运行时契约层（Definition）：只放类型 + 纯常量
```

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

## 5. 已知的域内环（如实记录，不假装没有）

| 环 | 位置 | 为什么不急着拆 | 处置 |
|---|---|---|---|
| `observability ↔ survival/control-band` | `host/observe/` 内部 | 三者共享 `Metric<T>` 构造器与数值原语，拆开会产生大量薄封装 | 域内环，可接受；若将来要独立替换某个模型再拆 |
| `store → decision`（**仅类型**） | `host/data/` → `host/guard/` | 只是 `DecisionSuspect` 类型的 import（编译期擦除，无运行时依赖） | 已登记：若要彻底消除，把该类型移入 `shared/`（TD-5） |

> 判据：**类型环不算架构违例，值环算**。类型在编译期擦除，不产生运行时耦合；
> 值依赖才会让「换一个实现」变成连锁改动。

## 6. 验证方式

```bash
npx tsc --noEmit                              # 类型
npm run lint                                  # 未使用导出/参数
npm run build                                 # 双产物（host + client）
npm test                                      # 46 个测试文件，含边界契约
npx tsx tests/contract/client-host-boundary.test.ts   # 单跑边界门
node scripts/mutation.mjs --dry-run           # 变异池是否覆盖新布局（递归）
```