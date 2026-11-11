/**
 * `infinityNorm` 的定义域契约（T15-02 未归因清零之二）。
 *
 * ## 为什么「导出」比「补假测试」诚实
 *
 * 它原本是私有函数，生产调用点**恒**传等长向量（两处都由
 * `MARKOV_STAGES.map(...)` 产生）⇒ 长度不等的分支**不可达**，任何针对
 * `i < a.length` 的变异体都不可能被真实现杀死。
 *
 * 按 CLAUDE.md 的纪律：不可达代码**不许**补假测试、**不许**进等价账本。
 * 选项只有两个 —— 「显式归因为工具边界」或「转成可观测契约」。这里选后者：
 * 导出函数后，下面这些**定义域外**的行为从「没人知道的死代码」变成
 * 「有断言记录的事实」。注意断言描述的是**兜底行为**（缺失分量按 0 计），
 * 它存在是为了「观测设施不拖垮守护流程」，**不是**允许调用方传不等长向量；
 * 定义域（等长）写在函数头注里。
 */
import { infinityNorm, markovAnalysis } from '../../src/host/observe/markov.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function main() {
  console.log('\n== 定义域内：等长向量 ==')
  {
    check('identical vectors have distance 0', infinityNorm([1, 2, 3], [1, 2, 3]) === 0)
    check('distance is the max absolute component difference', infinityNorm([1, 2, 3], [1, 5, 3]) === 3)
    check('negative differences use absolute value', infinityNorm([1], [4]) === 3)
    check('empty vectors have distance 0', infinityNorm([], []) === 0)
  }

  console.log('\n== 定义域外（兜底，不是契约）：按 a.length 逐分量、缺失按 0 ==')
  {
    // a 更长：多出的分量参与比较（b 缺失当 0）⇒ max(|1-1|, |5-0|) = 5。
    check('a longer: missing b components count as 0', infinityNorm([1, 5], [1]) === 5, infinityNorm([1, 5], [1]))
    // a 更短：b 的尾部被忽略 ⇒ 只看前两项。
    check('a shorter: b tail is ignored (loop bound is a.length)', infinityNorm([1, 5], [1, 9]) === 4, infinityNorm([1, 5], [1, 9]))
    check('a empty: distance is 0 regardless of b', infinityNorm([], [7, 8]) === 0)
  }

  console.log('\n== 生产调用者的等长不变式（间接证据：幂法结果确定）==')
  {
    // 幂法内部两处入参都来自 MARKOV_STAGES.map ⇒ 等长。用同一输入两次调用，
    // 平稳分布与收敛标记必须逐字节一致（若长度语义被破坏，数值会漂）。
    const journal = [
      { t: '2026-11-01T00:00:01.000Z', phase: 'monitoring' },
      { t: '2026-11-01T00:00:02.000Z', phase: 'deciding' },
      { t: '2026-11-01T00:00:03.000Z', phase: 'stabilizing' },
      { t: '2026-11-01T00:00:04.000Z', phase: 'recovered' },
      { t: '2026-11-01T00:00:05.000Z', phase: 'monitoring' },
    ] as never
    const a = markovAnalysis(journal as never)
    const b = markovAnalysis(journal as never)
    check('markov analysis is deterministic for the same input', JSON.stringify(a) === JSON.stringify(b))
    check('stationary distribution sums to ~1 (power iteration stayed finite)', (() => {
      const values = Object.values(a.stationary ?? {})
      if (values.length === 0) return true
      const sum = values.reduce((s, v) => s + v, 0)
      return Math.abs(sum - 1) < 0.02
    })(), a.stationary)
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
process.exit(failures === 0 ? 0 : 1)