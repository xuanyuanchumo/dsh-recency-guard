/**
 * 热重载闭环单测（v0.20.0 · reload-self + reload-history）。
 *
 * ## 覆盖面（对应 anic 三铁律的**本仓落地版**）
 *
 * 铁律①（in-flight 先落盘）：scheduled 结果里 handshake=true，且史账里
 * 最后一条是 in-flight —— 触发后本实例可能被替换，但「请求过」已在盘上。
 * 铁律②（触发不 await）：scheduled 立即返回，不挂调用方（史账里 in-flight
 * 不会被本轮改成 reloaded —— finalize 只发生在新实例启动）。
 * 铁律③（hmr 可选探测）：ctx 无 get / 无 hmr 服务 / 服务形状残缺 ⇒
 * unavailable 且**零写入**（盘上没有新条目 = 没有伪造活动痕迹）。
 *
 * 判据三分支（cycle-81 修正）：
 * - dist 落后源码（夹具：src mtime > dist mtime）⇒ refused + 「先 build」；
 * - 实例已最新（observedRevision = 当前 dist revision）⇒ refused + 「无需重载」；
 * - 实例未知（observedRevision=null 且旁路缺失）⇒ **放行** scheduled。
 *
 * 史账语义：FIFO 50 淘汰计数、损坏文件 `.corrupt` 备份、finalizeInFlight
 * 幂等（最后一条不是 in-flight ⇒ 零写入）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendReloadHistory,
  finalizeInFlight,
  readReloadHistory,
  RELOAD_HISTORY_FILE,
  RELOAD_HISTORY_LIMIT,
  type ReloadHistoryEntry,
} from '../../src/host/core/reload-history.ts'
import {
  markRunningRevision,
  probeHmr,
  readRunningRevision,
  reloadSelf,
  resetRunningRevisionForTest,
  writeRunningRevision,
} from '../../src/host/core/reload-self.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 造一个最小插件根：src/ 比 dist/ 新 = stale；反之 = fresh。 */
function makePluginRoot(base: string, stale: boolean): string {
  const root = join(base, stale ? 'stale-root' : 'fresh-root')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-recency-guard', version: '0.20.0' }), 'utf8')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1', 'utf8')
  writeFileSync(join(root, 'dist', 'index.js'), 'export const x = 1', 'utf8')
  writeFileSync(join(root, 'dist', 'client.js'), 'export const y = 1', 'utf8')
  // dist 比 src 新 60s = fresh；src 比 dist 新 60s = stale。
  const srcAt = new Date(Date.now() - (stale ? 120_000 : 120_000))
  const distAt = new Date(Date.now() - (stale ? 180_000 : 60_000))
  utimesSync(join(root, 'src', 'index.ts'), srcAt, srcAt)
  utimesSync(join(root, 'dist', 'index.js'), distAt, distAt)
  utimesSync(join(root, 'dist', 'client.js'), distAt, distAt)
  return root
}

/** 一个只会应答 hmr 探测的最小 ctx（get 返回给定服务）。 */
function ctxWithHmr(service: unknown): unknown {
  return { get: (key: string) => (key === 'hmr' ? service : undefined) }
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'rg-reload-'))
  resetRunningRevisionForTest()
  try {
    // ---------- 铁律③：hmr 缺席 ⇒ unavailable + 零写入 ----------
    console.log('\n== 铁律③：hmr 可选探测 ==')
    {
      const dir = join(base, 'probe')
      mkdirSync(dir, { recursive: true })
      const noGet = reloadSelf({}, { dir, reason: 'r1', actor: 'test' })
      check('ctx 没有 get ⇒ unavailable', noGet.action === 'unavailable', noGet.action)
      check('unavailable 不握手', noGet.handshake === false)
      const absent = reloadSelf(ctxWithHmr(undefined), { dir, reason: 'r2', actor: 'test' })
      check('hmr 服务缺席 ⇒ unavailable（headless 形态）', absent.action === 'unavailable', absent.action)
      const half = reloadSelf(ctxWithHmr({ reconcileProfile: () => {} }), { dir, reason: 'r3', actor: 'test' })
      check('服务形状残缺（缺 runExclusive）⇒ unavailable', half.action === 'unavailable', half.action)
      const probed = probeHmr(ctxWithHmr(undefined))
      check('probeHmr 对缺席服务如实报 unavailable', probed.available === false && probed.reason.length > 0, probed)
      check('unavailable 全程零写入（盘上无史账）', !existsSync(join(dir, RELOAD_HISTORY_FILE)))
    }

    // ---------- 铁律① + 判据三分支（fresh root） ----------
    console.log('\n== 判据三分支（fresh root）==')
    {
      const dir = join(base, 'judged')
      const root = makePluginRoot(base, false)
      mkdirSync(dir, { recursive: true })
      // 实例未知（null）⇒ 放行 scheduled（多一次无害重载 ≪ 误拒真重载）。
      const scheduled = reloadSelf(ctxWithHmr({ runExclusive: () => {}, reconcileProfile: () => {} }), {
        dir,
        pluginRoot: root,
        reason: '实例未知放行',
        actor: 'test',
        observedRevision: null,
      })
      check('实例未知 ⇒ 放行 scheduled', scheduled.action === 'scheduled', scheduled)
      check('scheduled 已握手（铁律①：in-flight 先落盘）', scheduled.handshake === true)
      const history = readReloadHistory(dir)
      check('史账最后一条是 in-flight', history.entries[history.entries.length - 1]?.status === 'in-flight', history.entries.at(-1)?.status)
      // 实例已最新 ⇒ refused「无需重载」。
      const revision = scheduled.revision ?? null
      const upToDate = reloadSelf(ctxWithHmr({ runExclusive: () => {}, reconcileProfile: () => {} }), {
        dir,
        pluginRoot: root,
        reason: '无需重载',
        actor: 'test',
        observedRevision: revision,
      })
      check('实例已最新 ⇒ refused', upToDate.action === 'refused', upToDate.action)
      check('refused 理由点名「无需重载」', typeof upToDate.reason === 'string' && upToDate.reason.includes('无需重载'), upToDate.reason)
      check('refused 也落账（可复核的执行事实）', readReloadHistory(dir).entries.length === 2)
      // force 跳过拒绝（测试/演示通道）。
      const forced = reloadSelf(ctxWithHmr({ runExclusive: () => {}, reconcileProfile: () => {} }), {
        dir,
        pluginRoot: root,
        reason: '强制重载',
        actor: 'test',
        observedRevision: revision,
        force: true,
      })
      check('force=true 跳过已最新拒绝 ⇒ scheduled', forced.action === 'scheduled', forced.action)
    }

    // ---------- 判据：dist 落后源码 ⇒ refused「先 build」 ----------
    console.log('\n== 判据：stale root ==')
    {
      const dir = join(base, 'stale-dir')
      const root = makePluginRoot(base, true)
      mkdirSync(dir, { recursive: true })
      const refused = reloadSelf(ctxWithHmr({ runExclusive: () => {}, reconcileProfile: () => {} }), {
        dir,
        pluginRoot: root,
        reason: '产物过期',
        actor: 'test',
        observedRevision: null,
      })
      check('dist 落后源码 ⇒ refused', refused.action === 'refused', refused.action)
      check('refused 理由点名「先 build」', typeof refused.reason === 'string' && refused.reason.includes('build'), refused.reason)
      check('stale 标记为 true', refused.stale === true)
    }

    // ---------- 旁路标记：写 → 读 → TTL 外丢弃 ----------
    console.log('\n== 运行实例旁路标记 ==')
    {
      const dir = join(base, 'running')
      mkdirSync(dir, { recursive: true })
      markRunningRevision('abc123')
      check('内存标记优先于旁路', readRunningRevision(dir) === 'abc123')
      resetRunningRevisionForTest()
      writeRunningRevision(dir, 'def456')
      check('旁路文件可读（跨模块实例可见性）', readRunningRevision(dir) === 'def456', readRunningRevision(dir))
      // 手工把 at 改成 25 小时前 ⇒ TTL 过期即弃（未知 ⇒ null，不是「已同步」）。
      const path = join(dir, 'running-revision.json')
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { at: string }
      raw.at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      writeFileSync(path, JSON.stringify(raw), 'utf8')
      check('TTL 过期 ⇒ 未知（null，放行）', readRunningRevision(dir) === null)
      resetRunningRevisionForTest()
    }

    // ---------- 史账：FIFO / 损坏备份 / finalize 幂等 ----------
    console.log('\n== 史账语义 ==')
    {
      const dir = join(base, 'history')
      mkdirSync(dir, { recursive: true })
      const entry = (status: ReloadHistoryEntry['status'], reason: string): ReloadHistoryEntry => ({
        at: new Date().toISOString(),
        actor: 'test',
        reason,
        status,
        fromRevision: null,
        toRevision: null,
        staleAtRequest: false,
        warnings: [],
        error: null,
      })
      for (let i = 0; i < RELOAD_HISTORY_LIMIT + 3; i += 1) {
        const appended = appendReloadHistory(dir, entry('refused', `round-${i}`))
        // 封顶后的稳态：每次追加读到的已是 50 条 ⇒ 追加后 51 条 ⇒ 恰好淘汰 1 条
        // （不是一次丢 3 条 —— FIFO 是逐步咬合的，这是它「保留最近」语义的一部分）。
        if (i === RELOAD_HISTORY_LIMIT + 2) check('FIFO 稳态每次淘汰 1 条（dropped=1）', appended.dropped === 1, appended)
      }
      const full = readReloadHistory(dir)
      check('史账封顶在 LIMIT', full.entries.length === RELOAD_HISTORY_LIMIT, full.entries.length)
      check('最旧的是第 3 条（FIFO 语义）', full.entries[0]?.reason === 'round-3', full.entries[0]?.reason)

      // 损坏文件：先备份 .corrupt 再重建（静默销毁证据不允许）。
      writeFileSync(join(dir, RELOAD_HISTORY_FILE), '{not json', 'utf8')
      const after = appendReloadHistory(dir, entry('refused', 'after-corrupt'))
      check('损坏后追加仍成功', after.ok === true)
      const corruptExists = existsSync(`${join(dir, RELOAD_HISTORY_FILE)}.corrupt`)
      check('损坏文件已备份为 .corrupt', corruptExists)
      check('重建后史账只有 1 条', readReloadHistory(dir).entries.length === 1)

      // finalize 幂等：最后一条不是 in-flight ⇒ 零写入。
      const noOp = finalizeInFlight(dir, 'rev-x')
      check('最后一条非 in-flight ⇒ finalize 返回 null', noOp === null)
      check('零写入（仍是 1 条）', readReloadHistory(dir).entries.length === 1)
      // in-flight → reloaded 只发生一次；重复调用是 no-op。
      appendReloadHistory(dir, entry('in-flight', 'handshake'))
      const beforeFinalize = readReloadHistory(dir).entries.length
      const done = finalizeInFlight(dir, 'rev-y')
      check('in-flight 被补成 reloaded', done?.status === 'reloaded', done?.status)
      check('toRevision 记录了观测值', done?.toRevision === 'rev-y')
      const again = finalizeInFlight(dir, 'rev-z')
      check('重复 finalize 是幂等 no-op', again === null && readReloadHistory(dir).entries.length === beforeFinalize)
    }

    // ---------- .corrupt 备份只留一份不无限累积（当前实现每次覆盖） ----------
    console.log('\n== 目录卫生 ==')
    {
      const dir = join(base, 'hygiene')
      mkdirSync(dir, { recursive: true })
      // 没有任何史账时读 → 空数组无错误。
      const empty = readReloadHistory(dir)
      check('缺失文件 ⇒ 空史账无错误', empty.entries.length === 0 && empty.error === null)
      check('分区目录里没有多余 .tmp（原子写卫生）', readdirSync(dir).every((f) => !f.endsWith('.tmp')))
    }
  } finally {
    resetRunningRevisionForTest()
    rmSync(base, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'ALL RELOAD CHECKS PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
