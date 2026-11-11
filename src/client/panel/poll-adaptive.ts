/**
 * 自适应轮询 —— 内容指纹 + 退避策略（TD `panel-error-boundary-adaptive-poll` 第 2 项）。
 *
 * ## 为什么需要它
 *
 * 固定 5s 轮询在两种情况下都不对：
 * - **数据稳定**时：每 5s 拉一次全量快照，白烧宿主 CPU/IO，还会让指针下的
 *   图谱频繁重渲染（用户只是看了一眼面板）；
 * - **数据剧变**时：5s 的窗口会把「正在崩溃循环」的关键几秒吞掉。
 *
 * 正确形态是「稳定退避 + 变化立刻回来」：连续多轮内容不变 ⇒ 5s→10s→15s
 * 封顶；一旦内容变化 ⇒ 立即回到 5s。**变化优先**——宁可多拉一次，也不能
 * 让用户等 15s 才看见新的崩溃。
 *
 * ## 为什么指纹要「稳定序列化」
 *
 * 宿主返回的 JSON 字段顺序在不同序列化路径下可能不同（对象构造顺序、
 * 增量合并）。直接 `JSON.stringify` 会把「内容相同、键序不同」判成变化，
 * 退避永远触发不了。规范化 JSON（递归按键名排序）+ FNV-1a 32 位哈希
 * 给出与顺序无关的指纹，且无任何依赖。
 *
 * 本文件纯函数、无 React/DOM/node 依赖，可在无浏览器环境逐条断言。
 */

/** 默认轮询基准（毫秒）。 */
export const POLL_BASE_MS = 5000
/** 轮询下限：再快就会让面板自己成为负载。 */
export const POLL_MIN_MS = 3000
/** 轮询上限：数据再稳定也不能超过 30s 才刷新一次。 */
export const POLL_MAX_MS = 30000
/**
 * 退避封顶倍数 —— 5s × 3 = 15s。
 *
 * 为什么与 `POLL_MAX_MS` 分开：上限 30s 是「绝对不许更慢」的硬边界，
 * 15s 是「退避策略本身只走三档」的设计。两者都生效：默认 max 下阶梯是
 * 5/10/15，自定义更小的 max 时会被 max 提前截断。
 */
export const POLL_BACKOFF_MULTIPLIER = 3

export interface PollDelayInput {
  /** 连续多少轮内容**未变**（首轮/刚变化为 0）。 */
  sameRounds: number
  /** 内容是否变化（变化优先于退避）。 */
  changed: boolean
  baseMs?: number
  minMs?: number
  maxMs?: number
}

/** 正整数兜底：坏输入（NaN/负数/0）回落默认值，保证最终延迟有限。 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 计算下一次轮询延迟（毫秒）。
 *
 * 阶梯（默认值）：变化/首轮/坏输入 ⇒ 5000；连续 1 轮不变 ⇒ 10000；
 * 连续 ≥2 轮不变 ⇒ 15000 封顶。最终结果永远落在 `[minMs, maxMs]` 内
 * （默认 [3000, 30000]），且一定是有限正数 —— 这个函数直接喂给
 * `setTimeout`，吐出 NaN 会让轮询永久停摆。
 */
export function nextPollDelay(input: PollDelayInput): number {
  const base = positive(input.baseMs, POLL_BASE_MS)
  let min = positive(input.minMs, POLL_MIN_MS)
  let max = positive(input.maxMs, POLL_MAX_MS)
  if (min > max) {
    // 调用方把上下限写反时交换而不是抛错：轮询是观测设施，不能因参数
    // 配置错误而停摆；交换后语义仍然是「夹在两者之间」。
    const swapped = min
    min = max
    max = swapped
  }
  const clamp = (value: number): number => Math.round(Math.min(max, Math.max(min, value)))
  // changed 只认真正的 true：undefined/字符串等异常值按「未变化」处理，
  // 避免一个坏字段把退避永久重置成 5s。
  if (input.changed === true) return clamp(base)
  const rounds =
    typeof input.sameRounds === 'number' && Number.isFinite(input.sameRounds) && input.sameRounds > 0
      ? Math.floor(input.sameRounds)
      : 0
  const cap = Math.min(max, base * POLL_BACKOFF_MULTIPLIER)
  const raw = base * (1 + rounds)
  // rounds 极大时乘法可能溢出成 Infinity：clamp 前先回落到 cap。
  return clamp(Number.isFinite(raw) ? Math.min(cap, raw) : cap)
}

/* ---------- 稳定序列化 + FNV-1a ---------- */

/** 规范 JSON：对象键递归排序，数组保序；非有限数字按 JSON 语义变 null。 */
export function stableStringify(value: unknown): string {
  return canonicalize(value, new Set<object>())
}

function canonicalize(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'number':
      // JSON 里 NaN/Infinity 都是 null：保留它们为 "NaN" 会让指纹有意义地
      // 抖动（而宿主 JSON 根本发不出来）。
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      // JSON.stringify(BigInt) 会抛；快照里没有 BigInt，按字符串稳定化。
      return JSON.stringify(`${value.toString()}n`)
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null'
    default:
      break
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) return JSON.stringify('[Circular]')
    stack.add(value)
    const out = `[${value.map((entry) => canonicalize(entry, stack)).join(',')}]`
    stack.delete(value)
    return out
  }
  const object = value as Record<string, unknown>
  if (stack.has(object)) return JSON.stringify('[Circular]')
  stack.add(object)
  const parts: string[] = []
  // 键排序是「顺序无关」的全部秘密；只跳过 JSON 本身会省略的成员
  // （undefined / function / symbol），与 JSON.stringify 的省略语义一致。
  for (const key of Object.keys(object).sort()) {
    const entry = object[key]
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue
    parts.push(`${JSON.stringify(key)}:${canonicalize(entry, stack)}`)
  }
  stack.delete(object)
  return `{${parts.join(',')}}`
}

/**
 * FNV-1a 32 位哈希（无依赖、确定性）。
 *
 * 为什么是 FNV 而不是 crypto：指纹只用来判断「同一/不同」，不做安全
 * 承诺；FNV-1a 十行、无异步、浏览器/Node 一致，同步路径上不会引入
 * microtask —— 轮询重排时少一个竞态源。
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    // Math.imul 保持 32 位乘法语义；普通 * 会丢精度成浮点。
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * 指纹里**必须剔除**的易变字段。
 *
 * `at` 是快照时刻、`diagnostics.snapshotMs` 是本次组装耗时 —— 它们每次
 * 请求都变。若参与指纹，「内容没变」永远判不出来，退避退化成固定 5s。
 * 这是本轮最容易写错的地方：测试必须覆盖「只改 at/耗时 ⇒ 指纹不变」。
 */
const OMIT_TOP_LEVEL = new Set(['at'])
const OMIT_DIAGNOSTIC_KEYS = new Set(['snapshotMs'])

function stripVolatile(snapshot: unknown): unknown {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot
  const copy: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) }
  for (const key of OMIT_TOP_LEVEL) delete copy[key]
  const diagnostics = copy.diagnostics
  if (diagnostics !== null && typeof diagnostics === 'object' && !Array.isArray(diagnostics)) {
    const cleaned: Record<string, unknown> = { ...(diagnostics as Record<string, unknown>) }
    for (const key of OMIT_DIAGNOSTIC_KEYS) delete cleaned[key]
    copy.diagnostics = cleaned
  }
  return copy
}

/** 快照内容指纹（8 位十六进制，便于日志/调试肉眼比对）。 */
export function snapshotFingerprint(snapshot: unknown): string {
  return fnv1a32(stableStringify(stripVolatile(snapshot))).toString(16).padStart(8, '0')
}

/**
 * 图谱内容指纹 —— 与快照同一套规范序列化 + FNV-1a。
 *
 * 为什么图谱要单独进指纹（v0.17 T15-11 收口）：轮询同时拉 snapshot 与 graph，
 * 二者是**独立路由**；能力节点/边发生变化（插件安装、能力契约变化）时快照
 * 可能一字未改。只哈希 snapshot ⇒ graph-only 变化会被判成「稳定」，最长要等
 * 一个退避周期（15s）才刷新 —— 用户会看到「新插件已装上，图里还没有」。
 * 图谱没有时间戳字段，不需要剔除易变字段：`nodes/edges/bounds/columns`
 * 都是确定性投影。
 */
export function graphFingerprint(graph: unknown): string {
  return fnv1a32(stableStringify(graph ?? null)).toString(16).padStart(8, '0')
}

/**
 * 一次轮询的**完整内容指纹** = 快照指纹 + 图谱指纹。
 *
 * 用分隔符拼接而不是把两个对象 merge 后再序列化：两者形状不同，merge 会
 * 让「graph 为 null（拉取失败）」与「graph 是空对象」有歧义；拼接保留
 * 两侧各自的「缺失」形态，且任一变化都改变结果。
 */
export function pollContentFingerprint(snapshot: unknown, graph: unknown): string {
  return `${snapshotFingerprint(snapshot)}|${graphFingerprint(graph)}`
}

/** 一次加载的轮询结果（组件据此决定下一轮延迟）。 */
export interface PollOutcome {
  changed: boolean
  /** 截至本次加载，连续未变的轮数。 */
  sameRounds: number
}

/*
 * ## 计时起点（有意选择，写进轮询契约）
 *
 * 下一轮定时器在 `load()` **resolve 之后**才创建 —— 标称间隔是「上一次请求
 * 完成 → 下一次请求开始」的间隔，慢请求会让实际周期 = 请求耗时 + 标称间隔。
 *
 * 为什么故意不按固定节拍（不从上一次**开始**计时）：
 * 1. **避免并发双拉取**：宿主数据面偶发慢（大 journal / 冷启动）时，固定节拍
 *    会在上一个请求还没回来时再发一个，两个响应乱序落地 ⇒ 面板可能在旧数据
 *    之后被新数据覆盖，再被旧数据覆盖（画面倒退）。
 * 2. **不让请求堆积**：慢宿主 + 快轮询会排队，队列本身就是新的负载源；观测
 *    设施不能成为它观测对象的压力。
 * 3. 采样率本来就是「完成后再等」，而不是「固定频率采样」—— 本面板要的是
 *    「数据是否变化」，不是等间隔时间序列。
 */