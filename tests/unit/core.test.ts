import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, emptyState, type GuardState, type JournalEvent, type JournalRecord } from '../../src/host/data/store.ts'
// cycle-14：cleanStaleLocks 从 store.ts 抽到 lock-hygiene.ts（纯提取）。直接引
// **抽出后的模块**，否则变异工具的归属判据（直接 import）会把这个新文件
// 判成「无直接测试」⇒ 它的变异体根本不进评估集合（v0.13 的漏判教训）。
import { cleanStaleLocks } from '../../src/host/data/lock-hygiene.ts'
import { displayDigits, sampleConfidence } from '../../src/host/core/metric.ts'
import { restoreDisabledExceptPrime, reenableOne, type RecoveryDeps } from '../../src/host/guard/recovery-actions.ts'
import { pidAlive, clearSentinel, sentinelPath } from '../../src/host/guard/sentinel.ts'
import { appendPatchText, findGuardableRows } from '../../src/host/guard/guarded-rows.ts'
import {
  suspectBundles,
  rankByRecency,
  pickSuspects,
  diffVersions,
} from '../../src/host/risk/recency.ts'
import { CapabilityGraph, declaredExposedNames } from '../../src/host/capability/capability.ts'
import { buildCapabilityGraph, verifyCapabilityContract, CAPABILITY_SPECS } from '../../src/host/capability/capability-specs.ts'
import { StageMachine, canTransition, riskScore, crashTrend, ALL_STAGES } from '../../src/host/core/lifecycle.ts'
import {
  crashRate,
  meanRecoveryTime,
  detectionRate,
  isolationPurity,
  rankRisks,
  ewma,
  median,
  crashIntervalStats,
  cusumChangePoint,
  computeMetrics,
  crashPressure,
} from '../../src/host/observe/observability.ts'
import { renderOutcome, formatStatus, formatArchive, formatArchives } from '../../src/host/surface/tool-render.ts'
import {
  normalizeWorkspace,
  projectKey,
  projectLabel,
  registerPartition,
  findPartition,
  writePartitionIndex,
  emptyPartitionIndex,
} from '../../src/host/core/isolation.ts'
import { archiveAndReset, listArchives, readArchiveManifest } from '../../src/host/data/archive.ts'
import { buildGraphData, connectedComponents, computeBounds, buildAdjacency } from '../../src/host/capability/graph-data.ts'
// cycle-14（E4.1 归因）：下面这些导入不是「顺带多引几个函数」——
// 它们让 core.test.ts 成为这些模块的**直接测试**，因此其变异体会真正进
// 被评估的集合（变异工具的归属判据是「直接 import」）。此前
// atomic-sync / patch / decision / risk-bayes 的 try-catch 变异体因为
// 「无直接测试」根本没人跑它们的故障路径，存活体只能靠猜归因。
import { writeFileAtomicSync } from '../../src/host/core/atomic-sync.ts'
import { writeDecision } from '../../src/host/guard/decision.ts'
import { ensurePatchBackup } from '../../src/host/profile/patch.ts'
import { logBeta } from '../../src/host/risk/risk-bayes.ts'
import { falsePositiveSamples } from '../../src/host/risk/risk-calibration.ts'
import { codePointWidth, clipWidth, displayWidth, padWidth, sanitizeText, wrapWidth } from '../../src/host/surface/tool-text.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

async function main() {
  // ═══ cycle-14 / E4.1：故障注入断言（杀死 try-catch 类存活变异体）═══
  //
  // 为什么原子写这组必须放在 main() 的**最前面**：临时文件名里带本进程内
  // 的调用序号（`${path}.${pid}.${sequence}.tmp`）。要构造「清理步骤自己
  // 失败」的故障，就得把临时文件的**确切路径**预置成一个非空目录；序号
  // 只有从 1 开始才可预测，因此本进程此前不得发生任何原子写调用。
  //
  // 这些断言杀的是「删除 try/catch 兜底」这一类变异体：删掉兜底后，
  // 失败路径会变成不可恢复的异常（或错误原因被替换），断言随即变红。
  console.log('\n== 原子写：失败路径清理 / 主错误不被清理错误覆盖 ==')
  {
    const root = await mkdtemp(join(tmpdir(), 'rg-atomic-'))
    try {
      // (1) rename 的落点是**已存在的目录** ⇒ rename 必然失败。
      //     失败路径必须删掉临时文件：`.tmp` 残留在 profile 里会被当成用户资产。
      const blocked = join(root, 'blocked-target')
      mkdirSync(blocked)
      let renameError: unknown
      try {
        writeFileAtomicSync(blocked, '{"v":1}')
      } catch (error) {
        renameError = error
      }
      check('原子写 rename 失败会抛出（不静默吞掉）', renameError instanceof Error, renameError)
      check(
        '.tmp 临时文件在失败路径被清理（不留残留）',
        readdirSync(root).every((name) => !name.endsWith('.tmp')),
        readdirSync(root),
      )

      // (2) 清理步骤自己失败时，调用方必须拿到**原始写错误**：
      //     把「写盘失败」换成「清理失败」会让真正的故障原因丢失
      //     （模块头注释：抛出原始原因更有诊断价值）。
      //     本进程此前只调用过一次原子写 ⇒ 这次临时名确定为 `...2.tmp`。
      const blocked2 = join(root, 'blocked-target-2')
      mkdirSync(blocked2)
      const temp2 = `${blocked2}.${process.pid}.2.tmp`
      mkdirSync(temp2)
      writeFileSync(join(temp2, 'inside'), 'x', 'utf8')
      let cleanupError: unknown
      try {
        writeFileAtomicSync(blocked2, 'x')
      } catch (error) {
        cleanupError = error
      }
      check(
        '清理失败时抛出的是原始写错误（EISDIR），不是清理错误（ERR_FS_EISDIR）',
        (cleanupError as { code?: string } | undefined)?.code === 'EISDIR',
        (cleanupError as { code?: string } | undefined)?.code,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // 分区索引写失败只降级：索引丢失只损失「面板能列出哪些工作区」，
  // 绝不能让启动路径挂掉（观测设施不拖垮守护流程）。把 `.recency-guard`
  // 先占成一个文件 ⇒ 原子写的目标目录不可用。
  console.log('\n== 分区索引：写失败只降级 ==')
  {
    const root = await mkdtemp(join(tmpdir(), 'rg-partidx-'))
    try {
      const profileDir = join(root, 'profile')
      mkdirSync(profileDir)
      writeFileSync(join(profileDir, '.recency-guard'), 'not-a-directory', 'utf8')
      let threw: unknown
      try {
        writePartitionIndex(profileDir, emptyPartitionIndex())
      } catch (error) {
        threw = error
      }
      check('分区索引写失败不抛出（只降级）', threw === undefined, threw)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // 归档一个**没有产物**的分区：state.json / journal.jsonl 缺失是正常形态
  // （空守护 / 从没写过日志），归档必须成功。删除对应 try 兜底后这里会抛
  // ENOENT —— 归档是重置入口，抛错等于「以最新事实重新开始」直接不可用。
  console.log('\n== 归档：缺失产物不得让归档失败 ==')
  {
    const root = await mkdtemp(join(tmpdir(), 'rg-archive-bare-'))
    try {
      const bare = join(root, 'bare-partition')
      mkdirSync(bare)
      const archived = archiveAndReset(bare, 'D:/Bare', '缺产物归档')
      check('没有 state.json 也能归档（crashSeq 记 0）', archived.manifest.summary.crashSeq === 0, archived.manifest.summary)
      check('没有 journal.jsonl 也能归档（事件数记 0）', archived.manifest.summary.journalEvents === 0, archived.manifest.summary)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // 锁清理对不存在的目录返回空报告，而不是抛 ENOENT：
  // Store.init 依赖它做 best-effort 清理（目录可能被手工删掉）。
  console.log('\n== 锁清理：目录不存在返回空报告 ==')
  {
    const root = await mkdtemp(join(tmpdir(), 'rg-locks-'))
    try {
      let report: ReturnType<typeof cleanStaleLocks> | undefined
      try {
        report = cleanStaleLocks(join(root, 'missing-dir'))
      } catch {
        report = undefined
      }
      check(
        '目录不存在时返回空报告（不抛）',
        report !== undefined && report.removed.length === 0 && report.kept.length === 0,
        report,
      )

      // 内容为 "0" 的锁：`pid <= 0` 判成「不完整记录」必须**清掉**。
      // 为什么这条单独写：`process.kill(0, 0)` 实测返回成功（Windows/POSIX
      // 都把 pid 0 解释成「当前进程组」）—— 若把 `<= 0` 改成 `< 0`，
      // pid=0 会被判成「活进程持有」而保留，atomic-write 随后等满超时
      // ⇒ 宿主 fatal load failure。这不是等价变异，**行为不同**：
      // 0 字节/非 PID 锁的清理是本模块存在的理由（v0.11.1 紧急修复）。
      const lockName = 'state.json.lock'
      const lockPath = join(root, lockName)
      writeFileSync(lockPath, '0', 'utf8')
      const old = new Date(Date.now() - 60_000)
      utimesSync(lockPath, old, old)
      const zeroReport = cleanStaleLocks(root)
      check(
        '内容为 "0" 的锁必须被清理（pid 0 不是有效持锁者）',
        zeroReport.removed.includes(lockName) && !zeroReport.kept.includes(lockName),
        zeroReport,
      )

      // 死进程 pid 的锁同样必须清理：`processAlive` 的 try/catch 把 ESRCH
      // 翻译成 false。删除该兜底后 process.kill 的异常会冒到外层逐条 catch，
      // 锁被误判成「保留」⇒ atomic-write 仍要等满超时。
      writeFileSync(lockPath, '2147483647', 'utf8')
      utimesSync(lockPath, old, old)
      const deadPidReport = cleanStaleLocks(root)
      check(
        '死进程 pid 的锁必须被清理（探活失败 ≠ 持锁）',
        deadPidReport.removed.includes(lockName) && !deadPidReport.kept.includes(lockName),
        deadPidReport,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // 决策写失败只降级，并在**外层 try 被删除**时仍不冒泡：
  // 这条断言钉住的正是「内层 writeSafe 自带兜底」这个等价性承重事实。
  console.log('\n== 决策/哨兵/备份：best-effort 失败不得冒泡 ==')
  {
    const root = await mkdtemp(join(tmpdir(), 'rg-besteffort-'))
    try {
      const fileAsPartition = join(root, 'partition-is-a-file.json')
      writeFileSync(fileAsPartition, 'x', 'utf8')
      let decisionThrew: unknown
      try {
        writeDecision(fileAsPartition, { capturedAt: 't', suspects: [], disable: [], reason: 'none' })
      } catch (error) {
        decisionThrew = error
      }
      check('决策写失败不冒泡（内层 writeSafe 已兜底）', decisionThrew === undefined, decisionThrew)

      // 哨兵清理是 rename → 目标 `.consumed` 已是一个非空目录 ⇒ rename 失败。
      const partition = join(root, 'partition')
      mkdirSync(partition)
      const sentinel = sentinelPath(partition)
      writeFileSync(sentinel, JSON.stringify({ exitCode: 1, at: 't', pid: 1234 }), 'utf8')
      const consumed = `${sentinel}.consumed`
      mkdirSync(consumed)
      writeFileSync(join(consumed, 'occupied'), 'x', 'utf8')
      let sentinelThrew: unknown
      try {
        clearSentinel(partition)
      } catch (error) {
        sentinelThrew = error
      }
      check('哨兵清理失败不冒泡（best effort）', sentinelThrew === undefined, sentinelThrew)

      // 备份写失败不得阻断守护行安装：把备份目录先占成一个文件。
      const patchDir = join(root, 'patch-dir')
      mkdirSync(patchDir)
      const patchFile = join(patchDir, 'cordis.patch.yml')
      writeFileSync(patchFile, '# user asset\n', 'utf8')
      writeFileSync(join(patchDir, '.recency-guard'), 'not-a-directory', 'utf8')
      let backupThrew: unknown
      try {
        ensurePatchBackup(patchFile, '# user asset\n')
      } catch (error) {
        backupThrew = error
      }
      check('备份写失败不冒泡（best effort，不阻断守护行安装）', backupThrew === undefined, backupThrew)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // 损坏的包清单必须被跳过：解析失败把异常冒到 findGuardableRows 的调用方
  // 是**导出 API 的真实行为差异**（安装可以被外层兜住，直接调用不行）。
  console.log('\n== 守护行寻址：损坏的包清单被跳过 ==')
  {
    const root = await mkdtemp(join(tmpdir(), 'rg-guardable-'))
    try {
      const profile = join(root, 'profile')
      const bundleDir = join(profile, 'node_modules', 'dsh-broken')
      mkdirSync(bundleDir, { recursive: true })
      writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-broken': '1.0.0' } }), 'utf8')
      writeFileSync(join(bundleDir, 'package.json'), '{ this is not json', 'utf8')
      let rows: ReturnType<typeof findGuardableRows> | undefined
      let guardableThrew: unknown
      try {
        rows = findGuardableRows(profile)
      } catch (error) {
        guardableThrew = error
      }
      check(
        '损坏的包清单被跳过（返回空行集，不抛）',
        guardableThrew === undefined && Array.isArray(rows) && rows.length === 0,
        { threw: guardableThrew, rows },
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // 非域参数必须返回 NaN（让上层守卫发现），绝不静默给一个有限/无穷值。
  console.log('\n== 贝塔函数：非域参数是 NaN 而不是 Infinity ==')
  {
    check('logBeta(0,1) 是 NaN（lgamma 的非域守卫）', Number.isNaN(logBeta(0, 1)), logBeta(0, 1))
    check('logBeta(1,1) = 0（均匀分布，解析解）', Math.abs(logBeta(1, 1)) < 1e-12, logBeta(1, 1))
  }

  // 恢复单插件：管理器拒绝/抛错必须 warn 后继续，而不是冒泡中断恢复流程。
  // 两条 try 各自独立（组合包与插件行），缺一条就有一条故障打到调用方。
  console.log('\n== 恢复单插件：管理器抛错不阻断其余恢复 ==')
  {
    const warnings: string[] = []
    const deps: RecoveryDeps = {
      store: {
        readState: async () => emptyState(),
        updateState: async (fn: (s: GuardState) => GuardState | Promise<GuardState>) => fn(emptyState()),
        append: async () => {},
        readBackup: async () => null,
      },
      pluginManager: {
        setBundleEnabled: async () => {
          throw new Error('bundle-enable-boom')
        },
        setPluginEnabled: async () => {
          throw new Error('plugin-enable-boom')
        },
      },
      suspectRows: async () => [{ entryId: 'row-1', moduleName: 'dsh-x' }],
      publishDecision: async () => {},
      transition: () => {},
      warn: (message: string) => warnings.push(message),
      toJson: (value: unknown) => value,
    }
    let reenableThrew: unknown
    try {
      await reenableOne(deps, 'dsh-x')
    } catch (error) {
      reenableThrew = error
    }
    check('启用组合包抛错被兜底（warn 而不冒泡）', reenableThrew === undefined, reenableThrew)
    check('组合包抛错写出 warn 日志', warnings.some((w) => w.includes('启用组合包')), warnings)
    check('启用插件行抛错被兜底并写出 warn 日志', warnings.some((w) => w.includes('启用插件')), warnings)
  }

  // 等价性**证明**（proof）—— 这两条不是缺口，是把账本里的等价理由钉成事实。
  // 没有它们，等价登记就只是「读起来像是没影响」（mutation-attribution §1.1
  // 已经因为这种直觉判断推翻过 3 条）。
  console.log('\n== 等价性承重事实（proof）==')
  {
    const root = await mkdtemp(join(tmpdir(), 'rg-equiv-'))
    try {
      const store = new Store(root, 'proof')
      await store.init()
      await store.append([{ kind: 'install', bundle: 'a' }, { kind: 'install', bundle: 'b' }])
      check('readJournal(0) 读 0 行（limit===0 时两分支都给 0，不是「全部」）', (await store.readJournal(0)).length === 0)
      check('readJournal(1) 读 1 行（同一函数上界行为）', (await store.readJournal(1)).length === 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const base: JournalRecord[] = [
      { kind: 'auto-disable', bundle: 'dsh-a', t: 't1' },
      { kind: 'enable', bundle: 'dsh-a', t: 't2' },
    ]
    const withHole = falsePositiveSamples([...base, undefined as unknown as JournalRecord])
    const without = falsePositiveSamples(base)
    check(
      'journal 尾部的 undefined 洞被跳过（统计与没有它逐字段一致）',
      JSON.stringify(withHole) === JSON.stringify(without),
      { withHole, without },
    )
  }

  // ═══ 指标边界 + journal 同步写的 best-effort ═══
  //
  // displayDigits(1) 是**等价账本的承重事实**：`sampleSize < 1` 与 `<= 1`
  // 只在 n=1 分岔，而 n=1 时守卫返回 1、公式 max(1, round(0.5)) 也是 1。
  // 这条断言不区分两个版本 —— 正因如此它才能证明「改法换不掉行为」。
  console.log('\n== 指标边界 + journal 同步写 best-effort ==')
  {
    check('sampleConfidence(0) = 0（n≤0 不可支撑置信度）', sampleConfidence(0) === 0, sampleConfidence(0))
    check('sampleConfidence(1) = 0（单样本 = 零置信）', sampleConfidence(1) === 0, sampleConfidence(1))
    check('displayDigits(1) = 1（n=1 与守卫分支同值）', displayDigits(1) === 1, displayDigits(1))
    const root = await mkdtemp(join(tmpdir(), 'rg-appendsync-'))
    try {
      const store = new Store(root, 'journal-fault')
      await store.init()
      // journal.jsonl 先占成一个**目录** ⇒ appendSync 的 readFileSync 失败。
      // 崩溃证据链的写失败绝不能拖垮宿主启动（模块头契约）。
      mkdirSync(join(store.partitionPath, 'journal.jsonl'))
      let appendThrew: unknown
      try {
        store.appendSync({ kind: 'note', detail: 'fault' })
      } catch (error) {
        appendThrew = error
      }
      check('journal 同步写失败不冒泡（best effort，不拖垮启动）', appendThrew === undefined, appendThrew)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // ═══ 命令窗口显示（R10）：宽度按**视觉列**，中英混排才对齐 ═══
  //
  // 断言锚点全部取自 `tool-text.ts` 的真实区间边界（0x0300 / 0x036f 是
  // 组合符号区间的两端），不猜近义词 —— 这是 v0.14 的教训：曾经用
  // `/省略/` 去匹配 `其余 N 项未展开`，测试全绿而变异体存活。
  console.log('\n== 命令窗口宽度：CJK / emoji / 组合字符 / 零宽 ==')
  {
    check('CJK 全宽按 2 列（「中文」= 4 列）', displayWidth('中文') === 4, displayWidth('中文'))
    check('组合符号区间下界 0x0300 占 0 列', codePointWidth(0x0300) === 0, codePointWidth(0x0300))
    check('组合符号区间上界 0x036f 占 0 列', codePointWidth(0x036f) === 0, codePointWidth(0x036f))
    check('组合字符不增加列宽（e + U+0301 = 1 列）', displayWidth('e\u0301') === 1, displayWidth('e\u0301'))
    check('零宽空格不占列（a + U+200B + b = 2 列）', displayWidth('a\u200bb') === 2, displayWidth('a\u200bb'))
    check('emoji 代理对按 2 列（🎉）', displayWidth('🎉') === 2, displayWidth('🎉'))
    check('ZWJ 连接的 emoji 是一个字形（👨‍👩‍👧 = 2 列）', displayWidth('👨‍👩‍👧') === 2, displayWidth('👨‍👩‍👧'))
    check('肤色修饰符不增加列宽（👍🏽 = 2 列）', displayWidth('👍🏽') === 2, displayWidth('👍🏽'))
    check('padWidth 按显示列右填充（「更新」补到 8 列）', displayWidth(padWidth('更新', 8)) === 8, padWidth('更新', 8))
    const wrappedCjk = wrapWidth('中'.repeat(10), 5)
    check(
      'CJK 折行不超预算且不丢字符',
      wrappedCjk.every((line) => displayWidth(line) <= 5) && wrappedCjk.join('') === '中'.repeat(10),
      wrappedCjk,
    )
    const wrappedEmoji = wrapWidth('🎉'.repeat(10), 5)
    check(
      'emoji 折行不超预算、不拆代理对（拼回原文）',
      wrappedEmoji.every((line) => displayWidth(line) <= 5) && wrappedEmoji.join('') === '🎉'.repeat(10),
      wrappedEmoji,
    )
    // 正常文本经中和必须**逐字节不变**（否则「修显示」会把正常输出改脏）。
    check(
      '正常包名/版本号经 sanitizeText 逐字节不变',
      sanitizeText('@scope/pkg 0.0.0-dev').text === '@scope/pkg 0.0.0-dev',
      sanitizeText('@scope/pkg 0.0.0-dev'),
    )
    // 恰好用满预算时必须继续吃字符：`budget = max - 1`（末位留给 `…`），
    // 所以 max=4 时内容预算正好是 3 列 —— `abc` 之后第 4 个字符必须被截掉。
    // 提前一格截断会让 118 列的预算只用 117 列。
    check('clipWidth 恰好用满内容预算（max=4 ⇒ 3 列内容 + 省略号）', clipWidth('abcde', 4) === 'abc…', clipWidth('abcde', 4))
  }

  // ═══ 原有核心断言 ═══
  console.log('\n== suspect classification ==')
  const bundles = [
    { name: '@deepseek-ai/dsh-base', installed: true, enabled: true, official: true },
    { name: '@deepseek-ai/dsh-web-app', installed: true, enabled: true, official: true },
    { name: 'dsh-third-party', installed: true, enabled: true },
    { name: 'dsh-experimental-thing', installed: true, enabled: true },
    { name: 'dsh-not-installed', installed: false, enabled: false },
    { name: 'dsh-disabled-bundle', installed: true, enabled: false },
  ]
  const suspects = suspectBundles(bundles).map((b) => b.name)
  check('official bundles are never suspects', !suspects.includes('@deepseek-ai/dsh-base'), suspects)
  check('not-installed bundle is not a suspect', !suspects.includes('dsh-not-installed'), suspects)
  check('disabled bundle is not a suspect', !suspects.includes('dsh-disabled-bundle'), suspects)
  check('third-party bundle is a suspect', suspects.includes('dsh-third-party'), suspects)

  console.log('\n== recency ranking ==')
  const journal = new Map([
    ['dsh-third-party', { at: '2026-01-01T00:00:00.000Z', kind: 'install' as const, version: '1.0.0' }],
    ['dsh-experimental-thing', { at: '2026-03-01T00:00:00.000Z', kind: 'update' as const, version: '2.0.0' }],
  ])
  const ranked = rankByRecency(suspectBundles(bundles), journal, { 'dsh-third-party': 1 })
  check('ranking is newest-first', ranked[0]?.bundle === 'dsh-experimental-thing', ranked.map((r) => r.bundle))
  check('pick 1 returns one', pickSuspects(ranked, 1).length === 1)
  check('pick 2 returns two', pickSuspects(ranked, 2).length === 2)

  console.log('\n== version diffing ==')
  const diff = diffVersions({ a: '1.0.0' }, { a: '2.0.0', b: '1.0.0' })
  check('update detected', diff.update.length === 1 && diff.update[0]?.to === '2.0.0', diff.update)
  check('install detected', diff.install.length === 1 && diff.install[0]?.name === 'b', diff.install)

  console.log('\n== store ==')
  const dir = await mkdtemp(join(tmpdir(), 'rg-core-'))
  try {
    const store = new Store(dir)
    await store.init()
    await store.append({ kind: 'install', bundle: 'dsh-a', version: '1.0.0' })
    const journalRows = await store.readJournal(10)
    check('journal records events', journalRows.length === 1, journalRows.length)
    check('journal stamps a timestamp', typeof journalRows[0]?.t === 'string')
    store.appendSync({ kind: 'note', detail: 'sync' })
    check('appendSync writes immediately', store.readJournalSync(10).some((e) => e.detail === 'sync'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  // ═══ 能力模型 ═══
  console.log('\n== capability graph ==')
  const graph = buildCapabilityGraph()
  check('the capability graph has records', graph.size === CAPABILITY_SPECS.length, graph.size)
  check('exposed capabilities are reported', graph.exposed().length > 0)
  const analysis = graph.analyze()
  check('connectivity is a ratio in [0,1]', analysis.connectivity >= 0 && analysis.connectivity <= 1, analysis.connectivity)
  check('every capability has a title', graph.all().every((r) => r.title.length > 0))
  check('every capability has a summary', graph.all().every((r) => r.summary.length > 0))
  check('the capability ids are unique', new Set(graph.all().map((r) => r.id)).size === graph.size)

  console.log('\n== capability connectivity analysis ==')
  // 夹具必须造出**单向关系**（只有一侧登记）才会被判为缺口：
  // A 声明消费 B，但 B 没有反向登记 A ⇒ 消费断链。
  const broken = new CapabilityGraph()
  broken.upsert({
    id: 'a', title: 'A', summary: 'a', produces: 'metric', carrier: 'tool',
    consumes: ['b'], consumedBy: [], stage: 'monitoring', exposed: false,
  })
  broken.upsert({
    id: 'b', title: 'B', summary: 'b', produces: 'metric', carrier: 'remote',
    consumes: [], consumedBy: [], stage: 'monitoring', exposed: false,
  })
  const brokenAnalysis = broken.analyze()
  check('a one-sided consumption is a broken link', brokenAnalysis.broken.length > 0, brokenAnalysis.broken)
  check('the broken link names the upstream', brokenAnalysis.broken[0]?.detail === 'b', brokenAnalysis.broken)
  check('an ability with no relation is isolated', brokenAnalysis.isolated.length === 1, brokenAnalysis.isolated)

  // 过度生产：C 声明被 D 消费，但 D 并不消费 C ⇒ 产出悬空。
  const over = new CapabilityGraph()
  over.upsert({
    id: 'c', title: 'C', summary: 'c', produces: 'metric', carrier: 'remote',
    consumes: [], consumedBy: ['d'], stage: 'monitoring', exposed: false,
  })
  over.upsert({
    id: 'd', title: 'D', summary: 'd', produces: 'metric', carrier: 'tool',
    consumes: [], consumedBy: [], stage: 'monitoring', exposed: false,
  })
  const overAnalysis = over.analyze()
  check('a one-sided production is over-production', overAnalysis.overproduced.length > 0, overAnalysis.overproduced)


  console.log('\n== capability contract ==')
  // 少注册了一个（清单声明暴露但实际没有）⇒ missing。
  const partial = verifyCapabilityContract(graph, ['recency-guard.panel', 'recency_guard'])
  check('a missing registration is reported', partial.missing.length > 0, partial.missing)
  check('the missing name is named', partial.missing.includes('recency-guard.graph'), partial.missing)
  // 多注册了一个（实际有但清单完全没提）⇒ extra。
  const extra = verifyCapabilityContract(graph, [
    ...declaredExposedNames(graph),
    'some-undeclared-thing',
  ])
  check('an undeclared registration is reported', extra.extra.includes('some-undeclared-thing'), extra.extra)
  // 完全注册时（不多不少）契约成立。
  // 口径必须是「主名称 ∪ 次要名称」（exposedNamesOf / declaredExposedNames）：
  // 只用 exposedAs 会漏掉路由别称（recency-guard.reenable 等），把本来齐全的
  // 注册面误报成缺口 —— 这正是本测试曾经红过的原因。
  const complete = verifyCapabilityContract(graph, [...declaredExposedNames(graph)])
  check('a fully registered surface satisfies the contract', complete.ok, complete)
  check('a surface with an extra name is not satisfied', extra.ok === false, extra)
  const full = verifyCapabilityContract(graph, [...declaredExposedNames(graph)])
  check('the full registration set satisfies the contract', full.ok, full)

  // ═══ 生命周期状态机 ═══
  console.log('\n== lifecycle state machine ==')
  const machine = new StageMachine('idle')
  check('the initial stage is idle', machine.stage === 'idle')
  check('idle cannot jump straight to recovered', !canTransition('idle', 'recovered'))
  check('idle can move to monitoring', canTransition('idle', 'monitoring'))
  check('crashed must pass through deciding', !canTransition('crashed', 'recovered'))
  check('a legal transition succeeds', machine.transition('monitoring', 'test'))
  check('the stage advanced', machine.stage === 'monitoring')
  check('an illegal transition is refused', !machine.transition('recovered', 'test'))
  check('the stage did not change on refusal', machine.stage === 'monitoring')
  check('the transition history records the reason', machine.transitions[0]?.reason === 'test')
  check('all stages are declared', ALL_STAGES.length === 6, ALL_STAGES)

  console.log('\n== risk model ==')
  const now = Date.parse('2026-06-01T00:00:00.000Z')
  const fresh = riskScore({ lastChangeAt: '2026-06-01T00:00:00.000Z', experimental: true, suspectHits: 1, observations: 1 }, now)
  const old = riskScore({ lastChangeAt: '2026-01-01T00:00:00.000Z', experimental: false, suspectHits: 0, observations: 1 }, now)
  check('a fresh experimental plugin scores higher', fresh > old, { fresh, old })
  check('the risk is bounded to [0,1]', fresh >= 0 && fresh <= 1 && old >= 0 && old <= 1)
  const noData = riskScore({ lastChangeAt: 'not-a-date', experimental: false, suspectHits: 0, observations: 0 }, now)
  check('an unparsable date yields a bounded score', noData >= 0 && noData <= 1, noData)

  console.log('\n== crash trend ==')
  // 模型回归的是**相邻崩溃的间隔**：
  // 间隔越来越短 ⇒ 崩溃变密（恶化）；越来越长 ⇒ 变稀（改善）。
  const HOUR = 3_600_000
  const worsening = crashTrend([0, 10 * HOUR, 12 * HOUR, 12.5 * HOUR], 12.5 * HOUR)
  check('shrinking intervals mean worsening', worsening.verdict === 'worsening', worsening)
  const improving = crashTrend([0, 2 * HOUR, 40 * HOUR, 200 * HOUR], 200 * HOUR)
  check('growing intervals mean improving', improving.verdict === 'improving', improving)
  const flat = crashTrend([0, 10 * HOUR, 20 * HOUR], 20 * HOUR)
  check('constant intervals are stable', flat.verdict === 'stable', flat)
  const single = crashTrend([0], 0)
  check('one sample yields no trend', single.samples === 1 && single.verdict === 'stable', single)
  // 同样 3 次崩溃，分布不同 ⇒ 间隔统计不同（这是计数做不到的）。
  const clustered = crashIntervalStats([0, 1000, 2000])
  const spread = crashIntervalStats([0, 30 * 86_400_000, 60 * 86_400_000])
  check(
    'the same count with different spacing yields different intervals',
    (clustered.value?.medianMs ?? 0) !== (spread.value?.medianMs ?? 0),
    { clustered: clustered.value, spread: spread.value },
  )

  console.log('\n== observability honesty boundaries ==')
  const emptyRate = crashRate([])
  check('no observations means an undefined crash rate', !emptyRate.defined && emptyRate.value === null, emptyRate)
  const zeroRate = crashRate([{ at: '2026-01-01T00:00:00.000Z', crashed: false }])
  check('zero crashes is a DEFINED zero', zeroRate.defined && zeroRate.value === 0, zeroRate)
  const noRecovery = meanRecoveryTime([{ at: '2026-01-01T00:00:00.000Z', crashed: true }])
  check('no recovery sample means an undefined mean', !noRecovery.defined, noRecovery)
  const noDetection = detectionRate([{ at: '2026-01-01T00:00:00.000Z', crashed: false }])
  check('no crash sample means an undefined detection rate', !noDetection.defined, noDetection)
  const pure = isolationPurity([])
  check('no partition means an undefined purity', !pure.defined, pure)
  const purity = isolationPurity([{ key: 'a', contaminated: false }, { key: 'b', contaminated: true }])
  check('purity counts clean partitions', purity.value === 0.5, purity)
  check('every metric carries a readable label', [emptyRate, zeroRate, purity].every((m) => m.label.length > 0))

  console.log('\n== statistics helpers ==')
  check('median of an odd-length set', median([3, 1, 2]) === 2)
  check('median of an even-length set', median([4, 1, 3, 2]) === 2.5)
  check('median of an empty set is zero', median([]) === 0)
  check('ewma of an empty series is zero', ewma([]) === 0)
  // EWMA 的「近期更重」用**半衰期越短越靠近最新值**表达，而不是魔数：
  // 同一组数据，H=1（α=0.5）比 H=5 更贴近最后一个值。
  const shortHalfLife = ewma([0, 0, 0, 10], 1)
  const longHalfLife = ewma([0, 0, 0, 10], 5)
  check('a shorter half-life weights recent values more', shortHalfLife > longHalfLife, {
    shortHalfLife,
    longHalfLife,
  })
  check('the half-life-1 result is half the latest value', shortHalfLife === 5, shortHalfLife)
  const intervals = crashIntervalStats([0, 1000, 3000])
  check('crash intervals need two samples', intervals.defined && intervals.value?.medianMs === 1500, intervals)
  check('one sample means no interval', !crashIntervalStats([0]).defined)

  console.log('\n== cusum change-point detection (cycle-3) ==')
  // 稳定间隔（每 60s 一次崩溃）不应触发变点。
  const steady = cusumChangePoint([0, 60_000, 120_000, 180_000, 240_000])
  check('steady intervals raise no change point', !steady.defined, steady)
  // 前 3 次间隔 60s，之后骤缩到 10s —— 变点应落在第 4 次崩溃附近。
  const accelerating = cusumChangePoint([0, 60_000, 120_000, 130_000, 140_000, 150_000])
  check('a density acceleration is detected', accelerating.defined, accelerating)
  if (accelerating.defined) {
    check('the change point lands after the acceleration begins', accelerating.value.index >= 3, accelerating.value)
    check('the change point carries a readable label', accelerating.label.includes('上行'), accelerating.label)
  }
  check('fewer than two crashes means no change point', !cusumChangePoint([0]).defined)

  console.log('\n== crash pressure (EWMA into the snapshot, cycle-4) ==')
  // 诚实边界：无观测 = 不可判定（null），不是 0 —— 与 crashRate 同一条红线。
  const noPressure = crashPressure([])
  check('no observations means an undefined pressure', !noPressure.defined && noPressure.value === null, noPressure)
  // 全平稳序列：0 是**真值**（有数据且每次启动都没崩），与 null 语义不同。
  const calm = crashPressure([
    { at: '2026-01-01T00:00:00.000Z', crashed: false },
    { at: '2026-01-01T00:01:00.000Z', crashed: false },
    { at: '2026-01-01T00:02:00.000Z', crashed: false },
  ])
  check('a crash-free series is a DEFINED zero', calm.defined && calm.value === 0, calm)
  // 时间局部性：同样 1/3 的崩溃率，崩溃**集中在最近**的压力必须更高
  // —— 这正是 crashRate 给不出的信息（EWMA 的存在理由）。
  const recent = crashPressure([
    { at: '2026-01-01T00:00:00.000Z', crashed: false },
    { at: '2026-01-01T00:01:00.000Z', crashed: false },
    { at: '2026-01-01T00:02:00.000Z', crashed: true },
  ])
  const ancient = crashPressure([
    { at: '2026-01-01T00:00:00.000Z', crashed: true },
    { at: '2026-01-01T00:01:00.000Z', crashed: false },
    { at: '2026-01-01T00:02:00.000Z', crashed: false },
  ])
  check('recent crashes weigh more than ancient ones', (recent.value ?? 0) > (ancient.value ?? 0), {
    recent: recent.value,
    ancient: ancient.value,
  })
  check('the pressure stays in [0,1]', (recent.value ?? -1) >= 0 && (recent.value ?? -1) <= 1)
  // computeMetrics 的快照字段连通性：intervals 与 changePoint 必须真实进入快照。
  // 数据带**持续**加速（3×60s → 4×10s）：CUSUM 语义是「持续变密」才告警，
  // 单个短间隔只算尖峰（会被 max(0,·) 钳掉），这正是它对漂移敏感的证据。
  // （cycle-4 修复：先构造快照再断言——此前断言行在 const 初始化之前引用
  //   metricsSnapshot，TDZ ReferenceError 把整条链路判死。）
  const metricsSnapshot = computeMetrics(
    [
      { at: '2026-01-01T00:00:00.000Z', crashed: true },
      { at: '2026-01-01T00:01:00.000Z', crashed: true },
      { at: '2026-01-01T00:02:00.000Z', crashed: true },
      { at: '2026-01-01T00:03:00.000Z', crashed: true },
      { at: '2026-01-01T00:03:10.000Z', crashed: true },
      { at: '2026-01-01T00:03:20.000Z', crashed: true },
      { at: '2026-01-01T00:03:30.000Z', crashed: true },
      { at: '2026-01-01T00:03:40.000Z', crashed: false },
    ],
    0.9,
    [],
    Date.parse('2026-01-01T00:04:00.000Z'),
  )
  // 快照连通性：crashPressure 必须真实进入 computeMetrics 的输出。
  check('the snapshot carries the crash pressure', metricsSnapshot.crashPressure.defined, metricsSnapshot.crashPressure)
  check('the snapshot carries the interval stats', metricsSnapshot.intervals.defined, metricsSnapshot.intervals)
  check('the snapshot carries the change point', metricsSnapshot.changePoint.defined, metricsSnapshot.changePoint)

  console.log('\n== tool render: human-readable dual form (cycle-3) ==')
  // renderOutcome：文本形态是给人看的（命令窗口），不是转义的 JSON。
  const outcome = formatStatus({
    profile: 'desktop',
    dshVersion: 'test',
    enabled: true,
    crashedLastRun: true,
    crashSeq: 2,
    stabilized: false,
    autoDisabled: [{ name: 'dsh-bad', reason: 'auto-recency', crashSeq: 2, disabledAt: '2026-01-01T00:00:00.000Z' }],
    suspectRanking: [{ bundle: 'dsh-bad', lastChangeAt: '2026-01-01T00:00:00.000Z', lastKind: 'update' }],
    experimentalSuspects: ['dsh-bad'],
  })
  const text = renderOutcome(outcome)
  check('render is multi-line and not raw JSON', text.includes('\n') && !text.trimStart().startsWith('{'), text.slice(0, 60))
  check('render names the suspect', text.includes('dsh-bad'), text)
  check('the outcome echoes the action', outcome.action === 'status' && outcome.ok === true, outcome.action)
  check('the data keeps the structured facts', (outcome.data as { crashSeq?: number }).crashSeq === 2, outcome.data)
  const archiveOutcome = formatArchive({ ok: true, archiveDir: 'X:/archive', count: 3 })
  check('archive render explains the reset', renderOutcome(archiveOutcome).includes('重新开始'), renderOutcome(archiveOutcome))

  console.log('\n== risk ranking ==')
  const risks = rankRisks(
    [
      { bundle: 'z-old', experimental: false, lastChangeAt: '2026-01-01T00:00:00.000Z', suspectHits: 0, observations: 1 },
      { bundle: 'a-new', experimental: true, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 1, observations: 1 },
    ],
    Date.parse('2026-06-01T00:00:00.000Z'),
  )
  check('the highest risk ranks first', risks[0]?.bundle === 'a-new', risks.map((r) => r.bundle))
  check('ties break by name for determinism', (() => {
    const tied = rankRisks(
      [
        { bundle: 'b', experimental: false, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 0, observations: 1 },
        { bundle: 'a', experimental: false, lastChangeAt: '2026-06-01T00:00:00.000Z', suspectHits: 0, observations: 1 },
      ],
      Date.parse('2026-06-01T00:00:00.000Z'),
    )
    return tied[0]?.bundle === 'a'
  })())
  check('every ranking row carries a readable label', risks.every((r) => r.label.includes('风险')))

  // ═══ 项目隔离 ═══
  console.log('\n== project isolation ==')
  check('paths are normalized to forward slashes', normalizeWorkspace('D:\\a\\b') === 'd:/a/b', normalizeWorkspace('D:\\a\\b'))
  check('drive letters are lowercased', normalizeWorkspace('C:/x') === 'c:/x')
  check('dot segments are resolved', normalizeWorkspace('c:/a/./b/../c') === 'c:/a/c', normalizeWorkspace('c:/a/./b/../c'))
  check('trailing separators are dropped', normalizeWorkspace('c:/a/b/') === 'c:/a/b')
  const keyA = projectKey('D:/Project/Alpha')
  const keyB = projectKey('d:\\project\\alpha')
  check('the same workspace yields the same key', keyA === keyB, { keyA, keyB })
  check('different workspaces yield different keys', projectKey('D:/a') !== projectKey('D:/b'))
  check('the key is a fixed-length hex string', /^[0-9a-f]{16}$/.test(keyA), keyA)
  check('the label is the last path segment', projectLabel('D:/Project/Alpha') === 'Alpha')

  console.log('\n== partition registry ==')
  const index = emptyPartitionIndex()
  const first = registerPartition(index, 'D:/Project/Alpha')
  check('a new partition is created', first.index.partitions.length === 1)
  check('the partition keeps its key across registrations', registerPartition(first.index, 'D:/Project/Alpha').partition.key === first.partition.key)
  check('a second workspace gets its own partition', registerPartition(first.index, 'D:/Project/Beta').index.partitions.length === 2)
  check('a partition can be found by key', findPartition(first.index, first.partition.key)?.label === 'Alpha')

  // ═══ 归档重置 ═══
  console.log('\n== archive and reset ==')
  const archiveRoot = await mkdtemp(join(tmpdir(), 'rg-archive-'))
  try {
    // 归档作用于**分区目录**（与运行时一致）。
    const store = new Store(archiveRoot, 'partition-a')
    await store.init()
    await store.append({ kind: 'install', bundle: 'dsh-x', version: '1.0.0' })
    await store.updateState((s) => ({ ...s, crashSeq: 3, autoDisabled: [{ name: 'dsh-x', disabledAt: 'x', reason: 'auto-recency', crashSeq: 3 }] }))
    await store.writeDecisionSync({ capturedAt: 'x', suspects: [], disable: ['dsh-x'], reason: 'crash-recovery', crashSeq: 3 })

    const archived = archiveAndReset(store.partitionPath, 'D:/Project/Alpha', '测试归档', new Date('2026-06-01T00:00:00.000Z'))
    check('the archive reports what it archived', archived.count >= 3, archived.count)
    check('the manifest records the reason', archived.manifest.reason === '测试归档')
    check('the manifest records the crash count', archived.manifest.summary.crashSeq === 3, archived.manifest.summary)
    check('the manifest records the auto-disabled bundles', archived.manifest.summary.autoDisabled.includes('dsh-x'))
    const after = await store.readState()
    check('the crash count is reset', after.crashSeq === 0, after.crashSeq)
    check('the auto-disabled list is cleared', after.autoDisabled.length === 0)
    const decision = store.readDecisionSync()
    check('the decision is cleared so old conclusions do not apply', decision?.disable.length === 0, decision)
    const archives = listArchives(store.partitionPath)
    check('the archive is listed', archives.length === 1, archives)
    check('the archive manifest can be read back', readArchiveManifest(archives[0].dir)?.reason === '测试归档')
    check('the archive manifest names the workspace it came from', readArchiveManifest(archives[0].dir)?.workspace === 'D:/Project/Alpha', readArchiveManifest(archives[0].dir)?.workspace)
    check('the journal moved into the archive', archived.manifest.entries.some((e) => e.kind === 'journal'))

    // cycle-4 T02：归档清单摘要必须**真正到达消费面**（工具投影），
    // 否则「举他对照基线」只是生产了没人读的数据（过度生产缺口）。
    console.log('\n== archive summary reaches the tool surface (cycle-4) ==')
    const archiveOutcome2 = formatArchives({
      archives: archives.map((a) => {
        const manifest = readArchiveManifest(a.dir)
        return {
          ...a,
          summary: manifest?.summary ?? { crashSeq: 0, autoDisabled: [], journalEvents: 0 },
        }
      }),
    })
    const archiveText = renderOutcome(archiveOutcome2)
    check('the summary names the crash count', archiveText.includes('崩溃 3 次'), archiveText)
    check('the summary names the disabled bundle', archiveText.includes('dsh-x'), archiveText)
    check('the summary counts journal events', archiveText.includes('事件'), archiveText)
  } finally {
    await rm(archiveRoot, { recursive: true, force: true })
  }

  console.log('\n== partitioned storage ==')
  const partitionRoot = await mkdtemp(join(tmpdir(), 'rg-partition-'))
  try {
    const storeA = new Store(partitionRoot, 'project-a')
    const storeB = new Store(partitionRoot, 'project-b')
    await storeA.init()
    await storeB.init()
    await storeA.append({ kind: 'install', bundle: 'dsh-only-in-a', version: '1.0.0' })
    await storeB.append({ kind: 'install', bundle: 'dsh-only-in-b', version: '1.0.0' })
    const journalA = await storeA.readJournal(10)
    const journalB = await storeB.readJournal(10)
    check('each partition keeps its own journal', journalA.length === 1 && journalB.length === 1, {
      a: journalA.length,
      b: journalB.length,
    })
    check(
      'a partition never sees another partition\'s events',
      journalA.every((e) => e.bundle === 'dsh-only-in-a') && journalB.every((e) => e.bundle === 'dsh-only-in-b'),
      { a: journalA, b: journalB },
    )
    check('the partitions have different directories', storeA.partitionPath !== storeB.partitionPath)
    await storeA.updateState((s) => ({ ...s, crashSeq: 7 }))
    check(
      'a crash in one partition does not reach the other',
      (await storeA.readState()).crashSeq === 7 && (await storeB.readState()).crashSeq === 0,
    )
  } finally {
    await rm(partitionRoot, { recursive: true, force: true })
  }

  // ═══ 守护行安装：空数组文档回归（真机 sb-rg-journey2 实测缺陷）═══
  console.log('\n== guarded row append on an empty-array patch document ==')
  {
    const patchRoot = await mkdtemp(join(tmpdir(), 'rg-patch-'))
    try {
      const patchPath = join(patchRoot, 'cordis.patch.yml')
      // dsh 生成的 profile patch 是「注释 + []」——不是裸 `[]`。
      const dshShape =
        '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
        '# a top-level YAML array of loader patch entries.\n[]\n'
      writeFileSync(patchPath, dshShape, 'utf8')
      appendPatchText(patchPath, '- id: some-plugin\n  name: dsh-some-plugin\n  disabled: !!js "false"\n')
      const after = readFileSync(patchPath, 'utf8')
      // 摘除空标记后，注释 + 顶层序列共存是合法 YAML；残留的 `[]` 会把文档
      // 变成流式空数组与块序列的混合 —— Loader 解析直接抛错（profile 起不来）。
      check('the bare empty-array marker is removed', !after.split('\n').some((l) => l.trim() === '[]'), after)
      check('the comments survive (user asset)', after.includes('# Your patch layer'))
      check('the guarded row is appended at the top level', after.includes('- id: some-plugin'))
      // 裸 `[]` 文档（无注释）也要正确。
      writeFileSync(patchPath, '[]\n', 'utf8')
      appendPatchText(patchPath, '- id: other-plugin\n  name: dsh-other-plugin\n')
      check('a bare empty array is also handled', !readFileSync(patchPath, 'utf8').split('\n').some((l) => l.trim() === '[]'))
      // 已有内容的文档不能被改动（追加语义，不重写用户资产）。
      const existing = '# comment\n- id: first\n  name: dsh-first\n'
      writeFileSync(patchPath, existing, 'utf8')
      appendPatchText(patchPath, '- id: second\n  name: dsh-second\n')
      check('existing rows are preserved', readFileSync(patchPath, 'utf8').includes('- id: first'))
      check('the new row is appended', readFileSync(patchPath, 'utf8').includes('- id: second'))
    } finally {
      await rm(patchRoot, { recursive: true, force: true })
    }
  }

  // ═══ 图谱数据 ═══
  console.log('\n== graph data ==')
  const edges = [
    { from: 'guard.observe.metrics', to: 'guard.present.panel', kind: 'produces' as const },
    { from: 'guard.decide.suspects', to: 'guard.present.panel', kind: 'produces' as const },
  ]
  const graphData = buildGraphData(graph.all(), edges, [])
  check('the graph has nodes', graphData.nodes.length > 0)
  check('the graph has edges', graphData.edges.length > 0)
  check('the layout is deterministic', (() => {
    const again = buildGraphData(graph.all(), edges, [])
    return (
      JSON.stringify(again.nodes.map((n) => [n.id, n.x, n.y])) ===
      JSON.stringify(graphData.nodes.map((n) => [n.id, n.x, n.y]))
    )
  })())
  check('every node has a shape (colour is not the only channel)', graphData.nodes.every((n) => n.shape.length > 0))
  check('every node has a label', graphData.nodes.every((n) => n.label.length > 0))
  const bounds = computeBounds(graphData.nodes)
  check('the bounds cover every node', graphData.nodes.every((n) => n.x >= bounds.minX && n.x <= bounds.maxX))
  const adjacency = buildAdjacency(graphData.edges)
  check('the adjacency index finds outgoing edges', (adjacency.outgoing.get('guard.observe.metrics')?.length ?? 0) === 1)
  const components = connectedComponents(graphData.nodes, graphData.edges)
  check('connectivity analysis runs', components.count >= 1, components)
  check('the largest component is at least one', components.largest >= 1)


  // ---------- v0.12.1 pidAlive（异常终止通道的复核依据） ----------
  // 这条通道判的是「上一轮没走到 disposer」，而残留 bootMarker 本身不携带死因：
  // 并发实例（另一个 dsh 还开着）不是崩溃。误判的代价是关掉无辜插件，
  // 所以探活的每个分支都要钉住 —— 尤其是 EPERM 必须算「活着」。
  check('pidAlive(自己) === true（当前进程必然存在）', pidAlive(process.pid) === true)
  check('pidAlive(0) === false（非法 pid 不是进程）', pidAlive(0) === false)
  check('pidAlive(-1) === false', pidAlive(-1) === false)
  check('pidAlive(NaN) === false', pidAlive(Number.NaN) === false)
  check('pidAlive(1.5) === false（非整数 pid 不存在）', pidAlive(1.5) === false)
  // 远超系统 PID 上限的值必然 ESRCH ⇒ false（用它避免与真实进程相撞造成偶发红）。
  check('pidAlive(2^31-1) === false（不存在的进程报 ESRCH）', pidAlive(2147483647) === false)
  // **不要断言 PID 1 存在**：那是平台事实而非不变式 —— Linux 的 1 是 init，
  // 而 Windows 根本没有 PID 1（System Idle Process 是 PID 0）。本行只验证
  // 「探活不会因为平台差异抛异常」，具体存在性交给上面两个确定用例
  // （自己的 pid 必然活、2^31-1 必然死）。
  check('pidAlive(1) 返回布尔且不抛（存在性是平台事实，不据此判定）', typeof pidAlive(1) === 'boolean')

  // ---------- v0.15 / TD-1：restore 事件显式列出被恢复的 bundle ----------
  // 消费侧（risk-calibration 的来源判定）自己有一节断言；这里钉**生产侧**。
  // 缺了这节，`bundles` 字段可以一直是空的/错的，而所有消费侧测试照样全绿
  // —— 因为它们的 journal 是手工构造的。
  console.log('\n== restore 事件显式列出 bundles（TD-1）==')
  {
    const appended: JournalEvent[] = []
    let state: GuardState = {
      ...emptyState(),
      // 顺序即语义：最后一项是首要嫌疑（保持关闭），前面两项才尝试恢复。
      autoDisabled: [
        { name: 'dsh-a', disabledAt: 't1', reason: 'auto-recency', crashSeq: 1 },
        { name: 'dsh-b', disabledAt: 't2', reason: 'auto-recency', crashSeq: 1 },
        { name: 'dsh-prime', disabledAt: 't3', reason: 'auto-recency', crashSeq: 1 },
      ],
    }
    const deps: RecoveryDeps = {
      store: {
        readState: async () => state,
        updateState: async (fn: (s: GuardState) => GuardState | Promise<GuardState>) => {
          state = await fn(state)
          return state
        },
        append: async (event: JournalEvent | JournalEvent[]) => {
          appended.push(...(Array.isArray(event) ? event : [event]))
        },
        readBackup: async () => null,
      },
      pluginManager: {
        // dsh-a 被管理器接受；dsh-b 被拒绝（生产上 reenableOne 仍会写一条 enable）。
        setBundleEnabled: async (name: string) => ({ application: name === 'dsh-b' ? 'failed' : 'applied' }),
        setPluginEnabled: async () => ({ application: 'applied' }),
      },
      suspectRows: async () => [],
      publishDecision: async () => {},
      transition: () => {},
      warn: () => {},
      toJson: (value: unknown) => value,
    }
    const result = await restoreDisabledExceptPrime(deps)
    const restoreRow = appended.filter((e) => e.kind === 'restore').pop()
    check('restore 事件带结构化 bundles 字段', Array.isArray(restoreRow?.bundles), restoreRow)
    check(
      '只列真正被重新启用的 bundle（失败者与首要嫌疑都不列）',
      JSON.stringify(restoreRow?.bundles) === JSON.stringify(['dsh-a']),
      { bundles: restoreRow?.bundles, kept: result.keptDisabled },
    )
    check(
      'restore 的 bundles 与返回值的 reenabled 同源（不是第二份真相）',
      JSON.stringify(restoreRow?.bundles) === JSON.stringify(result.reenabled),
      { bundles: restoreRow?.bundles, reenabled: result.reenabled },
    )
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
