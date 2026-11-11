import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 双字典对齐测试（键数、键集、占位符三张核对）。
 *
 * 为什么必须存在而不是「两个文件都加了」就算过
 * ----------------------------------------------
 * `t()` 的回退链是「当前语言 → 中文 → 键本身」。这条链会**掩盖**缺键：
 * 只往 zh.json 加一个键，英文界面不会报错，而是显示中文原文 ——
 * 症状是「英文版冒出一句中文」，而它出现在用户切语言的那一刻，
 * 测试跑不到、CI 看不见、开发者用的是中文系统所以本地也看不见。
 * 同理，插值名写错（zh 用 {count}、en 用 {number}）会让英文界面
 * 露出裸的花括号，而这只在英文版可见。
 *
 * 所以这里核对的是**三件事**：键集相同、无空值、占位符集合逐键相同。
 * 外加一条静态扫描：源码里出现的每个 `t('字面键')` 都必须在**两份**字典里存在。
 */

const here = join(fileURLToPath(import.meta.url), '..', '..', '..')
const zhPath = join(here, 'locale', 'zh.json')
const enPath = join(here, 'locale', 'en.json')
const clientDir = join(here, 'src', 'client')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 摊平成点号路径（与 i18n.ts 的 flatten 同语义：分支是对象、叶子是字符串）。 */
interface Dict {
  [key: string]: string | Dict
}

function flatten(dict: Dict, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.set(path, value)
    else if (value && typeof value === 'object') for (const [k, v] of flatten(value, path)) out.set(k, v)
  }
  return out
}

function main() {
  const zh = flatten(JSON.parse(readFileSync(zhPath, 'utf8')) as Dict)
  const en = flatten(JSON.parse(readFileSync(enPath, 'utf8')) as Dict)

  console.log('\n== 键集与键数 ==')
  {
    const zhKeys = [...zh.keys()].sort()
    const enKeys = [...en.keys()].sort()
    check('两份字典键数相同', zhKeys.length === enKeys.length, { zh: zhKeys.length, en: enKeys.length })
    const onlyZh = zhKeys.filter((key) => !en.has(key))
    const onlyEn = enKeys.filter((key) => !zh.has(key))
    check('没有「只在中文里」的键（英文版会露出中文原文）', onlyZh.length === 0, onlyZh)
    check('没有「只在英文里」的键', onlyEn.length === 0, onlyEn)
    check('字典非空（空文件会让上面的断言全部恒真）', zhKeys.length > 100, zhKeys.length)
  }

  console.log('\n== 无空值、无自我回退 ==')
  {
    const emptyZh = [...zh.entries()].filter(([, value]) => value.trim() === '')
    const emptyEn = [...en.entries()].filter(([, value]) => value.trim() === '')
    check('中文无空文案', emptyZh.length === 0, emptyZh.map(([key]) => key))
    check('英文无空文案', emptyEn.length === 0, emptyEn.map(([key]) => key))
    // 值等于键本身 ⇒ 这个条目从没被翻译过（回退链会把它藏起来）。
    const selfRef = [...zh.entries()].filter(([key, value]) => value === key)
    check('没有「值就是键名」的漏翻条目', selfRef.length === 0, selfRef.map(([key]) => key))
    const asciiOnlyZh = [...zh.entries()].filter(
      ([key, value]) => key.startsWith('graph.') && /^[\x00-\x7F]*$/.test(value) && !/[{}]/.test(value) && value.length > 3,
    )
    // 中文主语言里 graph.* 的文案应当含汉字 —— 全 ASCII 通常意味着把键名粘了进去。
    check('graph.* 中文文案含汉字（不是英文占位）', asciiOnlyZh.length === 0, asciiOnlyZh.map(([key, value]) => `${key}=${value}`))
  }

  console.log('\n== 插值占位符逐键对齐 ==')
  {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1] as string).sort()
    const mismatched: string[] = []
    for (const [key, value] of zh) {
      const other = en.get(key)
      if (other === undefined) continue
      const a = placeholders(value)
      const b = placeholders(other)
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatched.push(`${key}: zh[${a}] en[${b}]`)
    }
    check('每个键的 {占位符} 集合两语一致', mismatched.length === 0, mismatched)
  }

  console.log('\n== 源码里的每个字面键都存在 ==')
  {
    // 扫描 src/client 下**所有** .ts/.tsx（递归）。
    //
    // v0.15 功能域重构后 client 分成 panel/ graph/ api/ i18n/ 子目录：
    // 用 `readdirSync` 只读一层会**静默漏掉全部子目录**，扫描集变空、
    // 「扫到了客户端源码文件」这条断言会红 —— 那还是好的情况；
    // 若阈值放宽，它会变成一个「什么都没扫却全绿」的假测试。
    // 因此这里必须递归，且阈值按真实文件数校验。
    const clientFiles: string[] = []
    const walkClient = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) walkClient(path)
        else if (/\.(ts|tsx)$/.test(entry.name) && entry.name !== 'i18n.ts' && !entry.name.endsWith('.d.css.ts')) {
          clientFiles.push(path)
        }
      }
    }
    walkClient(clientDir)
    const files = clientFiles
    check('扫到了客户端源码文件（递归，含子目录）', files.length > 5, files.length)
    const missing: string[] = []
    let usedKeys = 0
    for (const filePath of files) {
      const raw = readFileSync(filePath, 'utf8')
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      // `(?<![\w$])` 很关键：`createElement('style')` 里的 `t('style` 不是翻译调用，
      // 早先一版扫描把它当成了键名，报了 8 个假缺口 —— 假缺口比没检查更糟，
      // 因为它教会下一个人「这个测试不准」。
      for (const match of source.matchAll(/(?<![\w$])t\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        const key = match[1] as string
        usedKeys += 1
        if (!zh.has(key)) missing.push(`zh:${filePath}:${key}`)
        if (!en.has(key)) missing.push(`en:${filePath}:${key}`)
      }
    }
    check('源码扫描到了足够多的键（防止正则失效后静默全过）', usedKeys > 80, usedKeys)
    check('每个 t(字面键) 在两份字典里都有', missing.length === 0, missing)
  }

  console.log('\n== 动态拼出的键族（模板字符串无法静态检查，这里显式钉住）==')
  {
    // GraphParts / GuardGraph 用 `t(\`graph.layout.${mode}\`)` 这类组合键。
    // 组合键的正则扫不到 ⇒ 新增一个档位却忘了配文案，只有这里能拦住。
    const families: Array<{ prefix: string; members: string[] }> = [
      { prefix: 'graph.layout.', members: ['layered', 'radial'] },
      { prefix: 'graph.color.', members: ['tone', 'kind', 'stage'] },
      { prefix: 'graph.kind.', members: ['capability', 'stage', 'metric', 'bundle', 'gap'] },
      { prefix: 'graph.linkRange.', members: ['hops1', 'hops2', 'closure'] },
    ]
    for (const family of families) {
      const absent = family.members.filter((member) => !zh.has(family.prefix + member) || !en.has(family.prefix + member))
      check(`组合键族 ${family.prefix}* 完整`, absent.length === 0, absent)
    }
    // 档位枚举与文案必须同源：LinkRange 的三个值都在上面钉了。
    for (const key of ['graph.edgeProduces', 'graph.edgeConsumes', 'graph.edgeTransitions', 'graph.edgeRanks']) {
      check(`边语义键 ${key} 双语齐备`, zh.has(key) && en.has(key))
    }
  }

  console.log(failures === 0 ? '\ni18n-parity 全部通过\n' : `\n${failures} 个断言失败\n`)
  if (failures > 0) process.exit(1)
}

main()
