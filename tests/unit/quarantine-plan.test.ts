/**
 * 贪心最小隔离集 + 依赖联动 + 候选排序（T14-04 判据 3/4/5）。
 *
 * ## 要钉住的四件事
 *
 * 1. **终止性**：有解（error 清零）/ 无解（无候选）/ 环（A↔B 互相依赖）
 *    三种形态都必须返回，且环状依赖不会让循环多跑（visited 集合）。
 * 2. **依赖联动**：关掉被依赖者时，依赖者一并进计划 —— 否则下一步崩在
 *    import 处，用户看到的是一次「新的」崩溃。
 * 3. **排序双向**：无声明 ⇒ 保持输入序（纯 recency，逐位不变）；
 *    有声明 ⇒ 已停用优先 → priority 升序 → 列表靠后。
 * 4. **unresolved 不静默**：治不了（受保护/无候选/配额）必须带出来。
 */
import {
  dependentsClosure,
  orderCandidates,
  planQuarantine,
  roundBudget,
  type CandidatePlugin,
} from '../../src/host/guard/quarantine-plan.ts'
import type { ConflictFinding } from '../../src/host/guard/conflict-metadata.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造候选。 */
function candidate(name: string, opts: Partial<CandidatePlugin> = {}): CandidatePlugin {
  return {
    name,
    enabled: true,
    index: opts.index ?? 0,
    ...opts,
  }
}

/** 造一条 finding（默认 error；唯一约定是首项为主责）。 */
function finding(kind: ConflictFinding['kind'], plugins: string[], severity: ConflictFinding['severity'] = 'error'): ConflictFinding {
  return {
    kind,
    severity,
    plugins,
    message: `${kind} on ${plugins.join(',')}`,
    source: { file: `/fake/${plugins[0]}/package.json`, line: 3 },
    declaration: '{"stub":true}',
  }
}

function main() {
  console.log('\n== 终止性 1/3：有解（error 清零） ==')
  {
    const plugins = [
      candidate('a', { declared: true, priority: 1, index: 0 }),
      candidate('b', { declared: true, priority: 9, index: 1 }),
    ]
    const plan = planQuarantine(plugins, [finding('declared-conflict', ['a', 'b'])])
    check('solvable: terminates with no-error', plan.terminatedBy === 'no-error', plan.terminatedBy)
    check('solvable: disables exactly one (minimal set)', plan.quarantine.length === 1, plan.quarantine)
    check('solvable: adaptive step recorded', plan.steps.length === 1, plan.steps)
    check('solvable: remaining errors hit zero', plan.steps[0]?.remainingErrors === 0, plan.steps[0])
    check('solvable: unresolved empty', plan.unresolved.length === 0, plan.unresolved)
  }

  console.log('\n== 终止性 2/3：无解（无候选） ==')
  {
    // 冲突双方都受保护 ⇒ 一个都不能关，error 永远在。
    const plugins = [candidate('official-a', { protected: true }), candidate('official-b', { protected: true })]
    const plan = planQuarantine(plugins, [finding('duplicate-service', ['official-a', 'official-b'])])
    check('unsolvable: terminated by no-candidate', plan.terminatedBy === 'no-candidate', plan.terminatedBy)
    check('unsolvable: quarantine empty', plan.quarantine.length === 0, plan.quarantine)
    check('unsolvable: unresolved carries the残余 error', plan.unresolved.length === 1, plan.unresolved)
    check('unsolvable: the残余 is the same finding', plan.unresolved[0]?.kind === 'duplicate-service', plan.unresolved[0])
  }

  console.log('\n== 终止性 3/3：环状依赖（visited 防死循环） ==')
  {
    const plugins = [
      candidate('a', { declared: true, dependencies: ['b'], index: 0 }),
      candidate('b', { declared: true, dependencies: ['a'], index: 1 }),
    ]
    const plan = planQuarantine(plugins, [finding('dsh-version', ['a'])])
    check('cycle: terminates', plan.quarantine.length > 0, plan)
    check('cycle: no repeated plugin in the plan', new Set(plan.quarantine).size === plan.quarantine.length, plan.quarantine)
    check('cycle: both sides of the ring quarantined together', plan.quarantine.length === 2, plan.quarantine)

    // 直接调闭包：环不会无限展开。
    const closure = dependentsClosure(plugins, ['a'])
    check('cycle closure: visited prevents re-entry', JSON.stringify(closure) === '["a","b"]', closure)
  }

  console.log('\n== 依赖联动：关一个 = 关一组 ==')
  {
    // top → mid → leaf：leaf 是冲突源，关 leaf 必须连带 mid、top。
    const plugins = [
      candidate('top', { dependencies: ['mid'], index: 0 }),
      candidate('mid', { dependencies: ['leaf'], index: 1 }),
      candidate('leaf', { index: 2 }),
      candidate('unrelated', { index: 3 }),
    ]
    const plan = planQuarantine(plugins, [finding('declared-conflict', ['leaf', 'unrelated'])])
    check('linkage: closure covers the whole dependents chain', JSON.stringify(plan.quarantine) === '["leaf","top","mid"]', plan.quarantine)
    check('linkage: unrelated plugin stays enabled', !plan.quarantine.includes('unrelated'), plan.quarantine)
    check('linkage: linked plugins are reported per step', plan.steps[0]?.linked.includes('top') === true && plan.steps[0]?.linked.includes('mid') === true, plan.steps[0])
    check('linkage: terminates with no-error', plan.terminatedBy === 'no-error', plan.terminatedBy)
  }

  console.log('\n== 排序双向 A：无声明 ⇒ 保持输入序（纯 recency） ==')
  {
    const input = [candidate('newest', { index: 0 }), candidate('middle', { index: 1 }), candidate('oldest', { index: 2 })]
    const ordered = orderCandidates(input)
    check('fallback: input order preserved verbatim', JSON.stringify(ordered.map((c) => c.name)) === '["newest","middle","oldest"]', ordered.map((c) => c.name))
    check('fallback: same array content identity not required', ordered.length === input.length && ordered[0] === input[0])

    // 计划器在无声明时也必须按输入序挑人（fixture 证明「只有预期场景变化」）。
    const findings = [finding('declared-conflict', ['newest', 'middle'])]
    const plan = planQuarantine(input, findings)
    check('fallback: planner picks the first candidate in recency order', plan.quarantine[0] === 'newest', plan.quarantine)
  }

  console.log('\n== 排序双向 B：有声明 ⇒ 已停用优先 → priority 升序 → 列表靠后 ==')
  {
    // priority 升序：低 priority（更靠后）先被关。
    const declared = [
      candidate('a', { declared: true, priority: 9, index: 0 }),
      candidate('b', { declared: true, priority: 1, index: 1 }),
    ]
    const ordered = orderCandidates(declared)
    check('declared: lower priority first', ordered[0]?.name === 'b', ordered.map((c) => c.name))

    // alreadyDisabled 优先于 priority（零代价优先）。
    const withDisabled = [
      candidate('costly', { declared: true, priority: 1, index: 0 }),
      candidate('freebie', { declared: true, priority: 99, index: 1, alreadyDisabled: true }),
    ]
    check('declared: already-disabled wins over priority', orderCandidates(withDisabled)[0]?.name === 'freebie')

    // 同已停用、同 priority ⇒ 列表靠后先（index 大者先）。
    const samePriority = [
      candidate('front', { declared: true, priority: 0, index: 0 }),
      candidate('back', { declared: true, priority: 0, index: 9 }),
    ]
    check('declared: later list position wins on ties', orderCandidates(samePriority)[0]?.name === 'back')
  }

  console.log('\n== 配额与确定性 ==')
  {
    // 两条独立 error，各自只有一个候选 ⇒ 需要关 2 个；配额 1 ⇒ 停在第 1 步。
    const plugins = [candidate('x', { declared: true, index: 0 }), candidate('y', { declared: true, index: 1 })]
    const findings = [finding('dsh-version', ['x']), finding('dsh-version', ['y'])]
    const capped = planQuarantine(plugins, findings, { maxDisable: 1 })
    check('cap: stops at the cap', capped.quarantine.length === 1, capped.quarantine)
    check('cap: terminated by cap', capped.terminatedBy === 'cap', capped.terminatedBy)
    check('cap: unresolved reports the rest', capped.unresolved.length === 1, capped.unresolved)

    // 同一输入两次计划必须逐字节一致（崩溃路径可回放）。
    const full = planQuarantine(plugins, findings)
    const again = planQuarantine(plugins, findings)
    check('determinism: same input yields identical plan', JSON.stringify(full) === JSON.stringify(again), { full, again })
    check('determinism: no cap means both get quarantined', full.quarantine.length === 2, full.quarantine)
  }

  console.log('\n== warning 不参与隔离 ==')
  {
    const plugins = [candidate('a', { declared: true, index: 0 })]
    const plan = planQuarantine(plugins, [finding('missing-dependency', ['a'], 'warning')])
    check('warning-only findings produce no quarantine', plan.quarantine.length === 0, plan)
    check('warning-only findings terminate by no-error', plan.terminatedBy === 'no-error', plan.terminatedBy)
  }

  console.log('\n== 轮数上界：预算耗尽 ⇒ cap（不是 no-candidate / no-error） ==')
  {
    // 两个插件各自一条独立 finding；预算只有 1 ⇒ 关掉第 1 个后循环必须停。
    const plugins = [candidate('x', { declared: true, index: 0 }), candidate('y', { declared: true, index: 1 })]
    const findings = [finding('dsh-version', ['x']), finding('dsh-version', ['y'])]
    const starved = planQuarantine(plugins, findings, { roundBudget: 1 })
    check('roundBudget formula is P+1', roundBudget(3) === 4 && roundBudget(0) === 1, [roundBudget(3), roundBudget(0)])
    check('exhausted budget terminates with cap', starved.terminatedBy === 'cap', starved.terminatedBy)
    check('exhausted budget keeps the work it already did', starved.quarantine.length === 1, starved.quarantine)
    check('exhausted budget reports the residual finding', starved.unresolved.length === 1, starved.unresolved)
    check('exhausted budget reports exactly one step', starved.steps.length === 1, starved.steps)

    // 对照 1：无候选可动（全受保护）⇒ 必须是 no-candidate，不能被预算分支抢答。
    const protectedOnly = planQuarantine([candidate('official', { protected: true })], [finding('dsh-version', ['official'])])
    check('protected-only terminates with no-candidate', protectedOnly.terminatedBy === 'no-candidate', protectedOnly.terminatedBy)

    // 对照 2：有解且预算充足（默认 P+1）⇒ no-error，而不是耗尽。
    const solved = planQuarantine(plugins, findings, { roundBudget: roundBudget(plugins.length) })
    check('default budget is enough for two independent findings', solved.quarantine.length === 2, solved.quarantine)
    check('default budget ends with no-error (not cap)', solved.terminatedBy === 'no-error', solved.terminatedBy)
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
process.exit(failures === 0 ? 0 : 1)