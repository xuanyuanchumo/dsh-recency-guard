/**
 * 文件名安全投影（T15 真实缺陷修复 + 去重）。
 *
 * ## 缺陷回顾（实测，不是假想）
 *
 * 两份拷贝（`data/store.ts` 的 `sanitize`、`observe/cooccurrence-store.ts`
 * 的 `sanitizeName`）都用过白名单 `[^A-Za-z0-9._@/-]` —— **包含 `/`**，
 * 且 `..` 由两个合法字符组成、正则挡不住：
 * - `'@scope/pkg'` ⇒ 文件名里带 `/`，`path.join` 把它当分隔符 ⇒ 多建一层
 *   子目录（写入方 `mkdirSync` 会建出来，读取方按文件找就 ENOENT）；
 * - `'@a/../../escape'` ⇒ 跳出分区/备份目录。
 *
 * ## 为什么现在只有**一份**实现
 *
 * 之前两份各自独立是「避免 observe → data 循环依赖」的权宜之计，代价是
 * 两份必然漂移（本项目在宽度实现上已经踩过）。本文件下沉到 `core`（零依赖），
 * 两边都 import 它 —— 循环依赖问题消失，漂移在结构上不可能发生。
 *
 * ## 投影规则（顺序有意义）
 *
 * 1. 分隔符（`/` `\`）→ `_`：先折叠，否则 `..` 会被拆成独立段；
 * 2. 连续点（`..`）→ `_`：`..` 段失去路径语义；
 * 3. 其余非法字符 → `_`。
 *
 * ## 为什么改写后要加指纹（自查发现的**新**风险）
 *
 * 第 1 步把 `/` 折成 `_` 会让 `'@scope/pkg'` 与真实存在的 `'@scope_pkg'`
 * 投影到**同一个文件** —— 两个不同包静默互相覆盖。指纹取自**原始名称**，
 * 于是「改写后才相同」的输入仍可区分；**未改写**的名称保持原样（存量兼容：
 * 生产常量 `'official-experimental'` 的文件名不变）。
 */
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

/** 允许出现在文件名里的字符（不含分隔符）。 */
const SAFE_CHARS = /[^A-Za-z0-9._@-]/g
const SEPARATORS = /[\\/]+/g
const DOT_RUNS = /\.{2,}/g

/**
 * 把任意字符串投影成**单个路径段**（不含 `/`、`\`、`..` 段）。
 *
 * 输出恒为「扁平文件名」：调用方可以安全地 `join(parent, pathSafeName(x))`，
 * 不需要 `mkdir` 子目录，也不会越出 `parent`。
 *
 * ## 指纹宽度（v0.18，TD-7 根治）
 *
 * 8 位 hex（32 bit）指纹的生日碰撞 ≈2.3×10⁻¹⁰，几十条目量级「可忽略」——
 * 但后果是**静默覆盖**，而本项目的纪律是「不静默」。v0.18 升到 16 位 hex
 * （64 bit），生日碰撞 ≤ 5.4×10⁻²⁰：即使全宇宙的插件条目也撞不上。
 *
 * ## 存量迁移（为什么还有 `legacyFingerprintName`）
 *
 * 改指纹宽度 = 改文件名 ⇒ v0.17 写出的带 8 位指纹文件「凭空消失」。
 * 读取端走 `candidateNames()` 双读：先试 64 位新名，再试 8 位旧名；
 * 写入端只写新名（下一次覆盖写即完成迁移，无需批量重命名工具）。
 */
export function pathSafeName(name: string): string {
  const flat = name.replace(SEPARATORS, '_').replace(DOT_RUNS, '_').replace(SAFE_CHARS, '_')
  if (flat === name) return flat
  return `${flat}-${fingerprint(name, 16)}`
}

/** v0.17 时代的 8 位指纹投影 —— 只用于**读取存量文件**，写入路径不得使用。 */
export function legacyFingerprintName(name: string): string {
  const flat = name.replace(SEPARATORS, '_').replace(DOT_RUNS, '_').replace(SAFE_CHARS, '_')
  if (flat === name) return flat
  return `${flat}-${fingerprint(name, 8)}`
}

/**
 * 读取候选名（新 → 旧）：调用方按序尝试，第一个存在的文件即命中。
 *
 * 未改写的名称两种投影相同 ⇒ 候选自动去重，调用方不会重复 stat。
 */
export function candidateNames(name: string): [string, ...string[]] {
  const modern = pathSafeName(name)
  const legacy = legacyFingerprintName(name)
  return modern === legacy ? [modern] : [modern, legacy]
}

/** 原始名称的十六进制指纹（`width` 个字符 = `width×4` bit）。 */
function fingerprint(name: string, width: number): string {
  return createHash('sha256').update(name).digest('hex').slice(0, width)
}

/**
 * 旧版（**不安全**）投影 —— 只用于**读取存量文件**，任何写入路径都不得使用。
 *
 * 为什么保留：升级前写出的作用域包备份是嵌套路径（`<root>/@scope/pkg.json`），
 * 直接按新名读会让用户的存量配置备份「凭空消失」。读取端会同时尝试新旧两种
 * 投影；写入端只写新的。
 */
export function legacyUnsafeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._@/-]/g, '_')
}

/**
 * 目标是否落在 `parent` 之内（`relative` 判定，**不比较字符串前缀**）。
 *
 * 用 `relative` 的理由：分隔符、大小写、`..`、盘符任何一项都会让字符串
 * 前缀比较说谎（`C:\x` 与 `C:\xyz` 共享前缀但不在同一目录）。
 */
export function staysInside(parent: string, target: string): boolean {
  const rel = relative(parent, target)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel)
}