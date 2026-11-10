#!/usr/bin/env node
// 第二次迁移：把「按域平铺」收敛为 dsh 规范的两层结构 —— **先运行时边界，再功能域**。
//
// 依据（kb: extra/cookbook/adding-a-package.zh.md）：
//   `packages/<group>/<pkg>/`，group 词表包含 `client` / `host`。
//   「`packages/client/*` 包改为 extends `tsconfig.base.client.json`；client 插件包
//   还需在 package.json 声明 `dsh.client`、导出 `./client`」。
//
// 本包同时有两个入口（package.json 的 `main: dist/index.js` 与 `exports["./client"]`），
// 因此第一层必须是**运行时边界**：
//   src/index.ts        host bundle 入口（Loader 四件套）
//   src/host/<domain>/  只在宿主侧运行（可用 node:fs / 进程 / 路由）
//   src/client/<area>/  只在浏览器侧运行（禁止 import 宿主域）
// 功能域在各自边界内部再分。
//
// 为什么这个顺序比「直接分域」更有价值：client 与 host 的**依赖方向**由此变成
// 结构事实（client 不得引用 host），可以写一条契约测试钉死；若只在同一个 src/
// 里按域分目录，浏览器 bundle 误引 node:fs 仍然要等到打包才暴露。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, dirname, basename, sep, normalize } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** 当前已按域分好的宿主导模块 → 目标 `host/<domain>/<name>.ts`。 */
const HOST_DOMAINS = ['core', 'data', 'guard', 'profile', 'observe', 'risk', 'capability', 'surface']

/** 客户端按**关注点**再分（不是按文件类型）：面板 / 图谱 / 数据接口 / 文案。 */
const CLIENT_AREAS = {
  panel: ['GuardPanel', 'PanelCards', 'InsightCards', 'panel-model', 'GuardPanelIcon'],
  graph: ['GuardGraph', 'GraphParts', 'graph-model', 'graph-analysis', 'minimap-model', 'viewport'],
  api: ['api'],
  i18n: ['i18n'],
}

/** 旧绝对路径 → 新绝对路径。 */
const moves = new Map()

for (const domain of HOST_DOMAINS) {
  const dir = join(SRC, domain)
  if (!existsSync(dir)) continue
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    moves.set(join(dir, entry.name), join(SRC, 'host', domain, entry.name))
  }
}

const clientDir = join(SRC, 'client')
for (const [area, names] of Object.entries(CLIENT_AREAS)) {
  for (const name of names) {
    for (const ext of ['.ts', '.tsx']) {
      const from = join(clientDir, `${name}${ext}`)
      if (existsSync(from)) moves.set(from, join(clientDir, area, `${name}${ext}`))
    }
  }
}

// 入口与样式留在 client 根（它们是 bundle 入口与全局资产，不属于任何关注点）。
for (const name of ['index.ts', 'entry.ts', 'styles.ts', 'styles.css', 'styles.d.css.ts']) {
  const from = join(clientDir, name)
  if (existsSync(from)) moves.set(from, join(clientDir, name))
}

// ── 1. 先在内存里算出「旧文件 → 新文件」，再据此重算 import ──────────────
// 必须**先算后搬**：搬完就不知道每个相对导入原本指向哪里了。
const allSourceFiles = []
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(path, acc)
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) acc.push(path)
  }
  return acc
}
walk(SRC, allSourceFiles)
walk(join(ROOT, 'tests'), allSourceFiles)
walk(join(ROOT, 'scripts'), allSourceFiles)

const newPathOf = (absolute) => moves.get(normalize(absolute)) ?? normalize(absolute)

const SPECIFIER_RE = /(\bfrom\s+['"])([^'"]+)(['"])/g

let rewritten = 0
for (const file of allSourceFiles) {
  const original = readFileSync(file, 'utf8')
  const newFile = newPathOf(file)
  const oldDir = dirname(file)
  const newDir = dirname(newFile)

  const next = original.replace(SPECIFIER_RE, (whole, prefix, specifier, suffix) => {
    if (!specifier.startsWith('.')) return whole
    // 用旧位置解析出目标的旧绝对路径（去掉扩展名后补回，便于命中 moves 表）
    const resolvedOld = normalize(join(oldDir, specifier))
    // strip extension for lookup, keep it for output
    const extMatch = /\.(js|ts|tsx|mjs|css)$/.exec(resolvedOld)
    const ext = extMatch?.[0] ?? ''
    const withoutExt = ext === '' ? resolvedOld : resolvedOld.slice(0, -ext.length)

    // moves 表按「带扩展名的真实文件名」建键；用两种候选去查（.ts / .tsx / 原扩展名）
    const candidates = [withoutExt + '.ts', withoutExt + '.tsx', withoutExt + '.css', withoutExt + '.d.css.ts', withoutExt + ext]
    let targetNew = null
    for (const candidate of candidates) {
      const mapped = moves.get(normalize(candidate))
      if (mapped !== undefined) {
        targetNew = mapped
        break
      }
    }
    if (targetNew === null) return whole // 目标没被移动（保持原样）

    let rel = relative(newDir, targetNew).split(sep).join('/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    return `${prefix}${rel}${suffix}`
  })

  if (next !== original) {
    writeFileSync(file, next, 'utf8')
    rewritten += 1
  }
}

// ── 2. 移动（保持 git 历史）─────────────────────────────────────────────
for (const [from, to] of moves) {
  if (normalize(from) === normalize(to)) continue
  mkdirSync(dirname(to), { recursive: true })
  const relFrom = relative(ROOT, from).split(sep).join('/')
  const relTo = relative(ROOT, to).split(sep).join('/')
  const tracked = (() => {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', relFrom], { cwd: ROOT, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  })()
  if (tracked) {
    execFileSync('git', ['mv', relFrom, relTo], { cwd: ROOT, stdio: 'inherit' })
  } else {
    execFileSync('node', ['-e', `require('node:fs').renameSync(${JSON.stringify(relFrom)}, ${JSON.stringify(relTo)})`], {
      cwd: ROOT,
      stdio: 'inherit',
    })
  }
}

// ── 3. 清掉迁移后留下的空目录 ──────────────────────────────────────────
for (const domain of HOST_DOMAINS) {
  const dir = join(SRC, domain)
  if (!existsSync(dir)) continue
  if (readdirSync(dir).length === 0) execFileSync('node', ['-e', `require('node:fs').rmdirSync(${JSON.stringify(relative(ROOT, dir))})`], { cwd: ROOT })
  else console.warn(`注意：${domain}/ 仍有残留文件`, readdirSync(dir))
}

console.log(`第二次迁移完成：${moves.size} 个目标，重写 ${rewritten} 个文件的 import。`)