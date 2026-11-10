// 坏夹具 A：entry apply 抛错（同步）。
//
// 注意语义：这**不是**无条件崩溃。cordis 会捕获 apply 的异常并把 entry 标成
// FAILED（实测 state=3）；宿主是否因此死掉，取决于 dsh-app-boot 的启动策略：
//   - entry id 在 requiredStartupEntryIds 里（如 webserver）⇒ auditStartupEntries
//     抛 StartupError ⇒ 宿主 fatal 退出码 1（真崩溃）
//   - 否则 ⇒ 只是 warning（自隔离），进程照常活着
// 所以同一个夹具同时充当正向与反向用例，锚定的正是威胁模型那条边界。
import './beacon.mjs'

export const name = 'fixture-apply-throw'

export function apply() {
  throw new Error('fixture: entry apply boom')
}