/**
 * 时间线备份（v0.8 备份增强）的回归。
 *
 * ## 被测对象
 *
 * `Store.writeVersionedBackup` / `listVersionedBackups` / `listVersionedBackupBundles`
 * —— 用户需求「记录插件更新的前后状态」的存储半部。更新检测半部在
 * `recordChanges`（集成路径，由 Host 测试覆盖）。
 *
 * ## 关键行为
 *
 * 1. 文件名 = `版本@时刻`：同一版本多次备份不互相覆盖（更新-回滚-再更新场景）。
 * 2. `retain` 按插件计数：装 30 个插件的 profile 不会互相挤占配额。
 * 3. 清单按插件聚合，报「保留几份 + 最新版本」：这是对账面，不是文件列表。
 * 4. 损坏文件不计入清单但**不删**：用户可能手工抢救。
 * 5. best-effort：目录不可写时返回 null，绝不抛 —— 备份不能中断更新检测主流程。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'rg-versioned-backup-'))
  try {
    console.log('\n== writeVersionedBackup: 基本写入与时间线 ==')
    {
      const store = new Store(root, 'p1')
      await store.init()
      const f1 = await store.writeVersionedBackup('dsh-ops', '0.4.3', { a: 1 })
      const f2 = await store.writeVersionedBackup('dsh-ops', '0.4.4', { a: 2 })
      check('first backup lands', typeof f1 === 'string' && existsSync(f1 ?? ''), f1)
      check('second backup lands', typeof f2 === 'string' && existsSync(f2 ?? ''), f2)
      check('filenames differ (version in name)', f1 !== f2, { f1, f2 })
      const rows = await store.listVersionedBackups('dsh-ops')
      check('timeline lists both, oldest first', rows.map((r) => r.version).join(',') === '0.4.3,0.4.4', rows)
      check('versions recorded verbatim', rows[0]?.version === '0.4.3' && rows[1]?.version === '0.4.4', rows)
      check('savedAt present', rows.every((r) => r.savedAt.length > 0), rows)
      // 同版本再来一份：文件名含时间戳 ⇒ 不覆盖
      const f3 = await store.writeVersionedBackup('dsh-ops', '0.4.4', { a: 3 })
      check('same version twice does not overwrite', typeof f3 === 'string' && f3 !== f2, { f2, f3 })
      const after = await store.listVersionedBackups('dsh-ops')
      check('all three remain', after.length === 3, after)
    }

    console.log('\n== retain：按插件计数，删最旧 ==')
    {
      const store = new Store(root, 'p2')
      await store.init()
      for (let i = 0; i < 7; i += 1) {
        await store.writeVersionedBackup('dsh-third-party', `1.${i}.0`, { seq: i }, { retain: 3 })
      }
      const rows = await store.listVersionedBackups('dsh-third-party')
      check('retain keeps the newest 3', rows.length === 3, rows.map((r) => r.version))
      check('the kept ones are the newest', rows.map((r) => r.version).join(',') === '1.4.0,1.5.0,1.6.0', rows.map((r) => r.version))
      // 另一个插件不受影响（按插件计数，不按全目录）
      await store.writeVersionedBackup('sage-mem', '2.1.0', {}, { retain: 3 })
      const other = await store.listVersionedBackups('sage-mem')
      check('another plugin keeps its own quota', other.length === 1, other)
    }

    console.log('\n== listVersionedBackupBundles：聚合对账面 ==')
    {
      const store = new Store(root, 'p3')
      await store.init()
      await store.writeVersionedBackup('dsh-ops', '0.4.3', {}, { retain: 5 })
      await store.writeVersionedBackup('dsh-ops', '0.4.4', {}, { retain: 5 })
      await store.writeVersionedBackup('sage-mem', '2.1.1', {}, { retain: 5 })
      const bundles = await store.listVersionedBackupBundles()
      check('aggregates by bundle', bundles.map((b) => b.bundle).join(',') === 'dsh-ops,sage-mem', bundles)
      const ops = bundles.find((b) => b.bundle === 'dsh-ops')
      check('count reflects both versions', ops?.count === 2, ops)
      check('latest version is the newest', ops?.latestVersion === '0.4.4', ops)
      check('latestAt present', typeof ops?.latestAt === 'string' && (ops?.latestAt ?? '').length > 0, ops)
    }

    console.log('\n== 损坏文件：不计入清单，不删除 ==')
    {
      const store = new Store(root, 'p4')
      await store.init()
      await store.writeVersionedBackup('dsh-ops', '0.4.3', {})
      const versionsDir = join(root, '.recency-guard', 'projects', 'p4', 'backups', 'versions', 'dsh-ops')
      const before = readdirSync(versionsDir)
      // 手工写一个损坏文件（模拟崩溃截断）
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(versionsDir, 'broken@2026-01-01T00-00-00-000Z.json'), '{ truncated', 'utf8')
      const rows = await store.listVersionedBackups('dsh-ops')
      check('corrupt file excluded from the listing', rows.length === 1 && rows[0]?.version === '0.4.3', rows)
      const after = readdirSync(versionsDir)
      check('corrupt file is NOT deleted (user may rescue it)', after.length === before.length + 1, { before: before.length, after: after.length })
      const bundles = await store.listVersionedBackupBundles()
      check('bundle aggregation skips corrupt-only data safely', bundles.every((b) => b.count > 0), bundles)
    }

    console.log('\n== 空态与旧 store 兼容 ==')
    {
      const store = new Store(root, 'p5')
      await store.init()
      check('empty timeline for unknown bundle', (await store.listVersionedBackups('never-seen')).length === 0)
      check('empty bundle list before any backup', (await store.listVersionedBackupBundles()).length === 0)
      // 不 init（旧分区目录形态）也不抛
      const raw = new Store(root, 'p6')
      check('listing without init returns empty (no throw)', (await raw.listVersionedBackupBundles()).length === 0)
    }

    console.log('\n== 自定义备份根：分区隔离保持 ==')
    {
      const customRoot = join(root, 'custom-backup-root')
      const store = new Store(root, 'p7', customRoot)
      await store.init()
      const file = await store.writeVersionedBackup('dsh-ops', '0.4.3', {})
      check('backup lands under the custom root', typeof file === 'string' && (file ?? '').includes('custom-backup-root'), file)
      check('partition key still namespaces inside the custom root', (file ?? '').includes('p7'), file)
      // 同一自定义根下，另一分区互不可见
      const other = new Store(root, 'p8', customRoot)
      await other.init()
      check('the other partition sees nothing of p7', (await other.listVersionedBackups('dsh-ops')).length === 0)
      // 默认位置的 store 也看不到自定义根里的东西
      const plain = new Store(root, 'p7')
      await plain.init()
      check('default-location store does not mix in custom-root data', (await plain.listVersionedBackups('dsh-ops')).length === 0)
      // 非绝对路径 / 空白回退默认
      const fallback = new Store(root, 'p9', 'not/absolute')
      await fallback.init()
      const f = await fallback.writeVersionedBackup('dsh-ops', '0.1.0', {})
      check('relative custom root falls back to the default location', typeof f === 'string' && (f ?? '').includes(join('.recency-guard', 'projects', 'p9')), f)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
