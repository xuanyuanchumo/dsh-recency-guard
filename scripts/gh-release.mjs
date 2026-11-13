/**
 * 创建 GitHub Release（v0.18.0）。
 *
 * ## 为什么用脚本直调 REST 而不是 gh CLI
 *
 * `vault_run` 的白名单 shell 对位置参数做 glob 展开，tag 名 `v0.18.0`
 * 被当成通配符报 "no matches found"。改用 node 的 fetch 直连 GitHub
 * REST API：token 由 vault_run 注入 `GH_TOKEN` 环境变量（不落盘、不外泄、
 * 不进日志），且不依赖任何本地 shell 的 glob 行为。
 *
 * ## 使用
 *
 *   node scripts/gh-release.mjs <owner/repo> <tag> <title> [bodyFile]
 */
import { readFileSync } from 'node:fs'

const [repo, tag, title, bodyFile] = process.argv.slice(2)
if (!repo || !tag) {
  console.error('usage: node scripts/gh-release.mjs <owner/repo> <tag> <title> [bodyFile]')
  process.exit(2)
}
const token = process.env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN not injected (run via vault_run)')
  process.exit(2)
}

const body = bodyFile
  ? readFileSync(bodyFile, 'utf8')
  : '## v0.18.0 变更（无 body 文件时的最小占位，正常流程应传 bodyFile）'

const resp = await fetch(`https://api.github.com/repos/${repo}/releases`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: title, body, draft: false, prerelease: false }),
})
const text = await resp.text()
if (!resp.ok) {
  console.error(`HTTP ${resp.status}: ${text}`)
  process.exit(1)
}
const data = JSON.parse(text)
console.log(`release created: ${data.html_url} (id=${data.id}, tag=${data.tag_name}, draft=${data.draft})`)
