/**
 * 配置 fail-loud（T16-01，学习 dsh-ops §2.5）。
 *
 * 钉住三件事：
 * 1. **未知键抛 ConfigError 且键名点名**——用户写错键名（backupDir ↔
 *    backupRoot）必须看得见，而不是配置静默失效；
 * 2. **合法键全过**——校验不误伤既有配置；
 * 3. **cordis 内部键（`$` 前缀）跳过**——宿主簿记不是用户配置，
 *    校验它们会把内部状态误报成未知键。
 *
 * 消息断言抄实现常量（v0.14 教训：断言锚点必须与实现文案同源——
 * 这里断言 `ConfigError` 的 `name` 字段而非消息全文，name 是稳定身份，
 * 消息文本的格式变化不该让本测试变红）。
 */
import { CONFIG_KNOWN_KEYS, ConfigError, rejectUnknownConfigKeys } from '../../src/host/core/config-strict.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function expectConfigError(fn: () => void): ConfigError | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof ConfigError ? error : null
  }
}

async function main(): Promise<void> {
  console.log('\n== 未知键 fail-loud ==')
  {
    const error = expectConfigError(() => rejectUnknownConfigKeys({ enabled: true, backupDir: '/tmp' }))
    check('unknown key throws ConfigError', error !== null)
    check('error names the offending key', error?.message.includes('backupDir') === true, error?.message)
    check('error lists accepted keys', error?.message.includes('backupRoot') === true, error?.message)
    check('error identity is ConfigError', error?.name === 'ConfigError')
  }
  {
    // 多个未知键一次列全（用户不用改一轮报一轮）。
    const error = expectConfigError(() => rejectUnknownConfigKeys({ foo: 1, bar: 2 }))
    check('multiple unknown keys listed together', error?.message.includes('foo') === true && error?.message.includes('bar') === true, error?.message)
  }

  console.log('\n== 合法键全过 ==')
  {
    const allValid = Object.fromEntries(CONFIG_KNOWN_KEYS.map((k) => [k, k === 'enabled' ? true : k === 'maxAutoDisable' ? 2 : 'x']))
    let threw: unknown = null
    try {
      rejectUnknownConfigKeys(allValid)
    } catch (error) {
      threw = error
    }
    check('all known keys pass', threw === null, threw)
  }
  {
    check('empty object passes', expectConfigError(() => rejectUnknownConfigKeys({})) === null)
    check('null passes', expectConfigError(() => rejectUnknownConfigKeys(null)) === null)
    check('undefined passes', expectConfigError(() => rejectUnknownConfigKeys(undefined)) === null)
    // 非对象（数组/字符串）不校验键——值类型错误由 schema 层管，键校验不越界。
    check('array passes (value layer is schema concern)', expectConfigError(() => rejectUnknownConfigKeys(['enabled'])) === null)
  }

  console.log('\n== cordis 内部键跳过 ==')
  {
    // $version / $effectiveScope 是宿主写进配置行的内部簿记。
    check('$-prefixed keys skipped', expectConfigError(() => rejectUnknownConfigKeys({ $version: 1, enabled: true })) === null)
  }

  console.log('\n== 自定义 known 清单（测试注入） ==')
  {
    check('custom known list respected', expectConfigError(() => rejectUnknownConfigKeys({ custom: 1 }, ['custom'])) === null)
    const error = expectConfigError(() => rejectUnknownConfigKeys({ enabled: true }, ['custom']))
    check('custom known list still rejects others', error !== null)
  }

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURES\n`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((error) => {
    console.log('  FAIL  harness crashed', String(error))
    process.exit(1)
  })
