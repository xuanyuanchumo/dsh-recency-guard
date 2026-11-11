import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  POLL_BASE_MS,
  POLL_MAX_MS,
  POLL_MIN_MS,
  fnv1a32,
  graphFingerprint,
  nextPollDelay,
  pollContentFingerprint,
  snapshotFingerprint,
  stableStringify,
} from '../../src/client/panel/poll-adaptive.ts'

/**
 * 自适应轮询 —— 纯函数 + 组件接线结构断言。
 *
 * 这条 TD 的失败形态都很难在界面上看出来：
 * - 指纹把 `at` 也算进去 ⇒ 永远判「变化」⇒ 退避从未生效（用户只看到 5s 不变）；
 * - 用 `setInterval` 再改间隔 ⇒ 旧/新定时器同时活着 ⇒ 后台双倍拉取；
 * - 暂停/卸载只 clear 当前句柄、不设 cancelled ⇒ 在途 load 回来后又挂一个 timer。
 * 所以这里既钉纯函数，也钉组件必须用 setTimeout 递归 + clearTimeout。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('\n[退避阶梯：5s → 10s → 15s 封顶]')
check('首轮/内容变化 ⇒ 基准 5s', nextPollDelay({ sameRounds: 0, changed: true }) === POLL_BASE_MS)
check('连续 1 轮不变 ⇒ 10s', nextPollDelay({ sameRounds: 1, changed: false }) === 10000)
check('连续 2 轮不变 ⇒ 15s 封顶', nextPollDelay({ sameRounds: 2, changed: false }) === 15000)
check('连续 10 轮不变仍是 15s（不无限增长）', nextPollDelay({ sameRounds: 10, changed: false }) === 15000)
check('变化优先于任何退避状态', nextPollDelay({ sameRounds: 9, changed: true }) === POLL_BASE_MS)

console.log('\n[夹紧与坏输入]')
check('下限夹紧：极小 base 抬到 3s', nextPollDelay({ sameRounds: 0, changed: false, baseMs: 1000, minMs: POLL_MIN_MS }) === POLL_MIN_MS)
check('上限夹紧：自定义 max=8000 时封顶 8s', nextPollDelay({ sameRounds: 5, changed: false, baseMs: 5000, maxMs: 8000 }) === 8000)
check('默认上限 30s 是绝对边界', nextPollDelay({ sameRounds: 100, changed: false, baseMs: 20000 }) <= POLL_MAX_MS)
check('NaN sameRounds 按基准处理', nextPollDelay({ sameRounds: Number.NaN, changed: false }) === POLL_BASE_MS)
check('负数 sameRounds 按基准处理', nextPollDelay({ sameRounds: -3, changed: false }) === POLL_BASE_MS)
check('NaN base 回落到默认基准且有限', Number.isFinite(nextPollDelay({ sameRounds: 1, changed: false, baseMs: Number.NaN })) && nextPollDelay({ sameRounds: 1, changed: false, baseMs: Number.NaN }) === 10000)
check('负数 max 回落到默认上限', nextPollDelay({ sameRounds: 9, changed: false, maxMs: -1 }) === 15000)
check('上下限写反时交换而不是抛错', nextPollDelay({ sameRounds: 0, changed: false, baseMs: 4000, minMs: 9000, maxMs: 5000 }) === 5000)
check('changed 传异常值按未变化处理（不会被坏字段永久重置）', nextPollDelay({ sameRounds: 2, changed: 'yes' as unknown as boolean }) === 15000)
check('返回值永远是整毫秒', Number.isInteger(nextPollDelay({ sameRounds: 1, changed: false, baseMs: 5000.4 })))

console.log('\n[稳定序列化：字段顺序无关]')
const a = { z: 1, a: { y: 2, b: 3 }, list: [1, 2, 3] }
const b = { list: [1, 2, 3], a: { b: 3, y: 2 }, z: 1 }
check('键序不同 ⇒ 规范化结果逐字节相同', stableStringify(a) === stableStringify(b), stableStringify(a))
check('数组顺序有意义（不是排序）', stableStringify([1, 2]) !== stableStringify([2, 1]))
check('undefined/function 成员按 JSON 语义省略', stableStringify({ x: 1, u: undefined, f: () => 1 }) === '{"x":1}')
check('NaN/Infinity 与 JSON 语义一致变 null', stableStringify({ n: Number.NaN, i: Number.POSITIVE_INFINITY }) === '{"i":null,"n":null}')
const circular: Record<string, unknown> = { name: 'loop' }
circular.self = circular
check('循环引用不抛（指纹是观测设施，不能因坏数据炸轮询）', typeof stableStringify(circular) === 'string')

console.log('\n[FNV-1a 外部向量]')
check('空串 = offset basis 0x811c9dc5', fnv1a32('') === 0x811c9dc5, fnv1a32('').toString(16))
check('"a" = 0xe40c292c（标准测试向量）', fnv1a32('a') === 0xe40c292c, fnv1a32('a').toString(16))
check('"foobar" = 0xbf9cf968（标准测试向量）', fnv1a32('foobar') === 0xbf9cf968, fnv1a32('foobar').toString(16))
check('结果是无符号 32 位', fnv1a32('任意长文本'.repeat(20)) >= 0 && fnv1a32('任意长文本'.repeat(20)) <= 0xffffffff)
check('不同内容大概率不同（碰撞不在这里赌）', fnv1a32('a') !== fnv1a32('b'))

console.log('\n[快照指纹：易变字段不参与]')
const base = {
  at: '2026-11-11T08:00:00.000Z',
  profile: 'sb-rg-c14',
  projectKey: 'abcdef12',
  stage: 'monitoring',
  diagnostics: { pluginVersion: '0.17.0', snapshotMs: 12, platform: 'win32' },
  risks: [{ bundle: 'pkg-a', risk: 0.8 }],
  transitions: [{ at: 'x', from: 'idle', to: 'monitoring' }],
}
const sameContentNewTime = {
  ...base,
  at: '2026-11-11T08:00:05.000Z',
  diagnostics: { ...base.diagnostics, snapshotMs: 99 },
}
check('只改 at/耗时 ⇒ 指纹不变（退避才可能生效）', snapshotFingerprint(base) === snapshotFingerprint(sameContentNewTime))
const reordered = {
  diagnostics: { ...base.diagnostics },
  risks: base.risks,
  transitions: base.transitions,
  stage: base.stage,
  projectKey: base.projectKey,
  profile: base.profile,
  at: base.at,
}
check('键序不同 ⇒ 指纹相同', snapshotFingerprint(base) === snapshotFingerprint(reordered))
check('真实内容变化 ⇒ 指纹变化', snapshotFingerprint(base) !== snapshotFingerprint({ ...base, stage: 'crashed' }))
check('风险分数变化 ⇒ 指纹变化', snapshotFingerprint(base) !== snapshotFingerprint({ ...base, risks: [{ bundle: 'pkg-a', risk: 0.9 }] }))
check('指纹是 8 位十六进制（可肉眼比对日志）', /^[0-9a-f]{8}$/.test(snapshotFingerprint(base)))

console.log('\n[图谱必须参与指纹：graph-only 变化也要回 5s]')
const graph = {
  nodes: [
    { id: 'guard.observe', x: 0, y: 0, kind: 'capability' },
    { id: 'guard.restore', x: 260, y: 0, kind: 'capability' },
  ],
  edges: [{ id: 'e1', from: 'guard.observe', to: 'guard.restore' }],
  bounds: { minX: 0, minY: 0, maxX: 460, maxY: 56 },
  columns: [{ index: 0, label: '能力' }],
}
const snapshotAtA = { ...base, at: '2026-11-11T08:00:00.000Z' }
const snapshotAtB = { ...base, at: '2026-11-11T08:00:09.000Z' }
check('只看 at 变化（graph 不变）⇒ 组合指纹不变', pollContentFingerprint(snapshotAtA, graph) === pollContentFingerprint(snapshotAtB, graph))
check('图谱节点新增 ⇒ 组合指纹变化', pollContentFingerprint(snapshotAtA, graph) !== pollContentFingerprint(snapshotAtA, { ...graph, nodes: [...graph.nodes, { id: 'new', x: 520, y: 0, kind: 'bundle' }] }))
check('图谱节点删除 ⇒ 组合指纹变化', pollContentFingerprint(snapshotAtA, graph) !== pollContentFingerprint(snapshotAtA, { ...graph, nodes: graph.nodes.slice(1) }))
check('图谱边修改 ⇒ 组合指纹变化', pollContentFingerprint(snapshotAtA, graph) !== pollContentFingerprint(snapshotAtA, { ...graph, edges: [{ id: 'e1', from: 'guard.restore', to: 'guard.observe' }] }))
check('图谱节点字段修改（label）⇒ 组合指纹变化', pollContentFingerprint(snapshotAtA, graph) !== pollContentFingerprint(snapshotAtA, { ...graph, nodes: [{ ...graph.nodes[0], label: '改名' }, graph.nodes[1]] }))
check('图谱对象键序不同 ⇒ 组合指纹相同', pollContentFingerprint(snapshotAtA, graph) === pollContentFingerprint(snapshotAtA, { edges: graph.edges, columns: graph.columns, bounds: graph.bounds, nodes: graph.nodes }))
check('graph 拉取失败（null）与空图谱可区分', pollContentFingerprint(snapshotAtA, null) !== pollContentFingerprint(snapshotAtA, { nodes: [], edges: [] }))
check('graph 指纹也是 8 位十六进制', /^[0-9a-f]{8}$/.test(graphFingerprint(graph)))
// graph-only 变化 ⇒ changed=true ⇒ 下一轮立即回基准 5s（不是等退避）。
const graphChanged = pollContentFingerprint(snapshotAtA, graph) !== pollContentFingerprint(snapshotAtA, { ...graph, nodes: [] })
check('graph-only 变化被判定为 changed', graphChanged)
check('changed=true ⇒ 立刻回 5s（不退避）', nextPollDelay({ changed: graphChanged, sameRounds: 7 }) === POLL_BASE_MS)

console.log('\n[组件接线：setTimeout 递归 + 清理]')
const here = dirname(fileURLToPath(import.meta.url))
const panelSource = readFileSync(join(here, '..', '..', 'src/client/panel/GuardPanel.tsx'), 'utf8')
check('轮询循环不再用 setInterval（旧定时器无法改周期）', !panelSource.includes('setInterval(() => void load('))
check('使用 setTimeout 递归续轮询', panelSource.includes('setTimeout('))
check('清理路径 clearTimeout（暂停/卸载不残留定时器）', panelSource.includes('clearTimeout('))
check('有 cancelled 闸门（在途 load resolve 后不得再挂 timer）', panelSource.includes('cancelled'))
check('状态栏显示真实间隔（pollDelay 而非写死常量）', /pollingOn.*pollDelay|pollDelay \/ 1000|pollDelay/.test(panelSource))
check('操作区另有间隔徽标（不必滚到页脚才能看到）', panelSource.includes('rg-poll-chip'))
check('操作区徽标同样使用 pollingOn {seconds} 与退避文案', /rg-poll-chip[\s\S]*?pollingOn[\s\S]*?pollingBackoff/.test(panelSource))
check('退避时有诚实说明文案键', panelSource.includes("t('panel.pollingBackoff')"))
const pollSource = readFileSync(join(here, '..', '..', 'src/client/panel/poll-adaptive.ts'), 'utf8')
check('注释写明计时从「请求完成后」开始（docs 契约来源）', pollSource.includes('resolve 之后'))
check('注释写明理由：避免并发双拉取/请求堆积', pollSource.includes('并发双拉取') && pollSource.includes('请求堆积'))
check('组件指纹覆盖 snapshot + graph 两条路由', panelSource.includes('pollContentFingerprint('))

if (failures > 0) {
  console.log(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nALL PASS')