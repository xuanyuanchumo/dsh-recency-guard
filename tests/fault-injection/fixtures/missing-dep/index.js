// 坏夹具 D：缺失依赖（ERR_MODULE_NOT_FOUND），发生在**模块 import 阶段**。
//
// 关键顺序：beacon 先 import 且先求值，缺失包后求值并抛错。这样即使 import
// 失败，beacon 也已经落盘 —— 检测侧能区分「模块真的被加载过但解析失败」与
// 「模块根本没被 import」（后者是假阳性来源）。
//
// 与夹具 A 同理：是否构成宿主崩溃取决于 entry id 是否属于 requiredStartupEntryIds。
import './beacon.mjs'

export const name = 'fixture-missing-dep'

export function apply() {}

// 为什么用动态 import 而不是静态 import：ESM 在**链接阶段**解析全部静态依赖，
// 静态 import 缺失包会让 beacon 也永远不被求值（实测），于是「模块真的被加载过」
// 这个证据就丢了。动态 import 发生在求值阶段，beacon 已先执行，错误照样是
// ERR_MODULE_NOT_FOUND，Loader 的处理路径与静态 import 失败一致。
await import('dsh-fault-injection-missing-package-xyz')