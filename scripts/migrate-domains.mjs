#!/usr/bin/env node
// 一次性迁移脚本：把 src/ 的平铺文件按**功能域**收进子目录，并重写 import。
//
// 依据 dsh 插件开发规范（kb: extra/cookbook/adding-a-package.zh.md）：
// `packages/<group>/<pkg>/` —— **group 是纯容器，按领域/角色分组，包恰好在下一层**。
// 本项目是单插件，映射为 `src/<domain>/<module>.ts`，`src/index.ts` 仍是唯一入口
// （Loader 四件套必须在包根，不能进子目录）。
//
// 为什么用脚本而不是手工 git mv：47 个文件 + ~200 条 import 逐条改会漏；
// 脚本一次性完成「移动 + 相对路径重算」，失败可整体 git reset 回滚。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative, dirname, basename, sep } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** 功能域 → 模块名（不含 .ts）。顺序无关。 */
const DOMAINS = {
  // 基础原语：状态机、revision、分区键、自描述、原子写。零域内依赖，被所有域引用。
  core: ['lifecycle', 'change-guard', 'isolation', 'self-describe', 'atomic-sync'],
  // 持久化与归档：拥有磁盘上的事实。
  data: ['store', 'archive'],
  // 崩溃守护主线：决策（含预启动决策）、恢复、信号、异常终止、守护行安装。
  guard: [
    'decision',
    'decision-evidence',
    'decision-views',
    'recovery-policy',
    'recovery-actions',
    'sentinel',
    'abnormal-boot',
    'startup-record',
    'boot-notes',
    'guarded-rows',
    'official-observe',
    'event-watch',
  ],
  // profile patch 的读写与标量改写（守护行的落点）。
  profile: ['patch', 'patch-yaml', 'patch-scalar'],
  // 观测与数学模型：指标、生存分析、控制带、预防性预警、转移矩阵、共现。
  observe: ['observability', 'survival', 'control-band', 'preventive', 'markov', 'observations', 'cooccurrence', 'cooccurrence-store'],
  // 风险与归因：新近性排序、贝叶斯并行读数、误伤校准。
  risk: ['recency', 'risk-bayes', 'risk-calibration'],
  // 能力模型与图谱投影。
  capability: ['capability', 'capability-specs', 'graph-data'],
  // 对外面：工具注册/分派/渲染、路由、状态投影、面板快照。
  surface: [
    'tool-text',
    'tool-render',
    'tool-presentation',
    'tool-dispatch',
    'tool-registration',
    'routes',
    'routes-plugin',
    'status-view',
    'status-projections',
    'snapshot',
    'partition-snapshot',
  ],
}

/** oldModule -> newRelativePath（相对 src/，不含 .ts）。 */
const mapping = new Map()
for (const [domain, modules] of Object.entries(DOMAINS)) {
  for (const name of modules) mapping.set(name, `${domain}/${name}`)
}

/** 确认映射覆盖了 src 根下所有 .ts（除 index.ts），漏一个就是静默丢文件。 */
const rootFiles = readdirSync(SRC, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => entry.name.replace(/\.ts$/, ''))
const missing = rootFiles.filter((name) => name !== 'index' && !mapping.has(name))
const extra = [...mapping.keys()].filter((name) => !rootFiles.includes(name))
if (missing.length > 0 || extra.length > 0) {
  console.error('映射不完整：missing=', missing, ' extra=', extra)
  process.exit(1)
}

// ── 1. 创建目录并 git mv ─────────────────────────────────────────────
// 注意：`git mv` 的 pathspec 相对**当前工作目录**解析。必须从仓库根执行、
// 并写全 `src/...` 路径；若把 cwd 设成 src/ 再传 `a.ts src/core/a.ts`，
// 实际会移动成 `src/src/core/a.ts`（本项目实测踩到的路径重复陷阱）。
for (const [name, target] of mapping) {
  const from = join(SRC, `${name}.ts`)
  const to = join(SRC, `${target}.ts`)
  if (!existsSync(from)) continue
  mkdirSync(dirname(to), { recursive: true })
  const tracked = (() => {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', `src/${name}.ts`], { cwd: ROOT, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  })()
  if (tracked) {
    execFileSync('git', ['mv', `src/${name}.ts`, `src/${target}.ts`], { cwd: ROOT, stdio: 'inherit' })
  } else {
    // 未跟踪的新文件（如本轮新增的 atomic-sync.ts）git mv 会失败，用普通改名。
    execFileSync('node', ['-e', `require('node:fs').renameSync(${JSON.stringify(`src/${name}.ts`)}, ${JSON.stringify(`src/${target}.ts`)})`], { cwd: ROOT, stdio: 'inherit' })
  }
}

// ── 2. 重写 import ───────────────────────────────────────────────────
// 两类形态：
//  (a) src 内部相对导入 `./X.js` → 相对新位置重算
//  (b) 外部（tests/ scripts/ docs 代码块）以包根为基的 `.../src/X.js` → 改为 `.../src/<domain>/X.js`
const MODULE_RE = /(\bfrom\s+['"])([^'"]+)(['"])/g

/** 把所有文件收进来一起改（含 client 内部指向被移动模块的情形）。 */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(path, acc)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.mjs')) {
      acc.push(path)
    }
  }
  return acc
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'scripts'))]

/** 把 src 内部的一个模块名解析成它现在的相对路径（相对 src 根，不含 .ts）。 */
function currentRelative(moduleName) {
  return mapping.get(moduleName) ?? moduleName
}

let rewritten = 0
for (const file of files) {
  const original = readFileSync(file, 'utf8')
  const fileIsInSrc = file.startsWith(SRC + sep)
  const fileDir = dirname(file)

  const next = original.replace(MODULE_RE, (whole, prefix, specifier, suffix) => {
    if (!specifier.startsWith('.')) return whole // 外部包不动

    // (a) src 内部：`./X.js` / `../X.js`
    if (fileIsInSrc) {
      const absolute = join(fileDir, specifier)
      const moduleName = basename(specifier).replace(/\.js$/, '')
      // 只有当目标确实是「被移动的 src 根模块」时才改写
      if (!mapping.has(moduleName)) return whole
      const newAbsolute = join(SRC, `${currentRelative(moduleName)}.js`)
      let rel = relative(fileDir, newAbsolute).split(sep).join('/')
      if (!rel.startsWith('.')) rel = `./${rel}`
      return `${prefix}${rel}${suffix}`
    }

    // (b) src 外部：`../../src/X.js` —— 把 `/src/X.js` 段换成 `/src/<domain>/X.js`
    const match = /^(.*\/src\/)([A-Za-z0-9_-]+)(\.js)$/.exec(specifier)
    if (match === null) return whole
    const [, head, moduleName, ext] = match
    if (!mapping.has(moduleName)) return whole
    return `${prefix}${head}${currentRelative(moduleName)}${ext}${suffix}`
  })

  if (next !== original) {
    writeFileSync(file, next, 'utf8')
    rewritten += 1
  }
}

console.log(`迁移完成：${mapping.size} 个模块进入 ${Object.keys(DOMAINS).length} 个域；重写 ${rewritten} 个文件的 import。`)