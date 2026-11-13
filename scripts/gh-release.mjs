/**
 * 创建或更新 GitHub Release（v0.18.0）。
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
 *   node scripts/gh-release.mjs create <owner/repo> <tag> <title> [bodyFile]
 *   node scripts/gh-release.mjs edit  <owner/repo> <tag>  [bodyFile]
 */
import { readFileSync } from 'node:fs'

const [action, repo, tag, title, bodyFile] = process.argv.slice(2)
if (!action || !repo || !tag) {
  console.error('usage: node scripts/gh-release.mjs <create|edit> <owner/repo> <tag> [title] [bodyFile]')
  process.exit(2)
}
const token = process.env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN not injected (run via vault_run)')
  process.exit(2)
}

const body = readBodyFile(bodyFile ?? title)

/** 读 body 文件；缺省给最小占位（正常流程应显式传文件）。 */
function readBodyFile(file) {
  return file ? readFileSync(file, 'utf8') : '## v0.18.0 变更（无 body 文件时的最小占位，正常流程应传 bodyFile）'
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
}

if (action === 'create') {
  const resp = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: title ?? tag,
      body,
      draft: false,
      prerelease: false,
    }),
  })
  const text = await resp.text()
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${text}`)
    process.exit(1)
  }
  const data = JSON.parse(text)
  console.log(`release created: ${data.html_url} (id=${data.id}, tag=${data.tag_name}, draft=${data.draft})`)
} else if (action === 'edit') {
  // tag 已存在时 PATCH 更新正文。tag 被 force-update 后按 tag 查找可能 404，
  // 此时按 ID 更新（`edit <repo> <id> [bodyFile]`，id 传数字）。
  const target = tag
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/releases/${target}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    },
  )
  const text = await resp.text()
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${text}`)
    process.exit(1)
  }
  const data = JSON.parse(text)
  console.log(`release updated: ${data.html_url} (id=${data.id}, body=${data.body.length} chars)`)
} else {
  console.error(`unknown action: ${action}`)
  process.exit(2)
}
