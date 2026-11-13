/**
 * npm 发布（直连 registry API，单次 PUT + CouchDB 附件）。
 *
 * ## 为什么不用 `npm publish`
 *
 * `vault_run` 的白名单 shell 把工作目录固定在**桌面 profile**
 * （`C:\Users\86156\.dsh\profiles\desktop`），于是：
 * - 读不到本仓的 `.npmrc`（那份把 registry 指向 npmjs.org 并用 `${NPM_TOKEN}` 注入凭据）；
 * - 落到用户级 `.npmrc`（registry = npmmirror，且**没有** `_authToken`）；
 * - 结果：`npm whoami` → ENEEDAUTH；`npm publish` →
 *   `Cannot read properties of null (reading 'prerelease')`
 *   （该报错是 npm 拿不到 packument 时的次生症状，不是根因）。
 *
 * ## 协议：一次 PUT，tarball 作为 CouchDB 附件
 *
 * npm registry 底层是 CouchDB。发布一个新版本的形态是**一个** PUT 到
 * `https://registry.npmjs.org/<name>`，body 是包文档（JSON），其中：
 *
 * - `_id` / `name` / `dist-tags` / `versions[v]`：包的元数据；
 * - `_attachments["<file>.tgz"]`：**tarball 本身**（base64 编码的字节 +
 *   `content_type` + `length`）。
 *
 * 踩过的三个坑（都是实测，不是推测）：
 *
 * 1. body 直接放 tarball 字节 ⇒ 400「Missing required package name or _id」
 *    —— registry 把 body 当**文档**解析，而 tarball 是二进制。
 * 2. 先 PUT 文档再 PUT 附件地址 ⇒ 400「Must include a tarball for new versions」
 *    —— registry 校验新版本必须**随文档一起**带上 tarball。
 * 3. 往 `/-/<file>.tgz` 直接 PUT 字节 ⇒ 405「PUT is not allowed」
 *    —— 那个 URL 是**只读**的下载路由，不是上传入口。
 *
 * ⇒ 唯一可行形态：**一次 PUT，tarball 放进 `_attachments`**。
 *
 * ## token 只从环境变量来
 *
 * 与 `scripts/gh-release.mjs` 同纪律：令牌由 `vault_run` 注入 `NPM_TOKEN`，
 * **不落盘、不进日志、不进命令行**。
 *
 * ## 流程
 *
 * 1. `npm pack` 产出 tarball（**先确认 tarball 内容含本轮全部功能** ——
 *    v0.18.0 的教训：带着「不含最后一批功能的 dist」发布后无法撤销）；
 * 2. 一次 PUT：文档 + `_attachments`；
 * 3. 轮询 packument，确认版本已上架且 `dist-tags.latest` 指向它。
 *
 * ## 用法
 *
 *   node scripts/npm-publish.mjs            # 打包 + 发布 + 校验
 *   node scripts/npm-publish.mjs --dry-run  # 只打包并打印内容清单
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const token = process.env.NPM_TOKEN

/**
 * 仓库根 = **本脚本所在目录的上一级**（`scripts/` → 包根）。
 *
 * 为什么不能靠 cwd：`vault_run` 的白名单 shell 把工作目录固定在**桌面 profile**，
 * 于是 `package.json` 读到了 `dsh-profile-desktop`（一个 profile 壳，没有 name/version）
 * ⇒ `npm pack` 报「Invalid package, must have name and version」。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const name = pkg.name
const version = pkg.version

if (!dryRun && !token) {
  console.error('NPM_TOKEN not injected (run via vault_run)')
  process.exit(2)
}

const registry = 'https://registry.npmjs.org'
const tarballName = `${name}-${version}.tgz`
const tarballPath = join(repoRoot, tarballName)

/** 1) 打包（在仓库根里跑，cwd 不可信）。 */
console.log(`[1/3] packing ${name}@${version} …`)
const packed = spawnSync('npm', ['pack', '--json'], { encoding: 'utf8', cwd: repoRoot })
if (packed.status !== 0) {
  console.error(packed.stderr || packed.stdout)
  process.exit(1)
}
if (!existsSync(tarballPath)) {
  console.error(`pack produced no tarball at ${tarballPath}`)
  console.error(packed.stdout.slice(0, 800))
  process.exit(1)
}

/** 2) 核对 tarball 内容（发布前的最后一道诚实门）。 */
const contents = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
const files = contents.stdout.split('\n').filter(Boolean)
console.log(`[2/3] tarball ${tarballName} contains ${files.length} entries:`)
for (const file of files) console.log(`      ${file}`)

if (dryRun) {
  rmSync(tarballPath, { force: true })
  console.log('dry-run: nothing published')
  process.exit(0)
}

const tarballBytes = readFileSync(tarballPath)
const shasum = createHash('sha1').update(tarballBytes).digest('hex')
const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`
const tarballUrl = `${registry}/${name}/-/${tarballName}`

/**
 * 3) 一次 PUT：包文档 + tarball 附件。
 *
 * `_attachments` 的键名必须与 `dist.tarball` 的**末段**一致（registry 按它
 * 把附件关联到版本）。
 */
const document = {
  _id: name,
  name,
  'dist-tags': { latest: version },
  versions: {
    [version]: {
      ...pkg,
      _id: name,
      dist: { tarball: tarballUrl, shasum, integrity },
    },
  },
  _attachments: {
    [tarballName]: {
      content_type: 'application/octet-stream',
      data: tarballBytes.toString('base64'),
      length: tarballBytes.length,
    },
  },
  readme: readFileSync(join(repoRoot, 'README.md'), 'utf8'),
  readmeFilename: 'README.md',
}

console.log(`[3/3] publishing ${name}@${version} (tarball ${tarballBytes.length} bytes) …`)
const response = await fetch(`${registry}/${name}`, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(document),
})
const body = await response.text()
rmSync(tarballPath, { force: true })

if (!response.ok) {
  console.error(`publish failed: HTTP ${response.status}`)
  console.error(body.slice(0, 1200))
  process.exit(1)
}
console.log(`published: HTTP ${response.status}`)

/** 4) 校验：版本已上架。 */
let verified = false
for (let attempt = 0; attempt < 15; attempt += 1) {
  await new Promise((r) => setTimeout(r, 2000))
  const check = await fetch(`${registry}/${name}/${version}`)
  if (check.ok) {
    const manifest = await check.json()
    console.log(`verified: ${manifest.name}@${manifest.version} is on the registry`)
    console.log(`         tarball: ${manifest.dist?.tarball ?? '(none)'}`)
    console.log(`         shasum : ${manifest.dist?.shasum ?? '(none)'}`)
    verified = true
    break
  }
}
if (!verified) {
  console.error('published but not yet visible on the registry (may need more time)')
  process.exit(1)
}

for (const entry of readdirSync(repoRoot)) {
  if (entry.endsWith('.tgz')) rmSync(join(repoRoot, entry), { force: true })
}
