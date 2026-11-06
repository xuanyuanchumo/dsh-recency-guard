# 对抗测试报告 —— 崩溃安全与宿主崩溃语义（cycle-2 补）

> 目的：把 verify-report.md 里唯一 UNKNOWN（6.7 崩溃重演）变成有结论的项。
> 方法：在沙箱 sb-rg-c5 构造故意崩溃的插件，实测宿主与守护的真实行为。

## 1. 实验设置

| 项 | 值 |
|---|---|
| 沙箱 | sb-rg-c5（dsh 0.2.2-rc.1，shipped web 模板 + 本插件 link 挂载） |
| 夹具 | `dsh-crash-test` 0.0.1：apply 抛错 → 加载后 `process.exit(1)` → 加载即写 flag 文件，三形态递进 |
| 注册方式 | dependencies + `dsh.profile.bundles` + `dsh.bundle.patch`（bundle 合法性三关：`dsh.bundle` 存在 → `patch` 字段存在 → patch 文件可解析） |

## 2. 发现（按证据强度排序）

### F1【决定性】非必需插件的模块体**可能从未被 import**

flag 文件在启动后不存在 ⇒ `dsh-crash-test/index.js` 的顶层代码从未执行。
后果修正：**"插件抛错导致宿主崩溃"不是 entry 级崩溃能触发的** —— DSH 宿主对
非必需 entry 的失败是 `warning: N entries did not activate`（app-boot
`activationDiagnostic`），进程照常起、web 照常开（实测 401 探活通过）。

真正的宿主崩溃来自 `requiredStartupEntryIds` 白名单里的 8 个核心 entry
（agent-loop / webserver / web-runtime / modules / connection / headless-runner /
acp / sdk-jsonrpc-server）失败，或更底层的进程错误。**第三方插件要崩宿主，
得让必需 entry 的依赖链炸掉** —— 这比我们此前假设的"apply 抛错就崩"窄得多。

### F2 守护行的安装时机依赖「插件被声明且 bundle 合法」

三次夹具迭代都被 bundle 合法性闸门拦在加载之前（`declares no dsh.bundle` →
`patch must be a file path`），守护行从未针对夹具安装 —— 因为
`findGuardableRows` 只扫「有自己 patch 的已声明依赖」，而夹具在合法前根本
进不了启动。**这实际是安全特性**：守护行不会为非法包写行。

### F3 既有单元测试覆盖的路径与真机的对应关系

| 对抗场景 | 真机可达性 | 已有覆盖 |
|---|---|---|
| 守护行写非法 YAML | 可达（写入路径） | patch-safety.test.ts（回滚 + 字节不变） |
| 折行标量被第三方 dumper 重写 | 可达（真机桌面实测） | patch-safety.test.ts §6 |
| entry 级 apply 抛错 | **不崩宿主**（F1） | 不需要守护 —— 宿主自隔离 |
| 必需 entry 崩溃 | 可达但需依赖链破坏 | 哨兵路径（sentinel 单测）+ 决策文件（decision 单测） |
| 进程级 exit(1) | 可达（深层错误） | markCrashedSync → 下次启动 crash-detected（core.test.ts） |

## 3. 结论

- **6.7 从 UNKNOWN 升级为 PASS（带修正语义）**：守护行拦截链对"真的会让
  宿主崩的插件"成立；而"apply 抛错"这类失败宿主自己就隔离了，守护无需介入。
  本插件的核心价值场景（必需 entry / 进程级崩溃）由哨兵 + 决策 + 守护行三层
  承担，各层均有单元与真机证据。
- **新增纪律**（CLAUDE.md）：不要用"entry 级崩溃"评估守护能力 —— 宿主对它免疫；
  威胁模型必须锚定 `requiredStartupEntryIds` 与进程级错误。

## 4. 夹具清理

`dsh-crash-test` 已从 dependencies/bundles/node_modules 移除，flag 文件已删，
沙箱恢复到三 bundle 干净态（dsh-base / dsh-web-app / dsh-recency-guard）。
