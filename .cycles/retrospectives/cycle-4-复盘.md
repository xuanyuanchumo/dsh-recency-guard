# 循环复盘 —— cycle-4（v0.6.0）

## 量化产出

| 项 | 值 |
|---|---|
| 任务 | 8/8 完成（T01-T08） |
| 测试 | 4/4 文件全绿，0 失败 0 错误（Core/Host/Client/Contract） |
| 门禁 | G0-G3 全 PASS（含 Q1-Q8 质量维度），G2 记账 hash eb0f252be37879fa |
| 新增消费链 | 2 条（ewma→快照/KPI；archive summary→工具/面板） |
| 沙箱旅程 | 13/13 PASS（J1-J13） |

## 做得好

1. **过度生产缺口的系统检出**：本轮主旨来自「生产了没人消费」的契约分析
   （ewma、readArchiveManifest）——能力清单的 analyze() 第一次在自己身上
   抓出真缺口，闭环方法论被验证。
2. **测试先行抓真缺陷**：自环邻居缺陷由测试断言先暴露（组件后修），
   分层测试的价值被再次实证（R03）。
3. **诚实边界贯彻**：crashPressure 无观测 = null；归档后 stage=idle +
   压力「不可判定」在真实沙箱旅程中复核（J6）。

## 踩坑与教训（编码化）

1. **pnpm file: 依赖会落盘拷贝**：沙箱里 node_modules/dsh-recency-guard 是
   静默的**目录拷贝**而非链接——「改了源码沙箱没变化」的根因。
   修复后用 junction。**教训**：file: 挂载后必须核验 LinkType 是 Junction。
2. **bundle 层选择 ≠ 依赖安装**：插件装了但不在 `dsh.profile.bundles` 里
   ⇒ bundle patch 层不组合 ⇒ 静默不激活（无任何警告）。**教训**：404 路由
   + 空 patch 是「层未选择」的指纹。
3. **DSH_PROFILE 环境继承**：会话内启动沙箱必须清 DSH_PROFILE/DSH_PROFILE_DIR，
   否则 --profile 报「select a profile only once」。
4. **门禁格式契约**：G2 解析测试报告需要「通过/失败」行格式的 §2 汇总表
   （自由格式不算）。**教训**：报告格式遵循 cycle-3 的通过范本。
5. **归档后 init-cycle 号回绕**：登记技术债
   `.cycles/tech-debt/anic-init-cycle-number-rewind.md`（技能侧修复建议已写）。

## 遗留与移交

- 桌面端 0.6.0 已热重载调度（handshake scheduled）；重启后面板/工具全量生效。
- 沙箱 sb-rg-5 保留（跨天持续开发复用）；schedule 存储噪声为官方包问题，
  与本插件无关。
- 技术债 1 项移交 ANIC 技能侧（非本插件修复范围）。
