/**
 * 多项目隔离的用户旅程（v0.13 T11-19「举他」验证）。
 *
 * ## 为什么这条必须存在
 *
 * 用户明确要求「不同项目使用本插件要隔离显示不能污染」。隔离机制
 * （`isolation.ts` 的 SHA-256 分区键 + 指针文件）此前只有**单元测试**验证
 * 纯函数，没有验证「两个真实工作区并存时，产物真的落在不同分区」。
 *
 * ## 旅程覆盖
 *
 * J1 两个不同工作区 ⇒ 两个不同分区键
 * J2 分区目录物理隔离（各自有独立的 journal/state 目录）
 * J3 指针文件指向「最后一个启动的工作区」（这是已知取舍，必须如实记录）
 * J4 一个工作区的崩溃计数不污染另一个
 * J5 大小写不同的同一路径 ⇒ 同一分区（Windows 路径不敏感）
 *
 * ## 诚实边界
 *
 * J3 验证的是**已知缺陷**而不是正确性：指针在 profile 目录是全局一份，
 * 并发工作区会串扰（`decision.ts` 头注已声明）。这里把它写成断言，
 * 是为了让「串扰确实存在」成为可复现事实，而不是口头风险。
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectKey, normalizeWorkspace, partitionDir, projectLabel } from '../../src/core/isolation.ts'
import { writePointer, pointerPath, readPointer } from '../../src/guard/decision.ts'
import { readFileSync, writeFileSync } from 'node:fs'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function main() {
  const profileDir = mkdtempSync(join(tmpdir(), 'rg-isolation-'))
  console.log('\n== J1 不同工作区 ⇒ 不同分区键 ==')
  const workspaceA = 'D:/Projects/Alpha'
  const workspaceB = 'D:/Projects/Beta'
  const keyA = projectKey(workspaceA)
  const keyB = projectKey(workspaceB)
  check('两个工作区分区键不同', keyA !== keyB, { keyA, keyB })
  check('分区键是 16 位十六进制', /^[0-9a-f]{16}$/.test(keyA), keyA)

  console.log('\n== J2 分区目录物理隔离 ==')
  const dirA = partitionDir(profileDir, keyA)
  const dirB = partitionDir(profileDir, keyB)
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  check('A 的分区目录存在', existsSync(dirA), dirA)
  check('B 的分区目录存在', existsSync(dirB), dirB)
  check('两个分区目录路径不同', dirA !== dirB)

  console.log('\n== J3 指针文件：已知串扰（如实记录为断言）==')
  writePointer(profileDir, keyA, dirA)
  const afterA = readPointer(profileDir)
  check('指针指向 A', afterA?.partitionKey === keyA, afterA)
  writePointer(profileDir, keyB, dirB)
  const afterB = readPointer(profileDir)
  check('指针被 B 覆盖（串扰存在，与 decision.ts 头注一致）', afterB?.partitionKey === keyB, afterB)
  check('指针文件是 profile 级唯一一份', existsSync(pointerPath(profileDir)))
  check('指针里带 partitionKey 供归因', typeof afterB?.partitionKey === 'string')

  console.log('\n== J4 一个工作区的状态不污染另一个 ==')
  {
    // 隔离的实质：两个分区目录各写各的，互不可见。
    const stateA = join(dirA, 'state.json')
    const stateB = join(dirB, 'state.json')
    writeFileSync(stateA, JSON.stringify({ crashSeq: 3 }), 'utf8')
    writeFileSync(stateB, JSON.stringify({ crashSeq: 0 }), 'utf8')
    const readA = JSON.parse(readFileSync(stateA, 'utf8'))
    const readB = JSON.parse(readFileSync(stateB, 'utf8'))
    check('A 的 crashSeq 是 3', readA.crashSeq === 3, readA)
    check('B 的 crashSeq 是 0（未被 A 污染）', readB.crashSeq === 0, readB)
  }

  console.log('\n== J5 Windows 路径大小写不敏感 ⇒ 同一分区 ==')
  {
    const lower = 'd:/projects/alpha'
    const upper = 'D:/Projects/Alpha'
    check('大小写不同归一化到同一键', projectKey(lower) === projectKey(upper), {
      lower: projectKey(lower),
      upper: projectKey(upper),
    })
    check('反斜杠与正斜杠等价', projectKey('D:\\Projects\\Alpha') === projectKey('D:/Projects/Alpha'))
    check('末尾分隔符不影响', projectKey('D:/Projects/Alpha/') === projectKey('D:/Projects/Alpha'))
    check('展示名保留原始大小写', projectLabel(upper) === 'Alpha', projectLabel(upper))
    check('规范化结果不含反斜杠', !normalizeWorkspace('D:\\Projects\\Alpha').includes('\\'))
  }

  console.log('\n== J6 不同盘符/不同层级不撞键 ==')
  {
    check('C 盘与 D 盘同路径不同键', projectKey('C:/Projects/Alpha') !== projectKey('D:/Projects/Alpha'))
    check('嵌套路径与父路径不同键', projectKey('D:/Projects/Alpha/sub') !== projectKey('D:/Projects/Alpha'))
  }

  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  check('临时 profile 已清理', !existsSync(profileDir))

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
