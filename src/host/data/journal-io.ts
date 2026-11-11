import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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

/** journal 行数上限（超过后丢弃最旧的行）。由 `store.ts` 再导出保持兼容。 */
export const JOURNAL_MAX_LINES = 1000

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

/**
 * 超过行数上限时裁剪（幂等、加锁、best-effort）。
 *
 * 为什么不在崩溃路径做：崩溃路径只有同步工作能完成，而裁剪要读全文件再
 * 原子替换。崩溃路径因此改用纯追加，把上限交给这里。
 *
 * 失败语义：**不抛、不截断**。读失败或锁超时都只是「这次没裁」，journal
 * 内容一行不少 —— 这正是「best effort」与「静默丢证据」的分界。
 */
export async function trimJournalFile(
  journalPath: string,
  readText: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<void> {
  try {
    if (!existsSync(journalPath)) return
    if (journalLines(await readText(journalPath)).length <= JOURNAL_MAX_LINES) return
    await withFileLock(
      journalPath,
      async () => {
        // 锁内重读：锁外那份可能已被别的进程追加过，按最新内容裁剪。
        const latest = journalLines(await readText(journalPath))
        if (latest.length <= JOURNAL_MAX_LINES) return
        await writeFileAtomic(journalPath, serializeJournal(latest), { mode: 0o644 })
      },
      { waitMs: 3000 },
    )
  } catch {
    /* best effort：裁剪失败只影响文件大小，不影响证据完整性 */
  }
}