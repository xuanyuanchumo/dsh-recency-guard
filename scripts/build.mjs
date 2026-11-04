import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })

/**
 * 宿主侧与客户端侧是**两个产物**：
 *
 * - `dist/index.js`（宿主）：被 DSH 的 Loader 当作插件模块加载。
 * - `dist/client.js`（客户端）：被客户端模块系统按
 *   `window.__ModuleLoader__.load({ id, factory })` 调用。
 *
 * 两者的依赖面不同：客户端不依赖宿主的服务包（cordis / dsh-tools），
 * 只依赖 React（由平台模块表提供）与本插件自己的纯逻辑模块。
 */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'info',
}

/** 宿主侧的外部依赖（由宿主提供）。 */
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
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  external: hostExternal,
  banner: {
    js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
  },
})

if (host.errors.length > 0) process.exit(1)

/**
 * 客户端侧的产物。
 *
 * React 是**平台模块**：`require('react')` 由客户端加载器解析，
 * 绝不能打进产物（两份 React 会让 hooks 失效）。
 * 样式表用 `text` loader 内联（`styles.css` 是唯一样式真相源）。
 */
const client = await build({
  ...common,
  entryPoints: ['src/client/entry.ts'],
  outfile: 'dist/client.js',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.css': 'text' },
})

if (client.errors.length > 0) process.exit(1)

console.log('build: host + client ready')
