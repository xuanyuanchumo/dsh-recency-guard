/**
 * 文件名投影的路径安全（T15 真实缺陷修复：`sanitizeName` / `sanitize` 白名单含 `/`）。
 *
 * ## 缺陷回顾（实测）
 *
 * 旧白名单 `[^A-Za-z0-9._@/-]` **允许 `/`**，且 `..` 由两个合法字符组成、
 * 正则挡不住：
 * - `'@scope/pkg'` ⇒ `observation-@scope/pkg.json` —— 多出一层子目录；
 * - `'@a/../../escape'` ⇒ 跳出分区目录。
 *
 * 修法：先折叠分隔符 → 再折叠连续点 → 最后逐字替换。本文件钉四件事：
 * 1. 生成的文件名**不含**分隔符；
 * 2. 用 `path.relative` 判**不越出**根目录（不用字符串前缀比较 —— 大小写/
 *    分隔符/`..` 任何一项都会让字符串比较说谎）；
 * 3. 折叠 `..` **不引入**「两个不同名映射到同一文件」的冲突（抽查关键对：
 *    `'@a/../b'` vs `'@a/b'`）；
 * 4. 两份独立实现（observation 与备份）**投影一致** —— 独立实现必须靠
 *    对拍防漂移（同 `bin/rescue.mjs` 宽度对拍的既有纪律）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { observationPath } from '../../src/host/observe/cooccurrence-store.ts'
import { Store } from '../../src/host/data/store.ts'
import { pathSafeName, staysInside } from '../../src/host/core/path-safe.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}


/** 相对路径里是否只有一层（即没有建子目录）。 */
function isFlatChild(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.includes(sep) && !rel.includes('/')
}

async function main(): Promise<void> {
  const root = join(tmpdir(), 'rg-path-probe-partition')
  console.log('\n== observationPath：作用域包名扁平化 ==')
  {
    const scoped = observationPath(root, '@scope/pkg')
    check('scoped name produces a flat child (no subdirectory)', isFlatChild(root, scoped), relative(root, scoped))
    check('scoped filename carries no forward slash', !basename(scoped).includes('/'), basename(scoped))
    check('scoped filename carries no backslash', !basename(scoped).includes('\\'), basename(scoped))
    // 防撞名：被改写的名字会追加原始名的 8 位 sha256 指纹
    // （`@scope/pkg` → `@scope_pkg-<8hex>`），因此这里只断言**可读主干 +
    // 合法后缀**，不锁死完整文件名 —— 否则实现一变测试就红，而它要守的
    // 不变式是「扁平 + 可辨认」，不是某个具体哈希。
    check(
      'scoped filename keeps the readable package name',
      /^observation-@scope_pkg(-[0-9a-f]{8})?\.json$/.test(basename(scoped)),
      basename(scoped),
    )
  }

  console.log('\n== observationPath：路径逃逸被折叠 ==')
  {
    const escaped = observationPath(root, '@a/../../escape')
    check('traversal name stays inside the partition dir', staysInside(root, escaped), relative(root, escaped))
    check('traversal name is flattened to a direct child', dirname(escaped) === root, dirname(escaped))
    const bare = observationPath(root, '..')
    check('a bare .. name stays inside', staysInside(root, bare), relative(root, bare))
    const winSep = observationPath(root, 'a\\..\\..\\b')
    check('windows separators are folded too', staysInside(root, winSep) && isFlatChild(root, winSep), relative(root, winSep))
  }

  console.log('\n== 未改写的名字保持原样（存量兼容）==')
  {
    check('plain name is unchanged (no fingerprint)', pathSafeName('official-experimental') === 'official-experimental', pathSafeName('official-experimental'))
    check('underscore name is unchanged (no fingerprint)', pathSafeName('@scope_pkg') === '@scope_pkg', pathSafeName('@scope_pkg'))
    check('rewritten name differs from an already-flat lookalike', pathSafeName('@scope/pkg') !== pathSafeName('@scope_pkg'))
  }

  console.log('\n== 折叠 .. 不引入同名冲突（抽查关键对）==')
  {
    const pairs: Array<[string, string]> = [
      ['@a/../b', '@a/b'],
      ['@a/../../escape', '@a/escape'],
      ['a b', 'a/b'],
      ['@scope/pkg', '@scope_pkg'],
    ]
    for (const [left, right] of pairs) {
      check(`distinct names stay distinct: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`, basename(observationPath(root, left)) !== basename(observationPath(root, right)), {
        left: basename(observationPath(root, left)),
        right: basename(observationPath(root, right)),
      })
    }
  }

  console.log('\n== store 备份：同族缺陷已修 + 跨实现对拍 ==')
  {
    const profile = mkdtempSync(join(tmpdir(), 'rg-path-store-'))
    try {
      const store = new Store(profile, 'part-a')
      await store.init()
      const scopedFile = await store.writeBackup('@scope/pkg', { a: 1 })
      check('backup for a scoped bundle is inside the backups root', staysInside(store.backupsRoot, scopedFile), relative(store.backupsRoot, scopedFile))
      check('backup for a scoped bundle is flat (no nested dir)', isFlatChild(store.backupsRoot, scopedFile), relative(store.backupsRoot, scopedFile))
      check('both implementations agree on the sanitized segment', basename(scopedFile) === basename(observationPath(root, '@scope/pkg')).replace(/^observation-/, ''), {
        backup: basename(scopedFile),
        observation: basename(observationPath(root, '@scope/pkg')),
      })

      const traversalFile = await store.writeBackup('@a/../../escape', { b: 2 })
      check('backup for a traversal name stays inside the backups root', staysInside(store.backupsRoot, traversalFile), relative(store.backupsRoot, traversalFile))
      check('backup for a traversal name is flat', isFlatChild(store.backupsRoot, traversalFile), relative(store.backupsRoot, traversalFile))

      // 读取仍能取回（写入与读取用同一投影）。
      const readBack = await store.readBackup('@scope/pkg')
      check('readBackup resolves the new flat name', readBack?.config !== undefined && JSON.stringify(readBack.config) === '{"a":1}', readBack)

      // 存量兼容：旧版（不安全）投影写出的是**嵌套**路径，只读回退必须仍能取回。
      const legacyDir = join(store.backupsRoot, '@legacy')
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, 'pkg.json'), JSON.stringify({ bundle: '@legacy/pkg', savedAt: 't', config: { old: true } }), 'utf8')
      const legacyBackup = await store.readBackup('@legacy/pkg')
      check('legacy nested backup is still readable (read-only fallback)', legacyBackup?.config !== undefined && JSON.stringify(legacyBackup.config) === '{"old":true}', legacyBackup)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.log('  FAIL  harness crashed', String(error))
    process.exit(1)
  })