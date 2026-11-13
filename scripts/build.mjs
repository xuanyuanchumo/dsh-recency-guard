import { build } from 'esbuild'
import { readFile, rm, writeFile } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })

/**
 * 宿主侧与客户端侧是**两个产物**：
 *
 * - `dist/index.js`（宿主）：被 DSH 的 Loader 当作插件模块加载（ESM）。
 * - `dist/client.js`（客户端）：DSH web 以**经典 <script>** 加载
 *   `/plugins/<name>/client.js`，并期望
 *   `window.__ModuleLoader__.load({ id, factory })` 的 **CJS 包装形态**
 *   （对照 dsh-anic 的产物逐字节核验，0.5.0 沙箱实测：裸 ESM 的 client
 *   会在浏览器里抛 "Cannot use import statement outside a module"，
 *   宿主报 "import failed"，面板无法渲染）。
 *
 * 两者的依赖面不同：客户端不依赖宿主的服务包（cordis / dsh-tools），
 * 只依赖 React（由平台模块表的 factory.require 解析，绝不双打包）与
 * 本插件自己的纯逻辑模块。
 */
const hostExternal = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-config-editor',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-atomic-write',
]

const host = await build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'info',
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  external: hostExternal,
  banner: {
    js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
  },
})

if (host.errors.length > 0) process.exit(1)

/**
 * 产出 `dist/host.js` —— `dist/index.js` 的**同内容别名**。
 *
 * ## 为什么需要这个别名
 *
 * ANIC 门禁（`dsh-anic` 技能包的 `gate-check.mjs`）的 G3「构建产物新鲜度」
 * 证据按**固定文件名**取产物：`dist/host.js` + `dist/client.js`，算
 * `sha256(sha256(host) + ":" + sha256(client)).slice(0,16)` 作为 revision。
 *
 * 本插件的宿主产物叫 `dist/index.js`（DSH 的 `main` 字段指向它，
 * 改名会破坏安装契约）⇒ 门禁永远拿不到 host 侧 ⇒ 证据恒为 `[dist=absent]`，
 * **那条证据就永远是空的**。
 *
 * 为什么用**同内容别名**而不是改名：DSH 按 `package.json` 的 `main`
 * 加载 `dist/index.js`；改文件名等于改安装契约。别名的代价是
 * 多一份字节（~350KB），换来门禁有真实的产物新鲜度证据。
 *
 * 为什么值得：cycle-71 的非功能报告实录过两次「改完 src 未 build 即跑真机
 * 探针，测的是旧字节码」—— 这道证据就是为了让那种状态**可见**。
 */
await writeFile('dist/host.js', await readFile('dist/index.js'))

/**
 * 客户端侧：先出 CJS 到 staging，再包成 ModuleLoader 形态。
 * React 是平台模块：`require('react')` 由加载器解析，两份 React 会让 hooks 失效。
 * 样式表用 `text` loader 内联进 CJS（styles.css 是唯一样式真相源）；
 * styles.ts 在物化时把它写进 <style id>，与 anic 的 styleId 方案互不冲突。
 */
const staging = 'dist/.client-cjs.tmp'
const client = await build({
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  logLevel: 'info',
  entryPoints: ['src/client/entry.ts'],
  outdir: staging,
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.css': 'text' },
})

if (client.errors.length > 0) process.exit(1)

/** 把 CJS 产物包成 window.__ModuleLoader__.load({ id, factory })。 */
function wrapClientModule(cjsBody, id) {
  // 去掉 "use strict"：factory 闭包继承外层 ESM 的严格模式，重复声明无害但冗余。
  const body = cjsBody.replace(/^"use strict";\s*\n?/, '').replace(/\/\/# sourceMappingURL=.*$/m, '')
  return [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(id)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    body,
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
}

const cjsFile = (await import('node:fs')).readdirSync(staging).find((f) => f.endsWith('.js'))
if (!cjsFile) {
  console.error('[build] no CJS client output produced')
  process.exit(1)
}
const cjsBody = await readFile(`${staging}/${cjsFile}`, 'utf8')
const name = JSON.parse(await readFile('package.json', 'utf8')).name
await writeFile('dist/client.js', wrapClientModule(cjsBody, name))
await rm(staging, { recursive: true, force: true })

console.log('build: host + client ready')
