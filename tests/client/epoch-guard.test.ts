import { applyIfCurrent, createEpochGuard } from '../../src/client/panel/epoch-guard.ts'

/**
 * 在途请求世代守卫的测试。
 *
 * ## 为什么这道防线不可省
 *
 * 面板允许查看别的分区。用户快速切换时，**上一分区的请求可能还在路上**：
 *
 * ```
 * t0: 切到分区 B → 发出请求 B（慢）
 * t1: 切到分区 C → 发出请求 C（快）→ C 先落地 ⇒ 画面显示 C
 * t2: B 后到      → 无守卫则直接 setSnapshot(B) ⇒ 画面显示 B（用户以为在看 C）
 * ```
 *
 * 在一个专门做「按项目隔离、不串扰」的插件里，这是最不能有的缺陷：
 * 用户会据此对**别的项目**的插件做出关闭/恢复决策。
 *
 * 现有的 `partitionMismatch` 挡不住它 —— 那个比对「请求的分区 vs 响应自称的
 * 分区」，这里两者**一致**（B 的响应确实自称 B）。问题不是「响应撒谎」，
 * 而是「**响应已过期**」。
 *
 * 本文件钉死的高危不变式：
 *
 * 1. **过期响应不落地**：世代号不匹配 ⇒ 数据被丢弃。
 * 2. **竞态顺序无关**：无论 B/C 谁先返回，画面最终都是 C（最新选择）。
 * 3. **advance 幂等语义清晰**：每次切换 +1，单调递增。
 * 4. **同世代仍可落地**：不误杀当前世代的响应。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

// ---------- 基本语义 ----------

const guard = createEpochGuard()
check('初始世代号为 0', guard.current === 0)
check('begin 返回当前世代号', guard.begin() === 0)
check('同世代请求仍然有效', guard.isCurrent(guard.begin()) === true)

guard.advance()
check('advance 后世代号 +1', guard.current === 1)
check('旧世代号的请求已过期', guard.isCurrent(0) === false)
check('新世代号的请求有效', guard.isCurrent(guard.begin()) === true)

// ---------- 竞态：旧分区响应后到被丢弃 ----------

const raceGuard = createEpochGuard()
const landed: string[] = []

// 用户切到 B：请求 B 发出，记下世代 0。
const epochB = raceGuard.begin()
// 用户又切到 C：世代推进。
raceGuard.advance()
// 请求 C 发出，记下世代 1。
const epochC = raceGuard.begin()

// C 先落地（快）⇒ 接受。
applyIfCurrent(epochC, raceGuard, (data: string) => landed.push(data), 'C')
// B 后落地（慢）⇒ 过期，必须丢弃。
applyIfCurrent(epochB, raceGuard, (data: string) => landed.push(data), 'B')

check('竞态：只有最新世代的数据落地', landed.length === 1 && landed[0] === 'C', landed)

// ---------- 竞态：旧分区响应先到（也应被丢弃） ----------

const raceGuard2 = createEpochGuard()
const landed2: string[] = []
const epochB2 = raceGuard2.begin()
raceGuard2.advance()
const epochC2 = raceGuard2.begin()
// B 先到（快）⇒ 但此时用户已切到 C ⇒ 丢弃。
applyIfCurrent(epochB2, raceGuard2, (data: string) => landed2.push(data), 'B')
// C 后到 ⇒ 接受。
applyIfCurrent(epochC2, raceGuard2, (data: string) => landed2.push(data), 'C')
check('竞态（反序）：最终仍只有最新世代', landed2.length === 1 && landed2[0] === 'C', landed2)

// ---------- applyIfCurrent 的返回值语义 ----------

const g3 = createEpochGuard()
const applied: string[] = []
check('applyIfCurrent 落地时返回 true', applyIfCurrent(g3.begin(), g3, (v: string) => applied.push(v), 'x') === true)
g3.advance()
check('applyIfCurrent 过期时返回 false', applyIfCurrent(0, g3, (v: string) => applied.push(v), 'y') === false)
check('applyIfCurrent 过期时不调用落地函数', applied.length === 1 && applied[0] === 'x', applied)

// ---------- 世代号单调递增 ----------

const g4 = createEpochGuard()
const epochs: number[] = []
for (let i = 0; i < 5; i += 1) {
  epochs.push(g4.begin())
  g4.advance()
}
check('世代号单调递增', epochs.every((value, index) => index === 0 || value > epochs[index - 1]), epochs)
check('advance 后的世代号大于所有历史世代', g4.current > Math.max(...epochs))

// ---------- 初始世代号可定制 ----------

const g5 = createEpochGuard(10)
check('初始世代号可定制', g5.current === 10)

if (failures > 0) {
  console.error(`\nepoch-guard: ${failures} 条断言失败`)
  process.exit(1)
}
console.log('\nepoch-guard 全部通过')
