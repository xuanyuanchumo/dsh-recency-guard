// 发布脚本：从环境变量取 NPM_TOKEN，以 npm_config_//registry.npmjs.org/:_authToken
// 注入子进程（npm 11 不读裸 NPM_TOKEN；写成 npm_config_* 才是受支持的配置通道），
// 然后调用 npm-cli publish 当前仓库。
import { execFileSync } from 'node:child_process'
const token = process.env.NPM_TOKEN || ''
if (!token) { console.error('NPM_TOKEN missing'); process.exit(1) }
const env = { ...process.env, 'npm_config_//registry.npmjs.org/:_authToken': token }
const r = execFileSync(process.execPath, ['D:/JetBrains/nvm/node_global/node_modules/npm/bin/npm-cli.js', 'publish', 'D:/Projects/TraeProjects/dsh-recency-guard', '--access', 'public', '--registry', 'https://registry.npmjs.org/'], { env, encoding: 'utf8', timeout: 180000 })
console.log(r.slice(-300))
