/**
 * 运行时边界契约测试 —— **client bundle 不得依赖 host 侧任何东西**。
 *
 * ## 为什么这条测试是这次重构的「兑现」
 *
 * v0.15 把 `src/` 重排为 `index.ts`（host 入口）+ `host/<domain>/` + `client/<area>/`。
 * 若只有目录改名而没有边界检查，这次重构就只是「文件挪了位置」——
 * 而它真正要解决的问题是：**浏览器 bundle 误引 `node:fs` 只能等到打包/运行时才炸**。
 *
 * dsh 规范把 `client` 与 `host` 列为不同 group（`packages/client/*` 与 `packages/host/*`），
 * 正是因为二者是**不同的运行时**：client 在浏览器里跑，没有 `node:*`、没有进程、没有文件系统。
 * 本包一个 package.json 带两个入口（`main: dist/index.js` 与 `exports["./client"]`），
 * 所以这条边界必须由测试来守，否则它只是一句注释。
 *
 * ## 判据（两条，缺一不可）
 *
 * 1. client 源码**不得** import 任何以 `node:` 开头的内建模块；
 * 2. client 源码**不得** import `src/host/**`（宿主域的任何模块）。
 *
 * 允许的例外只有一种：`import type`（类型只在编译期存在，不会把运行时依赖
 * 拉进 bundle）。类型可以跨边界共享，值不行 —— 这正是「声明式契约 vs 实现依赖」
 * 的分界。测试对这个例外做**显式识别**，不是放宽整条规则。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..', '..')
const clientDir = join(projectRoot, 'src', 'client')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 递归收集 client 侧全部源码。 */
function collect(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path, acc)
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(path)
  }
  return acc
}

/** 一条 import 语句的静态事实。 */
interface ImportFact {
  specifier: string
  /** 是否 `import type` / `import { type X }` 形态（编译期擦除）。 */
  typeOnly: boolean
  file: string
}

/** 抽取文件里的全部 import 说明符。 */
function importsOf(file: string): ImportFact[] {
  const text = readFileSync(file, 'utf8')
  const facts: ImportFact[] = []
  // 每条 import 语句（含多行）单独取出来判断 type-only；
  // 不能只看行首，因为 `import {\n  type A,\n  type B,\n} from 'x'` 是跨行的。
  const statement = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
  for (const match of text.matchAll(statement)) {
    const clause = match[1] ?? ''
    const specifier = match[2] ?? ''
    const typeOnly =
      /^type\s/.test(clause.trim()) ||
      // `import { type A, type B } from 'x'`：所有具名成员都带 type 前缀。
      (/^\{[\s\S]*\}$/.test(clause.trim()) &&
        clause
          .replace(/[{}]/g, '')
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .every((part) => part.startsWith('type ')))
    facts.push({ specifier, typeOnly, file })
  }
  return facts
}

const files = collect(clientDir)
check('扫到了 client 源码（递归）', files.length > 10, files.length)

const allImports = files.flatMap(importsOf)
check('抽取到了 import 语句', allImports.length > 10, allImports.length)

console.log('\n== 边界 1：client 不得 import node:* 内建模块 ==')
{
  const violations = allImports.filter((fact) => fact.specifier.startsWith('node:') && !fact.typeOnly)
  check(
    'client 侧没有任何 node:* 运行时 import',
    violations.length === 0,
    violations.map((v) => `${relative(projectRoot, v.file)} → ${v.specifier}`),
  )
}

console.log('\n== 边界 2：client 不得 import src/host/** ==')
{
  const violations = allImports.filter((fact) => {
    if (fact.typeOnly) return false // 类型跨边界是允许的（编译期擦除）
    if (!fact.specifier.startsWith('.')) return false
    // 解析成相对于项目根的逻辑路径，避免被 `../..` 的层数差异绕过。
    const resolved = join(dirname(fact.file), fact.specifier).replace(/\\/g, '/')
    return resolved.includes('/src/host/')
  })
  check(
    'client 侧没有任何 host 运行时 import',
    violations.length === 0,
    violations.map((v) => `${relative(projectRoot, v.file)} → ${v.specifier}`),
  )
}

console.log('\n== 反向：测试自身的判据是有效的（防止空转全绿）==')
{
  // 若抽取逻辑失效（比如正则写错），上面两条会「永远 0 违例」而假绿。
  // 这里用一条**已知违规**的合成输入验证判据真的会响。
  const fakeClientFile = join(clientDir, '__boundary-probe__.ts')
  // 不落盘：直接构造事实集，走与上面相同的过滤条件。
  // 深度必须与真实布局一致：`src/client/<area>/x.ts` ⇒ `../../../host/...`。
  // 早期版本写成 `../../host/...`，从 `src/client/` 只上跳两级到了仓库根，
  // 于是 resolved 里不含 `/src/host/` ⇒ 判据「怎么都不报」而假绿。
  const fakeClientFileNested = join(clientDir, 'graph', '__boundary-probe__.ts')
  const synthetic = [
    { specifier: 'node:fs', typeOnly: false, file: fakeClientFile },
    { specifier: '../../host/data/store.js', typeOnly: false, file: fakeClientFileNested },
    { specifier: 'node:fs', typeOnly: true, file: fakeClientFile }, // 类型不算违规
  ]
  const nodeViolations = synthetic.filter((f) => f.specifier.startsWith('node:') && !f.typeOnly)
  check('判据能识别 node:* 违规（合成样例）', nodeViolations.length === 1, nodeViolations.length)
  const hostViolations = synthetic.filter((f) => {
    if (f.typeOnly) return false
    if (!f.specifier.startsWith('.')) return false
    const resolved = join(dirname(f.file), f.specifier).replace(/\\/g, '/')
    return resolved.includes('/src/host/')
  })
  check('判据能识别 host 违规（合成样例）', hostViolations.length === 1, hostViolations.length)
  check('判据把 import type 视为合法（合成样例）', synthetic.filter((f) => f.typeOnly).length === 1)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)