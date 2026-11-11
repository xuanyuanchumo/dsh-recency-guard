/**
 * `observe/cooccurrence-store.ts` 直接单测（T15-04）。
 *
 * 为什么补这条：共现样本与观测快照是**研究证据链**，但此前只被 store.ts /
 * decision-views 间接消费，没有直接测试 ⇒ 六处 try/catch 与「畸形样本跳过」
 * 的取舍从未进过变异池。畸形数据下的行为必须逐条钉住：
 * 一条坏样本不能让所有历史证据消失（模块头注释的承诺）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import {
  cooccurrencePath,
  emptyStoredCooccurrence,
  observationPath,
  readCooccurrenceSync,
  readObservationSync,
  toObservationMap,
  writeCooccurrenceSync,
  writeObservation,
} from '../../src/host/observe/cooccurrence-store.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const root = await mkdtemp(join(tmpdir(), 'rg-cooc-test-'))
try {
  console.log('\n== 路径与空值 ==')
  check('空存储形状 = schemaVersion 1 + 空样本', JSON.stringify(emptyStoredCooccurrence()) === '{"schemaVersion":1,"samples":[]}')
  const path = cooccurrencePath(join(root, 'p1'))
  check('共现文件路径以 cooccurrence.json 结尾', path.endsWith('cooccurrence.json') && path.includes('p1'), path)

  console.log('\n== 读写往返 ==')
  const dir = join(root, 'p1')
  check('文件不存在 ⇒ 空存储（不抛）', JSON.stringify(readCooccurrenceSync(dir)) === '{"schemaVersion":1,"samples":[]}')
  writeCooccurrenceSync(dir, {
    schemaVersion: 1,
    samples: [{ at: '2026-11-11T00:00:00.000Z', officialActive: ['a'], suspects: ['b'], disabled: ['c'] }],
  })
  const roundtrip = readCooccurrenceSync(dir)
  check('写后读回同一条样本', roundtrip.samples.length === 1 && roundtrip.samples[0]?.suspects[0] === 'b', roundtrip)
  check('落盘文件真的存在', readFileSync(cooccurrencePath(dir), 'utf8').includes('"at"'))

  console.log('\n== 畸形数据：逐条跳过，不整份失效 ==')
  writeFileSync(cooccurrencePath(dir), '{"schemaVersion":1,"samples":"nope"}', 'utf8')
  check('samples 不是数组 ⇒ 空存储', readCooccurrenceSync(dir).samples.length === 0)
  writeFileSync(cooccurrencePath(dir), '{ not json', 'utf8')
  check('JSON 损坏 ⇒ 空存储（不抛）', readCooccurrenceSync(dir).samples.length === 0)
  writeFileSync(
    cooccurrencePath(dir),
    JSON.stringify({
      schemaVersion: 1,
      samples: [
        null,
        { at: 123 },
        { at: 't', officialActive: ['a', 2], suspects: 'x', disabled: [1, 'b'] },
      ],
    }),
    'utf8',
  )
  const filtered = readCooccurrenceSync(dir)
  check('跳过 null / 无 at 的条目（只剩 1 条）', filtered.samples.length === 1, filtered.samples)
  check('字符串数组只保留字符串元素', JSON.stringify(filtered.samples[0]?.officialActive) === '["a"]', filtered.samples[0])
  check('非数组字段降级为空数组', JSON.stringify(filtered.samples[0]?.suspects) === '[]', filtered.samples[0])

  console.log('\n== 写失败只降级（best effort）==')
  const fileAsDir = join(root, 'file-as-dir')
  writeFileSync(fileAsDir, 'x', 'utf8')
  let writeThrew: unknown
  try {
    writeCooccurrenceSync(fileAsDir, emptyStoredCooccurrence())
  } catch (error) {
    writeThrew = error
  }
  check('共现写失败不抛（目录被占成文件）', writeThrew === undefined, writeThrew)

  console.log('\n== 观测快照 ==')
  // 不变式（不是「当前行为」）：快照名必须是**扁平文件名**。
  // 此前 sanitizeName 的白名单保留了 '/'，作用域包名会建出子目录；
  // 更糟的是 '.' 也允许 ⇒ `@a/../../escape` 能跳出分区目录（路径逃逸）。
  // 断言按「不安全 = 红」写：这条测试曾经因为把现状抄成期望而变成假绿。
  const op = observationPath(dir, '@scope/pkg')
  check('作用域包名被扁平化（文件名不含路径分隔符）', !basename(op).includes('/') && !basename(op).includes('\\'), op)
  check('观测快照路径不越出分区目录', !relative(dir, op).startsWith('..'), op)
  check('观测快照名仍包含 observation- 前缀', op.includes('observation-'), op)
  const evil = observationPath(dir, '@a/../../escape')
  check('带 ../ 的包名不能逃出分区目录', !relative(dir, evil).startsWith('..'), evil)
  check('拖名里的 ../ 不能出现在文件名中', !basename(evil).includes('..'), evil)
  check('观测快照名不含空白', !/\s/.test(op), op)
  const badName = observationPath(dir, 'bad name!')
  check('非法字符被替换成下划线', badName.includes('bad_name_'), badName)

  writeFileSync(op, JSON.stringify({ a: { version: '1.0.0', enabled: true }, b: { enabled: false } }), 'utf8')
  const obs = readObservationSync(dir, '@scope/pkg')
  check('同步读回两条观测', obs.size === 2 && obs.get('a')?.version === '1.0.0' && obs.get('b')?.enabled === false, [...obs])
  writeFileSync(op, '{ broken', 'utf8')
  check('观测 JSON 损坏 ⇒ 空 Map（不抛）', readObservationSync(dir, '@scope/pkg').size === 0)
  mkdirSync(join(root, 'p2'), { recursive: true })
  await writeObservation(join(root, 'p2'), 'dsh-x', new Map([['k', { enabled: true, version: '2' }]]))
  const asyncObs = readObservationSync(join(root, 'p2'), 'dsh-x')
  check('异步写 → 同步读（崩溃路径能读到）', asyncObs.get('k')?.version === '2', [...asyncObs])

  check('toObservationMap(null) ⇒ 空 Map', toObservationMap(null).size === 0)
  check('toObservationMap(字符串) ⇒ 空 Map', toObservationMap('nope').size === 0)
  const mixed = toObservationMap({ a: { version: '1' }, b: 'not-an-object', c: { enabled: false } })
  check('非对象条目被跳过', mixed.size === 2 && !mixed.has('b'), [...mixed.keys()])
  check('enabled 缺省为 true、显式 false 保留', mixed.get('a')?.enabled === true && mixed.get('c')?.enabled === false)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)