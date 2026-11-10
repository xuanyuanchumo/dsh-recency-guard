// 注入探针：证明本模块的**顶层代码真的被 import 过**。
//
// 为什么需要它：本项目实测过「夹具的顶层代码根本没被 import」的假阳性 ——
// 一个从未加载的坏插件当然不会崩，于是「注入→崩溃→检出」链条上每一环都
// 在空转，测试却全绿。每个夹具的第一行 import 必须写它，检测侧断言 beacon
// 文件存在，才能证明这次注入真的发生过（而不是在测一个不存在的模块）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const file = process.env.FI_BEACON_FILE
if (file) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, module: import.meta.url }, null, 2),
    'utf8',
  )
}