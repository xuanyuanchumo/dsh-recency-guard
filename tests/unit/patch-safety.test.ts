/**
 * patch 安全回归 —— 针对 v0.6.0 崩溃缺陷的护栏测试。
 *
 * ## 缺陷回顾（真机证据）
 *
 * `guardedRowText` 曾把包名以 **未加引号的 plain scalar** 写进 profile patch：
 *
 *     - id: ui-task-board
 *       name: @linxin666/dsh-client-ui-task-board
 *       disabled: !!js "..."
 *
 * YAML 把 `@` 列为**保留指示符**，不允许出现在 plain scalar 开头，于是这一行
 * 不是"值有点怪"，而是**整份文档不可解析**。真机
 * `C:\Users\86156\.dsh\profiles\desktop\cordis.patch.yml` 第 185 行由此报
 * `bad indentation of a mapping entry (185:9)`，整个 profile patch 层失效。
 *
 * 也就是说：**防崩溃的插件，用一个 scoped 包名就把 profile 写崩了。**
 *
 * ## 本文件断言什么
 *
 * 1. 产出**永不**是带保留指示符的 plain scalar（这条在没有修复时必须红）；
 * 2. 产出能被真实 YAML 解析器解析（js-yaml/yaml 在就解析，不在就退化为结构校验）；
 * 3. 引号风格对任何输入都可往返（含 `'` `"` `\` 换行 中文）；
 * 4. 追加路径**校验后提交**：非法内容必须被拦下且文件字节不变（回滚）；
 * 5. 追加前留一份 pristine 备份；行 id 混合引号/裸值时去重仍然幂等。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  guardedRowText,
  yamlScalar,
  yamlDoubleQuoted,
  plainScalarProblem,
  validatePatchText,
  readPatchRowsFromText,
  parseScalar,
  patchBackupPath,
} from '../../src/profile/patch.js'
import { appendPatchText } from '../../src/guard/guarded-rows.js'
import { guardExpression } from '../../src/guard/decision.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 找到任意一个可用的真实 YAML 解析器；找不到返回 undefined（不静默当通过）。 */
async function loadYamlParser(): Promise<((text: string) => unknown) | undefined> {
  for (const id of ['js-yaml', 'yaml']) {
    try {
      const mod = (await import(id)) as { load?: (t: string) => unknown; parse?: (t: string) => unknown }
      if (typeof mod.load === 'function') return mod.load
      if (typeof mod.parse === 'function') return mod.parse
    } catch {
      /* 换下一个 */
    }
  }
  return undefined
}

/**
 * 真实解析前的准备：摘掉 `!!js` 标签。
 *
 * 为什么可以摘：`!!js` 是 dsh loader 自定义标签，js-yaml 不认识它，会以
 * "unknown tag" 抛错 —— 那是**另一个**原因导致的失败，会掩盖我们真正要
 * 断言的"文档结构是否合法"。摘掉标签后 `disabled` 变成一个普通的双引号
 * 标量，文档结构完全保留，正是要验证的对象。
 */
function stripJsTag(text: string): string {
  return text.replace(/!!js[ \t]+/g, '')
}

/** 复刻真机里最要命的那一行：scoped 包名。 */
const SCOPED = '@linxin666/dsh-client-ui-task-board'

async function main() {
  const realYaml = await loadYamlParser()
  if (realYaml === undefined) {
    console.log('  NOTE  未找到 js-yaml/yaml，真实解析断言退化为结构校验（不当作通过）')
  }

  // ═══ 1. 核心回归：scoped 包名不得产出非法 YAML ═══
  console.log('\n== v0.6.0 regression: a scoped bundle name must not produce invalid YAML ==')
  {
    const text = guardedRowText('ui-task-board', SCOPED, guardExpression(SCOPED))
    // 这条断言是缺陷的直接编码：`name:` 后面**不允许**直接跟 `@`。
    const offending = text.split('\n').find((line) => /^[ \t]*name:[ \t]*@/.test(line))
    check('name is never an unquoted plain scalar starting with "@"', offending === undefined, offending)
    check('the emitted row is quoted', text.includes(`name: '${SCOPED}'`), text)
    const verdict = validatePatchText(text)
    check('the structural validator accepts the row', verdict.ok, verdict)
    if (realYaml !== undefined) {
      let parsed: unknown
      let threw: unknown
      try {
        parsed = realYaml(stripJsTag(text))
      } catch (err) {
        threw = err
      }
      check('a real YAML parser accepts the row', threw === undefined, threw instanceof Error ? threw.message : threw)
      const row = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown>) : undefined
      check('the parser recovers the exact id', row?.id === 'ui-task-board', row)
      check('the parser recovers the exact scoped name', row?.name === SCOPED, row)
    }
  }

  // ═══ 2. 引号风格对任意输入可往返 ═══
  console.log('\n== quoting round-trip ==')
  {
    const hostile = [
      SCOPED,
      'plain-name',
      "a'b",
      'a"b',
      'a\\b',
      "a\\'b",
      'a\u0000b',
      'a\nb',
      'a\tb',
      '- dash',
      '? question',
      ': colon',
      '# hash',
      'a: b',
      'a #b',
      'trailing:',
      '  leading-space',
      'trailing-space  ',
      '[flow]',
      '{flow}',
      '%directive',
      '`backtick',
      '&anchor',
      '*alias',
      '!tag',
      '|block',
      '>folded',
      '中文名称',
      'emoji-🙂',
      'true',
      'null',
      '3.14',
      '',
    ]
    for (const value of hostile) {
      const emitted = yamlScalar(value)
      const back = parseScalar(emitted)
      check(`yamlScalar round-trips ${JSON.stringify(value)}`, back === value, { emitted, back })
      // 单引号风格没有反斜杠转义 ⇒ 只要经过 validatePatchText 不报错即可。
      const verdict = validatePatchText(`- id: '${'x'}'\n  name: ${emitted}\n`)
      check(`  ...and validates as a document value ${JSON.stringify(value)}`, verdict.ok, verdict)
    }
    check(
      'yamlDoubleQuoted escapes the characters that would change meaning',
      yamlDoubleQuoted('a\\b"c\nd') === '"a\\\\b\\"c\\nd"',
      yamlDoubleQuoted('a\\b"c\nd'),
    )
    check('yamlDoubleQuoted round-trips through parseScalar', parseScalar(yamlDoubleQuoted('a\\b"c\nd')) === 'a\\b"c\nd')
  }

  // ═══ 3. 校验器：能抓住 @，也能放过真实 patch ═══
  console.log('\n== validator precision ==')
  {
    const bad = validatePatchText('- id: ui-task-board\n  name: @linxin666/dsh-client-ui-task-board\n')
    check('an unquoted @scoped name is rejected', !bad.ok, bad)
    check('the rejection names the reserved indicator', (bad.reason ?? '').includes('@'), bad.reason)
    check('the rejection points at the offending line', bad.line === 2, bad.line)
    check('plainScalarProblem explains @', (plainScalarProblem(SCOPED) ?? '').includes('@'))
    check('plainScalarProblem accepts a normal dash name', plainScalarProblem('dsh-recency-guard') === undefined)
    check('plainScalarProblem accepts a numeric-looking value', plainScalarProblem('0.4.15') === undefined)
    check('plainScalarProblem rejects an embedded comment', plainScalarProblem('a #b') !== undefined)

    // 真实形态（截自桌面 profile 的实际片段，已引号化）
    const realistic = [
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '# a top-level YAML array of loader patch entries.',
      '- id: web',
      '  name: "@deepseek-ai/dsh-web"',
      '  config:',
      '    searchProvider: ddg',
      '    fetchProvider: fs-quality-fetch',
      '- id: subagent-model-selection-settings',
      '  config:',
      '    enabled: true',
      '    allowedModels:',
      '      - provider: codearts',
      '        model: GLM-5.2',
      "- id: 'ui-task-board'",
      `  name: '${SCOPED}'`,
      '  disabled: !!js "(() => false)()"',
      '- id: dsh-recency-guard',
      '  name: dsh-recency-guard',
      '  config:',
      '    port: 3080',
      '    link: link:D:/Projects/TraeProjects/dsh-recency-guard',
      '    source: github:tree-func/dsh-request-manager#26243e1e4cbe49af697ee36d7e8d5f1cdbc79127',
      '',
    ].join('\n')
    const ok = validatePatchText(realistic)
    check('a realistic patch document is accepted', ok.ok, ok)
    check('no spurious warnings on a clean document', ok.warnings.length === 0, ok.warnings)
    if (realYaml !== undefined) {
      let threw: unknown
      try {
        realYaml(stripJsTag(realistic))
      } catch (err) {
        threw = err
      }
      check('a real YAML parser accepts the realistic document', threw === undefined, threw instanceof Error ? threw.message : threw)
    }

    const tabs = validatePatchText('- id: x\n\tname: y\n')
    check('tab indentation is rejected', !tabs.ok, tabs)

    const dup = validatePatchText('- id: same\n  name: a\n- id: same\n  name: b\n')
    check('duplicate row ids are reported as a warning', dup.ok && dup.warnings.length === 1, dup)
  }

  // ═══ 4. 追加路径：备份 / 提交 / 回滚 ═══
  console.log('\n== append: validate-then-commit ==')
  {
    const root = mkdtempSync(join(tmpdir(), 'rg-patch-safety-'))
    try {
      const patchPath = join(root, 'cordis.patch.yml')
      const dshShape = '# user comment\n# second comment\n[]\n'
      writeFileSync(patchPath, dshShape, 'utf8')

      const first = appendPatchText(patchPath, guardedRowText('ui-task-board', SCOPED, guardExpression(SCOPED)))
      check('the first append commits', first.ok, first.reason)
      const afterFirst = readFileSync(patchPath, 'utf8')
      check('the empty-array marker is gone', !afterFirst.split('\n').some((l) => l.trim() === '[]'))
      check('user comments survive', afterFirst.includes('# user comment'))
      check('the scoped name is quoted on disk', afterFirst.includes(`name: '${SCOPED}'`))
      check('the pristine backup exists', existsSync(patchBackupPath(patchPath)), patchBackupPath(patchPath))
      check('the backup holds the pre-guard content', readFileSync(patchBackupPath(patchPath), 'utf8') === dshShape)
      check('the committed document validates', validatePatchText(afterFirst).ok, validatePatchText(afterFirst))
      if (realYaml !== undefined) {
        let threw: unknown
        try {
          realYaml(stripJsTag(afterFirst))
        } catch (err) {
          threw = err
        }
        check('a real YAML parser accepts the committed document', threw === undefined, threw instanceof Error ? threw.message : threw)
      }

      // 回滚：故意追加一段非法 YAML，必须被拦下且文件**字节不变**。
      const beforeBad = readFileSync(patchPath, 'utf8')
      const bad = appendPatchText(patchPath, '- id: evil\n  name: @evil/pkg\n')
      check('an invalid append is refused', !bad.ok, bad)
      check('the refusal carries a reason', (bad.reason ?? '').length > 0, bad.reason)
      check('the file is byte-identical after the refusal (rollback)', readFileSync(patchPath, 'utf8') === beforeBad)

      // 幂等：同一行 id 再追加必须被**拒绝**（Loader 遇重复 id 会直接抛错），
      // 且被拒绝时文件一个字节都不动。
      const firstDup = appendPatchText(patchPath, guardedRowText('dup-row', SCOPED, guardExpression(SCOPED)))
      check('a new row id is accepted', firstDup.ok, firstDup.reason)
      const beforeDup = readFileSync(patchPath, 'utf8')
      const secondDup = appendPatchText(patchPath, guardedRowText('dup-row', SCOPED, guardExpression(SCOPED)))
      check('re-appending the same row id is refused', !secondDup.ok, secondDup)
      check('the refusal names the duplicate id', (secondDup.reason ?? '').includes('dup-row'), secondDup.reason)
      check('the file is untouched by the duplicate refusal', readFileSync(patchPath, 'utf8') === beforeDup)
      const onDisk = readFileSync(patchPath, 'utf8')
      check(
        'the row id appears exactly once in the file text',
        onDisk.split("- id: 'dup-row'").length - 1 === 1,
        onDisk.split('\n').filter((l) => l.includes('dup-row')),
      )

      // 混合风格的文件也能读出行 id（旧行裸值 + 新行引号）。
      const mixed = "- id: legacy\n  name: dsh-legacy\n- id: 'quoted-row'\n  name: '@s/q'\n"
      const rows = readPatchRowsFromText(mixed)
      check('the reader unifies plain and quoted ids', rows.map((r) => r.id).join(',') === 'legacy,quoted-row', rows)
      check('the reader picks up names too', rows[1]?.name === '@s/q', rows[1])
      check('parseScalar handles a tagged value', parseScalar('!!js "false"') === 'false', parseScalar('!!js "false"'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ═══ 5. 真实名称空间扫描：本机 profile 里的 scoped 依赖全部安全 ═══
  console.log('\n== real-world name sweep ==')
  {
    const names = [
      '@linxin666/dsh-client-ui-task-board',
      '@linxin666/dsh-remote-web-ui',
      '@yyfather/dsh-token-vault',
      '@michengai/dsh-skills-manager',
      '@wlv-zedd/dsh-chatgpt-web',
      'dsh-ops',
      'dsh-recency-guard',
      'sage-mem',
    ]
    const doc = names.map((n, i) => guardedRowText(`row-${i}`, n, guardExpression(n))).join('')
    const verdict = validatePatchText(doc)
    check('every real scoped name emits a valid document', verdict.ok, verdict)
    if (realYaml !== undefined) {
      let parsed: unknown
      let threw: unknown
      try {
        parsed = realYaml(stripJsTag(doc))
      } catch (err) {
        threw = err
      }
      check('a real YAML parser accepts all real names at once', threw === undefined, threw instanceof Error ? threw.message : threw)
      const rows = parsed as Array<Record<string, unknown>>
      check(
        'all names survive the round-trip exactly',
        Array.isArray(rows) && rows.length === names.length && rows.every((r, i) => r.name === names[i]),
        rows,
      )
      check(
        'the disabled expression survives the YAML round-trip verbatim',
        Array.isArray(rows) && rows[0]?.disabled === guardExpression(names[0] as string),
        rows[0]?.disabled,
      )
    }
  }

  // ═══ 6. 折行标量（别的插件用 YAML dumper 重写 patch 后的形态）═══
  console.log('\n== folded quoted scalars (written by a third-party YAML dumper) ==')
  {
    // js-yaml dump() 默认 lineWidth=80，会把几百字符的 !!js 表达式折成多行：
    //   disabled: !!js "(() => { … const
    //     profile = ctx.get(…) …
    // 这在 YAML 里是合法的（换行折叠为空格）。逐行扫描会误判 "not terminated"，
    // 代价是**守护行再也装不进桌面 profile**（真机 15:45 被重写后实测）。
    const folded = [
      '- id: ui-task-board',
      "  name: '@linxin666/dsh-client-ui-task-board'",
      '  disabled: !!js "(() => { try { const fs = process.getBuiltinModule(\'fs\'); const',
      "    profile = ctx.get('profileContext'); if (!profile || !profile.dir) return",
      "    false; const pointerFile = profile.dir + '/.recency-guard/current.json'; if",
      '    (!fs.existsSync(pointerFile)) return false; const pointer =',
      "    JSON.parse(fs.readFileSync(pointerFile, 'utf8')); return",
      "    Array.isArray(pointer) && pointer.includes('@linxin666/dsh-client-ui-task-board'); }",
      '    catch { return false } })()"',
      '- id: dsh-ops',
      '  name: dsh-ops',
      '  disabled: !!js "false"',
      '',
    ].join('\n')
    const verdict = validatePatchText(folded)
    check('a folded !!js scalar is accepted', verdict.ok, verdict)
    const rows = readPatchRowsFromText(folded)
    check('folded rows are still discovered', rows.map((r) => r.id).join(',') === 'ui-task-board,dsh-ops', rows)
    check('the folded expression is unfolded into one line', (rows[0]?.disabled ?? '').includes("includes('@linxin666") && !(rows[0]?.disabled ?? '').includes('\n'), (rows[0]?.disabled ?? '').slice(-90))
    if (realYaml !== undefined) {
      let threw: unknown
      let parsed: unknown
      try {
        parsed = realYaml(stripJsTag(folded))
      } catch (err) {
        threw = err
      }
      check('a real YAML parser agrees the folded document is valid', threw === undefined, threw instanceof Error ? threw.message : threw)
      check('the real parser recovers the row too', Array.isArray(parsed) && (parsed as Array<Record<string, unknown>>)[0]?.id === 'ui-task-board', parsed)
    }
    // 真正的未闭合引号仍必须被拒（别把"容错"做成"放行"）。
    const broken = '- id: x\n  name: y\n  disabled: !!js "never closed\n'
    check('a genuinely unterminated quote is still rejected', !validatePatchText(broken).ok, validatePatchText(broken))
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
