import { existsSync, readFileSync as readTextFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { JournalRecord } from './store.ts'

/**
 * journal 的文本层（T15-02，从 `store.ts` 纯提取）。
 *
 * ## 为什么单独成文件
 *
 * 这一层只做「行 ↔ 文本 ↔ 裁剪」的形态转换与一个**可注入读**的裁剪动作，
 * 与 Store 的状态管理无关。抽出来后 `store.ts` 只保留委托，复杂度预算
 * （按文件计分）也从 103 降回预算内。
 *
 * ## 裁剪为什么需要可注入读（未归因清零的那条）
 *
 * `trimJournalIfNeeded` 的 catch 是「IO 失败兜底」：只要 `readFile` 抛，
 * 整个裁剪静默放弃、journal 原样保留。生产实现用真实 fs；如果测试只能
 * 真去写坏磁盘才能覆盖这条分支，那测的就是环境不是契约。这里把
 * `readText` 作为参数传入 —— **默认调用方传真实 fs，行为逐位不变**。
 */

/** journal 行数上限（超过后把活动文件轮转走）。由 `store.ts` 再导出保持兼容。 */
export const JOURNAL_MAX_LINES = 1000

/** 活动日志文件名（轮转前的写入目标）。 */
export const JOURNAL_ACTIVE_NAME = 'journal.jsonl'

/** 轮转文件前缀：`journal.<epoch>.jsonl`（epoch = 轮转时刻的 unix 毫秒）。 */
const ROTATED_PREFIX = 'journal.'
const ROTATED_SUFFIX = '.jsonl'

/** 切分 journal 行（丢掉空行）。 */
export function journalLines(raw: string): string[] {
  return raw ? raw.split('\n').filter(Boolean) : []
}

/** 序列化 journal：先封顶（保留最后 JOURNAL_MAX_LINES 行）再拼回。 */
export function serializeJournal(lines: readonly string[]): string {
  return `${lines.slice(-JOURNAL_MAX_LINES).join('\n')}\n`
}

/**
 * 解析 journal 行，容忍崩溃时写坏的尾部半行。
 *
 * 为什么要容忍而不是报错：崩溃路径上的写可能被进程死亡截断，让一行残缺的
 * JSON 使整份 journal 不可读，等于把守护者自己的证据链也弄丢了。
 * `limit <= 0` 返回空数组（「读 0 行」就是一行都不读；旧实现里
 * `slice(-0)` 会返回全部行，是个静默的语义反转）。
 */
export function parseJournalLines(raw: string, limit: number): JournalRecord[] {
  const lines = journalLines(raw)
  const take = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), lines.length) : 0
  const out: JournalRecord[] = []
  for (const line of lines.slice(lines.length - take)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip a torn tail line from a crash mid-write */
    }
  }
  return out
}

/** 列出分区目录里的轮转文件（按 epoch 升序 = 时间从旧到新）。 */
export function rotatedJournalPaths(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const epochs: Array<{ epoch: number; name: string }> = []
  for (const name of names) {
    if (!name.startsWith(ROTATED_PREFIX) || !name.endsWith(ROTATED_SUFFIX)) continue
    const middle = name.slice(ROTATED_PREFIX.length, name.length - ROTATED_SUFFIX.length)
    const epoch = Number(middle)
    if (!Number.isFinite(epoch) || middle === '') continue
    epochs.push({ epoch, name })
  }
  return epochs.sort((a, b) => a.epoch - b.epoch).map((e) => join(dir, e.name))
}

/** 活动日志的绝对路径。 */
export function activeJournalPath(dir: string): string {
  return join(dir, JOURNAL_ACTIVE_NAME)
}

/**
 * 超过行数上限时**轮转**（v0.18，TD-5 结构根治：删掉读改写窗口）。
 *
 * ## 为什么从「裁剪」改成「轮转」
 *
 * 旧裁剪是「锁内读最新 → 原子写回」——这个读改写窗口本身仍可能吞掉恰好
 * 落在窗口里的一次崩溃同步追加（TD-5 残余，书面登记过）。修锁不可行
 * （崩溃路径只有同步 IO 能完成，无法参与 async 锁），真正的根治是**让
 * 那个窗口不存在**：
 *
 * 1. 锁内 `renameSync(活动文件 → journal.<epoch>.jsonl)` —— rename 是
 *    元数据操作，**不读也不写文件内容**，因此没有任何「读到的快照变旧」
 *    的窗口；rename 之后到达的追加自然落到新活动文件（`appendFile` 对
 *    不存在的文件会创建）。
 * 2. 不删除任何行：轮转文件保留在分区目录里，读取端按 epoch 升序合并。
 *    磁盘占用由「轮转文件数上限」控制：超过 `MAX_ROTATED_FILES` 时删除
 *    **最旧**的轮转文件（同样只是 unlink 元数据操作，无读改写）。
 *
 * ## 崩溃路径为什么完全不动
 *
 * `appendSync` 仍是「对活动文件纯追加」。它可能与 rename 并发交错：
 * - 追加在 rename 前 ⇒ 那行随活动文件一起被轮走，仍可读（只是住进了
 *   轮转文件）；
 * - 追加在 rename 后 ⇒ 那行落进新活动文件，按序合并时仍在最新段。
 *   **任何交错都不丢行** —— 这正是测试要钉住的不变式。
 *
 * 失败语义：**不抛、不轮转**。rename 失败或锁超时都只是「这次没轮转」，
 * 活动文件继续增长 —— 与旧裁剪同级的 best-effort，但不再有丢行可能。
 */
export async function trimJournalFile(
  dir: string,
  readText: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<void> {
  const journalPath = activeJournalPath(dir)
  try {
    if (!existsSync(journalPath)) return
    if (journalLines(await readText(journalPath)).length <= JOURNAL_MAX_LINES) return
    await withFileLock(
      journalPath,
      async () => {
        // 锁内重读：锁外那份可能已被别的进程追加过，仍超限才轮转。
        const latest = journalLines(await readText(journalPath))
        if (latest.length <= JOURNAL_MAX_LINES) return
        // 结构根治：rename（无内容读写）而不是 writeFileAtomic（读改写）。
        // Windows 上 rename 到已存在目标会失败 ⇒ 用毫秒 epoch + 计数兜底，
        // 两个 epoch 撞名（同毫秒两次轮转）时递增找空位。
        let epoch = Date.now()
        let target = join(dir, `${ROTATED_PREFIX}${epoch}${ROTATED_SUFFIX}`)
        while (existsSync(target)) {
          epoch += 1
          target = join(dir, `${ROTATED_PREFIX}${epoch}${ROTATED_SUFFIX}`)
        }
        renameSync(journalPath, target)
        enforceRotatedLimit(dir)
      },
      { waitMs: 3000 },
    )
  } catch {
    /* best effort：轮转失败只影响文件大小，不影响证据完整性 */
  }
}

/** 轮转文件保留上限：超过时删最旧（unlink 是元数据操作，无读改写窗口）。 */
const MAX_ROTATED_FILES = 3

/** 只在轮转成功后调用：把轮转文件数压回上限。 */
function enforceRotatedLimit(dir: string): void {
  const rotated = rotatedJournalPaths(dir)
  const excess = rotated.length - MAX_ROTATED_FILES
  for (let i = 0; i < excess; i += 1) {
    try {
      unlinkSync(rotated[i])
    } catch {
      /* 删不掉就留着：多占一点磁盘好过丢证据 */
    }
  }
}

/**
 * 合并读取：轮转文件（epoch 升序）+ 活动文件，构成完整时间线。
 *
 * 跨文件取最后 `limit` 条：先按序拼出全部行再统一截尾，保证「limit 条」
 * 的语义与单文件时代一致（最近的 N 条，而不是每个文件各 N 条）。
 * 单文件不存在的场景（全新分区）自然返回空。
 */
export async function readMergedJournal(dir: string, limit: number): Promise<JournalRecord[]> {
  const files = [...rotatedJournalPaths(dir), activeJournalPath(dir)]
  const existing = files.filter((f) => existsSync(f))
  if (existing.length === 0) return []
  const parts: string[] = []
  for (const file of existing) {
    try {
      parts.push(await readFile(file, 'utf8'))
    } catch {
      /* 一个文件读失败不拖垮其余：跳过，证据链少一段好过全空 */
    }
  }
  return parseJournalLines(parts.join('\n'), limit)
}

/**
 * 同步版合并读取（崩溃路径/守卫流程同风格）。
 * 顶部 `readTextFileSync` 与 readMergedJournal 的 await readFile 同语义。
 */
export function readMergedJournalSync(dir: string, limit: number): JournalRecord[] {
  const files = [...rotatedJournalPaths(dir), activeJournalPath(dir)]
  const existing = files.filter((f) => existsSync(f))
  if (existing.length === 0) return []
  const parts: string[] = []
  for (const file of existing) {
    try {
      parts.push(readTextFileSync(file, 'utf8'))
    } catch {
      /* 同上：一段缺失好过全空 */
    }
  }
  return parseJournalLines(parts.join('\n'), limit)
}