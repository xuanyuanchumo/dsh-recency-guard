/**
 * 注入轮子进程：跑一次**真实形态的宿主启动**。
 *
 * 组成全部来自真实宿主运行时，没有一处是测试自造的判决：
 * - `cordis` + `cordis-plugin-loader`：`ctx.loader.create()` 就是宿主 Loader
 *   加载 entry 的同一条路径（模块 import → Config 校验 → inject 解析 → apply）；
 * - `dsh-app-boot.auditStartupEntries`：DSH 的真实启动策略 —— required
 *   entry 未激活 ⇒ 抛 StartupError；其余失败只 warning；
 * - `dsh-app-boot.installFailLoud`：DSH 的真实进程级兜底 —— 未捕获异常/拒绝
 *   ⇒ 一条 fatal 诊断 + exit(1)。
 *
 * 守护插件（src/index.ts）作为普通 entry 挂进同一棵树：它因此在真实路径上
 * 写完同步启动记录、装好进程级哨兵、落下 bootMarker —— 崩溃产物是它自己产出的，
 * 不是测试替它写的。这一点决定「检出」断言的可信度。
 */
import { pathToFileURL } from 'node:url'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importRuntime } from '../host/runtime.ts'

type AnyCtx = Record<string, any>

const profileDir = process.env.FI_PROFILE ?? ''
const workspace = process.env.FI_WORKSPACE ?? ''
const guardSpec = process.env.FI_GUARD_SPEC ?? ''
const badSpec = process.env.FI_BAD_SPEC ?? ''
const entryId = process.env.FI_ENTRY_ID ?? ''
const mode = process.env.FI_MODE ?? 'fatal'
const readyFile = process.env.FI_READY_FILE ?? ''
const reportFile = process.env.FI_REPORT_FILE ?? ''
const armedFile = process.env.FI_ARMED_FILE ?? ''

const { Context } = await importRuntime<any>('@deepseek-ai/cordis')
const { Loader } = await importRuntime<any>('@deepseek-ai/cordis-plugin-loader')
const app = await importRuntime<any>('@deepseek-ai/dsh-app-boot')

/** 写一份「这一轮到底发生了什么」的报告：失败时父进程用它区分「夹具崩了」和「测试脚本崩了」。 */
function report(payload: Record<string, unknown>): void {
  try {
    writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...payload }, null, 2), 'utf8')
  } catch {
    /* best effort：报告写不出来时父进程会按「无证据」判 FAIL */
  }
}

/** entry 状态快照（2=ACTIVE，3=FAILED；import 失败时 fiber 不存在 ⇒ null）。 */
function entryStates(ctx: AnyCtx): Array<Record<string, unknown>> {
  try {
    return [...ctx.loader.entries()].map((entry: AnyCtx) => ({
      id: entry.options?.id,
      name: entry.options?.name,
      state: entry.fiber?.state ?? null,
    }))
  } catch {
    return []
  }
}

/** 守护的 boot 是 fire-and-forget，必须等它把 bootMarker 写成**本进程**的 pid 再注入坏插件。 */
async function waitForGuardBoot(): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const partition = findSinglePartition()
    if (partition !== null) {
      try {
        const state = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8')) as AnyCtx
        if (state.bootMarker?.pid === process.pid) return true
      } catch {
        /* 文件可能正在写，重试 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** 沙箱里只有一张分区表（单工作区），直接找那一个目录，避免在子进程复刻分区键公式。 */
function findSinglePartition(): string | null {
  try {
    const projects = join(profileDir, '.recency-guard', 'projects')
    const dirs = readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory())
    return dirs.length === 1 ? join(projects, dirs[0]!.name) : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const ctx = new Context() as AnyCtx
  ctx.baseUrl = pathToFileURL(profileDir).href + '/'

  // 真实宿主在 boot 之前装这条兜底：未捕获异常/拒绝是 fatal，不是可忽略的噪声。
  app.installFailLoud('dsh-fi')

  await ctx.plugin(Loader)
  // 宿主服务的最小真实面：守护用 inject 声明了这三项，缺席会让整条 fiber 永不激活。
  ctx.provide('profileContext', { dir: profileDir, cwd: workspace, name: 'fi-fault-injection' })
  ctx.provide('tools', { register: () => () => undefined })
  ctx.provide('pluginManager', {
    listBundles: async () => [],
    listPlugins: async () => [],
    setBundleEnabled: async () => ({ application: 'applied' }),
    setPluginEnabled: async () => ({ application: 'applied' }),
  })

  // 1) 守护先进树：它的 apply 是同步写启动记录的，坏插件随后才加载 —— 顺序不能反。
  await ctx.loader.create({ id: 'recency-guard', name: guardSpec })
  await ctx.get('loader')?.await()
  const booted = await waitForGuardBoot()
  if (!booted) {
    report({ phase: 'guard-not-booted', entries: entryStates(ctx) })
    // 必须用 0 退出：守护已经装了进程级 exit 哨兵，非零退出会被记成「一次崩溃」，
    // 于是测试脚本自己的失败会伪装成注入成功（假阳性）。不可评估由父进程按
    // report.phase 判 FAIL。
    process.exit(0)
  }
  writeFileSync(readyFile, String(process.pid), 'utf8')

  // 2) 注入坏插件：走 Loader 的真实 entry 路径（模块 import 也在这里发生）。
  await ctx.loader.create({ id: entryId, name: badSpec })
  await ctx.get('loader')?.await()

  if (mode === 'kill') {
    // 已经完成一次正常启动且插件真的挂上了：先写下 armed 信号，父进程随后 SIGKILL。
    // 没有这个信号父进程会抢跑（在 entry 挂载前就杀，注入等于没发生）。
    writeFileSync(armedFile, String(process.pid), 'utf8')
    report({ phase: 'ready-for-kill', entries: entryStates(ctx) })
    setInterval(() => undefined, 1 << 30)
    return
  }

  // 3) 真实启动策略判决：required entry 失败 ⇒ 抛 StartupError。
  try {
    await app.auditStartupEntries(ctx, 'dsh-fi', (line: string) => process.stderr.write(line))
  } catch (error) {
    report({ phase: 'audit-threw', error: String((error as Error)?.message ?? error).slice(0, 400), entries: entryStates(ctx) })
    // 不接住：变成 unhandledRejection，由 installFailLoud 走真实致命路径（exit 1）。
    throw error
  }

  if (mode === 'clean') {
    report({ phase: 'survived', entries: entryStates(ctx) })
    // 真实宿主干净退出会 dispose 全部 fiber：守护的 disposer 因此清掉 bootMarker。
    await ctx.fiber.dispose()
    process.exit(0)
  }

  // fatal 但进程还活着：可能是异步错误尚未触发，也可能这个形态根本没构成崩溃。
  // 后者是关键发现，必须报出来而不是静默当成「已注入」。
  await new Promise((resolve) => setTimeout(resolve, 1500))
  report({ phase: 'still-alive', note: '注入的失败形态没有让进程退出（未构成崩溃）', entries: entryStates(ctx) })
  // 同上：非零退出会触发守护哨兵，必须用 0 退出（父进程按 phase 判 FAIL）。
  process.exit(0)
}

// 顶层不 await：让 StartupError 以未处理拒绝的形式到达 installFailLoud（真实路径）。
void main()
