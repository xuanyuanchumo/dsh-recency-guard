import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 卡片头部排版的结构断言（真机回归：标题被挤成单字竖排）。
 *
 * 为什么用静态断言而不是 RTL：本仓库没有 React 测试环境，而这条缺陷的
 * 根因恰恰在 CSS（flex 收缩 + CJK 可逐字断行），渲染级断言需要真实布局
 * 引擎。这里把「必须存在的规则」钉死：标题 nowrap + ellipsis、右侧操作
 * 不收缩、标题带全称 title、禁止 overflow-wrap: anywhere。
 *
 * 这些断言**不是**证明视觉正确；它们是防回归的绊线 —— 谁删掉 nowrap，
 * 这条测试立刻红，而不是等下一次真机截图。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const styles = readFileSync(join(root, 'src/client/styles.ts'), 'utf8')
const cards = readFileSync(join(root, 'src/client/panel/PanelCards.tsx'), 'utf8')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 取出某个选择器的规则体（源码里第一处；找不到返回空串）。 */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(selector)
  if (at < 0) return ''
  const open = source.indexOf('{', at)
  const close = source.indexOf('}', open)
  return open < 0 || close < 0 ? '' : source.slice(open + 1, close)
}

console.log('\n[标题：不竖排、可省略、保留全称]')
const titleRule = ruleBody(styles, '.rg-card-title {')
check('标题规则存在', titleRule.length > 0)
check('标题不换行（nowrap）', /white-space:\s*nowrap/.test(titleRule), titleRule)
check('空间不足用省略号而不是逐字断行', /text-overflow:\s*ellipsis/.test(titleRule) && /overflow:\s*hidden/.test(titleRule))
check('CJK 不在字间断行（keep-all）', /word-break:\s*keep-all/.test(titleRule))
check('禁止 overflow-wrap: anywhere（会造成单字竖排）', !/overflow-wrap:\s*anywhere/.test(styles))
check('标题容器允许收缩但带 min-width:0', /min-width:\s*0/.test(titleRule) && /flex:\s*1 1 auto/.test(titleRule))
const headRule = ruleBody(styles, '.rg-card-head {')
check('卡片头部允许收缩（min-width:0）', /min-width:\s*0/.test(headRule))
const opsRule = ruleBody(styles, '.rg-card-expand,')
check('右侧操作按钮不参与收缩（flex:0 0 auto）', /flex:\s*0 0 auto/.test(opsRule), opsRule)

console.log('\n[标题元素携带可读全称]')
check(
  '标题 span 带 title 属性（省略时仍可读到全称）',
  /<span className="rg-card-title" title=\{title\}>/.test(cards),
)

console.log('\n[数据流四步可读]')
const flowRule = ruleBody(styles, '.rg-card-body:has(.rg-dataflow)')
check('数据流卡 body 规则存在', flowRule.length > 0)
check('按内容伸展（height:auto）而不是固定 240px 裁切', /height:\s*auto/.test(flowRule), flowRule)
check('仍保留 max-height 兜底（超出时可滚动）', /max-height:/.test(flowRule))
check(
  '数据流仍是 4 步（journal → events → flow → render），第 4 步必须有可读出口',
  ['journal', 'events', 'flow', 'render'].every((key) =>
    readFileSync(join(root, 'src/client/panel/panel-model.ts'), 'utf8').includes(`key: '${key}'`),
  ),
)

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')