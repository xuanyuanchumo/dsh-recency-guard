/**
 * `core/self-describe.ts` 直接单测（T15-04）。
 *
 * 为什么补这条：它此前只被 index.ts 消费（自描述卡/版本行），没有直接测试
 * ⇒ 三个 fail-soft 分支与向上查找清单的逻辑**从没进过变异池**。
 *
 * 纪律：断言不猜「版本应该等于 package.json 的某个硬编码值」，而是**现场读
 * 同一份 package.json 对照** —— 版本号会随发布变，断言不该因此脆断。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  optionalRequire,
  readHostVersion,
  readSelfPackage,
  safeJson,
  safeVersion,
} from '../../src/host/core/self-describe.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const projectRoot = join(import.meta.dirname, '..', '..')
const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
  version?: string
  repository?: unknown
  bugs?: unknown
}

console.log('\n== safeJson：可序列化兜底 ==')
{
  const round = safeJson({ a: 1, b: ['x'], c: null })
  check('普通对象 JSON 往返不变', JSON.stringify(round) === '{"a":1,"b":["x"],"c":null}', round)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  let threw: unknown
  let fallback: unknown
  try {
    fallback = safeJson(circular)
  } catch (error) {
    threw = error
  }
  check('循环引用不抛异常（降级成字符串）', threw === undefined, threw)
  check('循环引用的降级结果是 String(v)', fallback === '[object Object]', fallback)
}

console.log('\n== optionalRequire：可选依赖缺席不抛 ==')
{
  let threw: unknown
  let value: unknown = 'sentinel'
  try {
    value = optionalRequire('dsh-recency-guard-definitely-not-installed-xyz')
  } catch (error) {
    threw = error
  }
  check('缺失的可选模块返回 undefined（不抛）', threw === undefined && value === undefined, { threw, value })
}

console.log('\n== readSelfPackage：向上查找本包清单 ==')
{
  const self = readSelfPackage()
  check('版本与现场 package.json 一致', self.version === (manifest.version ?? null), { got: self.version, want: manifest.version })
  check('版本非空（重构后不能静默降级为 null）', typeof self.version === 'string' && self.version.length > 0, self.version)
  check(
    'issues 链接要么是 https、要么诚实为 null',
    self.issuesUrl === null || self.issuesUrl.startsWith('https://'),
    self.issuesUrl,
  )
  check(
    'repository 链接要么是 https、要么诚实为 null',
    self.repositoryUrl === null || self.repositoryUrl.startsWith('https://'),
    self.repositoryUrl,
  )
}

console.log('\n== safeVersion / readHostVersion：宿主版本 fail-soft ==')
{
  check('safeVersion 返回字符串（缺席时 unknown，不是空串）', typeof safeVersion() === 'string' && safeVersion().length > 0, safeVersion())
  const host = readHostVersion()
  check('readHostVersion 返回 string 或 null（绝不猜）', host === null || typeof host === 'string', host)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)