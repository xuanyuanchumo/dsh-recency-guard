# 工程规范（dsh-recency-guard）

> 每条规范都来自实测教训 —— 违反它们的代价已经付过一次，不要再付一次。

## 1. 中文注释纪律

注释必须说明「**为什么这样写**」，不复述代码在做什么。
好注释回答的是「为什么不用显而易见的另一种写法」—— 那个被否决的方案
通常就是下一个维护者想改回去的方案。

## 2. 验证链（固定顺序，全零错误才算完成）

```bash
npm run build && npx tsc --noEmit && npm run lint && npm test
```

- 宿主测试前置：`npm run extract-runtime`（runtime/ 缺失先解出）。
- 「无法评估」≠「通过」：贴命令输出作为证据。
- 每轮 ANIC 循环必须落盘 `.cycles/cycles/cycle-N/test-reports/*.md`
  （评估器把目录不存在判 FAIL）。

## 3. 测试分层（tests/run.ts）

| 层 | 目录 | 覆盖 |
|---|---|---|
| Core | tests/unit/ | 纯逻辑：能力图/状态机/指标/隔离/归档/工具渲染 |
| Host | tests/host/ | 插件入口 + 工具注册与 action（假服务挂载） |
| Client | tests/client/ | 视口原语/布局/形状/i18n/形状校验（纯函数） |
| Contract | tests/contract/ | 能力清单 ↔ 注册处双向比对 + 包清单 |

新增能力的检查单：清单条目（capability-specs）→ 注册处 noteRegistered →
契约测试 → 快照字段 → 面板/工具消费点。五处缺一即缺口。

## 4. 宿主纪律（dsh 插件通用）

- Loader 四件套（name/inject/Config/apply）之外不导出任何东西。
- webServer 依赖放独立路由子插件（headless 下硬依赖会让 fiber 挂起）。
- 路由路径必须是 `src/routes.ts` 里的**字面量**。
- 只用 `--dsw-alias-*` / `--dsw-radius-*` 主题变量；硬编码颜色仅限 SVG 图形。
- 守护路径（崩溃决策/启动记录/守护行）**同步 IO**。
- 崩溃路径上的兜底数据用**同步变体**（bundleMtimesSync 等）——
  `await` 之后进程可能已经死了。
- 工具输出双形态：规范 JSON 给模型（`execute` 返回值），人读文本进
  `output.render`（会话命令窗口）。裸 `JSON.stringify` 是 v0.3 的显示问题根源。

## 5. 已知陷阱（真实踩坑，勿重蹈）

| 陷阱 | 正确做法 |
|---|---|
| 崩溃趋势回归时间戳 | 回归**相邻崩溃间隔**（只有间隔携带变密/变稀方向） |
| 归档 manifest 在搬走后读 | rename **前**读取（否则摘要永远报 0） |
| consumes/consumedBy 方向写反 | consumes = 我消费谁；consumedBy = 谁消费我 |
| 守护行表达式拿不到分区键 | 用指针文件（.recency-guard/current.json）搭桥 |
| 图谱 fit 在每次轮询重跑 | ref 守卫只 fit 一次（否则用户缩放被重置） |
| 一个包装多行守护行 | 只装第一行（代表行），多行在 Loader 重复 id 抛错 |
| 评估器判 test-reports 缺失 FAIL | 每轮循环落盘测试报告 |
| CUSUM 用中位数当基准 | 用 P75（中位数让一半样本天然低于基准，检测器失明） |
| clipToRect 取最大 t 交点 | 取**最小 t**（进入点）；B 在矩形内时最大 t 就是 B 自己 |

## 6. 版本号同步（三锚点）

发版前核对：`package.json` ↔ `README.md` ↔ `docs/agents/api.md` 的版本一致。
能力清单新增 exposed 能力时，三个文档同步更新。

## 7. 发布与沙箱流程

1. 验证链全绿 + ANIC 门禁 G0-G3 通过。
2. **沙箱验证**（绝不碰主力 profile）：
   `npx @deepseek-ai/dsh@<ver> plugin --profile sb-rg-* add file:/…/dsh-recency-guard`
   → 后台启动 web → 看日志（无 skipping 警告）→ 冒烟 → 用户旅程。
3. 通过后才更新主力 profile（由用户重启主力 dsh）。
4. 归档重置后不继承旧结论；「举他」用最新项目事实。
