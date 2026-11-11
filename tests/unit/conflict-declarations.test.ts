/**
 * `guard/conflict-declarations.ts` + `guard/conflict-findings.ts` 直接单测（T15-04）。
 *
 * 为什么补这条：这两份文件是 T14-03「确定性冲突证据」的实现，但此前没有
 * **直接 import** 它们的测试（evidence 的测试走的是转发层）⇒ 声明解析的
 * 范围判定与 finding 生成从未进变异池。
 *
 * 覆盖的外部依赖说明（不假装覆盖）：本文件只读 profile 目录的
 * `package.json` / `node_modules/<name>/package.json` / `dsh-plugin.json`；
 * **不**覆盖 `quarantine-plan` 如何消费 findings，也不覆盖真实 dsh 运行时的
 * 版本来源（`hostVersion` 一律显式传入）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  locateKeyLine,
  readDeclaredPluginsSync,
  satisfiesRange,
  type DeclaredPlugin,
} from '../../src/host/guard/conflict-declarations.js'
import { errorFindings, findingActive, findingsFor } from '../../src/host/guard/conflict-findings.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}
function plugin(over: Partial<DeclaredPlugin> & { name: string }): DeclaredPlugin {
  return {
    source: { file: 'fixture', line: 1 },
    declared: true,
    compat: {},
    enabled: true,
    ...over,
  }
}

console.log('\n== locateKeyLine：行号定位（0 = 无法定位）==')
{
  check('键在首行时返回第 1 行（index 0 是有效位置）', locateKeyLine('"dshCompat": {}', ['dshCompat']) === 1)
  check('键在后续行时返回真实行号', locateKeyLine('{\n  "dshCompat": {}\n}', ['dshCompat']) === 2)
  check('嵌套键按顺序定位', locateKeyLine('{\n  "dshCompat": {\n    "requires": {}\n  }\n}', ['dshCompat', 'requires']) === 3)
  check('缺失键返回 0（不伪造行号）', locateKeyLine('{}', ['dshCompat']) === 0)
  check('第二个键缺失时返回 0', locateKeyLine('{\n  "dshCompat": {}\n}', ['dshCompat', 'requires']) === 0)
}

console.log('\n== satisfiesRange：只在能判定时说话 ==')
{
  const cases: Array<[string | undefined, string | undefined, boolean, boolean]> = [
    ['1.2.3', '1.2.3', true, true],
    ['1.2.4', '1.2.3', false, true],
    ['1.2.3', '^1.0.0', true, true],
    ['2.0.0', '^1.0.0', false, true],
    ['1.2.9', '~1.2.0', true, true],
    ['1.3.0', '~1.2.0', false, true],
    ['1.2.3', '>=1.0.0 <2.0.0', true, true],
    ['2.1.0', '>=1.0.0 <2.0.0', false, true],
    ['1.2.3', '1.0.0 || 1.2.3', true, true],
    ['1.2.3', '*', true, true],
    ['1.2.3', 'workspace:*', false, false],
    ['1.2.3', 'npm:other@1', false, false],
    ['1.2.3', '1.x', false, false],
    [undefined, '^1.0.0', false, false],
    ['1.2.3', undefined, false, false],
  ]
  for (const [version, range, ok, decidable] of cases) {
    const verdict = satisfiesRange(version, range)
    check(
      `satisfiesRange(${JSON.stringify(version)}, ${JSON.stringify(range)}) = ${ok}/${decidable}`,
      verdict.ok === ok && verdict.decidable === decidable,
      verdict,
    )
  }
}

console.log('\n== readDeclaredPluginsSync：声明扫描（含损坏清单）==')
{
  const root = await mkdtemp(join(tmpdir(), 'rg-conflict-'))
  try {
    const profile = join(root, 'profile')
    const nm = join(profile, 'node_modules')
    mkdirSync(profile, { recursive: true })
    const writePlugin = (name: string, content: string) => {
      const dir = join(nm, ...name.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), content, 'utf8')
      return dir
    }
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dependencies: { 'dsh-a': '1', 'dsh-b': '1', 'dsh-broken': '1', 'dsh-fallback': '1', 'dsh-bad-fallback': '1' } }),
      'utf8',
    )
    writePlugin(
      'dsh-a',
      JSON.stringify({ version: '1.2.0', dshCompat: { services: ['svc'], requires: { 'dsh-b': '^1.0.0' } } }),
    )
    // dsh-b 只装到一半（没有 package.json）⇒ 跳过，不猜。
    mkdirSync(join(nm, 'dsh-b'), { recursive: true })
    const brokenDir = writePlugin('dsh-broken', '{ not json')
    writeFileSync(join(brokenDir, 'dsh-plugin.json'), '{}', 'utf8')
    const fallbackDir = writePlugin('dsh-fallback', JSON.stringify({ version: '2.0.0' }))
    writeFileSync(join(fallbackDir, 'dsh-plugin.json'), JSON.stringify({ dshCompat: { dsh: '>=0.10.0' } }), 'utf8')
    const badFallbackDir = writePlugin('dsh-bad-fallback', JSON.stringify({ version: '3.0.0' }))
    writeFileSync(join(badFallbackDir, 'dsh-plugin.json'), '{ broken', 'utf8')

    let threw: unknown
    let plugins: DeclaredPlugin[] = []
    try {
      plugins = readDeclaredPluginsSync(profile)
    } catch (error) {
      threw = error
    }
    check('损坏的 package.json 不让整次扫描抛异常', threw === undefined, threw)
    const names = plugins.map((p) => p.name).sort()
    check('跳过无 package.json 与损坏清单（剩 a/fallback/bad-fallback）', JSON.stringify(names) === '["dsh-a","dsh-bad-fallback","dsh-fallback"]', names)
    const a = plugins.find((p) => p.name === 'dsh-a')
    check('dshCompat 被解析成 declared + compat', a?.declared === true && JSON.stringify(a?.compat.services) === '["svc"]', a)
    check('声明行号可定位（≥1）', typeof a?.source.line === 'number' && a.source.line >= 1, a?.source)
    const fallback = plugins.find((p) => p.name === 'dsh-fallback')
    check('package.json 无 compat 时回落到 dsh-plugin.json', fallback?.declared === true && fallback.compat.dsh === '>=0.10.0', fallback)
    check('回落来源指向 dsh-plugin.json', fallback?.source.file.endsWith('dsh-plugin.json') === true, fallback?.source.file)
    const badFallback = plugins.find((p) => p.name === 'dsh-bad-fallback')
    check('损坏的回落清单 ⇒ declared:false（不猜，也不抛）', badFallback?.declared === false, badFallback)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n== findingsFor：四类 finding（误差=不产生 finding）==')
{
  const a = plugin({
    name: 'dsh-a',
    version: '1.2.0',
    compat: { services: ['svc'], conflicts: { 'dsh-b': '^1.0.0' }, dsh: '>=99.0.0', requires: { 'dsh-missing': '1' } },
  })
  const b = plugin({ name: 'dsh-b', version: '1.2.5', compat: { services: ['svc'] }, enabled: false })
  const c = plugin({ name: 'dsh-c', version: '0.1.0', compat: { requires: { 'dsh-b': '1' } } })
  const undeclared = plugin({ name: 'dsh-u', declared: false, compat: { conflicts: { 'dsh-b': '*' } } })
  const findings = findingsFor([a, b, c, undeclared], '0.16.0')
  const kinds = findings.map((f) => f.kind).sort()
  check('重复 service 被检出', kinds.includes('duplicate-service'), kinds)
  check('声明冲突被检出', kinds.includes('declared-conflict'), kinds)
  check('DSH 版本不满足被检出', kinds.includes('dsh-version'), kinds)
  check('缺失依赖按 error 检出', findings.some((f) => f.kind === 'missing-dependency' && f.severity === 'error' && f.plugins[0] === 'dsh-a'), findings)
  check('被禁用的依赖按 warning 检出', findings.some((f) => f.kind === 'missing-dependency' && f.severity === 'warning' && f.plugins[0] === 'dsh-c'), findings)
  check('未声明插件不产生任何 finding', findings.every((f) => !f.plugins.includes('dsh-u')), findings)
  const errors = errorFindings(findings)
  check('errorFindings 只留 error 级', errors.length > 0 && errors.every((f) => f.severity === 'error'), errors.length)
  const first = findings[0]
  check('finding 带可复核的 source（文件+行号）与 declaration', first !== undefined && typeof first.source.file === 'string' && first.declaration.length > 1, first)
  check('findingActive：涉及的插件全在场才算成立', first !== undefined && findingActive(first, new Set(['dsh-a', 'dsh-b', 'dsh-c'])) === true)
  check('findingActive：缺一个即为 false', first !== undefined && findingActive(first, new Set(['dsh-a'])) === false)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)