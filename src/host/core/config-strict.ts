/**
 * 配置 fail-loud（v0.18，T16-01，学习 dsh-ops §2.5）。
 *
 * ## 为什么需要它
 *
 * 此前 Config 是 `interface`（编译期形状）+ schemastery（运行期默认值），
 * 但**未知键被静默忽略**：用户在 cordis.patch.yml 里把 `backupRoot` 写成
 * `backupDir`，插件照常启动、照常工作，只是那条配置永远不生效——
 * 用户以为已经配置了，实际没有。这是「静默漂移」最温和也最难察觉的形态。
 *
 * dsh-ops 的做法（`lib/config.js:37-48`）：未知键抛 `ConfigError` 并列出
 * 全部合法键名。我们学习这条纪律，但落点不同：
 *
 * - dsh-ops 在**读每条配置值**时逐键校验（它的 config 读取器是手写的）；
 * - 我们在 **apply 入口一次性校验键集合**（schema 仍由 schemastery 管值校验）。
 *   值校验交给 schema，键校验由本模块兜底——两层各管一半，互不重复。
 *
 * ## 失败形态的取舍（为什么是 throw 而不是 warn）
 *
 * 宿主对 entry 级 apply 抛错只记 warning 并自隔离该 entry（威胁模型：
 * 自隔离 ≠ 进程崩溃）。这正是想要的形态：
 * - **用户看得见**：启动日志里有「unknown key(s) "backupDir"」，
 *   而不是面板上某个配置项「莫名不生效」；
 * - **不拖垮宿主**：其他插件与宿主本体照常启动；
 * - **诚实**：带着错误配置继续跑守护，比「部分配置被忽略地跑」更危险。
 *
 * ## 纪律
 *
 * - 已知键清单是**单一真相源**：从 `CONFIG_KNOWN_KEYS` 导出，schemastery
 *   分支与 fallback 分支共用（此前两份默认值表已各自漂移过一次的风险面）。
 * - `$` 前缀键跳过：cordis 内部符号（`$version` 等）不是用户配置，
 *   校验它们会把宿主的内部簿记误报成「未知键」。
 */

/** 配置错误的稳定身份：宿主日志与测试都按 name 识别，不按消息文本。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`dsh-recency-guard config: ${message}`)
    this.name = 'ConfigError'
  }
}

/**
 * 本插件声明的全部配置键（与 `src/index.ts` 的 `Config` interface 一一对应）。
 *
 * 为什么导出：`apply()` 用它校验，测试用它构造「合法键全过」的反例；
 * 写两份必然漂移（CLAUDE.md：两份定义必然漂移）。
 */
export const CONFIG_KNOWN_KEYS = [
  'enabled',
  'includeExperimental',
  'maxAutoDisable',
  'autoRestore',
  'confirmRounds',
  'versionedBackups',
  'backupRetain',
  'backupRoot',
] as const

/** cordis 内部键前缀：`$version`、`$effectiveScope` 等宿主簿记，不是用户配置。 */
const CORDIS_INTERNAL_PREFIX = '$'

/**
 * 校验配置键集合；发现未知键抛 `ConfigError`（键名 + 全部合法键）。
 *
 * @param raw  apply 收到的整份 config 对象（可能为 null/undefined —— 宿主在
 *             未配置时传空，视为合法）
 * @param known 合法键清单（默认 `CONFIG_KNOWN_KEYS`；测试可传子集）
 * @throws ConfigError 带全部未知键名（一次列全，用户不用改一轮报一轮）
 */
export function rejectUnknownConfigKeys(
  raw: unknown,
  known: readonly string[] = CONFIG_KNOWN_KEYS,
): void {
  if (raw === null || raw === undefined) return
  if (typeof raw !== 'object' || Array.isArray(raw)) return
  const knownSet = new Set(known)
  const unknown = Object.keys(raw as Record<string, unknown>).filter(
    (key) => !key.startsWith(CORDIS_INTERNAL_PREFIX) && !knownSet.has(key),
  )
  if (unknown.length === 0) return
  const unknownList = unknown.map((k) => JSON.stringify(k)).join(', ')
  const knownList = known.map((k) => JSON.stringify(k)).join(', ')
  throw new ConfigError(`unknown key(s) ${unknownList}; accepted keys are ${knownList}`)
}
