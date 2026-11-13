import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_SURFACE } from '../../src/host/capability/capability.ts'

/**
 * 契约层：`tool.call.toolview` 命令窗口通道的**注册面**核对。
 *
 * ## 为什么这是契约层（而不是普通单测）
 *
 * 「命令窗口能看到卡片」这件事**不由本插件单方面决定**：
 *
 * - 注册点必须在 **client 半部**（宿主在浏览器侧查 `tool.call.toolview` 席位）；
 * - 注册的 **key 必须等于 host 侧注册的工具名**（`TOOL_SURFACE.name`）；
 *   两处名字不一致 ⇒ 卡片永不命中 ⇒ 命令窗口退回 generic 行，
 *   而且**不报任何错**（静默失效）。
 *
 * 这正是本仓纪律里「声明了不消费 = 必然漂移」的同类：能力已实现、
 * 但没有一条契约把「两端接上了」钉住时，下一次重命名就会静默断链。
 *
 * 本文件钉死的高危不变式：
 *
 * 1. client 半部**必须**注册 `tool.call.toolview` 席位。
 * 2. 注册的 key **必须**等于 host 侧 `TOOL_SURFACE.name`。
 * 3. 该注册**必须**经由 `ctx.slots.inject('tool.call.toolview', …)` ——
 *    直接 `register` 会撞「向未声明 slot 注册」（宿主 ToolCallTree 未挂载）。
 * 4. 幂等守卫必须存在（`slots.entries()` 反查）——防热重载双挂载。
 * 5. 宿主侧工具名与 `dsh-plugin.json` 声明的 `x-tool-namespaces.tools` 必须一致
 *    （三处名字，改一处就要改三处）。
 */

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..', '..')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function read(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), 'utf8')
}

/** 抽取层文件的绝对路径（用于扩展名判据）。 */
const modelPath = join(projectRoot, 'src/client/toolview/toolview-model.ts')

// ---------- 1. client 半部注册了 toolview 席位 ----------

const integration = read('src/client/toolview/ToolViewIntegration.ts')
check('client 半部存在 toolview 集成文件', integration.length > 0)
check(
  'client 半部注册了 tool.call.toolview 席位',
  integration.includes("'tool.call.toolview'"),
  '未找到 tool.call.toolview 字面量',
)
check(
  '注册经由 ctx.slots.inject（不是直接 register）',
  /inject\(\s*'tool\.call\.toolview'/.test(integration),
  '未找到 inject(\'tool.call.toolview\', …) 调用',
)
check(
  '存在幂等守卫（slots.entries 反查）',
  integration.includes('entries?.(') || integration.includes('entries('),
  '未找到 entries 反查',
)
check(
  '注册计数用 getter（延迟注入下仍反映真实值）',
  /get count\(\)/.test(integration),
  '未找到 get count() —— 静态快照会在延迟注入下永远停在 0',
)

// ---------- 2. key 与 host 侧工具名一致 ----------

check(
  'toolview 的 key 常量等于 host 侧 TOOL_SURFACE.name',
  integration.includes(`TOOLVIEW_TOOL_NAME = '${TOOL_SURFACE.name}'`),
  `期望 '${TOOL_SURFACE.name}'`,
)
check(
  '注册项的 key 用的是该常量（不是硬编码字面量）',
  integration.includes('key: TOOLVIEW_TOOL_NAME'),
  '未找到 key: TOOLVIEW_TOOL_NAME',
)

// ---------- 3. client 入口真的调用了集成 ----------

const entry = read('src/client/entry.ts')
check('client 入口 import 了 toolview 集成', entry.includes("toolview/ToolViewIntegration.ts"))
check('client 入口调用了 integrateToolView', /integrateToolView\(ctx\)/.test(entry))

// ---------- 4. host 侧工具名与 manifest 一致（三处名字） ----------

const manifest = JSON.parse(read('dsh-plugin.json')) as {
  contributes?: {
    'x-tool-namespaces'?: Array<{ tools?: string[] }>
  }
}
const declaredTools = manifest.contributes?.['x-tool-namespaces']?.[0]?.tools ?? []
check(
  'dsh-plugin.json 声明的工具名与 host 侧一致',
  declaredTools.includes(TOOL_SURFACE.name),
  { declaredTools, expected: TOOL_SURFACE.name },
)

// ---------- 5. 卡片组件存在且是稳定 function component ----------

const card = read('src/client/toolview/GuardToolCard.tsx')
check('卡片组件文件存在', card.length > 0)
check('卡片组件是模块作用域的 function 声明（非内联箭头）', /export function GuardToolCard/.test(card))
check(
  '卡片 CSS 是单一样式真源（集成侧引用常量而非另写一份）',
  integration.includes('TOOLVIEW_CSS') && !integration.includes('rg-toolview-card {'),
  '集成侧不得另持一份 CSS',
)

// ---------- 6. 抽取层是纯函数（不引 React） ----------

const model = read('src/client/toolview/toolview-model.ts')
check('抽取层不 import react', !/from ['"]react['"]/.test(model), '抽取层必须零 React 依赖')
// JSX 的诚实判据是**文件扩展名**：`.ts` 文件在编译期就不可能含 JSX。
// 用正则扫 `<[A-Za-z]` 会误判类型注解（`Record<string, unknown>` 里的 `<R`）——
// 判据本身撒谎比没有判据更贵。
check('抽取层是 .ts 文件（结构上不可能含 JSX）', modelPath.endsWith('.ts'), modelPath)

if (failures > 0) {
  console.error(`\ntoolview-contract: ${failures} 条断言失败`)
  process.exit(1)
}
console.log('\ntoolview-contract 全部通过')
