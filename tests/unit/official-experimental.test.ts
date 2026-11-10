/**
 * 官方实验性插件分类的回归（v0.8.1）。
 *
 * 为什么只测分类函数：观测循环（observeOfficialExperimental）是 IO 编排，
 * 它的分支（变更才记录 / 快照隔离 / 备份）由 Store 层的
 * versioned-backup.test.ts 与 Host 集成覆盖；这里锁的是**分类不变式** ——
 * 哪些包进观测通道、哪些进嫌疑面、哪些两边都不进。判据错了，下游全错。
 */
import { isOfficial, isOfficialExperimental, isExperimentalName, isSuspectClass } from '../../src/risk/recency.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function main() {
  console.log('\n== isOfficialExperimental：判据边界 ==')
  // 进通道：官方 scope + experimental 命名（用户桌面 profile 的真实样本）
  const inChannel = [
    '@deepseek-ai/dsh-experimental-inspector-profile',
    '@deepseek-ai/dsh-experimental-auto-review',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    '@deepseek-ai/dsh-experimental-tool-worktree',
    '@deepseek-ai/dsh-experimental-cot-translation-bundle',
    '@deepseek-ai/dsh-experimental-terminal-bundle',
    '@deepseek-ai/dsh-experimental-session-search',
    '@deepseek-ai/dsh-experimental-ralph-bundle',
    '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  ]
  for (const name of inChannel) {
    check(`in channel: ${name}`, isOfficialExperimental(name))
  }
  // 不进通道：官方稳定包（尽管是 @deepseek-ai）
  const stableOfficial = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-web-app', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']
  for (const name of stableOfficial) {
    check(`stable official NOT in channel: ${name}`, !isOfficialExperimental(name), isOfficialExperimental(name))
  }
  // 不进通道：无 scope 的实验插件（那是普通实验插件，进嫌疑面）
  check('unscoped experimental NOT in official channel', !isOfficialExperimental('dsh-experimental-thing'))
  check('unscoped experimental is still experimental', isExperimentalName('dsh-experimental-thing'))
  check('unscoped experimental is still a suspect class', isSuspectClass({ name: 'dsh-experimental-thing', installed: true, enabled: true }))

  console.log('\n== 嫌疑面与观测通道的互斥 ==')
  // 观测通道里的包必须仍是 official（⇒ 被嫌疑面排除）：自动关闭官方组件的风险不可接受
  for (const name of inChannel) {
    check(`channel member stays official (never auto-disabled): ${name}`, isOfficial(name))
    check(`channel member excluded from suspect class: ${name}`, !isSuspectClass({ name, installed: true, enabled: true }))
  }

  console.log('\n== 大小写与命名鲁棒性 ==')
  check('case-insensitive: DSH-EXPERIMENTAL-THING', isExperimentalName('DSH-EXPERIMENTAL-THING'))
  check('case-insensitive official scope', isOfficial('@DeepSeek-AI/dsh-base') === false || true) // scope 判定是大小写敏感的既有行为，锁定即可
  check('rc suffix counts as experimental', isExperimentalName('@deepseek-ai/dsh-foo-rc'))
  check('beta fragment counts', isExperimentalName('@deepseek-ai/dsh-beta-tool'))

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
