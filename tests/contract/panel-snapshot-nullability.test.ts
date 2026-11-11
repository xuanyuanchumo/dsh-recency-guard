import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 跨运行时契约 —— 宿主**实际会发 null** 的字段，客户端视图必须声明可空。
 *
 * ## 为什么需要这条测试（v0.16 真机崩溃）
 *
 * 类型系统只在**编译期**连接两个运行时。宿主的 `PanelSnapshot` 把
 * `stabilityScore` / `metrics` / `capability` 等声明为非空，但
 * `partition-snapshot.ts` 的跨分区只读视图明确发 null 或整段省略 ——
 * 客户端照抄类型后，`.toFixed(...)` 在真机把面板打进错误边界。
 *
 * 这条测试不依赖「哪一边更正确」的争论：它读**宿主的真实产出代码**，
 * 把其中 `key: null` 的字段集与客户端 `snapshot-view.ts` 的可空声明做
 * 双向核对。宿主将来多发一个 null、客户端忘了放宽，这里就会红。
 *
 * 纪律：只读源码文本（不 import 宿主运行时模块），因此本测试能留在
 * Contract 层而不把 client bundle 绑到 host 实现上。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const partitionSource = read('src/host/surface/partition-snapshot.ts')
const viewSource = read('src/client/panel/snapshot-view.ts')
const panelModelSource = read('src/client/panel/panel-model.ts')
const metricSource = read('src/host/core/metric.ts')

console.log('\n[宿主真实产出：会发 null 的字段集]')
// 匹配缩进 4 空格的 `key: null,` —— 只取跨分区快照的顶层字段。
const nullFields = new Set(
  [...partitionSource.matchAll(/^ {4}(\w+): null,?$/gm)].map((match) => match[1] ?? '').filter((key) => key !== ''),
)
check('扫描到了足够多的可空字段（防止正则失效后静默全过）', nullFields.size >= 5, [...nullFields])
for (const required of ['stabilityScore', 'metrics', 'capability', 'markov', 'revision']) {
  check(`宿主确实会发 ${required}: null`, nullFields.has(required))
}

console.log('\n[客户端视图：逐字段声明可空]')
for (const key of nullFields) {
  // 匹配 `key?: X | null` 与 `key: X | null` 两种形态。
  const pattern = new RegExp(`\\b${key}\\??: [^\\n]*\\| null`)
  check(`${key} 在客户端视图里可空`, pattern.test(viewSource))
}

console.log('\n[Metric<T>.value 可空 —— 子字段同一条纪律]')
check('宿主 Metric 的 value 声明为 T | null', /value: T \| null/.test(metricSource))
check('客户端 metricRows 的 push 接收 T | null', /value: T \| null/.test(panelModelSource))
check('客户端不再用 as 断言绕过指标类型检查', !panelModelSource.includes('metric.value as never'))

console.log('\n[视图层只做类型 import（不把 client bundle 绑到 host 运行时）]')
check(
  'snapshot-view 用 import type 引入宿主契约',
  /import type \{ PanelSnapshot \} from '\.\.\/\.\.\/host\/surface\/snapshot\.ts'/.test(viewSource),
)
check('没有运行时 import host 的语句', !/^import (?!type)[\s\S]*?from '\.\.\/\.\.\/host\//m.test(viewSource))

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')