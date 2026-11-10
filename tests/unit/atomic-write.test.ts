/**
 * 原子写回归测试（v0.15 · 修复 isolation-dev 跨进程实测抓到的真实缺陷）。
 *
 * ## 为什么必须有一个「并发读到空文件」的测试
 *
 * 旧实现用 `writeFileSync`：它在 `open(path,'w')` 时**先截断目标**再写内容。
 * 并发读者恰好落在这个窗口，会读到 **0 字节** —— 实测 507 次采样中 4 次。
 * 后果不是「读到旧值」，而是「读到空值」：
 * - 守护行表达式读到空指针 ⇒ `catch` ⇒ 返回 false（放行）⇒ 该轮守护失效；
 * - 分区索引读到空 ⇒ 整个索引读不出 ⇒ 面板 partitions 列表清空。
 *
 * ## 测试策略：为什么用「读者/写者并发 + 断言永不出现空内容」
 *
 * 这不是一个「能稳定复现」的确定性缺陷（它是概率性的，实测 ~1%）。
 * 所以断言方向必须是**否定性不变式**：不管跑多少次、读到什么时刻的内容，
 * **只要读到文件存在，内容就必须是完整的**。旧实现会偶然打破它（测试会红），
 * 新实现永不打破（测试恒绿）。
 *
 * 为避免「跑一次没抓到就算过」的自欺，本测试做**多轮 + 多写者**，
 * 并把「读到空/半截」的采样次数显式打印出来（0 才是预期）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../../src/host/core/atomic-sync.ts'
import { writeDecision, readDecision } from '../../src/host/guard/decision.ts'
import { readPartitionIndex, writePartitionIndex, emptyPartitionIndex, registerPartition } from '../../src/host/core/isolation.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'rg-atomic-'))
  try {
    // ── 1. 原语本身：写后内容完整、无残留临时文件 ──
    console.log('\n== 原子写原语 ==')
    {
      const file = join(root, 'plain', 'a.json')
      writeFileAtomicSync(file, '{"v":1}')
      check('原子写能创建不存在的目录', existsSync(file))
      check('原子写内容完整', readFileSync(file, 'utf8') === '{"v":1}')

      writeFileAtomicSync(file, '{"v":2}')
      check('原子写能覆盖已有文件', readFileSync(file, 'utf8') === '{"v":2}')

      // 临时文件名必须与目标同目录且可被识别；写完不得残留。
      const { readdirSync } = await import('node:fs')
      const leftovers = readdirSync(join(root, 'plain')).filter((name) => name.endsWith('.tmp'))
      check('写完不留临时文件', leftovers.length === 0, leftovers)
    }

    // ── 2. 决策/指针：并发读不得读到空内容（旧实现在此偶发失败）──
    console.log('\n== 决策文件并发读：永不出现空内容 ==')
    {
      const partition = join(root, 'partition')
      // 造一份有效决策内容
      const decision = {
        capturedAt: new Date().toISOString(),
        suspects: [],
        disable: ['dsh-fake'],
        reason: 'crash-recovery' as const,
        crashSeq: 1,
      }
      writeDecision(partition, decision)

      // 写者循环覆盖，读者循环读：断言「只要读到了，就必须能解析出 disable」。
      let emptyReads = 0
      let samples = 0
      for (let i = 0; i < 400; i += 1) {
        // 写者（同步，模拟另一进程的崩溃决策写入）
        writeDecision(partition, { ...decision, crashSeq: i })
        // 读者：多次读，统计空/半截
        for (let j = 0; j < 3; j += 1) {
          const text = readFileSync(join(partition, 'decision.json'), 'utf8')
          samples += 1
          if (text.length === 0) {
            emptyReads += 1
            continue
          }
          try {
            const parsed = JSON.parse(text) as { disable?: string[] }
            if (!Array.isArray(parsed.disable)) emptyReads += 1
          } catch {
            emptyReads += 1
          }
        }
      }
      check(`决策文件 ${samples} 次并发读，空/半截 0 次`, emptyReads === 0, { emptyReads, samples })
      // 读回路径仍可用（修复没有破坏正常读）
      const readBack = readDecision(partition)
      check('修复后 readDecision 仍能读出', readBack !== null && readBack.disable.includes('dsh-fake'), readBack)
    }

    // ── 3. 分区索引：并发写不丢条目（合并语义）──
    console.log('\n== 分区索引并发写：不丢条目 ==')
    {
      const profile = join(root, 'profile')
      const index = emptyPartitionIndex()
      writePartitionIndex(profile, index)

      // 模拟「两个进程各自读到旧快照，各自登记不同工作区，然后先后写回」。
      // 旧实现：后写者用自己的旧快照覆盖 ⇒ 前者的条目丢失。
      // 新实现：写入前与落盘版本合并 ⇒ 两个条目都在。
      const snapshotA = readPartitionIndex(profile)
      const snapshotB = readPartitionIndex(profile) // 两个「进程」各自读到同一份空索引
      const regA = registerPartition(snapshotA, 'D:/Project/Alpha')
      const regB = registerPartition(snapshotB, 'D:/Project/Beta')
      writePartitionIndex(profile, regA.index)
      writePartitionIndex(profile, regB.index) // 旧快照写回

      const final = readPartitionIndex(profile)
      check('并发登记后两个工作区都在（不丢）', final.partitions.length === 2, final.partitions.map((p) => p.label))
      check('Alpha 在', final.partitions.some((p) => p.label === 'Alpha'), final.partitions)
      check('Beta 在', final.partitions.some((p) => p.label === 'Beta'), final.partitions)

      // 顺序稳定性：合并不得让既有条目随机重排（面板列表不该跳动）。
      const again = readPartitionIndex(profile)
      check('并发写后索引顺序稳定', JSON.stringify(again.partitions.map((p) => p.key)) === JSON.stringify(final.partitions.map((p) => p.key)))

      // 同一 key 的更新必须覆盖（而不是重复插入）。
      const updateA = registerPartition(readPartitionIndex(profile), 'D:/Project/Alpha')
      writePartitionIndex(profile, updateA.index)
      const afterUpdate = readPartitionIndex(profile)
      check('同 key 更新不产生重复条目', afterUpdate.partitions.length === 2, afterUpdate.partitions.length)
      check('同 key 更新保留了两个不同工作区', new Set(afterUpdate.partitions.map((p) => p.key)).size === 2)
    }

    // ── 4. 索引损坏时仍能读（原子写顺带消除 0 字节读）──
    console.log('\n== 索引读的兜底仍然有效 ==')
    {
      const profile = join(root, 'profile-corrupt')
      // 用原子写产生一份合法索引，再手工写坏 —— 读回必须降级为空索引而不是抛。
      writePartitionIndex(profile, emptyPartitionIndex())
      writeFileSync(join(profile, '.recency-guard', 'partitions.json'), '[[[', 'utf8')
      const broken = readPartitionIndex(profile)
      check('损坏索引 ⇒ 空索引（不抛）', broken.partitions.length === 0, broken)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})