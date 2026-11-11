/**
 * 统一测试入口 —— 跑完所有分层测试并汇总。
 *
 * 分层（对应 `.cycles/config.yml` 的 layers）：
 *   Core     纯逻辑层：能力模型 / 生命周期 / 隔离 / 可观测性 / 图谱数据
 *   Host     宿主层：守护流程、路由、归档
 *   Client   客户端层：面板纯函数、图谱交互计算
 *   Contract 契约层：能力清单 ↔ 注册处 双向比对
 *
 * 契约层覆盖率要求 100%：漏一条能力登记就是真缺口，不能靠覆盖率稀释。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')

/** 一个测试文件。 */
interface TestFile {
  layer: 'Core' | 'Host' | 'Client' | 'Contract'
  file: string
}

const LAYER_BY_DIR: Record<string, TestFile['layer']> = {
  unit: 'Core',
  host: 'Host',
  client: 'Client',
  contract: 'Contract',
  // E4.2 故障注入（v0.15）：真实 cordis Loader + dsh-app-boot 启动判决。
  // 归 Host 层：它测的是宿主挂载与崩溃恢复链路，不是纯函数。
  // 代价：npm test 时长约 +47s（子进程启动 + 崩溃检测轮），这是 E4.2 判据
  // 「检出率 100%」必须付的成本 —— 放慢 CI 也胜过把整层从门禁里摘掉。
  'fault-injection': 'Host',
}

/** 收集测试文件。 */
function collect(): TestFile[] {
  const out: TestFile[] = []
  for (const [dir, layer] of Object.entries(LAYER_BY_DIR)) {
    const base = join(here, dir)
    let entries: string[]
    try {
      entries = readdirSync(base)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(base, entry)
      if (!statSync(path).isFile()) continue
      if (!entry.endsWith('.test.ts')) continue
      out.push({ layer, file: path })
    }
  }
  return out.sort((a, b) => a.layer.localeCompare(b.layer) || a.file.localeCompare(b.file))
}

const files = collect()
if (files.length === 0) {
  console.error('没有找到测试文件。')
  process.exit(1)
}

// 并发污染守卫：变异工具在跑每个变异体时会**临时改写 `src/**` 再恢复**
// （`scripts/mutation.mjs`）。若此时有别人（eval-runner 的并行预热、另一个
// agent）在跑 `npm test`，测试进程读到的是变异体 —— 结果是「产品有 bug」的
// 假红（cycle-14 实测 E3/E8 因此误判，重跑同一 Merkle 根即 68/68）。
//
// 观测设施宁可拒绝出结论，也不出一个不可解释的结论。标记缺失就正常跑。
const mutationMarker = join(projectRoot, '.tmp', 'mutation.inflight')
if (existsSync(mutationMarker)) {
  console.error(
    '\n[guard] 检测到 .tmp/mutation.inflight：变异测试正在改写 src/**。\n' +
      '        此时跑测试会读到变异体，结论不可解释 —— 拒绝执行。\n' +
      '        等变异跑完后重试；若确认是残留标记（上一轮被强杀），删除该文件即可。',
  )
  process.exit(2)
}

console.log(`\n运行 ${files.length} 个测试文件：\n`)
let failed = 0
let passed = 0
const byLayer = new Map<string, { total: number; failed: number }>()

for (const test of files) {
  const rel = relative(projectRoot, test.file).replace(/\\/g, '/')
  const result = spawnSync(process.execPath, [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), test.file], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, TSX_TSCONFIG_PATH: join(projectRoot, 'tsconfig.json') },
  })
  const layer = byLayer.get(test.layer) ?? { total: 0, failed: 0 }
  layer.total += 1
  if (result.status === 0) {
    passed += 1
    console.log(`  PASS  [${test.layer}] ${rel}`)
  } else {
    failed += 1
    layer.failed += 1
    console.log(`  FAIL  [${test.layer}] ${rel}`)
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    console.log(
      output
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-18)
        .map((line) => `        ${line}`)
        .join('\n'),
    )
  }
  byLayer.set(test.layer, layer)
}

console.log('\n分层汇总：')
for (const [layer, stat] of [...byLayer.entries()].sort()) {
  const mark = stat.failed === 0 ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${layer}: ${stat.total - stat.failed}/${stat.total}`)
}

console.log(`\n${failed === 0 ? `全部通过（${passed}/${files.length}）` : `${failed} 个测试文件失败`}\n`)
process.exit(failed === 0 ? 0 : 1)
