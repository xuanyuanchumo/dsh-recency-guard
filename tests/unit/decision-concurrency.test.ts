/**
 * 常态路径的原子写 + 跨进程锁（T14-05 判据 6）。
 *
 * ## 这条测试要回答什么
 *
 * 「多进程并发写后读到的 JSON 永远可解析、条目不丢」—— 两件事分开验证：
 * 1. **可解析**：每次写后立刻读，JSON.parse 失败计数必须为 0
 *    （旧 `writeFileSync` 的截断窗口会稳定产出 0 字节文件）；
 * 2. **不丢条目**：N 个进程各追加 M 条，最终必须恰好 N×M 条。
 *    锁只缩小窗口是不够的 —— 这里断言的是**零丢失**。
 *
 * ## 为什么必须是真子进程
 *
 * `withFileLock` 是跨进程锁；同一进程里的并发 await 不构成「两个写者」
 * （同步段无法互相插入）。只用 Promise.all 会得到「永不撕裂」的假绿，
 * 而那正是本项目在指针/索引上踩过的坑（isolation-parallel 头注同一条纪律）。
 *
 * ## 三条通道各测一遍
 *
 * - **state**：`updateState`（已有锁，回归不破坏）；
 * - **decision**：`updateDecisionLocked`（本轮新增的 RMW）；
 * - **partition index**：`writePartitionIndexLocked`（本轮新增的跨进程合并写）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../../src/host/data/store.ts'
import { readPartitionIndex, registerPartition } from '../../src/host/core/isolation.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const WORKERS = 4
const ROUNDS = 6

/**
 * 工作进程源码。
 *
 * 为什么是**静态字符串 + argv 传参**而不是模板插值：动态 import 的路径
 * 必须是 `file://` URL（Windows 绝对路径带反斜杠，直接写进 import 说明符
 * 会得到 esbuild TransformError），而模板插值很容易把路径拼进说明符里。
 * 与 isolation-parallel 的跨进程段同一形态（那条路已被实测证明可用）。
 */
const WORKER_SOURCE = `
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const payload = JSON.parse(process.argv[2])
const src = (name) => pathToFileURL(payload.projectRoot + '/src/host/' + name).href
const { Store } = await import(src('data/store.ts'))
const isolation = await import(src('core/isolation.ts'))

const store = new Store(payload.profileDir, 'part-a')
const decisionPath = join(store.partitionPath, 'decision.json')
let torn = 0
function readBack() {
  if (!existsSync(decisionPath)) return
  try {
    JSON.parse(readFileSync(decisionPath, 'utf8'))
  } catch {
    torn += 1
  }
}
for (let i = 0; i < payload.rounds; i += 1) {
  await store.updateDecisionLocked((current) => ({
    capturedAt: new Date().toISOString(),
    suspects: [],
    disable: [...(current?.disable ?? []), 'w' + payload.worker + '-' + i],
    reason: 'none',
  }))
  readBack()
  await store.updateState((s) => ({ ...s, crashSeq: (s.crashSeq ?? 0) + 1 }))
  const { index } = isolation.registerPartition(isolation.readPartitionIndex(payload.profileDir), 'D:/ws-' + payload.worker)
  await isolation.writePartitionIndexLocked(payload.profileDir, index)
}
process.stdout.write(JSON.stringify({ torn }))
`

/** 起一个 worker 并收集 stdout。 */
function runWorker(scriptPath: string, payload: unknown): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_CLI, scriptPath, JSON.stringify(payload)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(PROJECT_ROOT, 'tsconfig.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code !== 0) rejectPromise(new Error(`worker exited ${code}: ${err.slice(-1200)}`))
      else resolvePromise(out)
    })
  })
}

async function main() {
  console.log(`\n== 跨进程并发写（${WORKERS} 进程 × ${ROUNDS} 轮 × 3 通道） ==`)
  const profile = mkdtempSync(join(tmpdir(), 'rg-concurrent-'))
  const workdir = mkdtempSync(join(tmpdir(), 'rg-workers-'))
  try {
    const store = new Store(profile, 'part-a')
    await store.init()

    const scripts = Array.from({ length: WORKERS }, (_, index) => {
      // 临时目录默认没有 package.json ⇒ tsx/esbuild 按 CJS 处理 worker，
      // 而 worker 用顶层 await（锁必须 await）⇒ 必须显式声明 ESM。
      writeFileSync(join(workdir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
      const path = join(workdir, `worker-${index}.ts`)
      writeFileSync(path, WORKER_SOURCE, 'utf8')
      return path
    })
    const results = await Promise.all(
      scripts.map((script, index) => runWorker(script, { projectRoot: PROJECT_ROOT, profileDir: profile, worker: index, rounds: ROUNDS })),
    )

    const tornTotal = results.reduce((sum, out) => sum + (JSON.parse(out) as { torn: number }).torn, 0)
    check('all workers finished cleanly', results.length === WORKERS, results)

    // 1) 可解析性：每次写后立刻 parse，失败必须为 0。
    check('decision.json was always parseable after every write', tornTotal === 0, { tornTotal })
    const decisionText = readFileSync(join(store.partitionPath, 'decision.json'), 'utf8')
    let parsedDecision: { disable?: string[] } = {}
    let parseOk = true
    try {
      parsedDecision = JSON.parse(decisionText) as { disable?: string[] }
    } catch {
      parseOk = false
    }
    check('final decision.json parses', parseOk, decisionText.slice(0, 200))

    // 2) 不丢条目：N×M 条全部在场且唯一。
    const entries = parsedDecision.disable ?? []
    check('decision entries: none lost', entries.length === WORKERS * ROUNDS, entries.length)
    check('decision entries: none duplicated', new Set(entries).size === entries.length)
    const expected = new Set<string>()
    for (let w = 0; w < WORKERS; w += 1) for (let i = 0; i < ROUNDS; i += 1) expected.add(`w${w}-${i}`)
    const missing = [...expected].filter((name) => !entries.includes(name))
    check('decision entries: every writer token survived', missing.length === 0, missing)

    // 3) state 的计数：锁路径同样零丢失。
    const state = await store.readState()
    check('state counter: all increments survived', state.crashSeq === WORKERS * ROUNDS, state.crashSeq)

    // 4) 分区索引：4 个并发写者都必须被登记。
    const index = readPartitionIndex(profile)
    check('partition index: all partitions registered', index.partitions.length === WORKERS, index.partitions.map((p) => p.key))
    check('partition index: json is parseable', Array.isArray(index.partitions))
    // 索引文件物理可读（不是 0 字节）。
    const indexText = readFileSync(join(profile, '.recency-guard', 'partitions.json'), 'utf8')
    check('partition index file is non-empty', indexText.length > 0 && existsSync(join(profile, '.recency-guard', 'partitions.json')))
  } finally {
    rmSync(profile, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.log('  FAIL  harness crashed', String(error))
    process.exit(1)
  })