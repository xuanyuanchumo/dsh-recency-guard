/**
 * api.ts 的失败语义测试（v0.12）—— 钉死「冲突信息不被 HTTP 状态码吞掉」。
 *
 * 踩过的坑：fetchJson 在非 2xx 时直接写 `HTTP ${status}` 就把 body 丢了，
 * 于是宿主的 409 `{reason, conflict, current}` 全部蒸发，面板只看到
 * 「请求失败」。乐观并发闭环的最后一米断在客户端 —— 而这在宿主层测试里
 * 完全看不出来（宿主层测的是路由返回什么）。
 *
 * 不起真服务器：桩 globalThis.fetch，断言返回结构。
 */
import { fetchSnapshot, postAction, isSnapshot } from '../../src/client/api.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 装一个按脚本返回的 fetch；返回被调用的请求列表。 */
function stubFetch(responses: Array<{ status: number; body: unknown; raw?: string }>): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let index = 0
  ;(globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const spec = responses[Math.min(index, responses.length - 1)]
    index += 1
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      async json() {
        if (spec.raw !== undefined) throw new Error('body is not JSON')
        return spec.body
      },
    }
  }
  return calls
}

const snapshotShape = { at: 'T', stage: 'monitoring', revision: 'deadbeefcafe' }

console.log('\n== 成功路径 ==')
{
  const calls = stubFetch([{ status: 200, body: snapshotShape }])
  const result = await fetchSnapshot()
  check('200 返回 ok 与数据', result.ok === true && (result as { data?: unknown }).data !== undefined, result)
  check('快照形状校验放行（at+stage）', isSnapshot(snapshotShape))
  check('不带分区时不拼 query', calls[0].url.endsWith('/snapshot'), calls[0].url)
}
{
  const calls = stubFetch([{ status: 200, body: snapshotShape }])
  await fetchSnapshot('abc123')
  check('带分区时拼 ?partition=', calls[0].url.includes('partition=abc123'), calls[0].url)
}

console.log('\n== available:false（读面请假）==')
{
  stubFetch([{ status: 200, body: { available: false, reason: '未知分区 ghost' } }])
  const result = await fetchSnapshot('ghost')
  check('available:false 转成失败并保留原因', result.ok === false && result.reason.includes('未知分区'), result)
}

console.log('\n== 409 冲突语义（v0.12 核心回归）==')
{
  stubFetch([
    {
      status: 409,
      body: { ok: false, conflict: 'stale-revision', reason: '状态已变化，动作未执行', current: 'cafe1234beef' },
    },
  ])
  const result = await postAction('archive', { reason: '测试', expectedRevision: 'stale0000000' })
  check('409 是失败', result.ok === false, result)
  if (result.ok === false) {
    check('409 保留宿主 reason 文案（不再被 HTTP 409 顶替）', result.reason.includes('状态已变化'), result.reason)
    check('409 透出 status 码', result.status === 409, result.status)
    check('409 透出机器可读 conflict（面板据此分支，不挂文案）', result.conflict === 'stale-revision', result.conflict)
    check('409 透出当前 revision（供带新值重试）', result.current === 'cafe1234beef', result.current)
  }
}

console.log('\n== 非 2xx 但 body 不是 JSON（降级不崩）==')
{
  stubFetch([{ status: 500, body: null, raw: '<html>500</html>' }])
  const result = await postAction('restore', {})
  check('body 解析失败时退回状态码文案', result.ok === false && result.reason === 'HTTP 500', result)
  check('解析失败不冒充有 conflict', result.ok === false && result.conflict === undefined, result)
}

console.log('\n== 网络异常 ==')
{
  ;(globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error('Failed to fetch')
  }
  const result = await postAction('recover', {})
  check('异常转成失败并带原因', result.ok === false && result.reason.includes('Failed to fetch'), result)
  check('异常时没有 status（缺席 ≠ 0）', result.ok === false && result.status === undefined, result)
}

console.log(failures === 0 ? '\napi 全部通过\n' : `\n${failures} 个断言失败\n`)
if (failures > 0) process.exit(1)
