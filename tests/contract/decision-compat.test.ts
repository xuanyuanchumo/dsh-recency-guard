/**
 * 决策文件向后兼容契约（v0.13 T11-03）。
 *
 * ## 为什么这条契约必须存在
 *
 * v0.13 给 `decision.json` 的 `suspects[]` 加了 `evidence` 字段（因子快照）。
 * 这个字段只服务**面板与离线回放**，不参与拦截判定 —— 守护行的
 * `disabled` 表达式只读 `disable` 数组（`decision.ts:153`）。
 *
 * 但「只读 disable」是**实现事实**，不是**契约**。没有这条测试时，
 * 将来有人把表达式改成 `decision.suspects[0].evidence.risk > 0.5`
 * （一个看起来很合理的"风险阈值拦截"），会：
 * 1. 让老版本决策文件（无 evidence）**静默全部放行**（`undefined > 0.5` 为 false）
 *    ⇒ 崩溃重演，正是本插件要防的场景；
 * 2. 让拦截依赖一个**可选的、纯展示的**字段，把观测面与决策面耦合。
 *
 * 所以这里钉住三件事：
 * - 表达式源码**不引用** `suspects` / `evidence`；
 * - 决策文件有/无 evidence 时，表达式对同一 disable 名单给出**相同结果**；
 * - 决策文件损坏/缺字段时表达式 fail-open（放行），绝不拦死。
 */
import { guardExpression, type Decision } from '../../src/decision.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/**
 * 在受控的假作用域里求值守护行表达式。
 *
 * 表达式期望的作用域：`ctx`（有 `get('profileContext')`）+ `process`（有
 * `getBuiltinModule('fs')`）。这里用内存假文件系统模拟，**不碰真实磁盘**，
 * 因此可以在测试里自由构造「有 evidence / 无 evidence / 损坏」三种决策文件。
 */
function evalGuard(expr: string, files: Record<string, string>): unknown {
  const fakeFs = {
    existsSync: (path: string): boolean => Object.prototype.hasOwnProperty.call(files, path),
    readFileSync: (path: string): string => {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
  }
  const profileDir = '/fake-profile'
  const scope = {
    ctx: {
      get: (name: string) => (name === 'profileContext' ? { dir: profileDir } : undefined),
    },
    process: {
      getBuiltinModule: (name: string) => {
        if (name !== 'fs') throw new Error(`unexpected module ${name}`)
        return fakeFs
      },
    },
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('ctx', 'process', `return ${expr}`) as (c: unknown, p: unknown) => unknown
  return fn(scope.ctx, scope.process)
}

/** 构造一个决策文件路径与指针文件路径（与 decision.ts 的相对路径约定一致）。 */
const POINTER = '/fake-profile/.recency-guard/current.json'
const DECISION = '/fake-profile/projects/abc123/decision.json'

function pointerFile(): string {
  return JSON.stringify({ partitionKey: 'abc123', decisionPath: 'projects/abc123/decision.json', at: '2026-11-10T00:00:00.000Z' })
}

function decisionFile(decision: Partial<Decision> & { disable: string[] }): string {
  return JSON.stringify({ capturedAt: '2026-11-10T00:00:00.000Z', reason: 'crash-recovery', suspects: [], ...decision })
}

function main() {
  const expr = guardExpression('dsh-foo')

  console.log('\n== 表达式源码不引用展示字段（结构门） ==')
  check('表达式不读 suspects', !expr.includes('suspects'), expr)
  check('表达式不读 evidence', !expr.includes('evidence'), expr)
  check('表达式读的是 disable 名单', expr.includes('disable'), expr)
  check('表达式带 try/catch fail-open', expr.includes('catch') && expr.includes('return false'))

  console.log('\n== 有 / 无 evidence ⇒ 拦截结果相同（行为门） ==')
  {
    const legacy = decisionFile({ disable: ['dsh-foo'] })
    const withEvidence = decisionFile({
      disable: ['dsh-foo'],
      suspects: [
        {
          bundle: 'dsh-foo',
          version: '1.0.0',
          lastChangeAt: '2026-11-09T00:00:00.000Z',
          evidence: {
            rank: 1,
            risk: 0.83,
            factors: { recency: 0.4, experimental: 0.3, crashFrequency: 0.13 },
            streak: 3,
            changeCount: 5,
            source: 'journal',
          },
        },
      ],
    })
    const filesLegacy = { [POINTER]: pointerFile(), [DECISION]: legacy }
    const filesEvidence = { [POINTER]: pointerFile(), [DECISION]: withEvidence }

    check('无 evidence 时拦截命中', evalGuard(expr, filesLegacy) === true)
    check('有 evidence 时拦截命中（新字段不影响判定）', evalGuard(expr, filesEvidence) === true)
    check('两种决策文件结果一致', evalGuard(expr, filesLegacy) === evalGuard(expr, filesEvidence))
  }

  console.log('\n== 名单不含本插件 ⇒ 放行 ==')
  {
    const files = { [POINTER]: pointerFile(), [DECISION]: decisionFile({ disable: ['other-plugin'] }) }
    check('不在名单里 ⇒ false（放行）', evalGuard(expr, files) === false)
  }

  console.log('\n== fail-open：任何一步失败都放行（绝不拦死） ==')
  {
    check('指针文件缺失 ⇒ 放行', evalGuard(expr, { [DECISION]: decisionFile({ disable: ['dsh-foo'] }) }) === false)
    check('决策文件缺失 ⇒ 放行', evalGuard(expr, { [POINTER]: pointerFile() }) === false)
    check(
      '指针文件损坏 ⇒ 放行',
      evalGuard(expr, { [POINTER]: '{not json', [DECISION]: decisionFile({ disable: ['dsh-foo'] }) }) === false,
    )
    check(
      '决策文件损坏 ⇒ 放行',
      evalGuard(expr, { [POINTER]: pointerFile(), [DECISION]: '{not json' }) === false,
    )
    check(
      '指针指向不存在的决定文件 ⇒ 放行',
      evalGuard(expr, {
        [POINTER]: JSON.stringify({ partitionKey: 'x', decisionPath: 'projects/gone/decision.json' }),
      }) === false,
    )
    check(
      'disable 不是数组 ⇒ 放行（不把畸形数据当命中）',
      evalGuard(expr, {
        [POINTER]: pointerFile(),
        [DECISION]: JSON.stringify({ disable: 'dsh-foo' }),
      }) === false,
    )
    check(
      '表达式内异常不冒泡（返回 false 而非 throw）',
      (() => {
        try {
          return evalGuard(expr, { [POINTER]: pointerFile(), [DECISION]: '{}' }) === false
        } catch {
          return false
        }
      })(),
    )
  }

  console.log('\n== 包名转义不受影响 ==')
  {
    const scopedExpr = guardExpression('@scope/pkg-name')
    const files = { [POINTER]: pointerFile(), [DECISION]: decisionFile({ disable: ['@scope/pkg-name'] }) }
    check('scoped 包名可正确拦截', evalGuard(scopedExpr, files) === true)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  if (failures > 0) process.exit(1)
}

main()
