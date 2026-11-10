#!/usr/bin/env node
// 一次性重构：拆掉 observe 域内的循环依赖。
//
// 现状（Q5 评审判定的真实环）：
//   observability → survival → observability
//   observability → control-band → observability
// 根因不是「模型互相引用」，而是**度量原语（Metric 契约 + 统计函数）与
// 具体模型住在同一个文件里**：survival/control-band 需要 `defineMetric`、
// `median`、`round4` 这些原语，却只能从 observability 拿 ⇒ 环。
//
// 拆法（依赖方向单向化）：
//   core/metric.ts      ← 度量原语（Metric 契约 / 统计 / EWMA / 环形缓冲）
//   observe/series.ts   ← 崩溃序列投影（crashSeries，只依赖 number）
//   observe/survival.ts → core/metric + series
//   observe/control-band.ts → core/metric
//   observe/preventive.ts → core/metric
//   observe/observability.ts → core/metric + series + survival + control-band
// 这样 survival/control-band/preventive 不再反向依赖 observability，环消失；
// observability 仍是「汇总读数」的角色，符合它原本的职责。

import { readFileSync, writeFileSync } from 'node:fs'

const OBS = 'src/host/observe/observability.ts'
const METRIC = 'src/host/core/metric.ts'
const SERIES = 'src/host/observe/series.ts'

const PRIMITIVES = [
  'MetricMeta',
  'Metric',
  'undefinedMetric',
  'definedMetric',
  'sampleConfidence',
  'displayDigits',
  'median',
  'medianAbsoluteDeviation',
  'quantile',
  'variance',
  'ewma',
  'ewmaLevel',
  'ewmaAlpha',
  'round4',
  'RingBuffer',
  'tailWindow',
]

const SERIES_BLOCKS = ['CrashSeries', 'crashSeries']

/** 抽取一个顶层声明及其紧邻的文档注释块。 */
function extractBlock(text, name) {
  const declaration = new RegExp(
    `^export (?:declare )?(?:function|interface|type|const|class)\\s+${name}\\b`,
    'm',
  )
  const match = declaration.exec(text)
  if (match === null) return null
  let start = match.index
  // 向上吞掉紧邻的 /** ... */ 或多行 // 注释
  let cursor = start
  const before = text.slice(0, start)
  const docEnd = before.lastIndexOf('*/')
  if (docEnd >= 0 && before.slice(docEnd + 2).trim() === '') {
    const docStart = before.lastIndexOf('/**', docEnd)
    if (docStart >= 0) start = docStart
  }
  // 找到声明结束：下一个顶层声明或文件末尾。用花括号配平更稳。
  const body = text.slice(start)
  const end = findDeclarationEnd(body)
  if (end < 0) return null
  return { block: body.slice(0, end), offset: start, length: end }
}

/** 从声明起点找到它的结束位置（含结尾换行）。 */
function findDeclarationEnd(body) {
  let depth = 0
  let inString = null
  let seenBrace = false
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (inString !== null) {
      if (ch === '\\') i += 1
      else if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i)
      if (nl < 0) return -1
      i = nl
      continue
    }
    if (ch === '/' && body[i + 1] === '*') {
      const close = body.indexOf('*/', i + 2)
      if (close < 0) return -1
      i = close + 1
      continue
    }
    if (ch === '{') {
      depth += 1
      seenBrace = true
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && seenBrace) {
        // 吞掉到行尾
        const nl = body.indexOf('\n', i)
        return nl < 0 ? body.length : nl + 1
      }
      continue
    }
    // 无花括号声明（type/const/函数表达式）：以空行 + 下一顶层声明为界
    if (depth === 0 && !seenBrace && ch === '\n') {
      const rest = body.slice(i + 1)
      if (/^\s*\n/.test(rest) || /^export /.test(rest) || /^\/\*\*/.test(rest) || /^\/\//.test(rest)) {
        return i + 1
      }
    }
  }
  return -1
}

function takeBlocksFrom(file, names) {
  let text = readFileSync(file, 'utf8')
  const collected = []
  for (const name of names) {
    const found = extractBlock(text, name)
    if (found === null) {
      console.error(`未找到声明：${name}`)
      process.exit(1)
    }
    collected.push({ name, block: found.block })
    text = text.slice(0, found.offset) + text.slice(found.offset + found.length)
  }
  writeFileSync(file, text, 'utf8')
  return collected
}

const primitiveBlocks = takeBlocksFrom(OBS, PRIMITIVES)
const seriesBlocks = takeBlocksFrom(OBS, SERIES_BLOCKS)

const header = (title, why) => `/**
 * ${title}
 *
 * ${why}
 *
 * ## 为什么独立成文件（v0.15 拆环）
 *
 * 这些原语原本与具体模型同住在 \`observability.ts\`，导致
 * \`observability → survival → observability\` 这类循环依赖：
 * 模型要用原语，只能从汇总模块反向取。eval 的 Q5（架构约束）把它判为 FAIL。
 *
 * 依赖方向现在单向：模型依赖原语，原语不依赖任何模型。
 */

`

writeFileSync(
  METRIC,
  `${header(
    '度量原语 —— Metric 契约 + 统计/EWMA 原语。',
    '只依赖 Math，不依赖任何模型，也不依赖任何观测数据形状。',
  )}${primitiveBlocks.map((entry) => entry.block).join('\n')}`,
  'utf8',
)

writeFileSync(
  SERIES,
  `${header('崩溃序列投影 —— 把时间戳序列变成「间隔」序列。', '纯函数，只依赖 number。')}${seriesBlocks
    .map((entry) => entry.block)
    .join('\n')}`,
  'utf8',
)

// observability 改为从新模块取原语，并 re-export 保持既有调用方不变。
let observability = readFileSync(OBS, 'utf8')
const importLine = `import {
${PRIMITIVES.map((name) => `  ${name},`).join('\n')}
} from '../core/metric.ts'
import { crashSeries, type CrashSeries } from './series.ts'

// re-export：既有调用方（preventive、测试、client 类型）继续从 observability 取，
// 不必全量改 import；而 survival/control-band 已直接依赖 core/metric，环已断。
export {
${PRIMITIVES.map((name) => `  ${name},`).join('\n')}
  crashSeries,
  type CrashSeries,
}
`
// 插在最前面的 import 之后（保守：插在文件首个 import 之前会把 import 顶下去，
// 所以定位第一个空行之后的 import 区末尾）
const firstImportEnd = observability.indexOf('\n\n')
observability =
  observability.slice(0, firstImportEnd + 1) + importLine + observability.slice(firstImportEnd + 1)
writeFileSync(OBS, observability, 'utf8')

// survival / control-band / preventive 改为直接依赖 core/metric
for (const file of ['src/host/observe/survival.ts', 'src/host/observe/control-band.ts', 'src/host/observe/preventive.ts']) {
  let text = readFileSync(file, 'utf8')
  text = text.replace(/from '\.\/observability\.ts'/g, "from '../core/metric.ts'")
  // survival 的 crashSeries 来自 series.ts（已随环一起拆走）
  text = text.replace(
    /import \{ crashSeries, (definedMetric[^}]*)\} from '\.\/series\.ts'/,
    "import { crashSeries } from './series.ts'\nimport { $1 } from '../core/metric.ts'",
  )
  writeFileSync(file, text, 'utf8')
}

console.log('拆环完成：core/metric.ts + observe/series.ts')