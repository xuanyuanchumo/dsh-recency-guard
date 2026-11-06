# 沙箱旅程报告 —— cycle-1（v2）

## 1. 头部

| 字段 | 值 |
|---|---|
| 沙箱 | `sb-rg-probe`（%DSH_HOME%\profiles\sb-rg-probe）|
| 端口 | 3083（避开主力 64474） |
| dsh 版本 | 0.2.1-rc.5（与本插件 peer 匹配） |
| 旅程时间 | 2026-11-04 16:30 ~ 2026-11-05 02:15 |

## 2. 沙箱初始化

```
npx -y "@deepseek-ai/dsh@0.2.1-rc.5" plugin --profile sb-rg-probe add file:D:/Projects/TraeProjects/dsh-recency-guard
pnpm install（补 @deepseek-ai/dsh-web-app + @deepseek-ai/dsh-base）
node <npx-cache>/@deepseek-ai/dsh/lib/bin.js --profile sb-rg-probe --port 3083 --no-open
```

## 3. 启动形态的教训（本轮实测，写入 conventions）

| 形态 | 结果 |
|---|---|
| `dsh web --profile X` | **报错**："select a profile only once"——`dsh web` 本身就是「启动 web 主力 profile」的缩写（dsh web ≡ dsh --profile web），再加 --profile 是二次选择 |
| `DSH_PROFILE=X env + dsh web` | **危险**：env 被忽略，启动的是 web 主力 profile 第二实例（桌面插件全加载）——已立即终止且未污染 desktop 分区 |
| `dsh --profile X --port P`（profile 内有 web-app bundle） | **正确形态**：独立沙箱起来，插件激活，路由可用 |
| profile 无 @deepseek-ai/dsh-web-app | 进程活但不监听（没有 web 服务器） |

## 4. 旅程结果（正向）

| # | 场景 | 结果 |
|---|---|---|
| J1 | GET /recency-guard/api/snapshot → 200（快照一次成型） | ✓ |
| J2 | GET /graph → 16 节点 25 边 6 列（分层布局） | ✓ |
| J3 | GET /archives → {archives:[]}（缺席即诚实空） | ✓ |
| J4 | POST /action/recover → 200，disabled=[]（守护自身不被列为嫌疑——0.5.0 修复） | ✓ |
| J5 | GUI 面板渲染：KPI 圆环 79/监控中/崩溃率 0%/趋势平稳/CUSUM 无上行变点 | ✓（截图） |
| J6 | GUI 图谱：搜索「风险」→ 命中「风险评分」→ 回车定位 → 详情侧栏（类型/引用/连接数 入1·出2/居中定位） | ✓（截图） |
| J7 | 契约自检 gaps=0（noteRegistered alias 与清单一致） | ✓ |
| J8 | 多项目隔离：partitions 显示两个工作区独立分区 | ✓ |
| J9 | 指标诚实边界：无样本的恢复耗时/检出率/间隔/变点显示「不可判定」而非 0 | ✓ |

## 5. 旅程结果（反向）

| # | 场景 | 结果 |
|---|---|---|
| R1 | 无 webServer 的 headless 环境 | 路由子插件 pending 仅自身，工具/状态机照常（routes-plugin 设计回归） |
| R2 | client.js 为裸 ESM 的旧产物 | import failed → 双段构建管线修复后消除 |
| R3 | ctx 服务未声明时读取 | 抛错被 try/catch 捕获，telemetry.skipped 如实记录 |
| R4 | sidebar 未渲染时注册 panellist | not declared 被吞，epoch 变化后宿主重放回调注册成功 |
| R5 | 沙箱崩溃隔离 | 全程主力 desktop（64474）未受任何影响（红线核查：desktop 分区无新增） |

## 6. 结论

沙箱旅程正反向全部通过。面板席位、图谱交互、指标、隔离、归档在独立 profile 下与设计一致。
