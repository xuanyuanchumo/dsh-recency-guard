import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeBuildFreshness,
  findPluginRoot,
  freshnessVerdict,
  type BuildFreshness,
} from '../../src/host/core/build-freshness.ts'

/**
 * 产物新鲜度检测的测试。
 *
 * ## 为什么要有这个测试
 *
 * `link:` / `file:` 安装下改了 `src/**` 但忘了重建 ⇒ 宿主跑的是**上一版产物**，
 * 而插件照常加载、工具照常注册、面板照常出数 —— **只有行为是旧的，且不报错**。
 * 这个检测把真相摆在面板上，但它的判据本身也必须可靠，否则就是「用假绿换假红」。
 *
 * 本文件钉死的高危不变式：
 *
 * 1. **三态严格区分**：`true` = 确认过期；`false` = 确认不旧；
 *    `null` = **无法判定**。发布形态（无 src/）必须落 `null` ——
 *    落 `false` 会让面板显示「产物与源码一致」，那是把「无法判定」说成「正常」。
 * 2. **版本不造假**：版本来自 `package.json`，不是从产物里正则捞
 *    （产物里到处是 `0.9.0` 这类字符串，正则会捞到第一个匹配的 = 假事实）。
 * 3. **指纹不伪造**：任一产物缺失 ⇒ `revision = null`。
 * 4. **同毫秒不算过期**：严格大于，避免毫秒级抖动误报。
 * 5. **找不到根目录不抛异常**，且落 `stale = null`。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造一个临时「插件根」：含 package.json / src / dist。 */
function makeRoot(options: {
  version?: string
  withSource?: boolean
  withArtifacts?: boolean
  sourceNewer?: boolean
}): string {
  const root = mkdtempSync(join(tmpdir(), 'rg-fresh-'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'dsh-recency-guard',
      version: options.version ?? '9.9.9',
    }),
    'utf8',
  )
  if (options.withArtifacts !== false) {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.js'), '// host\n', 'utf8')
    writeFileSync(join(root, 'dist', 'client.js'), '// client\n', 'utf8')
  }
  if (options.withSource !== false) {
    mkdirSync(join(root, 'src'), { recursive: true })
    const sourceFile = join(root, 'src', 'a.ts')
    writeFileSync(sourceFile, 'export const a = 1\n', 'utf8')
    const base = Date.now()
    const artifactTime = (base - 10_000) / 1000
    const sourceTime = options.sourceNewer === false ? (base - 20_000) / 1000 : (base + 5_000) / 1000
    // 产物可能不存在（withArtifacts: false 的用例）—— 只给存在的文件设时刻。
    for (const name of ['index.js', 'client.js']) {
      const artifact = join(root, 'dist', name)
      if (existsSync(artifact)) utimesSync(artifact, artifactTime, artifactTime)
    }
    utimesSync(sourceFile, sourceTime, sourceTime)
  }
  return root
}

// ---------- 确认过期 ----------

const staleRoot = makeRoot({ sourceNewer: true })
const stale = computeBuildFreshness(staleRoot)
check('源码更新 ⇒ stale=true', stale.stale === true, stale)
check('过期时 driftMs 为正', typeof stale.driftMs === 'number' && stale.driftMs > 0, stale.driftMs)
check('过期时 version 来自 package.json', stale.builtVersion === '9.9.9', stale.builtVersion)
check('过期时指纹非空', typeof stale.revision === 'string' && stale.revision.length === 16, stale.revision)
check('过期结论措辞含重建指引', freshnessVerdict(stale).level === 'stale' && freshnessVerdict(stale).text.includes('npm run build'))

// ---------- 确认不旧 ----------

const freshRoot = makeRoot({ sourceNewer: false })
const fresh = computeBuildFreshness(freshRoot)
check('源码较旧 ⇒ stale=false', fresh.stale === false, fresh)
check('不旧时 driftMs 为负', typeof fresh.driftMs === 'number' && fresh.driftMs < 0, fresh.driftMs)
check('不旧结论为 ok', freshnessVerdict(fresh).level === 'ok')

// ---------- 无法判定：发布形态（无 src/） ----------

const publishedRoot = makeRoot({ withSource: false })
const published = computeBuildFreshness(publishedRoot)
check('无源码 ⇒ stale=null（无法判定，不是「不旧」）', published.stale === null, published)
check('无源码 ⇒ 给出原因', typeof published.reason === 'string' && published.reason.length > 0, published.reason)
check('无源码 ⇒ 结论为 unknown', freshnessVerdict(published).level === 'unknown')
check('无源码 ⇒ 指纹仍可算（产物在）', typeof published.revision === 'string' && published.revision.length === 16, published.revision)

// ---------- 无法判定：产物缺失 ----------

const noArtifactRoot = makeRoot({ withArtifacts: false })
const noArtifact = computeBuildFreshness(noArtifactRoot)
check('产物缺失 ⇒ stale=null', noArtifact.stale === null, noArtifact)
check('产物缺失 ⇒ 指纹为 null（不伪造）', noArtifact.revision === null, noArtifact.revision)

// ---------- 找不到根目录 ----------

const bogus = computeBuildFreshness(join(tmpdir(), 'rg-definitely-not-a-plugin-root-xyz'))
check('找不到根目录 ⇒ 不抛异常且 stale=null', bogus.stale === null, bogus)
check('找不到根目录 ⇒ 有原因', typeof bogus.reason === 'string' && bogus.reason.length > 0)

// ---------- 找不到根目录（真实路径） ----------

check('findPluginRoot 找到本插件根', findPluginRoot(process.cwd()) !== null)
check('findPluginRoot 对无关目录返回 null', findPluginRoot(join(tmpdir(), 'rg-nope-xyz')) === null)

// ---------- 清理 ----------

for (const root of [staleRoot, freshRoot, publishedRoot, noArtifactRoot]) {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nbuild-freshness: ${failures} 条断言失败`)
  process.exit(1)
}
console.log('\nbuild-freshness 全部通过')
void (0 as unknown as BuildFreshness)
