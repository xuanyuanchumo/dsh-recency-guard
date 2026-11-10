// 反向夹具：正常插件。apply 成功返回 ⇒ entry ACTIVE，宿主干净退出。
import './beacon.mjs'

export const name = 'fixture-good'

export function apply() {
  // 不注册任何需要宿主服务的资源：夹具只验证「不崩」，越简单越不会替宿主背锅。
}