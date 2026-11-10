// 坏夹具 B：进程级错误 —— apply 里直接 process.exit(1)。
//
// 为什么必须单独一类：cordis 的 apply 被包在 try/catch 里，但 process.exit
// 是同步终止进程，异常处理根本没有机会运行。这是「守护必须能检出」的
// 真崩溃形态，且 exit(1) 会执行 process.on('exit') ⇒ 哨兵通道有信号。
import './beacon.mjs'

export const name = 'fixture-exit-now'

export function apply() {
  process.exit(1)
}