/**
 * 声明式冲突元数据 → finding 分类矩阵（T14-03 判据 1）。
 *
 * ## 这条测试要回答什么
 *
 * 四类 finding × **命中/不命中**，每一格都要有断言；再加一条最重要的
 * 反向断言：**没有任何声明时一条 finding 都不能出现**。
 * 这条比「能检出冲突」更重要 —— 猜出来的确定性证据会把无辜插件关掉，
 * 而它看起来和真证据一模一样（都带 source 与 severity）。
 *
 * ## 断言的锚点
 *
 * - `kind` / `severity` / `plugins` 逐个核对（不是只看「有 finding」）；
 * - `source.line` 用夹具里真实行号钉死（证明它来自文件定位而不是编造）；
 * - `declaration` 必须包含声明原文的关键片段（证明可复核）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  errorFindings,
  findingsFor,
  readDeclaredPluginsSync,
  satisfiesRange,
  type DeclaredPlugin,
} from '../../src/host/guard/conflict-metadata.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造一个声明插件（纯函数测试用；source 行号无关紧要）。 */
function plugin(name: string, opts: Partial<DeclaredPlugin> = {}): DeclaredPlugin {
  return {
    name,
    version: opts.version ?? '1.0.0',
    source: opts.source ?? { file: `/fake/${name}/package.json`, line: 7 },
    declared: opts.declared ?? true,
    compat: opts.compat ?? {},
    enabled: opts.enabled ?? true,
    ...(opts.dependencies === undefined ? {} : { dependencies: opts.dependencies }),
    ...(opts.peerDependencies === undefined ? {} : { peerDependencies: opts.peerDependencies }),
  }
}

/** 按 kind 取 finding。 */
function ofKind(list: ReturnType<typeof findingsFor>, kind: string) {
  return list.filter((f) => f.kind === kind)
}

function main() {
  console.log('\n== 分类矩阵 1/4：declared-conflict ==')
  {
    // 命中：A 声明与 B@^1.0.0 冲突，B 的版本 1.2.0 落在范围里。
    const hit = findingsFor(
      [
        plugin('a', { compat: { conflicts: { b: '^1.0.0' } } }),
        plugin('b', { version: '1.2.0' }),
      ],
      '0.2.2',
    )
    const conflicts = ofKind(hit, 'declared-conflict')
    check('conflict hit: exactly one finding', conflicts.length === 1, hit)
    check('conflict hit: severity is error', conflicts[0]?.severity === 'error', conflicts[0])
    check('conflict hit: both plugins named', JSON.stringify(conflicts[0]?.plugins) === '["a","b"]', conflicts[0]?.plugins)
    check('conflict hit: declaration is verbatim', (conflicts[0]?.declaration ?? '').includes('"b":"^1.0.0"'), conflicts[0]?.declaration)
    check('conflict hit: source file points at the declaring plugin', conflicts[0]?.source.file === '/fake/a/package.json', conflicts[0]?.source)

    // 不命中：对手不在场。
    const absent = findingsFor([plugin('a', { compat: { conflicts: { b: '^1.0.0' } } })], '0.2.2')
    check('conflict miss: absent opponent produces no finding', ofKind(absent, 'declared-conflict').length === 0, absent)

    // 不命中：版本不满足。
    const wrongVersion = findingsFor(
      [plugin('a', { compat: { conflicts: { b: '^2.0.0' } } }), plugin('b', { version: '1.2.0' })],
      '0.2.2',
    )
    check('conflict miss: version outside range', ofKind(wrongVersion, 'declared-conflict').length === 0, wrongVersion)

    // 不命中：范围不可判定（workspace:*）⇒ 沉默，不是「冲突」也不是「不冲突」。
    const undecidable = findingsFor(
      [plugin('a', { compat: { conflicts: { b: 'workspace:*' } } }), plugin('b', { version: '1.2.0' })],
      '0.2.2',
    )
    check('conflict miss: undecidable range stays silent', ofKind(undecidable, 'declared-conflict').length === 0, undecidable)
  }

  console.log('\n== 分类矩阵 2/4：duplicate-service ==')
  {
    const hit = findingsFor(
      [plugin('a', { compat: { services: ['svc.search'] } }), plugin('b', { compat: { services: ['svc.search'] } })],
      '0.2.2',
    )
    const dups = ofKind(hit, 'duplicate-service')
    check('duplicate-service hit: one finding', dups.length === 1, hit)
    check('duplicate-service hit: names both providers', JSON.stringify(dups[0]?.plugins) === '["a","b"]', dups[0]?.plugins)
    check('duplicate-service hit: message names the service', (dups[0]?.message ?? '').includes('svc.search'), dups[0]?.message)

    const miss = findingsFor(
      [plugin('a', { compat: { services: ['svc.search'] } }), plugin('b', { compat: { services: ['svc.other'] } })],
      '0.2.2',
    )
    check('duplicate-service miss: distinct services', ofKind(miss, 'duplicate-service').length === 0, miss)

    // 同一插件重复声明同一服务不算「重复提供」（去重后只有一个 provider）。
    const selfDup = findingsFor([plugin('a', { compat: { services: ['svc.x', 'svc.x'] } })], '0.2.2')
    check('duplicate-service miss: one plugin repeating itself', ofKind(selfDup, 'duplicate-service').length === 0, selfDup)
  }

  console.log('\n== 分类矩阵 3/4：dsh-version ==')
  {
    const hit = findingsFor([plugin('a', { compat: { dsh: '>=0.3.0' } })], '0.2.2')
    const versions = ofKind(hit, 'dsh-version')
    check('dsh-version hit: one finding', versions.length === 1, hit)
    check('dsh-version hit: message quotes both sides', (versions[0]?.message ?? '').includes('0.3.0') && (versions[0]?.message ?? '').includes('0.2.2'), versions[0]?.message)

    // 不命中：多段范围（>=0.2.1 <0.3.0）在 0.2.2 上成立。
    const ok = findingsFor([plugin('a', { compat: { dsh: '>=0.2.1 <0.3.0' } })], '0.2.2')
    check('dsh-version miss: satisfied range', ofKind(ok, 'dsh-version').length === 0, ok)

    // 不命中：宿主版本不可解析（诚实边界：判不了就沉默）。
    const unknownHost = findingsFor([plugin('a', { compat: { dsh: '>=0.3.0' } })], undefined)
    check('dsh-version miss: unparsable host version', ofKind(unknownHost, 'dsh-version').length === 0, unknownHost)

    // 命中：peerDependencies 里的 dsh 范围也算声明（第二个来源）。
    const peer = findingsFor([plugin('a', { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.9.0' } })], '0.2.2')
    check('dsh-version hit: via peerDependencies', ofKind(peer, 'dsh-version').length === 1, peer)
  }

  console.log('\n== 分类矩阵 4/4：missing-dependency ==')
  {
    // 命中（error）：requires 指向的包不在 profile 里。
    const missing = findingsFor([plugin('a', { compat: { requires: { 'pkg-x': '^1.0.0' } } })], '0.2.2')
    const deps = ofKind(missing, 'missing-dependency')
    check('missing-dependency hit: error when not installed', deps.length === 1 && deps[0]?.severity === 'error', deps)
    check('missing-dependency hit: names the required package', (deps[0]?.message ?? '').includes('pkg-x'), deps[0]?.message)

    // 不命中：需要的包在场且启用。
    const present = findingsFor(
      [plugin('a', { compat: { requires: { 'pkg-x': '^1.0.0' } } }), plugin('pkg-x', { version: '1.1.0' })],
      '0.2.2',
    )
    check('missing-dependency miss: requirement satisfied', ofKind(present, 'missing-dependency').length === 0, present)

    // 降级（warning）：包在场但被禁用 —— 那是隔离的结果，不是缺陷。
    const disabled = findingsFor(
      [plugin('a', { compat: { requires: { 'pkg-x': '^1.0.0' } } }), plugin('pkg-x', { version: '1.1.0', enabled: false })],
      '0.2.2',
    )
    const warn = ofKind(disabled, 'missing-dependency')
    check('missing-dependency: disabled dependency downgrades to warning', warn.length === 1 && warn[0]?.severity === 'warning', warn)
    check('warning does not enter the quarantine input', errorFindings(disabled).length === 0, errorFindings(disabled))
  }

  console.log('\n== 没有声明 ⇒ 一条 finding 都不能有 ==')
  {
    // 这些插件甚至带「看起来像冲突」的字段，但 declared=false ⇒ 它没声明。
    const undeclared = plugin('plain', { declared: false, compat: { conflicts: { b: '^1.0.0' } } })
    const list = findingsFor([undeclared, plugin('b', { version: '1.2.0' })], '0.2.2')
    check('undeclared plugin produces zero findings', list.length === 0, list)

    const emptyCompat = findingsFor([plugin('empty', { compat: {} }), plugin('b')], '0.2.2')
    check('declared-but-empty compat produces zero findings', emptyCompat.length === 0, emptyCompat)
  }

  console.log('\n== 版本范围：可判定 vs 不可判定 ==')
  {
    const cases: Array<[string, string, boolean, boolean, string]> = [
      ['1.2.3', '^1.0.0', true, true, 'caret inside'],
      ['2.0.0', '^1.0.0', false, true, 'caret outside'],
      ['0.2.2', '>=0.2.1 <0.3.0', true, true, 'conjunction'],
      ['0.3.1', '>=0.2.1 <0.3.0', false, true, 'conjunction outside'],
      ['1.2.3', '~1.2.0', true, true, 'tilde inside'],
      ['1.3.0', '~1.2.0', false, true, 'tilde outside'],
      ['1.2.3', '1.2.3', true, true, 'exact'],
      ['1.2.4', '1.2.3', false, true, 'exact mismatch'],
      ['9.9.9', 'workspace:*', false, false, 'workspace protocol is undecidable'],
      ['9.9.9', '1.x', false, false, 'x-range is undecidable'],
    ]
    for (const [version, range, ok, decidable, label] of cases) {
      const verdict = satisfiesRange(version, range)
      check(`range ${label}: ${version} vs ${range}`, verdict.ok === ok && verdict.decidable === decidable, verdict)
    }
    check('unparsable version is undecidable', satisfiesRange('latest', '^1.0.0').decidable === false)
  }

  console.log('\n== 磁盘扫描：source 行号与声明原文 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-conflict-'))
    try {
      const writePlugin = (name: string, text: string) => {
        const dir = join(profile, 'node_modules', ...name.split('/'))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), text, 'utf8')
      }
      // 声明在第 6 行（从 1 数）：dependencies 占 3 行、peerDependencies 1 行。
      writePlugin(
        'alpha',
        `{
  "name": "alpha",
  "version": "1.0.0",
  "dependencies": { "beta": "^1.0.0" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.2.1" },
  "dshCompat": {
    "conflicts": { "beta": "^1.0.0" },
    "services": ["svc.alpha"]
  }
}
`,
      )
      writePlugin(
        'beta',
        `{
  "name": "beta",
  "version": "1.2.0"
}
`,
      )
      writePlugin(
        'gamma',
        `{
  "name": "gamma",
  "version": "0.1.0",
  "dependencies": {}
}
`,
      )
      writeFileSync(
        join(profile, 'package.json'),
        JSON.stringify({ name: 'p', dependencies: { alpha: '1.0.0', beta: '1.2.0', gamma: '0.1.0' } }),
        'utf8',
      )

      const plugins = readDeclaredPluginsSync(profile)
      check('scan: three plugins read', plugins.length === 3, plugins.map((p) => p.name))
      const alpha = plugins.find((p) => p.name === 'alpha')
      check('scan: alpha declared', alpha?.declared === true, alpha)
      check('scan: source line points at the dshCompat key', alpha?.source.line === 6, alpha?.source)
      check('scan: source file is the package.json', (alpha?.source.file ?? '').endsWith(join('alpha', 'package.json')), alpha?.source)
      check('scan: dependency edges collected', JSON.stringify(alpha?.dependencies) === '["beta"]', alpha?.dependencies)
      check('scan: peer deps collected', alpha?.peerDependencies?.['@deepseek-ai/dsh-tools'] === '>=0.2.1', alpha?.peerDependencies)
      check('scan: gamma declared=false', plugins.find((p) => p.name === 'gamma')?.declared === false)
      check('scan: source line 0 when nothing declared', plugins.find((p) => p.name === 'gamma')?.source.line === 0)

      const findings = findingsFor(plugins, '0.2.2')
      const conflict = ofKind(findings, 'declared-conflict')[0]
      check('scan: conflict found from disk declarations', conflict !== undefined, findings)
      check('scan: finding carries the declaring file', conflict?.source.file === alpha?.source.file, conflict?.source)
      check('scan: finding carries the declaring line', conflict?.source.line === 6, conflict?.source)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 次级来源：dsh-plugin.json ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-conflict-plugin-'))
    try {
      const dir = join(profile, 'node_modules', 'delta')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'delta', version: '2.0.0' }), 'utf8')
      // 清单在第 3 行声明 dshCompat（package.json 里没有）。
      writeFileSync(
        join(dir, 'dsh-plugin.json'),
        `{
  "name": "delta",
  "dshCompat": { "services": ["svc.delta"] }
}
`,
        'utf8',
      )
      writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { delta: '2.0.0' } }), 'utf8')
      const plugins = readDeclaredPluginsSync(profile)
      const delta = plugins[0]
      check('dsh-plugin.json: declaration is read', delta?.declared === true, delta)
      check('dsh-plugin.json: source points at the manifest', (delta?.source.file ?? '').endsWith('dsh-plugin.json'), delta?.source)
      check('dsh-plugin.json: line is located', delta?.source.line === 3, delta?.source)
      check('dsh-plugin.json: services carried', JSON.stringify(delta?.compat.services) === '["svc.delta"]', delta?.compat)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
process.exit(failures === 0 ? 0 : 1)