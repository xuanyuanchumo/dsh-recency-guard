/**
 * 故障注入测试的公共地基（E4.2 / 研究文档 07 §5.2、§5.3、§5.4）。
 *
 * ## 为什么用「真实宿主启动策略」而不是自己判成功/失败
 *
 * 本项目的威胁模型有一条硬边界（CLAUDE.md）：**entry 级 apply 抛错宿主只是
 * warning（自隔离），不崩进程**；真崩溃来自 requiredStartupEntryIds 里的核心
 * entry 失败或进程级错误。如果测试自己定义「加载出错 = 崩溃」，就会把
 * 宿主的自隔离行为误判成崩溃，检出率虚高、反向用例全红。
 *
 * 所以这里的判决权全部交给真实运行时：
 * - 崩溃与否 ⇒ `dsh-app-boot` 的 `auditStartupEntries` + `installFailLoud`；
 * - 模块怎么加载 ⇒ `cordis-plugin-loader` 的真实 entry 树（`ctx.loader.create`）；
 * - 守护怎么算检出 ⇒ 守护自己的 journal / state.json / decision.json 产物。
 * 测试只负责搭沙箱、注入、取证与断言，不替被测系统下结论。
 *
 * ## 隔离
 *
 * 每个用例一个 `mkdtemp` 目录（在项目 `.tmp/` 下，属 .gitignore；放项目内是因为
 * 跨盘符无法用相对路径引用 `src/index.ts`，Loader 的 entry name 必须是相对
 * `baseUrl` 的说明符）。绝不读写 `~/.dsh/profiles/**` —— 07 §5.4 的硬要求。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { hasRuntime } from '../host/runtime.ts'

/** 项目根（测试文件在 tests/fault-injection/ 下）。 */
export const projectRoot = resolve(import.meta.dirname, '..', '..')

/** 沙箱父目录：`.tmp/` 已 gitignore；mkdtemp 保证每次都是新目录。 */
export const sandboxRoot = join(projectRoot, '.tmp')

/** 守护插件的真相源：源码经 tsx 由 Loader 直接加载（不依赖 dist 是否已构建）。 */
export const guardEntry = join(projectRoot, 'src', 'index.ts')

/** tsx 的 CLI 入口（与 tests/run.ts 同一手法，避免依赖 PATH 里的 npx）。 */
export const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/** 一个坏插件的注入方式。 */
export type FaultMode =
  /** 真实 fatal：required entry 失败或进程级错误 ⇒ 退出码 1。 */
  | 'fatal'
  /** 不跑 exit 处理器：由测试方 SIGKILL（哨兵通道的盲区）。 */
  | 'kill'
  /** 宿主存活并干净退出（反向用例）。 */
  | 'clean'

/** 守护的哪条通道应当给出信号。 */
export type DetectionChannel = 'sentinel' | 'abnormal' | 'none'

export interface FaultCase {
  /** 用例 id（也是文件路径里的标识）。 */
  id: string
  /** 夹具目录名（tests/fault-injection/fixtures/<fixture>/index.js）。 */
  fixture: string
  /** bundle 名：同时是 profile 依赖名与 node_modules 目录名（守护的嫌疑排名靠它）。 */
  bundle: string
  /** Loader entry id。requiredStartupEntryIds 的成员会触发致命启动失败。 */
  entryId: string
  mode: FaultMode
  /** 期望命中的通道；反向用例为 'none'。 */
  channel: DetectionChannel
  /** E4.2 的判据：是否必须被检出。 */
  expectDetected: boolean
  /** 写入报告用的人读说明（为什么这个形态是崩溃 / 不是崩溃）。 */
  why: string
}

/**
 * 注入矩阵。
 *
 * 必需 id 取自真实宿主的 `requiredStartupEntryIds`（runtime/dsh-app-boot 实测：
 * agent-loop / tool-executor-native / webserver …）。用 `webserver` 是因为它在
 * 列表里且不需要任何服务即可失败 —— 夹具只管抛错，不影响别的启动路径。
 */
export const FAULT_CASES: readonly FaultCase[] = [
  {
    id: 'apply-throw-required',
    fixture: 'apply-throw',
    bundle: 'fi-apply-throw',
    entryId: 'webserver',
    mode: 'fatal',
    channel: 'sentinel',
    expectDetected: true,
    why: '核心 entry（requiredStartupEntryIds）的 apply 抛错 ⇒ auditStartupEntries 抛 StartupError ⇒ 宿主 fatal 退出码 1',
  },
  {
    id: 'missing-dep-required',
    fixture: 'missing-dep',
    bundle: 'fi-missing-dep',
    entryId: 'webserver',
    mode: 'fatal',
    channel: 'sentinel',
    expectDetected: true,
    why: '模块 import 阶段 ERR_MODULE_NOT_FOUND + 核心 entry ⇒ 同样是宿主 fatal（import 错误被 Loader 吞掉，致命性来自启动策略）',
  },
  {
    id: 'exit-now',
    fixture: 'exit-now',
    bundle: 'fi-exit-now',
    entryId: 'fi-exit-now',
    mode: 'fatal',
    channel: 'sentinel',
    expectDetected: true,
    why: 'apply 里 process.exit(1)：进程级错误，cordis 的 try/catch 拦不住，exit 处理器仍会跑 ⇒ 哨兵通道',
  },
  {
    id: 'async-throw-after-apply',
    fixture: 'async-throw',
    bundle: 'fi-async-throw',
    entryId: 'fi-async-throw',
    mode: 'fatal',
    channel: 'sentinel',
    expectDetected: true,
    why: '加载成功后异步 throw（H4.2 要抓的时序缺陷）⇒ installFailLoud 的 uncaughtException ⇒ exit 1',
  },
  {
    id: 'hard-kill',
    fixture: 'good',
    bundle: 'fi-hard-kill',
    entryId: 'fi-hard-kill',
    mode: 'kill',
    channel: 'abnormal',
    expectDetected: true,
    why: 'SIGKILL/TerminateProcess 不跑 exit 处理器 ⇒ 哨兵缺席；只有残留 bootMarker + pidAlive 能检出（v0.12.1 第二通道）',
  },
  {
    id: 'apply-throw-optional',
    fixture: 'apply-throw',
    bundle: 'fi-apply-throw-opt',
    entryId: 'fi-optional-entry',
    mode: 'clean',
    channel: 'none',
    expectDetected: false,
    why: '反向：entry 级 apply 抛错宿主只是 warning（自隔离），进程存活 ⇒ 不得判成崩溃',
  },
  {
    id: 'missing-dep-optional',
    fixture: 'missing-dep',
    bundle: 'fi-missing-dep-opt',
    entryId: 'fi-optional-entry',
    mode: 'clean',
    channel: 'none',
    expectDetected: false,
    why: '反向：非核心 entry 的 import 失败同样只是 warning ⇒ 不得判成崩溃',
  },
  {
    id: 'good-plugin',
    fixture: 'good',
    bundle: 'fi-good',
    entryId: 'fi-good-entry',
    mode: 'clean',
    channel: 'none',
    expectDetected: false,
    why: '反向：好插件不崩 ⇒ 不得出现任何崩溃证据（防止「全部报错即检出」的假实现）',
  },
]

/** 一次沙箱注入的路径事实（全部在临时目录内）。 */
export interface Sandbox {
  /** 临时目录根（= profile 目录）。 */
  dir: string
  /** 工作区（决定分区键；两个子进程必须用同一个）。 */
  workspace: string
  /** Loader entry 说明符：相对 profile 目录指到 src/index.ts。 */
  guardSpec: string
  /** 注入 bundle 的入口说明符（相对 profile 目录）。 */
  badSpec: string
  /** 注入探针落盘位置（证明夹具顶层代码真的被 import）。 */
  beaconFile: string
  /** 子进程表示「守护已启动、bootMarker 已落盘」的信号文件。 */
  readyFile: string
  /** 强杀用例：表示「坏插件已挂进树」的信号文件（必须在 SIGKILL 之前等到它）。 */
  armedFile: string
  /** 第二次启动（检测轮）完成的信号文件。 */
  detectDoneFile: string
  /** 子进程的崩溃/存活报告（用于证明失败形态来自夹具而不是测试脚本）。 */
  reportFile: string
}

/** 相对 profile 目录的 Loader 说明符（必须以 `.` 开头，Loader 才按 URL 解析）。 */
function loaderSpec(from: string, target: string): string {
  const rel = relative(from, target).replace(/\\/g, '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/**
 * 建造一个隔离沙箱并注入一个坏插件。
 *
 * bundle 布局刻意做成真实形状（profile/package.json 声明依赖 + node_modules/<name>/
 * package.json 带 version）：守护的嫌疑排名从这条链路取版本与 recency，随便
 * 放一个裸 .mjs 文件根本进不了嫌疑面 —— 那样测出的「未检出」是夹具的问题。
 */
export function createSandbox(testCase: FaultCase): Sandbox {
  mkdirSync(sandboxRoot, { recursive: true })
  const dir = mkdtempSync(join(sandboxRoot, 'fi-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `fi-profile-${testCase.id}`, private: true, dependencies: { [testCase.bundle]: '1.0.0' } }, null, 2),
    'utf8',
  )
  const bundleDir = join(dir, 'node_modules', testCase.bundle)
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: testCase.bundle, version: '1.0.0', type: 'module', main: 'index.js' }, null, 2),
    'utf8',
  )
  cpSync(join(import.meta.dirname, 'fixtures', testCase.fixture, 'index.js'), join(bundleDir, 'index.js'))
  // 探针必须放进被注入的 bundle 内部：夹具用 `import './beacon.mjs'` 引用它。
  cpSync(join(import.meta.dirname, 'fixtures', 'beacon.mjs'), join(bundleDir, 'beacon.mjs'))

  return {
    dir,
    workspace,
    guardSpec: loaderSpec(dir, guardEntry),
    badSpec: loaderSpec(dir, join(bundleDir, 'index.js')),
    beaconFile: join(dir, '.fi-beacon', testCase.id),
    readyFile: join(dir, '.fi-ready'),
    armedFile: join(dir, '.fi-armed'),
    detectDoneFile: join(dir, '.fi-detect-done'),
    reportFile: join(dir, '.fi-report.json'),
  }
}

/** runtime 是否可用（缺失时测试必须诚实跳过，不能静默 PASS）。 */
export function runtimeReadiness(): { ready: boolean; reason: string } {
  if (process.env.FI_SIMULATE_NO_RUNTIME === '1') {
    // 只用于演示降级行为：不删 runtime/（那是别的测试的依赖），用环境变量模拟缺失。
    return { ready: false, reason: 'FI_SIMULATE_NO_RUNTIME=1（模拟 runtime/ 缺失）' }
  }
  if (!hasRuntime()) return { ready: false, reason: 'runtime/cordis/package.json 不存在（先 npm run extract-runtime）' }
  return { ready: true, reason: 'runtime/ 在场' }
}

/** 轮询等待文件出现（子进程之间同步用的最小机制，不依赖 sleep 猜测）。 */
export async function waitForFile(path: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return existsSync(path)
}

/** 子进程评测结果。 */
export interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 起一个 tsx 子进程并收集输出（不阻塞调用方 —— kill 用例需要先拿句柄）。 */
export function spawnTsx(script: string, env: Record<string, string>, timeoutMs = 40_000) {
  const child: ChildProcess = spawn(process.execPath, [tsxCli, script], {
    cwd: projectRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(projectRoot, 'tsconfig.json'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const done = new Promise<ChildResult>((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
  return { child, done }
}

/** 读取一次注入/检测后的守护产物（文件不存在时给出 null，由断言层判 FAIL）。 */
export interface GuardArtifacts {
  partitionDir: string | null
  journal: Array<Record<string, unknown>>
  state: Record<string, unknown> | null
  decision: Record<string, unknown> | null
  /** 崩溃轮写下的哨兵（检测轮启动时会被改名成 crashed.consumed）。 */
  sentinelPresent: boolean
  sentinelConsumed: Record<string, unknown> | null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 守护按工作区分区；这里直接找唯一的 projects/<key> 目录，避免在测试里复刻分区键公式。 */
export function findPartitionDir(profileDir: string): string | null {
  const projects = join(profileDir, '.recency-guard', 'projects')
  try {
    const entries = readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory())
    return entries.length === 1 ? join(projects, entries[0]!.name) : null
  } catch {
    return null
  }
}

export function readArtifacts(profileDir: string): GuardArtifacts {
  const partitionDir = findPartitionDir(profileDir)
  if (partitionDir === null) {
    return { partitionDir: null, journal: [], state: null, decision: null, sentinelPresent: false, sentinelConsumed: null }
  }
  let journal: Array<Record<string, unknown>> = []
  try {
    journal = readFileSync(join(partitionDir, 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        } catch {
          return []
        }
      })
  } catch {
    journal = []
  }
  return {
    partitionDir,
    journal,
    state: readJson(join(partitionDir, 'state.json')),
    decision: readJson(join(partitionDir, 'decision.json')),
    sentinelPresent: existsSync(join(partitionDir, 'crashed')),
    sentinelConsumed: readJson(join(partitionDir, 'crashed.consumed')),
  }
}

/** 从产物里取「崩溃证据」事件（两条通道共用一个 kind，靠字段区分）。 */
export function crashEvents(journal: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return journal.filter((e) => e.kind === 'crash-detected')
}

/** 守护本轮是否真的启动过（journal 里每次启动一条 note，含 pid）。 */
export function bootNotes(journal: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return journal.filter((e) => e.kind === 'note' && typeof e.detail === 'string' && e.detail.startsWith('dsh 启动 pid='))
}