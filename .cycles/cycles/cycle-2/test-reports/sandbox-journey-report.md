# 沙箱真机用户旅程报告（cycle-2）

## 1. 头部

| 字段 | 值 |
|---|---|
| 日期 | 2026-11-04 |
| 执行者 | lead（AI，ANIC L4 全自主） |
| 沙箱 profile | `sb-rg-journey2`（独立新建；未触碰 desktop/web/sb-rg） |
| 宿主 | dsh 0.2.1-rc.5（`runtime/cli/bin/dsh.cmd`），Node 24.14/24.21 |
| 工作区 | `D:/Projects/TraeProjects/rg-project-b`（分区键 16902bd13516ae32） |
| 嫌疑夹具 | `.tmp/fake-crash-plugin`（启动即未捕获异常）、`.tmp/fake-crash-plugin2`（同） |

## 2. 正向旅程（崩溃 → 预启动拦截 → 恢复）

| # | 场景 | 预期 | 实测证据 | 结果 |
|---|---|---|---|---|
| P1 | 首次启动（守护已装行） | 崩溃 exit 1；决策关闭最近更新 1 个 | `EXIT=1`；`fatal uncaught exception: fake plugin crash`；decision.json `disable:["dsh-fake-crash-plugin2"] crashSeq:1`；哨兵/指针/分区就位 | PASS |
| P2 | 二次启动 | plugin2 被**预启动拦截**（模块不加载）；plugin1 仍崩 → 升级关 2 个 | journal `第 2 次崩溃` + `suspects:[plugin2,plugin1]`；`disable:[plugin2,plugin1] crashSeq:2`；崩溃栈只指向 plugin1（plugin2 未加载） | PASS |
| P3 | 三次启动 | 双嫌疑都被拦截 → **启动成功**；stabilized=true；非首要嫌疑自动恢复 | `--dump-config` exit 0（无 crash）；后续完整启动：state `stabilized:true`，journal `restore: 重新启用 dsh-fake-crash-plugin2`；plugin1（首要嫌疑）保持关闭 | PASS |

## 3. 负向旅程（反场景）

| # | 场景 | 预期（安全语义） | 实测证据 | 结果 |
|---|---|---|---|---|
| N1 | decision.json 损坏（`{broken json!!`） | 表达式异常 → 返回 false → 全部放行（不锁死） | `--dump-config` exit 0，无解析失败 | PASS |
| N2 | 指针文件缺失 | 同上（fail-open） | exit 0，无解析失败 | PASS |
| N3 | `enabled:false`（patch config 行） | 只记录，**绝不**自动禁用 | 崩溃后 **无 decision 文件**（NO DECISION FILE） | PASS |
| N4 | reenable 语义 | 移除 autoDisabled + 决策清空 → 下次启动拦截解除 | 真实分区：`autoDisabled:[plugin2]→[] restored:[plugin2]`；重启后崩溃栈指向 plugin1（plugin2 已正常加载） | PASS |
| N5 | 归档重置 | 状态搬走留档（manifest 先读后搬）+ 计数归零 + 决策清空 | `crashSeq 1→0`、`autoDisabled→[]`、`disable→[]`；manifest `workspace=rg-project-b reason=旅程N5 crashSeq=1 entries=7`；`archives listed=1` | PASS |
| N6 | 多项目隔离 | A 崩溃不影响 B；键唯一；journal 互不可见 | `keyA≠keyB`；A `crashSeq=3` 而 B `crashSeq=0`；A journal=[dsh-only-in-a] B=[dsh-only-in-b] | PASS |
| N7 | 「举他」只读对照 | 另一工作区读清单，不导入任何状态 | N5b/N6：清单 read-only reference，无状态导入 | PASS |

## 4. 旅程中发现并修复的真实缺陷（R08 缺陷闭环）

**缺陷**：dsh 生成的 profile patch 是「注释 + `[]`」空数组文档。
`appendPatchText` 只对裸 `[]` 做整体等值摘除，注释存在时空标记残留，
追加守护行后文件成为「流式空数组 + 块序列」混合 —— Loader 抛
`YAMLException: end of the stream or a document separator is expected`，
**profile 起不来**（P1 首跑实测：EXIT=1 且守护行本身成为崩溃面）。

**修复**：`src/guarded-rows.ts` 按行摘除空数组标记（注释保留）；
新增 Core 层回归测试（dsh 形态 / 裸 [] / 既有内容三场景）。
修复后 P1-P3 全链路通过。

## 5. 环境与复现

```bash
# profile 初始化（一次）
dsh plugin --profile sb-rg-journey2 add file:D:/Projects/TraeProjects/dsh-recency-guard
dsh plugin --profile sb-rg-journey2 add file:<repo>/.tmp/fake-crash-plugin
dsh plugin --profile sb-rg-journey2 add file:<repo>/.tmp/fake-crash-plugin2
# 旅程（在任意项目目录）
dsh --profile sb-rg-journey2 --help          # P1 崩溃
dsh --profile sb-rg-journey2 --help          # P2 拦截 1 个仍崩
dsh --profile sb-rg-journey2 --dump-config   # P3 干净（exit 0）
```

## 6. 诚实边界

- N4 reenable 与 N5/N6/N7 用真实分区 + 插件自有 Store/archive API 在
  `tsx` 下执行（等价于工具 action 的存储层路径）；工具 action 本身在
  Host 层测试（tests/host/tool.test.ts）已覆盖注册与分发。
- 沙箱副本是 pnpm 从 `file:` 目录的**真实拷贝**（非硬链）：改源码后必须
  `pnpm remove/add` 刷新沙箱副本，否则验证的是旧代码（本次实测踩坑）。
- profile 目录在验证后可整体删除，无残留。

## 7. 结论

正反向旅程 **10/10 场景 PASS（100%）**：正向 3 + 负向 7（含隔离与举他）。
G2「旅程覆盖零缺口」证据成立。
