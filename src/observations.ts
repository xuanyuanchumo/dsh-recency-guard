import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 面板/图谱的**数据来源** —— 从日志与状态派生观测事实。
 *
 * ## 为什么要从 index.ts 抽出来
 *
 * `index.ts` 原本同时承担四件事：宿主接线、守护流程、观测派生、工具定义。
 * 1077 行、30 个方法的单类让**任何一处改动都要通读全文件**，也让复杂度
 * 预算（band-detector 的单文件上限）被单文件吃满。
 *
 * 本模块把「从日志/状态派生事实」这一件事独立出来，纯函数、无副作用、
 * 可独立单测 —— 复杂度自然被切分。
 */
import type { Observation } from './observability.js'
import type { RecencyEntry } from './recency.js'
import type { JournalRecord } from './store.js'

/** 风险排序的输入。 */
export interface RiskInput {
  bundle: string
  experimental: boolean
  lastChangeAt: string
  suspectHits: number
  observations: number
}

/**
 * 从日志推导启动观测序列。
 *
 * 一次启动 = 一条 `note`（"dsh 启动 pid=…"）；其后若出现 `crash-detected`，
 * 则该次启动以崩溃告终。
 */
export function deriveObservations(events: readonly JournalRecord[]): Observation[] {
  const observations: Observation[] = []
  let current: Observation | null = null
  for (const event of events) {
    if (event.kind === 'note' && typeof event.detail === 'string' && event.detail.startsWith('dsh 启动')) {
      current = { at: event.t, crashed: false }
      observations.push(current)
      continue
    }
    if (event.kind === 'crash-detected' && current) {
      current.crashed = true
      current.detected = true
    }
  }
  return observations
}

/**
 * 从日志推导嫌疑插件的风险输入。
 *
 * 历史嫌疑次数 = 该插件被写入「自动关闭」记录的次数；观测次数 = 它在嫌疑
 * 名单里出现过的总次数（至少 1，避免除零）。
 */
export function deriveRiskInputs(
  ranked: readonly RecencyEntry[],
  events: readonly JournalRecord[],
): RiskInput[] {
  const hits = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== 'disable' || typeof event.bundle !== 'string') continue
    hits.set(event.bundle, (hits.get(event.bundle) ?? 0) + 1)
  }
  for (const entry of ranked) {
    seen.set(entry.bundle, (seen.get(entry.bundle) ?? 0) + 1)
  }
  return ranked.map((entry) => ({
    bundle: entry.bundle,
    experimental: isExperimentalName(entry.bundle),
    lastChangeAt: entry.lastChangeAt,
    suspectHits: hits.get(entry.bundle) ?? 0,
    observations: Math.max(1, seen.get(entry.bundle) ?? 1),
  }))
}

/** 实验性命名判定（与 recency.ts 同源，避免两处各写一份）。 */
function isExperimentalName(name: string): boolean {
  const n = name.toLowerCase()
  return ['experimental', '-exp', 'beta', 'canary', 'nightly', '-rc', 'alpha'].some((h) => n.includes(h))
}

/**
 * 读取 profile 的依赖清单 —— 插件**声明**的依赖（不是传递依赖）。
 *
 * 只有被 profile 声明的依赖才是「用户装的插件」；一个插件的传递依赖不是
 * 独立的嫌疑对象。
 */
export function readDeclaredDependencies(profileDir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const deps = manifest?.dependencies
    return deps && typeof deps === 'object' ? Object.keys(deps) : []
  } catch {
    return []
  }
}
