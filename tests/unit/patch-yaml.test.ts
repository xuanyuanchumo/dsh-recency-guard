/**
 * `profile/patch-yaml.ts` 直接单测（T15-04）。
 *
 * 为什么补这条：变异工具的归属判据是「测试文件**直接 import** 该模块」。
 * 此前 patch-yaml 只被 patch.ts 间接消费，于是它的扫描/折行/校验分支
 * **从未进过变异池** —— 指标没覆盖的东西，指标不会告诉你它没覆盖（v0.15）。
 *
 * 断言锚点取自实现里的**真实文案与边界**（v0.14 教训：`/省略/` 匹配
 * `其余 N 项未展开` 的假断言），不是凭印象猜的近义词。
 */
import {
  foldQuotedContinuations,
  isLoaderRowId,
  scanPatchLines,
  validatePatchText,
} from '../../src/host/profile/patch-yaml.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n== foldQuotedContinuations：多行引号折成一行 ==')
{
  // 单行引号标量不该被改（幂等：正常文档逐字节不变）。
  check('单行引号值保持原样', foldQuotedContinuations('a: "hello"') === 'a: "hello"')
  // 真机形态是 `!!js "…"`，首个字符是 `!` —— 漏掉带标签的形态等于修复没生效。
  const tagged = ['b: !!js "one', '  two"', 'c: 3'].join('\n')
  const folded = foldQuotedContinuations(tagged)
  check('带标签的跨行引号被折成一行', folded.split('\n')[0] === 'b: !!js "one two"', folded)
  check('后续行置空（行号因此不变）', folded.split('\n')[1] === '' && folded.split('\n')[2] === 'c: 3', folded.split('\n'))
  // 结尾未闭合：必须**原样返回**而不是把越界的 undefined 当行去 trim。
  const unclosed = ['key: "unclosed', '  more'].join('\n')
  let threw: unknown
  let out = ''
  try {
    out = foldQuotedContinuations(unclosed)
  } catch (error) {
    threw = error
  }
  check('未闭合引号在文件结尾不抛异常', threw === undefined, threw)
  check('未闭合引号原样返回', out === unclosed, out)
  // 缩进为 0 的行不是续行：折行必须在它之前停住。
  const stopped = ['k: "open', 'next: value'].join('\n')
  check('无缩进的下一行不当作续行', foldQuotedContinuations(stopped) === stopped)
}

console.log('\n== scanPatchLines：结构扫描 ==')
{
  const text = [
    '# 注释行被跳过',
    '- id: guard-row',
    '  name: dsh-x',
    'insert:',
    '  - id: nested-row',
    'config:',
    '  providers:',
    '    - id: not-a-row',
  ].join('\n')
  const scanned = scanPatchLines(text)
  check('跳过注释与空行（扫描行数 7）', scanned.length === 7, scanned.length)
  const top = scanned.find((line) => line.key === 'id' && line.indent === 0)
  check('顶层的 `- id:` 是序列项', top?.sequenceItem === true && top?.value === 'guard-row', top)
  check('顶层序列行是 Loader 行 id', top !== undefined && isLoaderRowId(top))
  const nested = scanned.find((line) => line.value === 'nested-row')
  check('insert 下的行 scope 含 insert', JSON.stringify(nested?.scope) === '["insert"]', nested)
  check('insert 下的行是 Loader 行 id', nested !== undefined && isLoaderRowId(nested))
  const configId = scanned.find((line) => line.value === 'not-a-row')
  check('config.providers[] 的 id 不是 Loader 行 id', configId !== undefined && !isLoaderRowId(configId), configId)
  // 制表符缩进是 Loader 的硬错误：扫描结果必须带 problem 而不是静默接受。
  const tabbed = scanPatchLines('a:\n\tb: 1')
  check('制表符缩进被标记为 problem', tabbed.some((line) => line.problem === 'YAML 缩进不允许使用制表符'), tabbed)
}

console.log('\n== validatePatchText：提交前的自证 ==')
{
  check('空文档合法（ok + 无警告）', JSON.stringify(validatePatchText('')) === '{"ok":true,"warnings":[]}')
  const duplicate = ['- id: same', '- id: same'].join('\n')
  const dup = validatePatchText(duplicate)
  check('重复行 id 产生警告而不是放行静默', dup.ok === true && dup.warnings.some((w) => w.includes('重复的行 id')), dup)
  const eq71 = validatePatchText('- id: one\n  name: x\n- id: two\n  name: y')
  check('不同 id 不产生警告', eq71.ok === true && eq71.warnings.length === 0, eq71)
  const bad = validatePatchText('a:\n\tb: 1')
  check('非法 YAML 返回 ok:false 且给出原因', bad.ok === false && String(bad.reason).length > 0, bad)
  check('非法 YAML 的行号指向问题行', bad.ok === false && bad.line === 2, bad)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)