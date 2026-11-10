// 坏夹具 C：加载成功后异步抛错（H4.2 明确要抓的时序缺陷）。
//
// apply 成功返回 ⇒ entry ACTIVE、宿主认为插件没问题；错误发生在之后的事件
// 循环里。这正是单元测试最难覆盖、故障注入最有价值的形态：启动完成 ≠ 安全。
// 真实宿主装了 installFailLoud，uncaughtException ⇒ 一条 fatal 诊断 + exit(1)。
import './beacon.mjs'

export const name = 'fixture-async-throw'

export function apply() {
  setTimeout(() => {
    throw new Error('fixture: async boom after successful apply')
  }, 10)
}