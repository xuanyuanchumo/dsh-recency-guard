/**
 * 离线逃生通道的可写模式（T14-07 判据 7）。
 *
 * ## 要钉住的东西
 *
 * 1. **默认只读**：`status` / 不带 `--yes` 的 `apply` 绝不改 profile；
 * 2. **两阶段**：`apply --yes` 后记录里有 beforeHash/afterHash/原 index，
 *    且当前 package.json 的哈希 == afterHash（证明第二步真的发生了）；
 * 3. **精确回插**：`restore --yes` 后 bundles 的顺序与隔离前**逐位相同**
 *    （不是「加回去就完事」—— 顺序影响加载顺序，也影响用户对 profile 的认知）；
 * 4. **中断恢复**：记录 `prepared` 但文件已是 `afterHash` ⇒ `restore --resume`
 *    按「中断后已生效」处理；记录 `prepared` 且文件还是 `beforeHash`
 *    ⇒ 拒绝（exit 3），不动 profile；
 * 5. **篡改检测**：before 与 beforeHash 不一致 ⇒ 拒绝。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const RESCUE = join(PROJECT_ROOT, 'bin', 'rescue.mjs')

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function run(args: string[]): { code: number; out: string } {
  const result = spawnSync(process.execPath, [RESCUE, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** 读 bundles 列表。 */
function bundlesOf(profile: string): string[] {
  const manifest = readJson(join(profile, 'package.json'))
  return (manifest as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
}

/** 造一个最小可用 profile（含分区索引与决策文件）。 */
function makeProfile(bundles: string[], disable: string[]): string {
  const profile = mkdtempSync(join(tmpdir(), 'rg-rescue-'))
  writeFileSync(
    join(profile, 'package.json'),
    `${JSON.stringify({ name: 'sandbox-profile', dsh: { profile: { bundles } } }, null, 2)}\n`,
    'utf8',
  )
  const guard = join(profile, '.recency-guard')
  const partitionDir = join(guard, 'projects', 'part-a')
  mkdirSync(partitionDir, { recursive: true })
  writeFileSync(
    join(guard, 'partitions.json'),
    JSON.stringify({ schemaVersion: 1, partitions: [{ key: 'part-a', workspace: 'D:/ws', label: 'ws', firstSeenAt: 't', lastSeenAt: 't' }] }),
    'utf8',
  )
  writeFileSync(join(partitionDir, 'decision.json'), JSON.stringify({ capturedAt: 't', suspects: [], disable, reason: 'crash-recovery' }), 'utf8')
  return profile
}

function main() {
  console.log('\n== 默认只读：status 与 dry-run 都不写盘 ==')
  {
    const profile = makeProfile(['a', 'b', 'c', 'd'], ['b'])
    try {
      const before = sha(readFileSync(join(profile, 'package.json'), 'utf8'))
      const status = run(['status', '--profile-dir', profile])
      check('status exits 0', status.code === 0, status.code)
      check('status does not write package.json', sha(readFileSync(join(profile, 'package.json'), 'utf8')) === before)

      const dry = run(['apply', '--profile-dir', profile])
      check('apply without --yes is a dry run (exit 0)', dry.code === 0, dry.code)
      check('dry run says it will isolate', dry.out.includes('拟隔离'), dry.out)
      check('dry run does not write package.json', sha(readFileSync(join(profile, 'package.json'), 'utf8')) === before)
      check('dry run leaves bundles intact', JSON.stringify(bundlesOf(profile)) === JSON.stringify(['a', 'b', 'c', 'd']), bundlesOf(profile))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 两阶段 apply ==')
  const profile = makeProfile(['a', 'b', 'c', 'd'], ['b'])
  try {
    const beforeText = readFileSync(join(profile, 'package.json'), 'utf8')
    const applied = run(['apply', '--profile-dir', profile, '--reason', '测试隔离', '--yes'])
    check('apply --yes exits 0', applied.code === 0, applied.out)
    check('bundles lost exactly the target', JSON.stringify(bundlesOf(profile)) === JSON.stringify(['a', 'c', 'd']), bundlesOf(profile))

    const recordsDir = join(profile, '.recency-guard', 'rescue')
    // 取唯一一条记录（文件名就是 uuid.json）。
    const files = readdirSync(recordsDir).filter((name) => name.endsWith('.json'))
    check('apply writes exactly one rescue record', files.length === 1, files)
    const record = readJson(join(recordsDir, files[0] as string))
    check('record status is applied', record.status === 'applied', record.status)
    check('record has beforeHash', typeof record.beforeHash === 'string' && (record.beforeHash as string).length === 64)
    check('record has afterHash', typeof record.afterHash === 'string' && (record.afterHash as string).length === 64)
    check('beforeHash matches the pre-apply text', record.beforeHash === sha(beforeText))
    check('afterHash matches the current text', record.afterHash === sha(readFileSync(join(profile, 'package.json'), 'utf8')))
    const removed = record.removed as Array<{ name: string; index: number }>
    check('record keeps the original index', removed.length === 1 && removed[0].name === 'b' && removed[0].index === 1, removed)
    check('record keeps the reason', record.reason === '测试隔离', record.reason)

    console.log('\n== restore：按原 index 精确回插 ==')
    const dryRestore = run(['restore', '--profile-dir', profile])
    check('restore without --yes is a dry run', dryRestore.code === 0 && dryRestore.out.includes('dry-run'), dryRestore.out)
    check('dry restore does not touch package.json', JSON.stringify(bundlesOf(profile)) === JSON.stringify(['a', 'c', 'd']))

    const restored = run(['restore', '--profile-dir', profile, '--yes'])
    check('restore --yes exits 0', restored.code === 0, restored.out)
    check('bundles are back in the exact original order', JSON.stringify(bundlesOf(profile)) === JSON.stringify(['a', 'b', 'c', 'd']), bundlesOf(profile))
    check('restored text is byte-identical to before', readFileSync(join(profile, 'package.json'), 'utf8') === beforeText)
    const afterRecord = readJson(join(recordsDir, files[0] as string))
    check('record status is restored', afterRecord.status === 'restored', afterRecord.status)
    check('restore twice is a no-op (idempotent)', run(['restore', '--profile-dir', profile, '--id', String(record.id), '--yes']).code === 0)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }

  console.log('\n== 中断恢复：prepared 记录 + 文件已是 afterHash ==')
  {
    const profile = makeProfile(['a', 'b', 'c'], [])
    try {
      const beforeText = readFileSync(join(profile, 'package.json'), 'utf8')
      // 模拟「第一步写完记录、第二步已改文件、第三步标 applied 前被杀」。
      const afterManifest = { name: 'sandbox-profile', dsh: { profile: { bundles: ['a', 'c'] } } }
      const afterText = `${JSON.stringify(afterManifest, null, 2)}\n`
      writeFileSync(join(profile, 'package.json'), afterText, 'utf8')
      const recordsDir = join(profile, '.recency-guard', 'rescue')
      mkdirSync(recordsDir, { recursive: true })
      writeFileSync(
        join(recordsDir, 'interrupted.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: '00000000-0000-4000-8000-000000000001',
          directory: resolve(profile),
          createdAt: '2026-11-11T00:00:00.000Z',
          removed: [{ name: 'b', index: 1 }],
          before: beforeText,
          beforeHash: sha(beforeText),
          afterHash: sha(afterText),
          status: 'prepared',
        }),
        'utf8',
      )
      const resume = run(['restore', '--profile-dir', profile, '--resume', '--yes'])
      check('interrupted resume exits 0', resume.code === 0, resume.out)
      check('interrupted resume detects the write already happened', resume.out.includes('中断后已生效'), resume.out)
      check('interrupted resume re-inserts at the original index', JSON.stringify(bundlesOf(profile)) === JSON.stringify(['a', 'b', 'c']), bundlesOf(profile))
      check('interrupted resume restores byte-identically', readFileSync(join(profile, 'package.json'), 'utf8') === beforeText)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 拒绝路径：第二步没发生 / 记录被篡改 ==')
  {
    const profile = makeProfile(['a', 'b'], [])
    try {
      const beforeText = readFileSync(join(profile, 'package.json'), 'utf8')
      const afterText = `${JSON.stringify({ name: 'sandbox-profile', dsh: { profile: { bundles: ['a'] } } }, null, 2)}\n`
      const recordsDir = join(profile, '.recency-guard', 'rescue')
      mkdirSync(recordsDir, { recursive: true })
      writeFileSync(
        join(recordsDir, 'never-applied.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: '00000000-0000-4000-8000-000000000002',
          directory: resolve(profile),
          createdAt: '2026-11-11T00:00:00.000Z',
          removed: [{ name: 'b', index: 1 }],
          before: beforeText,
          beforeHash: sha(beforeText),
          afterHash: sha(afterText),
          status: 'prepared',
        }),
        'utf8',
      )
      // 文件仍是 before ⇒ 第二步没发生 ⇒ 拒绝（exit 3），不改文件。
      const refused = run(['restore', '--profile-dir', profile, '--resume', '--yes'])
      check('prepared-but-not-applied is refused', refused.code === 3, refused.code)
      check('refused path leaves the profile untouched', sha(readFileSync(join(profile, 'package.json'), 'utf8')) === sha(beforeText))

      // 篡改：before 与 beforeHash 不一致。
      writeFileSync(
        join(recordsDir, 'tampered.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: '00000000-0000-4000-8000-000000000003',
          directory: resolve(profile),
          createdAt: '2026-11-11T00:00:00.000Z',
          removed: [{ name: 'b', index: 1 }],
          before: '{"tampered":true}',
          beforeHash: sha(beforeText),
          afterHash: sha(afterText),
          status: 'applied',
        }),
        'utf8',
      )
      const tampered = run(['restore', '--profile-dir', profile, '--id', '00000000-0000-4000-8000-000000000003', '--yes'])
      check('tampered record is refused', tampered.code === 3, tampered.code)
      check('tampered record message names the hash check', tampered.out.includes('篡改'), tampered.out)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log('\n== 未知命令与缺参数 ==')
  {
    const profile = makeProfile(['a'], [])
    try {
      check('unknown command exits 1', run(['whatever', '--profile-dir', profile]).code === 1)
      check('missing --profile-dir exits 1', run(['status']).code === 1)
      const list = run(['rescues', '--profile-dir', profile])
      check('rescues lists nothing gracefully', list.code === 0 && list.out.includes('没有 rescue 记录'), list.out)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

Promise.resolve()
  .then(main)
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.log('  FAIL  harness crashed', String(error))
    process.exit(1)
  })