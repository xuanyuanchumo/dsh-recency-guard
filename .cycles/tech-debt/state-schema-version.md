# 技术债：状态文件 schemaVersion

- 登记时间：2026-11-08（cycle-6）
- 来源：参考插件研究（dsh-compat-guardian `lib/index.js:410` 状态文件带
  schemaVersion，非法格式报错而非静默重建）
- 现状：`state.json` / `decision.json` / 归档 manifest 无版本字段；
  读取端用 `{...emptyState(), ...parsed}` 宽容合并 —— 字段演进安全，
  但「文件被外力写坏成相似形状」无法与「旧版本文件」区分。
- 建议：GuardState 增加 `v?: 1`；读取端对不认识的 `v` 报错进 journal
  （不静默重建，保留现场）；归档 manifest 同理。
- 影响面：store.ts / archive.ts / 读取兼容测试。
- 优先级：P2（下一次破坏性字段演进时顺手做）。
