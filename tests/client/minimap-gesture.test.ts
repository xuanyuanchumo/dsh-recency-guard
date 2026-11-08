/**
 * 小地图手势不冒泡的**源码门**（v0.12 / T10-17）。
 *
 * 为什么需要一道源码门：这条缺陷（React 合成事件从小地图往上冒到
 * .rg-graph-viewport，被父容器的「拖画布平移」和「点空白清选中」吃掉）
 * 是**纯交互**缺陷 —— 单测环境没有 DOM，渲染层测不到。此前它只能靠
 * 「读自己的 diff」发现，于是收尾状态只能是「代码改了，但没证据」。
 *
 * 自由文本的证据等于没有证据（技能纪律：告警级守卫等于没有守卫）。
 * 这道门把不变式变成断言：GraphMinimap 的每一个手势处理器都**必须**
 * 自行 stopPropagation。将来谁重构时删掉一个，CI 立刻红，而不是等用户
 * 抱怨「拖小地图时整个图在抖」。
 *
 * 与契约层的 presentCall 接线门同源（tests/contract/capability.test.ts）：
 * 都是「结构不变式无法在纯函数层证明时，退一步证明源码里它存在」。
 * 这不是偷懒 —— 它证明的正是那条无法被行为测试覆盖的线。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const source = readFileSync(join(process.cwd(), 'src', 'client', 'GraphParts.tsx'), 'utf8')

/**
 * 抠出 GraphMinimap 的函数体。
 *
 * 为什么不能「从第一个 `{` 开始配平」（本门第一版就犯了这个错，被下面的
 * svgRef 断言当场抓住）：本组件签名是
 * `export function GraphMinimap({ width, height, … }: GraphMinimapProps): ReactElement {` ——
 * 第一个 `{` 是**参数解构**的花括号，它的配对闭合在参数表末尾，于是
 * 配平只会截到参数表，返回一段没有 svgRef 的碎片 ⇒ 所有断言假 FAIL。
 *
 * 正确做法：先按**圆括号**配平找到参数表的收尾 `)`，其后的第一个 `{`
 * 才是函数体的起点。两道配平都用嵌套计数，因此对 JSX 里的
 * `{rects.map(...)}`、模板串与注释都不敏感；截到的片段仍要求含 `svgRef`
 * （本组件独有标识）—— 配平一旦失手就会在那里响亮失败，而不是静默漏检。
 */
function componentBody(name: string): string {
  const start = source.indexOf(`export function ${name}(`)
  if (start < 0) throw new Error(`component ${name} not found — 组件改名要同步这道门`)
  // 第一道配平：圆括号 ⇒ 找到参数表的收尾 `)`。
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(') paren++
    else if (ch === ')') {
      paren--
      if (paren === 0) break
    }
  }
  if (paren !== 0) throw new Error(`unbalanced parens in ${name}`)
  // 第二道配平：参数表之后的第一个 `{` 起算花括号。
  let j = source.indexOf('{', i + 1)
  if (j < 0) throw new Error(`no body for ${name}`)
  let depth = 0
  for (; j < source.length; j++) {
    const ch = source[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, j + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const body = componentBody('GraphMinimap')
check('抠到的确是 GraphMinimap 本体（含 svgRef 标识）', body.includes('svgRef'))

/** 必须自带 stopPropagation 的手势：父容器在同一条冒泡链上挂着这些手势。 */
const GESTURES = ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'onClick', 'onDoubleClick']

for (const gesture of GESTURES) {
  const at = body.indexOf(`${gesture}={`)
  check(`小地图声明了 ${gesture}`, at >= 0)
  if (at < 0) continue
  // 处理器体：从 `{` 起配平，取该箭头函数的内容。
  let i = body.indexOf('{', at)
  let depth = 0
  let handler = ''
  for (; i < body.length; i++) {
    const ch = body[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        handler = body.slice(at, i + 1)
        break
      }
    }
  }
  check(
    `${gesture} 自行 stopPropagation（否则父容器的拖画布/清选中会同时跑）`,
    handler.includes('stopPropagation'),
    handler.slice(0, 120),
  )
}

// 反向不变式：小地图**不该**自己声明「清选中」语义（那是容器的职责），
// 它只该把导航意图交回调用方 —— 一旦这里出现 onSelect，说明选中态被复制成两份。
check('小地图不携带选中态写入（导航意图交回调用方）', !/onSelect|setSelected/.test(body))

/**
 * 指针捕获的异常安全（真机用户旅程实测出的缺陷，不是假想需求）。
 *
 * 缺陷形态：`event.currentTarget.setPointerCapture?.(id)` 排在
 * `onNavigate(...)` **之前**，而 `?.` 只防「方法不存在」不防「方法抛异常」。
 * 浏览器在 pointerId 失效时按规范抛 NotFoundError ⇒ 整条 handler 中断 ⇒
 * 点小地图**毫无反应**（控制台才有痕迹）。一个可选优化否决了主功能。
 *
 * 这道门钉两件事：
 * 1. 源码里不得再出现「裸 setPointerCapture 调用」（必须经 try 包裹的封装）；
 * 2. 捕获调用必须排在 onNavigate **之后**或被保护 —— 用「不得出现
 *    `setPointerCapture` 紧跟 `onNavigate` 的裸调用序列」表达。
 */
const bareCapture = /currentTarget\.setPointerCapture\?\.\(/.test(body)
check('不再有裸 setPointerCapture?.() —— 可选链不防抛异常（真机实测缺陷）', !bareCapture)
const bareRelease = /currentTarget\.releasePointerCapture\?\.\(/.test(body)
check('不再有裸 releasePointerCapture?.()（未持有时同样抛）', !bareRelease)
check('捕获走 try 包裹的封装', /try\s*\{[^}]*setPointerCapture/.test(body) && /try\s*\{[^}]*releasePointerCapture/.test(body))

console.log(failures === 0 ? '\n小地图手势门 全部通过\n' : `\n${failures} 个断言失败\n`)
if (failures > 0) process.exit(1)
