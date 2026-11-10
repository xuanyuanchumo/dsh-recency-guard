/**
 * 检测轮子进程：崩溃之后的新一次启动。
 *
 * 为什么必须**换一个进程**做检测：
 * 1. 哨兵通道判定的是「上一轮怎么死的」，同一进程里没有「上一轮」；
 * 2. 异常终止通道的判据是 `残留 pid ≠ 本进程 && pid 已死`，本进程 pid 必然
 *    等于残留标记（那会被误归成 self-reload —— 真实的假归因陷阱）；
 * 3. 模块缓存与已装的进程级 exit 监听器都会污染同一进程内的第二次启动。
 *
 * 这里只做一件事：让守护走完一次真实的 `bootInner()`（读哨兵 → 判定 → 写 journal
 * / state / decision），然后干净退出。取证由父进程读产物完成 —— 断言不依赖
 * 子进程「自报通过」。
 */
import { pathToFileURL } from 'node:url'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importRuntime } from '../host/runtime.ts'

type AnyCtx = Record<string, any>

const profileDir = process.env.FI_PROFILE ?? ''
const workspace = process.env.FI_WORKSPACE ?? ''
const guardSpec = process.env.FI_GUARD_SPEC ?? ''
const doneFile = process.env.FI_DETECT_DONE ?? ''

const { Context } = await importRuntime<any>('@deepseek-ai/cordis')
const { Loader } = await importRuntime<any>('@deepseek-ai/cordis-plugin-loader')
const app = await importRuntime<any>('@deepseek-ai/dsh-app-boot')

function findSinglePartition(): string | null {
  try {
    const projects = join(profileDir, '.recency-guard', 'projects')
    const dirs = readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory())
    return dirs.length === 1 ? join(projects, dirs[0]!.name) : null
  } catch {
    return null
  }
}

/** 读 journal 行数（用于判断 boot 是否还在写事实）。 */
function journalLines(): number {
  const partition = findSinglePartition()
  if (partition === null) return 0
  try {
    return readFileSync(join(partition, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').length
  } catch {
    return 0
  }
}

/**
 * 等这一轮 boot 真正落盘并**结算完**。
 *
 * 两个条件缺一不可：
 * 1. `bootMarker.pid === 本进程` —— bootInner 先把 marker 写进 state 才做恢复判定；
 * 2. journal 行数稳定 —— 否则检测侧会在 updateState 之后、`applyAbnormalRecovery`
 *    之前抢跑 dispose（实测：异常终止通道的 lastRecoveryVerdict 永远是 undefined，
 *    因为进程在恢复判定之前就退出了）。
 *
 * 不用固定 sleep：慢机器会假红，快机器会抢跑。
 */
async function waitForThisBoot(): Promise<boolean> {
  const deadline = Date.now() + 15_000
  let markerSeen = false
  while (Date.now() < deadline) {
    if (!markerSeen) {
      const partition = findSinglePartition()
      if (partition !== null) {
        try {
          const state = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8')) as AnyCtx
          markerSeen = state.bootMarker?.pid === process.pid
        } catch {
          /* 写盘进行中，重试 */
        }
      }
    }
    if (markerSeen) {
      // 连续两次相隔 400ms 行数不变 ⇒ 本轮该写的崩溃事实已经写完了。
      const before = journalLines()
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (journalLines() === before) return true
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** 本轮开始前 state 里的 bootMarker（失败时用它回滚，避免失败的重试自己制造「残留标记」）。 */
function readPreviousMarker(): unknown {
  const partition = findSinglePartition()
  if (partition === null) return null
  try {
    const state = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8')) as AnyCtx
    return state.bootMarker ?? null
  } catch {
    return null
  }
}

/**
 * 把 bootMarker 恢复成上一轮的真实值。
 *
 * 为什么需要：本轮 boot 如果没跑完（例如崩溃遗留的失效锁让 updateState 超时），
 * 它可能已经把自己的 pid 写进 marker 后死掉。这个残留标记会让下一次重试把
 * 本进程（已退出）判成 abnormal —— 测试脚本自己的失败就变成了「注入成功」。
 */
function restorePreviousMarker(previous: unknown): void {
  const partition = findSinglePartition()
  if (partition === null) return
  try {
    const state = JSON.parse(readFileSync(join(partition, 'state.json'), 'utf8')) as AnyCtx
    state.bootMarker = previous ?? null
    writeFileSync(join(partition, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* 没有 state 可回滚（本轮完全没落盘）⇒ 无需处理 */
  }
}

async function main(): Promise<void> {
  const previousMarker = readPreviousMarker()
  const ctx = new Context() as AnyCtx
  ctx.baseUrl = pathToFileURL(profileDir).href + '/'
  app.installFailLoud('dsh-fi-detect')
  await ctx.plugin(Loader)
  ctx.provide('profileContext', { dir: profileDir, cwd: workspace, name: 'fi-fault-injection' })
  ctx.provide('tools', { register: () => () => undefined })
  ctx.provide('pluginManager', {
    listBundles: async () => [],
    listPlugins: async () => [],
    setBundleEnabled: async () => ({ application: 'applied' }),
    setPluginEnabled: async () => ({ application: 'applied' }),
  })
  await ctx.loader.create({ id: 'recency-guard', name: guardSpec })
  await ctx.get('loader')?.await()
  if (!(await waitForThisBoot())) {
    restorePreviousMarker(previousMarker)
    writeFileSync(doneFile, 'boot-not-observed', 'utf8')
    // 必须 0 退出：非零会触发守护哨兵，把「检测轮自己没跑完」记成一次崩溃。
    process.exit(0)
  }
  // 干净退出：让守护的 disposer 清掉 bootMarker（反向用例据此断言「干净关闭」）。
  await ctx.fiber.dispose()
  writeFileSync(doneFile, String(process.pid), 'utf8')
  process.exit(0)
}

void main()