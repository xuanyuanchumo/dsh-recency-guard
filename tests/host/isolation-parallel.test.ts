/**
 * 多分区并行隔离回归（cycle-13 / E4.3，判据：隔离违例数 = 0）。
 *
 * ## 这条测试要回答什么
 *
 * E4.3 的原文判据是「多分区并行跑同一测试矩阵 | 隔离违例数 | 0」。
 * 既有 `isolation-journey.test.ts` 证明的是**串行**下两个工作区落两个分区；
 * 它无法回答「同时跑」时会不会串。本文件把矩阵真正并发起来：
 *
 * - **in-process**：`Promise.all` 同时驱动 N=6 个分区，中间用两道 barrier
 *   把 6 个任务对齐到同一点再一起写/一起读 —— 这是任务要求的「真并发」，
 *   串行化会让整条测试失去意义。
 * - **cross-process**：另外用 N=4 个**真实子进程**跑同一个 profile。
 *   理由：`writeDecisionSync` / `writePointer` / `writePartitionIndex` 都是
 *   **同步** IO，同一进程里同步段无法互相插入；只用 Promise.all 会得出
 *   「指针永不撕裂」的假绿。真正的指针/注册竞态只有跨进程才暴露。
 *
 * ## 隔离违例的判据（不是「看起来没串」）
 *
 * 对每个分区：
 * 1. journal 里每一条事件的 `partition` 必须是自己，bundle 前缀必须是自己；
 * 2. state / snapshot / decision / observation / cooccurrence / backups 读回的
 *    值必须**恰好等于自己写入的值**；
 * 3. 物理层否定性证据：递归扫描本分区目录的全部文件，**不允许出现**
 *    任何其它分区的标记串（数据泄漏最终一定以字节形式落盘）；
 * 4. profile 根目录不允许出现 journal/state/decision 等全局产物。
 * 任一命中即计入 `隔离违例`，最终断言 == 0。
 *
 * ## 已知边界如实测量（不掩盖）
 *
 * `decision.ts` 头注已登记：指针 `.recency-guard/current.json` 是 **profile 级
 * 一份**，并发工作区会被最后一个写入者覆盖。本文件不把它伪装成不存在：
 * - 断言**直接按分区路径读**（`decisionPath(partitionDir)`）拿到自己的决策
 *   ⇒ 数据面违例 0；
 * - 单独度量**指针桥**（指针 → 决策文件，即守护行表达式的真实路径）的跨分区
 *   读取数。稳态下必然是 N-1（只有最后写入者读到自己），这是**已知边界**，
 *   不是并发新增的污染；跨进程段另外测量指针撕裂/未解析次数并原样打印。
 * 若出现超出该形态的现象（例如指针指向不存在的分区、决策文件撕裂），
 * 测试会失败并给出证据 —— 那才是真缺陷。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../../src/host/data/store.ts'
import { computeRevision, type RevisionFacts } from '../../src/host/core/change-guard.ts'
import {
  partitionDir,
  projectKey,
  readPartitionIndex,
  registerPartition,
  writePartitionIndex,
} from '../../src/host/core/isolation.ts'
import { decisionPath, pointerPath, readDecision, readPointer, writePointer } from '../../src/host/guard/decision.ts'
import type { GuardState, JournalEvent, PrebootDecision } from '../../src/host/data/store.ts'

// ─────────────────────────── 测试骨架 ───────────────────────────

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/** in-process 并发分区数（任务要求 N ≥ 4）。 */
const PARTITION_COUNT = 6
/** cross-process 并发子进程数。 */
const XPROC_PARTITION_COUNT = 4
/** 跨分区锁互不干扰：每个分区并发 updateState 的次数。 */
const LOCK_ROUNDS = 8
/** 固定时间戳：让「多次读逐字节一致」不被新写入的时间戳干扰。 */
const FIXED_AT = '2026-11-10T00:00:00.000Z'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 隔离违例登记簿：每一条都要能回指「哪个通道、哪个分区、证据是什么」。 */
interface IsolationViolation {
  channel: string
  partition: number
  detail: string
}
const violations: IsolationViolation[] = []

function recordViolation(channel: string, partition: number, detail: string): void {
  violations.push({ channel, partition, detail })
  console.log(`  VIOLATION  [${channel}] partition=${partition} ${detail}`)
}

/** 分区内唯一的标记串（跨分区扫描靠它判定泄漏）。 */
function token(index: number, suffix: string): string {
  return `pkg-par${index}-${suffix}`
}

/** 跨进程段使用另一套标记串，避免与 in-process 段互相污染。 */
function xToken(index: number, suffix: string): string {
  return `pkg-xpar${index}-${suffix}`
}

function stable(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * 并发对齐栅栏：前 parties-1 个到达者挂起，最后一个到达者同步唤醒全部。
 *
 * 为什么需要它：`Promise.all` 只保证「都启动了」，不保证「同一时刻都在写」。
 * 栅栏让 6 个分区在同一 microtask 排空里一起进入写阶段/读阶段，
 * 使「并发」成为可判定事实，而不是时序运气。
 */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0
  let waiters: Array<() => void> = []
  return async (): Promise<void> => {
    arrived += 1
    if (arrived >= parties) {
      arrived = 0
      const release = waiters
      waiters = []
      for (const wake of release) wake()
      return
    }
    await new Promise<void>((wake) => waiters.push(wake))
  }
}

/** 在飞操作计数器：证明「N 个分区确实同时有操作在飞」。 */
function inFlightMeter(): { enter(): void; leave(): void; readonly max: number } {
  let active = 0
  let max = 0
  return {
    enter(): void {
      active += 1
      if (active > max) max = active
    },
    leave(): void {
      active -= 1
    },
    get max(): number {
      return max
    },
  }
}

/** 递归列出目录内全部普通文件（不存在时返回空）。 */
function walkFiles(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * 物理层否定性证据：本分区目录里是否出现了别人的标记串。
 *
 * 为什么只扫标记串而不是比较文件哈希：哈希会把「自己的文件被重写」
 * 也算成差异（噪声），而标记串每次命中都是一次真实的跨分区字节泄漏。
 */
function foreignTokenHits(dir: string, ownIndex: number, count: number, makeToken: (i: number, s: string) => string): string[] {
  const markers: string[] = []
  for (let j = 0; j < count; j += 1) {
    if (j === ownIndex) continue
    markers.push(makeToken(j, ''))
  }
  const hits: string[] = []
  for (const file of walkFiles(dir)) {
    let text: string
    try {
      if (statSync(file).size > 512 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const marker of markers) {
      if (text.includes(marker)) hits.push(`${file.replace(/\//g, '/')} :: ${marker}`)
    }
  }
  return hits
}

// ─────────────────────────── 事实夹具 ───────────────────────────

interface PartitionFixture {
  index: number
  workspace: string
  key: string
  dir: string
  store: Store
}

function journalFixture(index: number): JournalEvent[] {
  return [
    { kind: 'install', bundle: token(index, 'alpha'), version: `1.0.${index}`, partition: index },
    { kind: 'update', bundle: token(index, 'alpha'), version: `1.0.${index}`, prevVersion: `0.9.${index}`, partition: index },
    { kind: 'crash-detected', bundle: token(index, 'alpha'), detail: `partition-${index}`, partition: index },
  ]
}

function stateFixture(index: number): GuardState {
  return {
    bootMarker: { startedAt: FIXED_AT, pid: 90_000 + index },
    crashSeq: index + 1,
    autoDisabled: [
      {
        name: token(index, 'auto'),
        version: `2.0.${index}`,
        disabledAt: FIXED_AT,
        reason: 'auto-recency',
        crashSeq: index + 1,
      },
    ],
    stabilized: index % 2 === 0,
    restored: [token(index, 'restored')],
    lastExitCode: 1,
    crashedRun: true,
  }
}

function decisionFixture(index: number): PrebootDecision {
  return {
    capturedAt: FIXED_AT,
    suspects: [{ bundle: token(index, 'alpha'), version: `1.0.${index}`, lastChangeAt: FIXED_AT }],
    disable: [token(index, 'disable')],
    reason: 'crash-recovery',
    crashSeq: index + 1,
    phase: 'quarantined',
  }
}

/** 一个分区在并发矩阵里写的全部内容（读回时逐项比对的真值）。 */
function expectedFacts(index: number): {
  journal: JournalEvent[]
  state: GuardState
  snapshot: Record<string, string>
  observation: Record<string, { version?: string; enabled: boolean }>
  cooccurrence: { schemaVersion: 1; samples: Array<{ at: string; officialActive: string[]; suspects: string[]; disabled: string[] }> }
  decision: PrebootDecision
} {
  return {
    journal: journalFixture(index),
    state: stateFixture(index),
    snapshot: { [token(index, 'alpha')]: `1.0.${index}` },
    observation: { [token(index, 'beta')]: { version: `2.0.${index}`, enabled: index % 2 === 0 } },
    cooccurrence: {
      schemaVersion: 1,
      samples: [
        {
          at: FIXED_AT,
          officialActive: [token(index, 'official')],
          suspects: [token(index, 'alpha')],
          disabled: [token(index, 'disable')],
        },
      ],
    },
    decision: decisionFixture(index),
  }
}

// ─────────────────────────── 并发写 / 读 ───────────────────────────

async function writePartition(
  fx: PartitionFixture,
  profileDir: string,
  writeGate: () => Promise<void>,
  syncGate: () => Promise<void>,
  meter: ReturnType<typeof inFlightMeter>,
): Promise<void> {
  const facts = expectedFacts(fx.index)
  await writeGate()
  meter.enter()
  try {
    // 分区内的 5 个异步写各自落在**不同文件**上，因此可以同分区并发；
    // journal 只有这里在写（writeVersionedBackup 不追加 journal），
    // 避免同分区「读改写」竞争混进来干扰隔离判定。
    // 注意：`Store.init()` 必须在此之前完成 —— atomic-write 的
    // `withFileLock` 要求父目录已存在（updateState 的锁文件建在分区目录里）。
    await Promise.all([
      fx.store.append(facts.journal),
      fx.store.updateState(() => facts.state),
      fx.store.writeSnapshot(facts.snapshot),
      fx.store.writeObservationSnapshot('official', new Map(Object.entries(facts.observation))),
      fx.store.writeVersionedBackup(token(fx.index, 'alpha'), `1.0.${fx.index}`, { partition: fx.index }),
    ])
  } finally {
    meter.leave()
  }
  await syncGate()
  // 同步写阶段。同一进程内同步段不可插入，但 6 个分区在栅栏后仍会
  // 以 microtask 顺序交错执行 —— 共享结构的最后写入者因此可判定。
  fx.store.writeDecisionSync(facts.decision)
  writePointer(profileDir, fx.key, fx.dir)
  fx.store.writeCooccurrenceSync(facts.cooccurrence)
  const next = registerPartition(readPartitionIndex(profileDir), fx.workspace)
  writePartitionIndex(profileDir, next.index)
}

/** 读回本分区的全部通道，并把任何「读到别人」记为隔离违例。 */
async function verifyPartition(fx: PartitionFixture): Promise<void> {
  const expected = expectedFacts(fx.index)
  const i = fx.index

  const journal = await fx.store.readJournal(100)
  if (journal.length !== expected.journal.length) {
    recordViolation('journal-size', i, `期望 ${expected.journal.length} 行，实际 ${journal.length} 行`)
  }
  for (const record of journal) {
    if (record.partition !== i) {
      recordViolation('journal-foreign-event', i, `读到 partition=${String(record.partition)} 的事件 ${String(record.kind)}`)
    }
    if (typeof record.bundle === 'string' && !record.bundle.startsWith(`pkg-par${i}-`)) {
      recordViolation('journal-foreign-bundle', i, `bundle=${record.bundle}`)
    }
  }
  const state = await fx.store.readState()
  if (state.crashSeq !== expected.state.crashSeq) {
    recordViolation('state-crashSeq', i, `期望 ${expected.state.crashSeq} 实际 ${state.crashSeq}`)
  }
  const autoNames = state.autoDisabled.map((entry) => entry.name)
  if (stable(autoNames) !== stable(expected.state.autoDisabled.map((entry) => entry.name))) {
    recordViolation('state-autoDisabled', i, stable(autoNames))
  }
  if (stable(state.restored) !== stable(expected.state.restored)) {
    recordViolation('state-restored', i, stable(state.restored))
  }
  if (state.bootMarker?.pid !== expected.state.bootMarker?.pid) {
    recordViolation('state-bootMarker', i, `pid=${String(state.bootMarker?.pid)}`)
  }
  if (state.stabilized !== expected.state.stabilized) {
    recordViolation('state-stabilized', i, `stabilized=${String(state.stabilized)}`)
  }

  const snapshot = await fx.store.readSnapshot()
  if (stable(snapshot) !== stable(expected.snapshot)) {
    recordViolation('snapshot', i, stable(snapshot))
  }

  const decision = await Promise.resolve(fx.store.readDecisionSync())
  if (decision === null || stable(decision.disable) !== stable(expected.decision.disable)) {
    recordViolation('decision-partition-path', i, decision === null ? '决策文件缺失' : stable(decision.disable))
  }

  // 决策必须以**分区目录**为唯一寻址依据（指针只做桥，不是数据源）。
  // 注意：`readDecision` 的参数是**分区目录**（内部再拼 decision.json），
  // 传 decisionPath() 的返回值会变成 `decision.json/decision.json`。
  const direct = readDecision(fx.dir)
  if (direct === null || stable(direct.disable) !== stable(expected.decision.disable)) {
    recordViolation('decision-direct-path', i, direct === null ? 'readDecision 读到 null' : stable(direct.disable))
  }

  const observation = await fx.store.readObservationSnapshot('official')
  const observed = Object.fromEntries(observation)
  if (stable(observed) !== stable(expected.observation)) {
    recordViolation('observation', i, stable(observed))
  }

  const cooccurrence = fx.store.readCooccurrenceSync()
  if (stable(cooccurrence.samples) !== stable(expected.cooccurrence.samples)) {
    recordViolation('cooccurrence', i, stable(cooccurrence.samples))
  }

  // 备份通道：矩阵写的是**版本化时间线**（writeVersionedBackup 不追加 journal，
  // 因此不会引入同分区 journal 读改写竞争）。`readBackup` 读的是另一条
  // 「最近一份」通道（writeBackup），这里如实按写入的那条通道校验。
  const versioned = await fx.store.listVersionedBackups(token(i, 'alpha'))
  if (versioned.length !== 1 || versioned[0]?.version !== `1.0.${i}`) {
    recordViolation('backup-versions', i, stable(versioned.map((row) => row.version)))
  }
  const backupFile = versioned[0]?.file
  if (backupFile !== undefined) {
    try {
      const stored = JSON.parse(readFileSync(backupFile, 'utf8')) as { config?: { partition?: number } }
      if (stored.config?.partition !== i) recordViolation('backup-content', i, stable(stored.config))
    } catch {
      recordViolation('backup-content', i, `备份文件不可解析: ${backupFile}`)
    }
  }

  // 物理隔离的否定性证据：字节层面不得出现别人的标记。
  for (const hit of foreignTokenHits(fx.dir, i, PARTITION_COUNT, token)) {
    recordViolation('foreign-token-on-disk', i, hit)
  }
}

/** revision 的装配与 `Guard.currentRevision()` 逐字段同源（不能用测试自造的事实）。 */
async function revisionOf(fx: PartitionFixture): Promise<string> {
  const state = await fx.store.readState()
  const decision = fx.store.readDecisionSync()
  const tail = fx.store.readJournalSync(1)
  const facts: RevisionFacts = {
    crashSeq: state.crashSeq,
    stabilized: state.stabilized,
    decisionDisable: decision?.disable ?? [],
    journalTail: tail.length > 0 ? (tail[tail.length - 1]?.t ?? '') : '',
    autoDisabled: state.autoDisabled.map((entry) => entry.name),
    restored: state.restored,
  }
  return computeRevision(facts)
}

// ─────────────────────────── 跨进程 worker ───────────────────────────

/**
 * 子进程 worker 源码（运行时写到临时目录，不落仓库）。
 *
 * 为什么必须跨进程：`writePointer` / `writePartitionIndex` / `writeDecisionSync`
 * 都是 `writeFileSync`（open 'w' 截断 + write），在同一进程里同步段天然互斥
 * ⇒ 只跑 Promise.all 会得到「指针永不撕裂」的假绿。只有两个 OS 进程同时
 * 截断同一文件，才会出现「读到 0 字节 / 半截 JSON」的真实窗口。
 */
const WORKER_SOURCE = [
  "const { pathToFileURL } = await import('node:url')",
  'const payload = JSON.parse(process.argv[2])',
  'const src = (name) => pathToFileURL(payload.projectRoot + "/src/host/" + name).href',
  "const { Store } = await import(src('data/store.ts'))",
  "const { writePointer } = await import(src('guard/decision.ts'))",
  "const { readPartitionIndex, registerPartition, writePartitionIndex } = await import(src('core/isolation.ts'))",
  'const store = new Store(payload.profileDir, payload.key)',
  'await store.init()',
  'await store.append(payload.events)',
  'await store.updateState((state) => ({ ...state, ...payload.state }))',
  'store.writeDecisionSync(payload.decision)',
  'store.writeCooccurrenceSync(payload.cooccurrence)',
  '// 指针竞态窗口：重复写指针，放大「另一个进程正在截断/写入」的交叠概率。',
  'for (let round = 0; round < 12; round += 1) {',
  '  writePointer(payload.profileDir, payload.key, store.partitionPath)',
  '  await new Promise((resolve) => setTimeout(resolve, 1))',
  '}',
  'const next = registerPartition(readPartitionIndex(payload.profileDir), payload.workspace)',
  'writePartitionIndex(payload.profileDir, next.index)',
  'console.log(JSON.stringify({ ok: true, key: payload.key }))',
  'process.exit(0)',
].join('\n')

interface WorkerResult {
  code: number | null
  out: string
  err: string
}

function runWorker(workerPath: string, payload: unknown, timeoutMs = 30_000): Promise<WorkerResult> {
  return new Promise<WorkerResult>((done) => {
    const child = spawn(process.execPath, [TSX_CLI, workerPath, JSON.stringify(payload)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(PROJECT_ROOT, 'tsconfig.json') },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    let settled = false
    const settle = (result: WorkerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      settle({ code: null, out, err: `${err}\n[timeout ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => settle({ code: null, out, err: `${err}${error.message}` }))
    child.on('close', (code: number | null) => settle({ code, out, err }))
  })
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rg-isolation-parallel-'))
  const profileDir = join(root, 'profile')
  const xprocProfileDir = join(root, 'profile-xproc')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(xprocProfileDir, { recursive: true })
  console.log(`\n临时根目录: ${root}`)
  console.log(`分区数: ${PARTITION_COUNT} (Promise.all) + ${XPROC_PARTITION_COUNT} (真实子进程)`)

  try {
    const workspaces = Array.from({ length: PARTITION_COUNT }, (_, i) => `D:/Projects/isolation-par/${i}`)
    const fixtures: PartitionFixture[] = workspaces.map((workspace, index) => {
      const key = projectKey(workspace)
      const store = new Store(profileDir, key)
      return { index, workspace, key, dir: store.partitionPath, store }
    })

    console.log('\n== B1 分区键与目录：一工作区一键一目录 ==')
    check('N 个分区键两两不同', new Set(fixtures.map((fx) => fx.key)).size === PARTITION_COUNT, fixtures.map((fx) => fx.key))
    check('N 个分区目录两两不同', new Set(fixtures.map((fx) => fx.dir)).size === PARTITION_COUNT)
    check(
      'Store 目录 == isolation.partitionDir（布局单一真相源）',
      fixtures.every((fx) => resolve(fx.dir) === resolve(partitionDir(profileDir, fx.key))),
    )
    check('测试未触碰 ~/.dsh/profiles（根目录在系统临时区）', !root.includes('.dsh'), root)

    console.log('\n== B2 真并发写矩阵（Promise.all + 双栅栏）==')
    // 初始化是所有写的前置条件：withFileLock 的锁文件建在分区目录里，
    // 父目录不存在时 updateState 会直接 ENOENT。这里 6 个分区**同时** init，
    // 但每个分区内部走的是 Store.init 自己的顺序，不是测试造出的假并发。
    const initGate = barrier(PARTITION_COUNT)
    const initMeter = inFlightMeter()
    await Promise.all(
      fixtures.map(async (fx) => {
        await initGate()
        initMeter.enter()
        try {
          await fx.store.init()
        } finally {
          initMeter.leave()
        }
      }),
    )
    check(`6 个分区同时初始化（实测 max=${initMeter.max}）`, initMeter.max >= PARTITION_COUNT, initMeter.max)
    check('每个分区目录都已创建', fixtures.every((fx) => existsSync(fx.dir)))

    const writeGate = barrier(PARTITION_COUNT)
    const syncGate = barrier(PARTITION_COUNT)
    const writeMeter = inFlightMeter()
    const writeStarted = Date.now()
    await Promise.all(
      fixtures.map((fx) => writePartition(fx, profileDir, writeGate, syncGate, writeMeter)),
    )
    const writeElapsed = Date.now() - writeStarted
    check(`6 个分区同时有写操作在飞（实测 max=${writeMeter.max}）`, writeMeter.max >= PARTITION_COUNT, writeMeter.max)
    check('写矩阵在 10s 内完成（无死锁）', writeElapsed < 10_000, `${writeElapsed}ms`)

    console.log('\n== B3 读回隔离：每个分区只看见自己的事实 ==')
    const readGate = barrier(PARTITION_COUNT)
    await Promise.all(
      fixtures.map(async (fx) => {
        await readGate()
        await verifyPartition(fx)
      }),
    )
    console.log(`  数据通道隔离违例（中途实时打印）: ${violations.length}`)

    console.log('\n== B4 profile 根目录不得出现全局状态产物 ==')
    const rootEntries = readdirSync(join(profileDir, '.recency-guard')).sort()
    check(
      '根目录只有 projects/ 与分区索引、指针',
      stable(rootEntries.filter((name) => !name.endsWith('.lock'))) === stable(['current.json', 'partitions.json', 'projects']),
      rootEntries,
    )
    for (const forbidden of ['journal.jsonl', 'state.json', 'decision.json', 'snapshot.json', 'cooccurrence.json']) {
      check(`根目录不存在 ${forbidden}`, !rootEntries.includes(forbidden))
    }
    const index = readPartitionIndex(profileDir)
    check('分区索引登记了全部 6 个分区', index.partitions.length === PARTITION_COUNT, index.partitions.length)
    check(
      '分区索引的键与工作区一一对应',
      stable(index.partitions.map((p) => p.key).sort()) === stable(fixtures.map((fx) => fx.key).sort()),
    )

    console.log('\n== B5 并发确定性：同一事实并发重复读逐字节一致（无撕裂读）==')
    for (const fx of fixtures) {
      const readOnce = async (): Promise<string> =>
        stable({
          state: await fx.store.readState(),
          journal: await fx.store.readJournal(100),
          snapshot: fx.store.readSnapshotSync(),
          decision: fx.store.readDecisionSync(),
          observation: Object.fromEntries(fx.store.readObservationSnapshotSync('official')),
          cooccurrence: fx.store.readCooccurrenceSync(),
        })
      const samples = await Promise.all(Array.from({ length: 8 }, () => readOnce()))
      const identical = samples.every((sample) => sample === samples[0])
      check(`分区 ${fx.index} 的 8 次并发读逐字节一致`, identical)
    }

    console.log('\n== B6 revision：不同分区事实不同 ⇒ revision 必然不同（且确定）==')
    const revisions = await Promise.all(fixtures.map((fx) => revisionOf(fx)))
    check('6 个分区得到 6 个互不相同的 revision', new Set(revisions).size === PARTITION_COUNT, revisions)
    const repeated = await Promise.all(fixtures.map((fx) => revisionOf(fx)))
    check('同一分区重复计算 revision 稳定（无并发漂移）', stable(repeated) === stable(revisions))
    check('revision 是 12 位短哈希', revisions.every((rev) => /^[0-9a-f]{12}$/.test(rev)), revisions[0])

    console.log('\n== B7 指针桥：分区路径直读归属正确，共享指针如实度量 ==')
    const pointerFile = pointerPath(profileDir)
    check('指针文件是 profile 级唯一一份', existsSync(pointerFile))
    check(
      '指针路径与任何分区决策文件都不同',
      fixtures.every((fx) => resolve(pointerFile) !== resolve(decisionPath(fx.dir))),
    )
    for (const fx of fixtures) {
      const direct = readDecision(fx.dir)
      check(
        `分区 ${fx.index} 直读决策只含自己（分区目录寻址）`,
        direct !== null && direct.disable.length === 1 && direct.disable[0] === token(fx.index, 'disable'),
        direct?.disable,
      )
    }
    const pointer = readPointer(profileDir)
    check('并发写指针后仍能解析出合法指针（无撕裂）', pointer !== null, pointer)
    check('指针的 partitionKey 指向真实存在的分区', pointer !== null && fixtures.some((fx) => fx.key === pointer.partitionKey), pointer?.partitionKey)
    const pointerDecisionFile = pointer ? resolve(profileDir, pointer.decisionPath) : ''
    const pointerOwner = pointer ? fixtures.find((fx) => fx.key === pointer.partitionKey) : undefined
    check(
      '指针 decisionPath 指向该分区的决策文件',
      pointerOwner !== undefined && pointerDecisionFile.toLowerCase() === resolve(decisionPath(pointerOwner.dir)).toLowerCase(),
      pointerDecisionFile,
    )
    check('指针指向的决策文件真实存在', pointerDecisionFile !== '' && existsSync(pointerDecisionFile))

    // 守护行表达式的真实语义：读指针 → 读它指向的决策。
    // 稳态下指针只有一个目标 ⇒ 至多 1 个分区读到自己，其余 N-1 读到别人。
    // 这是 decision.ts 头注登记的**已知边界**，此处如实计数而非掩盖。
    let pointerSelfReads = 0
    let pointerForeignReads = 0
    for (const fx of fixtures) {
      const viaBridge = pointerDecisionFile !== '' && existsSync(pointerDecisionFile) ? JSON.parse(readFileSync(pointerDecisionFile, 'utf8')) as { disable?: string[] } : null
      const bridgeDisables = Array.isArray(viaBridge?.disable) ? viaBridge.disable : []
      if (bridgeDisables.includes(token(fx.index, 'disable'))) pointerSelfReads += 1
      else pointerForeignReads += 1
    }
    console.log(`  指针桥读数：自读 ${pointerSelfReads} / 跨分区读 ${pointerForeignReads}（已知边界，非数据通道违例）`)
    check('指针桥恰好让 1 个分区（最后写入者）读到自己', pointerSelfReads === 1, { pointerSelfReads, pointerForeignReads })
    check(
      '指针桥的跨分区读取不超过 N-1（未出现额外串扰）',
      pointerForeignReads === PARTITION_COUNT - 1,
      { pointerForeignReads: pointerForeignReads },
    )
    check(
      '指针未把任何分区引向不存在的决策文件（否则表达式会静默放行）',
      pointerForeignReads + pointerSelfReads === PARTITION_COUNT && pointerDecisionFile !== '',
      { pointerDecisionFile },
    )

    console.log('\n== B8 跨分区锁互不干扰（6 分区 × 8 轮并发 updateState）==')
    const lockMeter = inFlightMeter()
    const rootLockSamples: string[] = []
    const monitor = setInterval(() => {
      try {
        for (const name of readdirSync(join(profileDir, '.recency-guard'))) {
          if (name.endsWith('.lock')) rootLockSamples.push(name)
        }
      } catch {
        /* 目录瞬态不可读不算问题 */
      }
    }, 2)
    const lockStarted = Date.now()
    await Promise.all(
      fixtures.flatMap((fx) =>
        Array.from({ length: LOCK_ROUNDS }, async () => {
          lockMeter.enter()
          try {
            await fx.store.updateState((state) => ({ ...state, crashSeq: state.crashSeq + 1 }))
          } finally {
            lockMeter.leave()
          }
        }),
      ),
    )
    clearInterval(monitor)
    const lockElapsed = Date.now() - lockStarted
    check(`并发 updateState 确实交叠（实测 max=${lockMeter.max}）`, lockMeter.max >= PARTITION_COUNT, lockMeter.max)
    check('锁竞争在 10s 内完成（无锁超时/死锁）', lockElapsed < 10_000, `${lockElapsed}ms`)
    for (const fx of fixtures) {
      const state = await fx.store.readState()
      const expectedSeq = fx.index + 1 + LOCK_ROUNDS
      check(`分区 ${fx.index} 的 ${LOCK_ROUNDS} 次自增一次不丢（最终 crashSeq=${state.crashSeq}）`, state.crashSeq === expectedSeq, { expected: expectedSeq, actual: state.crashSeq })
      const leftoverLocks = readdirSync(fx.dir).filter((name) => name.endsWith('.lock'))
      check(`分区 ${fx.index} 的写锁已全部释放`, leftoverLocks.length === 0, leftoverLocks)
    }
    check('profile 根目录从未出现锁文件（锁严格分区化）', rootLockSamples.length === 0, rootLockSamples.slice(0, 5))

    console.log('\n== B9 落盘否定性证据（锁与并发都结束后再扫一次）==')
    for (const fx of fixtures) {
      const hits = foreignTokenHits(fx.dir, fx.index, PARTITION_COUNT, token)
      check(`分区 ${fx.index} 的磁盘上没有任何其它分区标记`, hits.length === 0, hits)
    }
    console.log(`  数据通道隔离违例累计: ${violations.length}`)
    check('数据通道隔离违例数 == 0', violations.length === 0, violations)

    // ─────────── 跨进程：真实的 OS 级并发 ───────────
    console.log('\n== C1 真实多进程并发（4 个子进程同一 profile）==')
    check('tsx CLI 存在（子进程运行前提）', existsSync(TSX_CLI), TSX_CLI)
    const workerPath = join(root, 'parallel-worker.mjs')
    writeFileSync(workerPath, WORKER_SOURCE, 'utf8')

    const xWorkspaces = Array.from({ length: XPROC_PARTITION_COUNT }, (_, i) => `D:/Projects/isolation-xproc/${i}`)
    const xFixtures = xWorkspaces.map((workspace, index) => {
      const key = projectKey(workspace)
      const store = new Store(xprocProfileDir, key)
      return { index, workspace, key, dir: store.partitionPath, store }
    })
    const xPayloads = xFixtures.map((fx) => ({
      projectRoot: PROJECT_ROOT,
      profileDir: xprocProfileDir,
      key: fx.key,
      workspace: fx.workspace,
      i: fx.index,
      events: [
        { kind: 'install', bundle: xToken(fx.index, 'alpha'), version: `5.0.${fx.index}`, partition: fx.index },
        { kind: 'crash-detected', detail: `xproc-${fx.index}`, partition: fx.index },
      ],
      state: stateFixture(fx.index),
      decision: { ...decisionFixture(fx.index), disable: [xToken(fx.index, 'disable')], suspects: [{ bundle: xToken(fx.index, 'alpha'), version: `5.0.${fx.index}`, lastChangeAt: FIXED_AT }] },
      cooccurrence: { schemaVersion: 1, samples: [{ at: FIXED_AT, officialActive: [xToken(fx.index, 'official')], suspects: [xToken(fx.index, 'alpha')], disabled: [xToken(fx.index, 'disable')] }] },
    }))

    // 父进程在子进程写指针的同时持续采样：专门抓「截断窗口读到的撕裂指针」。
    const pointerStats: {
      samples: number
      missing: number
      empty: number
      parseErrors: number
      noDecisionPath: number
      ok: number
      firstTorn: { at: string; bytes: number; content: string } | null
    } = { samples: 0, missing: 0, empty: 0, parseErrors: 0, noDecisionPath: 0, ok: 0, firstTorn: null }
    let sampling = true
    const samplePointer = (): void => {
      pointerStats.samples += 1
      let raw: string
      try {
        raw = readFileSync(pointerPath(xprocProfileDir), 'utf8')
      } catch {
        pointerStats.missing += 1
        return
      }
      if (raw.trim() === '') {
        pointerStats.empty += 1
        if (pointerStats.firstTorn === null) {
          pointerStats.firstTorn = { at: new Date().toISOString(), bytes: Buffer.byteLength(raw, 'utf8'), content: raw }
        }
        return
      }
      let parsed: { decisionPath?: unknown }
      try {
        parsed = JSON.parse(raw) as { decisionPath?: unknown }
      } catch {
        pointerStats.parseErrors += 1
        if (pointerStats.firstTorn === null) {
          pointerStats.firstTorn = { at: new Date().toISOString(), bytes: Buffer.byteLength(raw, 'utf8'), content: raw.slice(0, 200) }
        }
        return
      }
      if (typeof parsed.decisionPath !== 'string') pointerStats.noDecisionPath += 1
      else pointerStats.ok += 1
    }
    // 守护行表达式实际消费的是两样东西：指针 → 它指向的**决策文件**。
    // 两个写者都是 `writeFileSync`（先截断后写），所以撕裂风险不止指针：
    // 决策文件被读到 0 字节/半数组时，表达式同样 catch ⇒ 放行。
    const decisionStats = { samples: 0, missing: 0, empty: 0, invalid: 0, parseErrors: 0, ok: 0, firstTorn: null as string | null }
    const sampleDecisions = (): void => {
      for (const fx of xFixtures) {
        decisionStats.samples += 1
        let raw: string
        try {
          raw = readFileSync(join(fx.dir, 'decision.json'), 'utf8')
        } catch {
          decisionStats.missing += 1
          continue
        }
        if (raw.trim() === '') {
          decisionStats.empty += 1
          decisionStats.firstTorn ??= JSON.stringify({ file: fx.dir, bytes: 0, content: '' })
          continue
        }
        try {
          const parsed = JSON.parse(raw) as { disable?: unknown }
          if (!Array.isArray(parsed.disable)) {
            decisionStats.invalid += 1
            decisionStats.firstTorn ??= JSON.stringify({ file: fx.dir, bytes: Buffer.byteLength(raw, 'utf8'), content: raw.slice(0, 120) })
          } else decisionStats.ok += 1
        } catch {
          decisionStats.parseErrors += 1
          decisionStats.firstTorn ??= JSON.stringify({ file: fx.dir, bytes: Buffer.byteLength(raw, 'utf8'), content: raw.slice(0, 120) })
        }
      }
    }
    const sampler = (async (): Promise<void> => {
      while (sampling) {
        samplePointer()
        sampleDecisions()
        await new Promise<void>((wake) => setImmediate(wake))
      }
    })()

    const xStarted = Date.now()
    const results = await Promise.all(xPayloads.map((payload) => runWorker(workerPath, payload)))
    sampling = false
    await sampler
    const xElapsed = Date.now() - xStarted
    check(`4 个子进程全部正常退出（${xElapsed}ms）`, results.every((result) => result.code === 0), results.map((result) => ({ code: result.code, err: result.err.slice(0, 200) })))
    check('每个子进程都报告 ok:true', results.every((result) => {
      try {
        return (JSON.parse(result.out.trim().split('\n').pop() ?? '{}') as { ok?: boolean }).ok === true
      } catch {
        return false
      }
    }), results.map((result) => result.out.slice(-120)))

    console.log('\n== C2 跨进程后：数据通道仍只含自己的事实 ==')
    for (const fx of xFixtures) {
      const journal = await fx.store.readJournal(100)
      check(`子进程分区 ${fx.index} 的 journal 只有自己的 2 行`, journal.length === 2 && journal.every((record) => record.partition === fx.index), journal.map((record) => record.partition))
      const state = await fx.store.readState()
      check(`子进程分区 ${fx.index} 的 state 是自己的 crashSeq=${fx.index + 1}`, state.crashSeq === fx.index + 1, state.crashSeq)
      const decision = await Promise.resolve(fx.store.readDecisionSync())
      check(
        `子进程分区 ${fx.index} 的决策只含自己`,
        decision !== null && stable(decision.disable) === stable([xToken(fx.index, 'disable')]),
        decision?.disable,
      )
      const direct = readDecision(fx.dir)
      check(`子进程分区 ${fx.index} 按分区目录直读仍正确`, direct !== null && stable(direct.disable) === stable([xToken(fx.index, 'disable')]))
      const hits = foreignTokenHits(fx.dir, fx.index, XPROC_PARTITION_COUNT, xToken)
      check(`子进程分区 ${fx.index} 磁盘上无其它子进程标记`, hits.length === 0, hits)
    }

    console.log('\n== C3 指针/决策在真实并发下的观测（如实打印，不作美化）==')
    console.log(
      `  采样 ${pointerStats.samples} 次：合法 ${pointerStats.ok} / 空文件 ${pointerStats.empty} / 解析失败 ${pointerStats.parseErrors} / 缺字段 ${pointerStats.noDecisionPath} / 不存在 ${pointerStats.missing}`,
    )
    console.log(
      `  决策文件采样 ${decisionStats.samples} 次：合法 ${decisionStats.ok} / 空文件 ${decisionStats.empty} / 缺 disable ${decisionStats.invalid} / 解析失败 ${decisionStats.parseErrors} / 尚未创建 ${decisionStats.missing}`,
    )
    if (decisionStats.firstTorn !== null) console.log(`  首次决策撕裂证据: ${decisionStats.firstTorn}`)
    const afterXPointer = readPointer(xprocProfileDir)
    check('子进程全部退出后指针可解析（静默态无撕裂）', afterXPointer !== null, afterXPointer)
    check('静默态指针指向 4 个真实分区之一', afterXPointer !== null && xFixtures.some((fx) => fx.key === afterXPointer.partitionKey), afterXPointer?.partitionKey)
    const afterXDecisionFile = afterXPointer ? resolve(xprocProfileDir, afterXPointer.decisionPath) : ''
    check('静默态指针指向的决策文件存在', afterXDecisionFile !== '' && existsSync(afterXDecisionFile))
    if (pointerStats.firstTorn !== null) {
      console.log(`  首次撕裂证据: ${JSON.stringify(pointerStats.firstTorn)}`)
      console.log(
        `  REAL FINDING（已实测，非推断）: 指针用 writeFileSync 写（decision.ts writeSafe：open 'w' 截断 → write），不是 rename 原子提交；跨进程并发下实测读到 0 字节指针 ${pointerStats.empty} 次（采样 ${pointerStats.samples} 次）。守护行表达式对空指针 catch ⇒ 返回 false（放行），代价是该轮守护整体失效（回到崩溃重演）。生产调用路径同构：Guard.publishDecisionOnCrash / publishDecision（index.ts:927/971、1243/1252）= writeDecisionSync 紧跟 writePointer。注意：worker 重复写指针 12 次是为了放大窗口（生产每次崩溃/恢复只写一次），因此实测频率不代表生产频率，但**非原子写者本身**是生产代码。复制方式：npx tsx tests/host/isolation-parallel.test.ts 的 C1/C3 段。真实场景：同一 profile 起 2 个 dsh 进程、各自工作区不同。决策文件用同一个非原子写者（store.writeDecisionSync），类别相同；本轮 ${decisionStats.samples} 次采样未观测到撕裂，如实记录为「未观测到」而非「不存在」。修复方向（未改 src，超出本任务写入范围）：指针与决策改用 writeFileAtomic。`,
      )
    }
    check(
      '指针/决策的撕裂只出现在采样窗口内，静默态必须干净（否则守护行会随机放行）',
      afterXPointer !== null && existsSync(afterXDecisionFile),
    )
    check('跨进程静默态：4 个决策文件都可解析且 disable 是数组', xFixtures.every((fx) => {
      try {
        const parsed = JSON.parse(readFileSync(join(fx.dir, 'decision.json'), 'utf8')) as { disable?: unknown }
        return Array.isArray(parsed.disable)
      } catch {
        return false
      }
    }))

    console.log('\n== C4 跨进程分区索引（共享结构的诚实度量）==')
    const xIndex = readPartitionIndex(xprocProfileDir)
    console.log(`  4 个子进程并发登记后索引条目数: ${xIndex.partitions.length}/${XPROC_PARTITION_COUNT}`)
    if (xIndex.partitions.length < XPROC_PARTITION_COUNT) {
      console.log(
        '  REAL FINDING: 分区索引是 read-modify-write 且无锁（isolation.ts writePartitionIndex），跨进程并发登记会丢失条目 ⇒ 面板看不到其它工作区。复现见 C1 段。',
      )
    }
    check('分区索引至少保留了 1 个条目（未整体损坏）', xIndex.partitions.length >= 1, xIndex.partitions.length)
    check('分区索引文件本身可解析（schemaVersion==1）', xIndex.schemaVersion === 1)

    console.log('\n== 结论 ==')
    console.log(`  分区数：${PARTITION_COUNT}（Promise.all 并发）+ ${XPROC_PARTITION_COUNT}（真实子进程）`)
    console.log(`  隔离违例数（数据通道）: ${violations.length}`)
    console.log(`  指针桥跨分区读取: ${pointerForeignReads}/${PARTITION_COUNT}（已知边界，decision.ts 头注登记）`)
    console.log(`  revision 跨分区唯一: ${new Set(revisions).size}/${PARTITION_COUNT}`)
    console.log(`  跨进程分区索引条目: ${xIndex.partitions.length}/${XPROC_PARTITION_COUNT}（少于 ${XPROC_PARTITION_COUNT} 即共享索引丢条目，见 C4）`)
    console.log(`  跨进程指针采样: ${pointerStats.samples} 次，撕裂 ${pointerStats.empty + pointerStats.parseErrors + pointerStats.noDecisionPath} 次`)
    console.log(`  跨进程决策文件采样: ${decisionStats.samples} 次，撕裂 ${decisionStats.empty + decisionStats.invalid + decisionStats.parseErrors} 次`)
    check('全部隔离违例为 0（E4.3 判据）', violations.length === 0, violations.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
    check('临时目录已清理（未残留 mkdtemp）', !existsSync(root), root)
  }

  console.log(failures === 0 ? '\nisolation-parallel 全部通过\n' : `\n${failures} 个断言失败\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()