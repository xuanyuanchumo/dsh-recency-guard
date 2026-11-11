#!/usr/bin/env node
/**
 * 沙箱用户旅程（cycle-14 / T14-09）
 *
 * ## 为什么要有这个脚本，而不是只靠 tests/fault-injection
 *
 * `tests/fault-injection` 用 tsx 直接加载 **源码**，证明的是「守护逻辑对」；
 * 它不能证明「发布产物装进真实 profile 后、真实 dsh CLI 启动时也对」——
 * 两者之间的差异（dist 是否包含最新代码、bundle 的 dsh.bundle 声明是否合法、
 * peerDependencies 是否装得上、profile 的 patch 行是否被真实 Loader 求值）
 * 只有真机旅程能抓到。
 *
 * 所以本脚本做三件事，全部用**真实 dsh CLI**：
 *   1. 往隔离 profile 装一个会崩的夹具插件（apply 成功后异步抛错 ⇒ 宿主 exit 1）；
 *   2. 启动 → 期望崩溃 → 断言守护写下 decision.json（预启动决策）；
 *   3. 再启动 → 期望守护行拦住夹具 → 进程存活 → 断言 journal 有恢复证据。
 *
 * ## 隔离纪律（研究文档 07 §5.4）
 *
 * 只操作 `--profile <沙箱名>` 指向的目录；profile 名必须以 `sb-` 开头，
 * 脚本会拒绝其它名字，避免误碰 desktop/web 主力 profile。
 *
 * ## 用法
 *
 *   node scripts/journey-sandbox.mjs --profile sb-rg-c14 [--port 3199] [--workspace <dir>]
 *
 * 退出码：0 全部通过；1 断言失败；2 参数/环境错误。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function parseArgs(argv) {
  const out = { profile: '', port: 3199, workspace: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const next = argv[i + 1]
    if (key === '--profile') { out.profile = next; i += 1 } else if (key === '--port') { out.port = Number(next); i += 1 } else if (key === '--workspace') { out.workspace = next; i += 1 } else if (key === '--help' || key === '-h') { out.help = true }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法：node scripts/journey-sandbox.mjs --profile sb-xxx [--port 3199] [--workspace <dir>]')
  process.exit(0)
}
if (!/^sb-/.test(args.profile)) {
  console.error(`拒绝执行：profile 名必须以 sb- 开头（收到 "${args.profile}"）。主线 profile 绝不碰。`)
  process.exit(2)
}

const profileDir = join(homedir(), '.dsh', 'profiles', args.profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`profile 不存在：${profileDir}（先用 dsh plugin --profile ${args.profile} add ... 初始化）`)
  process.exit(2)
}

const workspace = resolve(args.workspace)
const repoRoot = resolve(import.meta.dirname, '..')
const guardDir = join(profileDir, '.recency-guard')
const dshCmd = process.env.DSH_BIN || 'dsh'
const fixtureName = 'dsh-fi-journey'
const fixtureSrc = join(repoRoot, '.tmp', 'journey-fixture', fixtureName)

/** 结果收集（断言失败也要把证据写完，便于复盘）。 */
const checks = []
function check(name, ok, evidence) {
  checks.push({ name, ok, evidence })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`)
}

/** 写夹具：一个「加载成功之后才炸」的插件（entry 级 apply 抛错只会被宿主自隔离，不崩进程）。 */
function writeFixture() {
  rmSync(fixtureSrc, { recursive: true, force: true })
  mkdirSync(fixtureSrc, { recursive: true })
  writeFileSync(join(fixtureSrc, 'package.json'), JSON.stringify({
    name: fixtureName,
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(fixtureSrc, 'cordis.patch.yml'), [
    '# 旅程夹具的 bundle patch：把自身作为一条 loader entry 挂进 profile',
    '- insert:',
    `    - id: ${fixtureName}-entry`,
    `      name: ${fixtureName}`,
    '',
  ].join('\n'))
  writeFileSync(join(fixtureSrc, 'index.js'), `// 旅程夹具：apply 成功后异步抛错 ⇒ 宿主 installFailLoud 的 uncaughtException ⇒ exit 1\n// 这正是 CLAUDE.md 的威胁模型里「真崩溃」的形态（entry 级抛错只是 warning）。\nexport const name = '${fixtureName}'\nexport function apply() {\n  setTimeout(() => { throw new Error('${fixtureName}: async boom') }, 10)\n}\n`)
}

function runDsh(extraArgs, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(dshCmd, ['--profile', args.profile, ...extraArgs], {
      cwd: workspace,
      env: { ...process.env, DSH_PROFILE: args.profile, DSH_PROFILE_DIR: profileDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { out += String(d) })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, out }) })
  })
}

/** 读当前分区的 decision.json（指针文件搭桥，和守护行表达式同一口径）。 */
function readDecision() {
  const pointerFile = join(guardDir, 'current.json')
  if (!existsSync(pointerFile)) return null
  try {
    const pointer = JSON.parse(readFileSync(pointerFile, 'utf8'))
    const file = join(profileDir, pointer.decisionPath)
    if (!existsSync(file)) return null
    return { file, decision: JSON.parse(readFileSync(file, 'utf8')) }
  } catch { return null }
}

function readJournal(limit = 40) {
  const projects = join(guardDir, 'projects')
  if (!existsSync(projects)) return []
  const key = existsSync(join(guardDir, 'current.json'))
    ? JSON.parse(readFileSync(join(guardDir, 'current.json'), 'utf8')).partitionKey
    : readdirSync(projects)[0]
  const file = join(projects, key, 'journal.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => {
    try { return JSON.parse(l) } catch { return {} }
  })
}

console.log(`== 沙箱旅程 ==\nprofile: ${profileDir}\nworkspace: ${workspace}\nport: ${args.port}\n`)

// 0) 干净起点：先清掉上一轮的守护产物，保证结论只来自本轮事实。
rmSync(guardDir, { recursive: true, force: true })

// 1) 装夹具（真实的 pnpm 安装路径，不是伪造的 node_modules 目录）。
writeFixture()
const add = spawnSync(dshCmd, ['plugin', '--profile', args.profile, 'add', `file:${fixtureSrc}`], { encoding: 'utf8', shell: process.platform === 'win32' })
check('夹具安装成功（dsh plugin add file:）', add.status === 0, (add.stdout || '').trim().split('\n').slice(-2).join(' | '))

// profile 的 bundles 必须显式包含夹具，否则它只是普通依赖、不会成为 profile layer。
{
  const pkgFile = join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const bundles = pkg.dsh?.profile?.bundles ?? []
  if (!bundles.includes(fixtureName)) {
    bundles.push(fixtureName)
    pkg.dsh.profile.bundles = bundles
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  check('夹具已声明为 profile bundle', true, bundles.join(', '))
}

// 2) 第一次启动：期望崩溃（exit 非 0）。
const first = await runDsh(['--port', String(args.port), '--no-open'], 45_000)
check('第一次启动以非零码退出（真实崩溃）', first.code !== 0, `exit=${first.code}`)
check('崩溃栈来自夹具而不是脚本', /async boom/.test(first.out), (first.out.match(/.*async boom.*/) ?? [''])[0].trim())

const afterCrash = readDecision()
check('崩溃那一刻同步写下 decision.json', Boolean(afterCrash), afterCrash?.file ?? '')
check('决策把夹具列为停用对象', Boolean(afterCrash?.decision?.disable?.includes(fixtureName)), JSON.stringify(afterCrash?.decision?.disable ?? []))

const patchFile = join(profileDir, 'cordis.patch.yml')
const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
check('守护行已写入 profile patch（Loader 预启动求值）', patchText.includes(fixtureName) && patchText.includes('disabled: !!js'), patchFile)

// 3) 第二次启动：期望守护栏拦住夹具 ⇒ 进程存活并开始监听。
// 这里必须「起在后台、等到 token 行、再断言」，不能用固定超时 ——
// 超时只能证明「30 秒内没退出」，证明不了「真的起来了」。
function startDshAndWait(port, timeoutMs) {
  return new Promise((resolveStart) => {
    const child = spawn(dshCmd, ['--profile', args.profile, '--port', String(port), '--no-open'], {
      cwd: workspace,
      env: { ...process.env, DSH_PROFILE: args.profile, DSH_PROFILE_DIR: profileDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let out = ''
    const done = (ok, reason) => { resolveStart({ child, ok, reason, out }) }
    const timer = setTimeout(() => done(false, 'timeout'), timeoutMs)
    const onData = (d) => {
      out += String(d)
      if (/dsh web: http:\/\/127\.0\.0\.1:/.test(out)) { clearTimeout(timer); done(true, 'listening') }
      if (/async boom/.test(out)) { clearTimeout(timer); done(false, 'crashed') }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => { clearTimeout(timer); done(false, `exit=${code}`) })
  })
}

const second = await startDshAndWait(args.port, 40_000)
check('第二次启动保持存活并开始监听（守护行生效）', second.ok, second.reason)
check('第二次启动没有夹具崩溃栈', !/async boom/.test(second.out), (second.out.match(/.*async boom.*/) ?? ['(none)'])[0].trim())

const journal = readJournal()
check('journal 记录了崩溃检测', journal.some((e) => e.kind === 'crash-detected'), `${journal.filter((e) => e.kind === 'crash-detected').length} 条`)

// 4) 归档重置 + 恢复：产物搬进 archives 并留 manifest，之后从最新事实重开。
if (second.ok) {
  const routeArchive = await fetch(`http://127.0.0.1:${args.port}/recency-guard/api/action/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'journey script archive' }),
  }).catch(() => null)
  const archiveJson = routeArchive ? await routeArchive.json().catch(() => null) : null
  check('归档路由可用（POST /recency-guard/api/archive）', Boolean(routeArchive), `status=${routeArchive?.status ?? 'unreachable'}`)
  check('归档返回结构化结果', Boolean(archiveJson && (archiveJson.ok === true || archiveJson.archived !== undefined)), JSON.stringify(archiveJson)?.slice(0, 160) ?? 'null')

  const routeArchives = await fetch(`http://127.0.0.1:${args.port}/recency-guard/api/archives`).catch(() => null)
  const archivesJson = routeArchives ? await routeArchives.json().catch(() => null) : null
  const archivesCount = Array.isArray(archivesJson?.archives) ? archivesJson.archives.length : (Array.isArray(archivesJson) ? archivesJson.length : -1)
  check('归档清单可读（GET /recency-guard/api/archives）', archivesCount >= 1, `archives=${archivesCount}`)

  // 恢复：把夹具重新启用（模拟用户手动放行），守护应记录 restore 证据。
  const routeRestore = await fetch(`http://127.0.0.1:${args.port}/recency-guard/api/action/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundles: [fixtureName] }),
  }).catch(() => null)
  check('恢复路由可用（POST /recency-guard/api/restore）', Boolean(routeRestore), `status=${routeRestore?.status ?? 'unreachable'}`)
}

// 收尾：无论断言如何都要杀掉后台进程，避免留下监听端口的孤儿进程。
//
// 为什么必须先 destroy 掉 stdio 再 kill：Windows 上「kill 掉的子进程 + 仍然挂着的
// pipe」会在进程退出阶段触发 libuv 的 `!(handle->flags & UV_HANDLE_CLOSING)` 断言，
// 表现为「14/14 全通过之后脚本挂住不退出」（实测踩过一次，被 ops 当作后台 job 收编）。
if (second.child) {
  try {
    second.child.stdout?.destroy()
    second.child.stderr?.destroy()
    second.child.stdin?.destroy()
    // Windows 上 `shell: true` 意味着 child.pid 是 cmd.exe，真正的 dsh 是它的孙进程。
    // 只 kill(cmd) 会留下仍持有继承管道的 dsh.exe ⇒ 调用方（agent 的 bash）永远等 EOF，
    // 表现为「脚本已打印汇总却挂住不返回」。所以按进程树杀。
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(second.child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      second.child.kill('SIGKILL')
    }
  } catch { /* 已退出 */ }
}

// 汇总
const failed = checks.filter((c) => !c.ok)
console.log(`\n== 汇总：${checks.length - failed.length}/${checks.length} PASS ==`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}`)
}
// 用定时器退出而不是立即 exit：给 kill 的完成留一个事件循环轮次，
// 让 libuv 先把子进程句柄收干净（立即 exit 会把上面的断言暴露在 teardown 里）。
setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 150)