/**
 * 跨实现宽度对拍（T15-05）—— 零依赖脚本 vs 宿主显示原语。
 *
 * ## 为什么需要这条契约
 *
 * `bin/rescue.mjs` 必须保留**自己的**宽度实现：宿主起不来时 `node_modules`
 * 可能正损坏，逃生通道不能 import 宿主模块（零依赖纪律）。但「独立实现」
 * 一旦没有对拍就**必然漂移** —— v0.16 给 `tool-text.ts` 修了组合字符/零宽/
 * ZWJ，rescue 那份没跟上，于是命令窗口两张表在中英混排下整体右移。
 *
 * 这条测试用**同一份语料**跑两份实现，逐条断言 `displayWidth` 相等；
 * 并额外钉住**正确值**（不只是「相等」）—— 两份一起错时相等也会成立，
 * 那种「一致地错」必须被显式期望值挡住。
 *
 * 不覆盖：CSS 列宽、字体回退（浏览器侧）；折行策略（rescue 不做折行）。
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  codePointWidth as hostCodePointWidth,
  displayWidth as hostDisplayWidth,
  padWidth as hostPadWidth,
} from '../../src/host/surface/tool-text.js'
import {
  codePointWidth as rescueCodePointWidth,
  displayWidth as rescueDisplayWidth,
  padWidth as rescuePadWidth,
} from '../../bin/rescue.mjs'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 共享语料：每一类「宽/窄/零宽」都必须出现，否则对拍会漏掉整类字符。 */
const CORPUS: Array<[string, string]> = [
  ['ASCII', 'hello world'],
  ['空串', ''],
  ['CJK 统一表意', '中文'],
  ['CJK 中文标点（全角）', '，。！？（）【】'],
  ['全角字母数字', 'ＡＢＣ１２３'],
  ['emoji（代理对）', '🎉'],
  ['ZWJ 家庭序列', '👨‍👩‍👧'],
  ['肤色修饰符', '👍🏽'],
  ['组合字符', 'e\u0301'],
  ['零宽空格', 'a\u200bb'],
  ['非 BMP 音乐符号', '𝄞'],
  ['中英混排（真实命令窗口形态）', 'dsh-fi-crash（第 1 次崩溃后关闭）'],
  ['混合攻击面', '👨‍👩‍👧🎉e\u0301a\u200b𝄞 中文，。！？'],
  ['作用域包名', '@scope/pkg'],
]

console.log('\n== displayWidth 逐条相等（同一份语料）==')
for (const [label, text] of CORPUS) {
  const host = hostDisplayWidth(text)
  const rescue = rescueDisplayWidth(text)
  check(`${label} 两份实现一致（${host} 列）`, host === rescue, { host, rescue, text })
}

console.log('\n== 正确值（防止「一致地错」）==')
{
  const expectations: Array<[string, string, number]> = [
    ['CJK 全宽', '中文', 4],
    ['emoji 代理对', '🎉', 2],
    ['ZWJ 家庭序列是一个字形', '👨‍👩‍👧', 2],
    ['肤色修饰符不增宽', '👍🏽', 2],
    ['组合字符不占列', 'e\u0301', 1],
    ['零宽空格不占列', 'a\u200bb', 2],
    ['ASCII', 'abc', 3],
    ['空串', '', 0],
    ['非 BMP 符号', '𝄞', 1],
    ['全角标点按 2 列', '，', 2],
  ]
  for (const [label, text, want] of expectations) {
    check(`${label}：宿主实现 = ${want}`, hostDisplayWidth(text) === want, hostDisplayWidth(text))
    check(`${label}：rescue 实现 = ${want}`, rescueDisplayWidth(text) === want, rescueDisplayWidth(text))
  }
}

console.log('\n== codePointWidth 单码点相等 ==')
{
  const codePoints = [0x20, 0x41, 0x4e2d, 0x1100, 0x115f, 0x0300, 0x036f, 0x200b, 0x200d, 0x1f389, 0x1f3fb, 0x1d11e, 0xff0c]
  for (const cp of codePoints) {
    const host = hostCodePointWidth(cp)
    const rescue = rescueCodePointWidth(cp)
    check(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} 两份实现一致（${host}）`, host === rescue, { host, rescue })
  }
}

console.log('\n== padWidth：CJK 右填充后列宽相等 ==')
for (const label of ['崩溃计数', 'profile', '更新', '更新了', 'dsh-fi-crash']) {
  const width = 16
  const hostPadded = hostPadWidth(`${label}：`, width)
  const rescuePadded = rescuePadWidth(`${label}：`, width)
  check(`${label}：宿主实现补到 ${width} 列`, hostDisplayWidth(hostPadded) === width, hostDisplayWidth(hostPadded))
  check(`${label}：rescue 实现补到 ${width} 列`, rescueDisplayWidth(rescuePadded) === width, rescueDisplayWidth(rescuePadded))
  check(`${label}：两份实现的填充逐字节一致`, hostPadded === rescuePadded, { hostPadded, rescuePadded })
}

console.log('\n== CLI 入口没被 import 破坏（main 守卫）==')
{
  const rescue = join(import.meta.dirname, '..', '..', 'bin', 'rescue.mjs')
  const help = spawnSync(process.execPath, [rescue, '--help'], { encoding: 'utf8', timeout: 30_000 })
  check('直接执行 --help 仍走 CLI（exit 0）', help.status === 0, help.status)
  check('--help 打印用法', (help.stdout ?? '').includes('用法'), (help.stdout ?? '').slice(0, 120))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)