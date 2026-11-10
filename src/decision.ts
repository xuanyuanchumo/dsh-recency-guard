import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-sync.js'

/**
 * 预启动决策 —— 决定文件、指针文件与守护行的表达式。
 *
 * ## 为什么决策文件要有一个「指针」
 *
 * 守护行的 `disabled` 表达式运行在 Loader 的求值作用域里
 * （`with (ctx) { eval(expr) }`）：有 `ctx` 和 `process`，**没有 require**。
 * 它能拿到 `ctx.get('profileContext').dir`（profile 目录），但**拿不到
 * 分区键** —— 分区键是本插件按 `profileContext.cwd` 算出来的。
 *
 * 于是决策文件必须放在**表达式能算出来的位置**，即 profile 目录之下。
 * 但多项目隔离要求每个分区各有一份决策 —— 两者需要一座桥。
 *
 * 桥的形式是**指针文件**：
 * - `<profile>/.recency-guard/current.json` —— 指向「本工作区当前分区」的
 *   决策文件路径（相对 profile 目录）。
 * - 表达式读这个指针，再读它指向的决策文件。
 *
 * ## 诚实边界：并发工作区会串扰指针
 *
 * 指针在 profile 目录是**全局一份**，会被最后一个启动的工作区覆盖。
 * 同一 profile 下**并发**跑多个工作区时，A 工作区可能读到 B 的决策。
 *
 * 为什么仍然这样设计：
 * 1. DSH 的 profile 本身是**单实例**资源（同一 profile 的两个进程会争
 *    同一个 profile 目录），多工作区并发是**罕见**用法；
 * 2. 替代方案（让表达式枚举分区目录并按 cwd 匹配）需要表达式能读目录并
 *    逐个解析 JSON —— 在无 require 的作用域里既不可靠又慢；
 * 3. 更糟的失败模式是**指针指向不存在的分区**（决策读不到 ⇒ 全部放行 ⇒
 *    回到「崩溃重演」），而**误指**只会关掉一个可能无关的插件 ——
 *    前者破坏恢复能力，后者只损失一点精度。**宁可过放行，不可过拦截**。
 *
 * 因此指针缺失或不合法时，表达式一律返回 false（放行）。
 */

/** 决策文件相对于**分区目录**的路径。 */
export const DECISION_RELATIVE_PATH = 'decision.json'

/** 指针文件相对于 **profile 目录** 的路径。 */
export const POINTER_RELATIVE_PATH = '.recency-guard/current.json'

/** 指针文件的内容。 */
export interface DecisionPointer {
  /** 指向的分区键。 */
  partitionKey: string
  /** 指向的决策文件（相对 profile 目录）。 */
  decisionPath: string
  /** 写入时刻。 */
  at: string
}

/** 决策文件的形状。 */
export interface Decision {
  capturedAt: string
  /** 嫌疑插件，最新变更在前（含因子证据，见 `DecisionSuspect`）。 */
  suspects: DecisionSuspect[]
  /** 本轮要拦截的插件名。 */
  disable: string[]
  reason: 'none' | 'crash-recovery'
  crashSeq?: number
}

/**
 * 嫌疑插件的因子证据快照（v0.13 方向③落地）。
 *
 * `decision.json` 此前只记排序键（`lastChangeAt`），回答不了「为什么是 A
 * 而不是 B」。本字段把 `riskScore` 的三因子分解、连续头号轮数、变更事件数
 * 一并落盘，供面板解释与离线回放验证。
 *
 * 定义放这里（而非 `decision-evidence.ts`）是为了**形状的单一真相源**：
 * `store.ts` 的 `PrebootDecision` 与本接口必须逐字段一致，否则读写两侧漂移。
 */
export interface DecisionSuspectEvidence {
  /** 在嫌疑名单中的位置（1 基）。 */
  rank: number
  /** 风险总分 ∈ [0,1]。 */
  risk: number
  /** 三因子加权贡献分解。 */
  factors: { recency: number; experimental: number; crashFrequency: number }
  /** 连续作为头号嫌疑的轮数（含本轮）；非头号 = 0。 */
  streak: number
  /** journal 里该插件的安装/更新事件数。 */
  changeCount: number
  /** `lastChangeAt` 的证据来源（journal = 安装事实，mtime = 引导值）。 */
  source?: 'journal' | 'mtime'
}

/** 决策文件里一个嫌疑插件的条目。 */
export interface DecisionSuspect {
  bundle: string
  version?: string
  lastChangeAt: string
  /** 因子证据（可选：老版本决策文件没有这个字段）。 */
  evidence?: DecisionSuspectEvidence
}

/** 决策文件的绝对路径（参数是**分区目录**）。 */
export function decisionPath(partitionDir: string): string {
  return join(partitionDir, ...DECISION_RELATIVE_PATH.split('/'))
}

/** 指针文件的绝对路径（参数是 **profile 目录**）。 */
export function pointerPath(profileDir: string): string {
  return join(profileDir, ...POINTER_RELATIVE_PATH.split('/'))
}

/** 读决策（同步）；文件不存在或损坏时返回 null。 */
export function readDecision(partitionDir: string): Decision | null {
  try {
    const path = decisionPath(partitionDir)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Decision
    if (!Array.isArray(parsed.disable)) return null
    return parsed
  } catch {
    return null
  }
}

/** 写决策（同步）。 */
export function writeDecision(partitionDir: string, decision: Decision): void {
  try {
    writeSafe(decisionPath(partitionDir), JSON.stringify(decision, null, 2))
  } catch {
    /* best effort */
  }
}

/**
 * 读指针（同步）—— 返回指针内容，文件缺失/损坏时返回 null。
 *
 * 为什么需要读指针：排查「为什么这个插件被拦了」时，第一件要确认的事实是
 * **表达式读到了哪个分区的决策**。没有读函数时只能靠人肉开文件，而文件路径
 * 本身要由 `pointerPath()` 拼 —— 那正是最容易拼错的一环。
 *
 * 注意它**不影响表达式行为**：守护行的求值逻辑内联在 `guardExpression()` 里，
 * 本函数只服务诊断与测试。
 */
export function readPointer(profileDir: string): DecisionPointer | null {
  try {
    const file = pointerPath(profileDir)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DecisionPointer
    if (typeof parsed?.decisionPath !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 写指针（同步）—— 指向某个分区的决策文件。
 *
 * @param profileDir profile 目录
 * @param partitionKey 分区键
 * @param partitionDir 分区目录
 */
export function writePointer(profileDir: string, partitionKey: string, partitionDir: string): void {
  try {
    const relative = decisionPath(partitionDir)
      .slice(profileDir.length)
      .replace(/\\/g, '/')
      .replace(/^\//, '')
    const pointer: DecisionPointer = {
      partitionKey,
      decisionPath: relative,
      at: new Date().toISOString(),
    }
    writeSafe(pointerPath(profileDir), JSON.stringify(pointer, null, 2))
  } catch {
    /* best effort */
  }
}

function writeSafe(path: string, content: string): void {
  // 原子提交（v0.15，isolation-dev 跨进程实测的缺陷修复）。
  //
  // 旧实现是 `writeFileSync`：它在 open('w') 时**先截断目标**再写内容，
  // 并发的读者会读到 0 字节（实测 507 次采样中 4 次空指针）。守护行
  // 表达式读到空指针 ⇒ catch ⇒ 放行 ⇒ 该轮守护整体失效。
  //
  // 换成「临时文件 + rename」后，读者看到的要么是旧内容、要么是新内容，
  // 不存在中间态。这里保留 try/catch：写入失败只降级不抛 ——
  // 决策文件写不进去是「下轮还能重试」的事，不该让当前崩溃路径挂掉。
  try {
    writeFileAtomicSync(path, content)
  } catch {
    /* best effort：决策/指针写失败不拖垮崩溃路径 */
  }
}

/**
 * 守护行的 `disabled` 表达式。
 *
 * 它按顺序读：
 * 1. 指针文件（profile 目录）→ 得到决策文件的相对路径；
 * 2. 决策文件 → 读 `disable` 名单；
 * 3. 名单里有本插件 ⇒ 返回 true（保持关闭）。
 *
 * 任何一步失败都返回 **false（放行）** —— 守护机制宁可漏拦，不可把
 * profile 锁死在插件之外。
 */
export function guardExpression(bundleName: string): string {
  const escaped = bundleName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return [
    `(() => { try {`,
    `const fs = process.getBuiltinModule('fs');`,
    `const profile = ctx.get('profileContext');`,
    `if (!profile || !profile.dir) return false;`,
    `const pointerFile = profile.dir + '/.recency-guard/current.json';`,
    `if (!fs.existsSync(pointerFile)) return false;`,
    `const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));`,
    `if (!pointer || typeof pointer.decisionPath !== 'string') return false;`,
    `const decisionFile = profile.dir + '/' + pointer.decisionPath;`,
    `if (!fs.existsSync(decisionFile)) return false;`,
    `const decision = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));`,
    `return Array.isArray(decision.disable) && decision.disable.includes('${escaped}');`,
    `} catch { return false } })()`,
  ].join(' ')
}
