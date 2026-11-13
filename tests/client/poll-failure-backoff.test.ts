import {
  FAILURE_BACKOFF_STEPS,
  nextFailureDelay,
  nextPollDelay,
  pageVisible,
  POLL_BASE_MS,
} from '../../src/client/panel/poll-adaptive.ts'

/**
 * 轮询退避（内容退避 + 失败退避 + 页面可见性）的测试。
 *
 * ## 为什么要有失败退避（新增，v0.19）
 *
 * 内容退避只处理「**成功但内容没变**」。宿主挂掉时请求**失败**，
 * 而失败分支原本返回 `changed: true` ⇒ 下一轮立刻回到 5s ⇒
 * **每 5s 打一次死掉的宿主，永不停歇**。观测设施变成压力源。
 *
 * ## 为什么隐藏时不彻底停轮询
 *
 * 停掉 ⇒ 用户切回标签页要等一个完整周期（最坏 15s）才看到数据，
 * 而用户恰在**切回来的那一刻**最想看新数据。推迟 + 恢复即补拉才是对的。
 *
 * 本文件钉死的高危不变式：
 *
 * 1. **失败退避单调递增且封顶**：5→10→20→40→60s，且永不超上限。
 * 2. **失败计数为 0 ⇒ 立刻重试**（首次失败不该等 60s）。
 * 3. **坏输入不产生 NaN/Infinity**：延迟直接喂 `setTimeout`，
 *    吐出 NaN 会让轮询**永久停摆**（比慢更糟）。
 * 4. **页面可见性在无 document 的环境降级为可见**（不因缺 API 而停轮询）。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

// ---------- 失败退避 ----------

check('失败 0 次 ⇒ 用阶梯首档（立刻重试）', nextFailureDelay(0) === FAILURE_BACKOFF_STEPS[0], nextFailureDelay(0))
check('失败 1 次 ⇒ 首档', nextFailureDelay(1) === FAILURE_BACKOFF_STEPS[0], nextFailureDelay(1))
check('失败 2 次 ⇒ 次档', nextFailureDelay(2) === FAILURE_BACKOFF_STEPS[1], nextFailureDelay(2))
check('失败 3 次 ⇒ 第三档', nextFailureDelay(3) === FAILURE_BACKOFF_STEPS[2], nextFailureDelay(3))
check('失败 5 次 ⇒ 封顶档', nextFailureDelay(5) === FAILURE_BACKOFF_STEPS[FAILURE_BACKOFF_STEPS.length - 1], nextFailureDelay(5))
check('失败 999 次 ⇒ 仍封顶（不越界）', nextFailureDelay(999) === FAILURE_BACKOFF_STEPS[FAILURE_BACKOFF_STEPS.length - 1], nextFailureDelay(999))
check('失败退避单调不减', FAILURE_BACKOFF_STEPS.every((value, index) => index === 0 || value >= FAILURE_BACKOFF_STEPS[index - 1]), [...FAILURE_BACKOFF_STEPS])
check('失败退避封顶 ≤ 60s', Math.max(...FAILURE_BACKOFF_STEPS) <= 60000, Math.max(...FAILURE_BACKOFF_STEPS))

// ---------- 坏输入 ----------

check('失败次数为 NaN ⇒ 落首档（不产生 NaN）', nextFailureDelay(Number.NaN) === FAILURE_BACKOFF_STEPS[0], nextFailureDelay(Number.NaN))
check('失败次数为负 ⇒ 落首档', nextFailureDelay(-5) === FAILURE_BACKOFF_STEPS[0], nextFailureDelay(-5))
check('失败次数为 Infinity ⇒ 落封顶', nextFailureDelay(Number.POSITIVE_INFINITY) === FAILURE_BACKOFF_STEPS[FAILURE_BACKOFF_STEPS.length - 1], nextFailureDelay(Number.POSITIVE_INFINITY))
check('失败次数为小数 ⇒ 向下取整到档位', nextFailureDelay(2.9) === FAILURE_BACKOFF_STEPS[1], nextFailureDelay(2.9))

// ---------- 与内容退避的关系 ----------

check('内容退避仍按基准起步', nextPollDelay({ sameRounds: 0, changed: true }) === POLL_BASE_MS)
check('内容退避封顶 15s', nextPollDelay({ sameRounds: 99, changed: false }) === 15000, nextPollDelay({ sameRounds: 99, changed: false }))
check('失败退避比内容退避上限更保守', Math.max(...FAILURE_BACKOFF_STEPS) > 15000)

// ---------- 页面可见性 ----------

check('无 document 环境 ⇒ 视为可见（不因缺 API 停轮询）', pageVisible() === true)

// ---------- 交付契约：延迟必须是有限正数 ----------

const allDelays = [
  ...FAILURE_BACKOFF_STEPS,
  nextFailureDelay(0),
  nextFailureDelay(3),
  nextFailureDelay(Number.NaN),
  nextPollDelay({ sameRounds: 0, changed: true }),
  nextPollDelay({ sameRounds: 5, changed: false }),
]
check('所有延迟都是有限正数（setTimeout 不会永久停摆）', allDelays.every((d) => Number.isFinite(d) && d > 0), allDelays)

if (failures > 0) {
  console.error(`\npoll-failure-backoff: ${failures} 条断言失败`)
  process.exit(1)
}
console.log('\npoll-failure-backoff 全部通过')
