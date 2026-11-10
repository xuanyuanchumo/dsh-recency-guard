import zh from '../../../locale/zh.json' with { type: 'json' }
import en from '../../../locale/en.json' with { type: 'json' }

/**
 * 客户端文案 —— 自持字典（不依赖宿主 locale 服务）。
 *
 * 为什么自持而不是 `ctx.locale.register`
 * --------------------------------------
 * `ctx.locale` 在旧宿主/独立测试环境里可能缺席，而面板**不该因为没有
 * locale 服务就白屏**。自持字典的做法：
 * - 有宿主 locale 服务时，仍用它（见 `index.ts` 的注册）以获得实时切换；
 * - 没有时退回本模块的 `t()`，行为不变。
 *
 * 检测链：`localStorage` 显式选择 → `document.documentElement.lang` → 默认中文。
 * **不读 `navigator.language`**：测试环境默认 `en-US`，会把中文断言全部翻红。
 */

export type ClientLang = 'zh' | 'en'

/**
 * 字典节点 —— 递归结构：叶子是字符串，分支是嵌套对象。
 *
 * 为什么递归而不是「string | 一层对象」：图例键（graph.kind.capability）
 * 天然是两层分组（类型 → 语言），硬拍平会让 zh/en 文件出现 `kind.x`
 * 字面量键 —— 与 lookup 的点号路径语义（按 `.` 拆段逐层下钻）不一致，
 * 实测会让翻译回退到键本身。
 */
export interface Dict {
  [key: string]: string | Dict
}

/** 语言选择键。 */
export const LANG_KEY = 'recency-guard-lang'

/** 读取当前语言。 */
export function detectClientLang(): ClientLang {
  try {
    const stored = globalThis.localStorage?.getItem(LANG_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    /* storage 不可用 ⇒ 走下一级 */
  }
  try {
    const element = (globalThis as { document?: { documentElement?: { lang?: string } } }).document?.documentElement
    const lang = element?.lang
    if (typeof lang === 'string' && lang.toLowerCase().startsWith('en')) return 'en'
  } catch {
    /* 无 DOM ⇒ 走默认值 */
  }
  return 'zh'
}

/** 宿主语言联动（仅在用户没有显式选择时写入）。 */
export function setLocaleFromHost(active: string): void {
  if (active !== 'zh' && active !== 'en') return
  try {
    if (globalThis.localStorage?.getItem(LANG_KEY) !== null) return
    globalThis.localStorage?.setItem(LANG_KEY, active)
  } catch {
    /* storage 不可用 ⇒ 不影响默认链 */
  }
}

/** 在嵌套字典里查一个键（点号路径）。 */
function lookup(dict: Dict, key: string): string | undefined {
  let current: unknown = dict
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' ? current : undefined
}

/** 翻译。回退链：当前语言 → 中文 → 键本身（缺翻译要**看得见**，不是空白）。 */
export function t(key: string, params?: Record<string, string | number>): string {
  // 回退链：当前语言 → 英文 → 中文 → 键本身。
  // （中文是主语言，故在英文之后兜底；缺翻译要**看得见**，不是空白。）
  const raw = lookup(detectClientLang() === 'en' ? (en as Dict) : (zh as Dict), key) ?? lookup(zh as Dict, key) ?? key
  if (!params) return raw
  let out = raw
  for (const [name, value] of Object.entries(params)) {
    out = out.replaceAll(`{${name}}`, String(value))
  }
  return out
}

/** 交给宿主 locale 服务的字典（若存在）。 */
export function registerDictionaries(): { zh: Record<string, string>; en: Record<string, string> } {
  return { zh: flatten(zh as Dict), en: flatten(en as Dict) }
}

/**
 * 把嵌套字典摊平成点号路径。
 *
 * 宿主的 `locale.register` 要求**扁平的点号键**（否则 `t('a.b')` 找不到）。
 */
function flatten(dict: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[path] = value
    else if (value && typeof value === 'object') Object.assign(out, flatten(value as Dict, path))
  }
  return out
}
