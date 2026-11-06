/**
 * 面板布局的**样式契约**回归。
 *
 * ## 为什么 CSS 也要有测试
 *
 * v0.7.0 的面板完全能用、逻辑全绿、测试全过 —— 但下半部分在真机上根本看不到。
 * 原因不是代码逻辑，是少了一组 CSS 属性：宿主槽位 `.mainPanel` 只有一屏高且
 * `overflow: visible`，祖先 `.centerCol` 是 `overflow-y: hidden`，而 `.rg-panel`
 * 按内容自然增高到 3965px，于是被裁掉，整页又不可滚（docScrollH == clientH）。
 *
 * 这类缺陷不会被任何行为测试抓到（组件挂载成功、数据渲染正确），却直接决定
 * 用户能不能看到数据。因此用**静态契约**把它钉死：属性被删掉就红。
 *
 * 判据不追求"CSS 正确性"的完整证明，只锁四件套 —— 少任何一件，flex 子项都会
 * 按内容撑开而不是滚动：
 *
 *   1. `height: 100%`        占据宿主给的确定高度
 *   2. `min-height: 0`       允许收缩到可滚动（flex 默认 min-height:auto 会撑开）
 *   3. `overflow-y: auto`    自己滚
 *   4. `overscroll-behavior: contain`  滚到尽头不把宿主带着滚
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', '..', 'src', 'client', 'styles.css'), 'utf8')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/**
 * 取基础 `.rg-panel { … }` 块（不是 `[data-form=…]` 变体）。
 *
 * 必须先剥掉 CSS 注释：本文件的注释里写了示例片段
 * （`.centerCol { overflow-y: hidden }`），那些花括号会让朴素的 `[^}]*`
 * 提前收尾 —— 实测第一次跑就把注释里的 `overflow-y: hidden` 当成了真实声明。
 */
function basePanelBlock(source: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const match = /(^|\n)\.rg-panel\s*\{([^}]*)\}/.exec(withoutComments)
  return match ? (match[2] as string) : ''
}

const block = basePanelBlock(css)
/** 规范化：压掉空白便于断言，同时保留属性值。 */
const flat = block.replace(/\s+/g, ' ')

/**
 * 按声明解析成 map，而不是对整块做子串匹配。
 *
 * 为什么：子串匹配会踩坑 —— 实测 `/height:\s*100%/` 会命中 `max-height: 100%`，
 * 于是把 `height: 100%` 摘掉后断言仍然通过（假绿）。按声明名精确比对才可信。
 */
function declarations(source: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const chunk of flat.split(';')) {
    const index = chunk.indexOf(':')
    if (index === -1) continue
    const name = chunk.slice(0, index).trim()
    const value = chunk.slice(index + 1).trim()
    if (name !== '' && value !== '') map.set(name, value)
  }
  return map
}
const decl = declarations(block)

console.log('\n== panel scroll contract (v0.7.1) ==')
check('the base .rg-panel block exists', block.length > 0)
check('panel claims the slot height', decl.get('height') === '100%', decl.get('height'))
check('panel can shrink (min-height: 0)', decl.get('min-height') === '0', decl.get('min-height'))
check('panel scrolls itself (overflow-y: auto)', decl.get('overflow-y') === 'auto', decl.get('overflow-y'))
check(
  'panel contains overscroll (does not drag the host)',
  decl.get('overscroll-behavior') === 'contain',
  decl.get('overscroll-behavior'),
)
check('panel stays a vertical flex column', decl.get('flex-direction') === 'column', decl.get('flex-direction'))

// 反例守卫：如果哪天有人把 height 改成 auto，上面第一条仍会红 —— 这里再明确一次
// 「高度不能被内容撑开」的语义，避免用 `height: auto` 假通过。
check('panel height is not content-driven (not `height: auto`)', !/height:\s*auto/.test(flat), flat.match(/height:[^;]*/g))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)