# 契约层测试报告（cycle-1）

## 1. 头部

| 字段 | 值 |
|---|---|
| 日期 | 2026-11-04 |
| 执行者 | lead（AI，ANIC L4 全自主） |
| 覆盖率要求 | **100%**（漏一条能力登记就是真缺口，不能靠覆盖率稀释） |
| 测试文件 | tests/contract/capability.test.ts |

## 2. 契约内容与断言结果

### 2.1 能力 id 规范

- id 全局唯一；全部以 `guard.` 前缀命名 ✅
- id 形如 `guard.<域>.<名>`（域：observe/decide/recover/present/govern/tool）✅

### 2.2 能力完备性

- 每条能力都有 title / summary / stage / carrier / produces ✅
- 暴露能力必带 exposedAs；非暴露能力必不带 ✅

### 2.3 关系自洽（双向登记）

- 逐条检查 `consumes`：上游存在且上游的 `consumedBy` 反向登记了本能力 ✅
- 逐条检查 `consumedBy`：下游存在且下游的 `consumes` 反向登记了本能力 ✅

### 2.4 无死能力

- 孤立能力 = 0；消费断链 = 0；过度生产 = 0 ✅
- **连通率 connectivity === 1**（15 条能力全连通）✅

### 2.5 暴露面

工具 `recency_guard`、路由 `recency-guard.panel` / `graph` / `reset` / `isolation` 全部在清单中 ✅

### 2.6 路由 ↔ 清单一致

- `ROUTE_PREFIX === '/recency-guard/api'` ✅
- 每个路由路径在 src/routes.ts 中是**字面量**（非模板拼接）且带前缀、互不重复 ✅
- snapshot 路由与暴露能力名一致 ✅

### 2.7 客户端面与 manifest

- `PANEL_ID === 'recency-guard'`、`NAMESPACE === 'recencyGuard'` ✅
- manifest：exports 指向 `./dist/` 且产物真实存在；client.platform=web；bundle.patch 声明存在；locale/zh.json 与 en.json 存在 ✅

### 2.8 Loader 四件套

- 导出恰好为 `name / inject / Config / apply`，无多余导出 ✅

## 3. 双向比对结论

**清单 ↔ 注册处双向比对 `ok === true`**：

| 方向 | 检查 | 结果 |
|---|---|---|
| 清单 → 注册处（漏登） | 清单声明暴露的能力都有对应注册面 | 0 缺口 |
| 注册处 → 清单（虚登） | 注册面没有清单未声明的名字 | 0 缺口 |
| 关系自洽 | consumes/consumedBy 双向登记 | 0 单向 |

## 4. 结论

契约层 100% 通过：能力注册/生产/消费闭环无缺口（R1 门禁证据成立）。
