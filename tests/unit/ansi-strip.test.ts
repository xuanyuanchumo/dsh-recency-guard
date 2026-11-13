import { sanitizeText, stripAnsiSequences } from '../../src/host/surface/tool-text.ts'

/**
 * ANSI 转义序列剥离的测试。
 *
 * ## 为什么要有这个测试（实测缺陷）
 *
 * 逐码点的控制字符剥离（`sanitizeText` 的第 1 步）会把 `ESC` 本身删掉，
 * 却把**参数负载**留在原地：
 *
 * ```
 * input : "safe\u001b[31mRED\u001b[0m"
 * output: "safe\[31mRED\[0m"     ← 用户看到 "[31mRED[0m"
 * ```
 *
 * 那不是「安全了」，是「安全地留下了垃圾」：终端里本来靠 ESC 生效的颜色
 * 变成了**可见的字面量**，语义丢失 + 噪声可见，比原来的彩色更糟。
 *
 * ## 本文件钉死的高危不变式
 *
 * 1. **序列级剥除**：CSI / OSC / DCS / 两字符转义 / 孤立 ESC 全部剥干净，
 *    **不留可见负载**。
 * 2. **正常文本逐字节不变**：`@scope/pkg`、`0.0.0-dev`、时间戳经此函数不变 ——
 *    「修显示问题反而把正常输出改脏」是最难发现的回归。
 * 3. **幂等**：剥过一次没有 ESC 了，第二次不得再改。
 * 4. **终止符是必需的**：OSC/DCS 若没有终止符，不能靠「匹配到 ESC] 就停」
 *    把负载留下来（那正是缺陷本身）。
 * 5. **CR 语义**：裸 CR（无 LF）在终端里会覆盖行首 ⇒ 折成换行保留视觉分行。
 */

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

// ---------- 各序列族 ----------

check('CSI 颜色序列被完整剥除', stripAnsiSequences(`safe${ESC}[31mRED${ESC}[0m`).text === 'safeRED', stripAnsiSequences(`safe${ESC}[31mRED${ESC}[0m`).text)
check('CSI 清屏序列被剥除', stripAnsiSequences(`a${ESC}[2Jb`).text === 'ab')
check('CSI 带中间符被剥除', stripAnsiSequences(`a${ESC}[1;2 Hb`).text === 'ab')
check('OSC（BEL 终止）被剥除', stripAnsiSequences(`x${ESC}]8;;http://evil${BEL}y${ESC}]8;;${BEL}z`).text === 'xyz', stripAnsiSequences(`x${ESC}]8;;http://evil${BEL}y${ESC}]8;;${BEL}z`).text)
check('OSC（ST 终止）被剥除', stripAnsiSequences(`x${ESC}]0;title${ESC}\\y`).text === 'xy')
check('DCS 被剥除', stripAnsiSequences(`a${ESC}Pq${ESC}\\b`).text === 'ab')
check('两字符转义（字符集选择）被剥除', stripAnsiSequences(`a${ESC}(Bb`).text === 'ab', stripAnsiSequences(`a${ESC}(Bb`).text)
check('孤立 ESC 被剥除', stripAnsiSequences(`a${ESC}b`).text === 'ab')
check('裸 CR 折成换行', stripAnsiSequences('a\rb').text === 'a\nb')
check('CRLF 保持原样', stripAnsiSequences('a\r\nb').text === 'a\r\nb')

// ---------- 负载不残留（缺陷本身） ----------

const payloadCheck = stripAnsiSequences(`safe${ESC}[31mRED${ESC}[0m`)
check('CSI 参数负载不残留', !payloadCheck.text.includes('[31m') && !payloadCheck.text.includes('[0m'), payloadCheck.text)
const oscCheck = stripAnsiSequences(`x${ESC}]8;;http://evil${BEL}y`)
check('OSC 负载不残留', !oscCheck.text.includes('8;;') && !oscCheck.text.includes('http'), oscCheck.text)

// ---------- 正常文本不变 ----------

check('正常包名逐字节不变', stripAnsiSequences('@scope/pkg').text === '@scope/pkg')
check('版本号逐字节不变', stripAnsiSequences('0.0.0-dev').text === '0.0.0-dev')
check('无 ANSI 的普通文本不变', stripAnsiSequences('plain text 123').text === 'plain text 123')
check('中文逐字节不变', stripAnsiSequences('插件崩溃守护').text === '插件崩溃守护')

// ---------- 幂等 ----------

const once = stripAnsiSequences(`a${ESC}[31mb`).text
const twice = stripAnsiSequences(once)
check('幂等：二次处理文本不变', twice.text === once, { once, twice: twice.text })
check('幂等：二次处理 removed=0', twice.removed === 0, twice.removed)

// ---------- 计数 ----------

check('计数：一次剥除记 1', stripAnsiSequences(`a${ESC}[31mb`).removed === 1, stripAnsiSequences(`a${ESC}[31mb`).removed)
check('计数：无 ANSI 时为 0', stripAnsiSequences('plain').removed === 0)
check('计数：多个序列分别计数', stripAnsiSequences(`a${ESC}[31mb${ESC}[0mc`).removed === 2, stripAnsiSequences(`a${ESC}[31mb${ESC}[0mc`).removed)

// ---------- 与 sanitizeText 的集成 ----------

const sanitized = sanitizeText(`safe${ESC}[31mRED${ESC}[0m`)
check('sanitizeText 集成：无 ANSI 负载残留', !sanitized.text.includes('[31m') && !sanitized.text.includes('[0m'), sanitized.text)
check('sanitizeText 集成：正常包名仍逐字节不变', sanitizeText('@scope/pkg-1.2.3').text === '@scope/pkg-1.2.3')
check('sanitizeText 集成：计数被并入 removed', sanitizeText(`a${ESC}[31mb`).removed >= 1)

if (failures > 0) {
  console.error(`\nansi-strip: ${failures} 条断言失败`)
  process.exit(1)
}
console.log('\nansi-strip 全部通过')
