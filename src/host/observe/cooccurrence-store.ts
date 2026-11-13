/**
 * 共现样本的**文件存储**（v0.13 方向④，从 store.ts 拆出以控制复杂度）。
 *
 * ## 为什么单独成模块
 *
 * store.ts 的复杂度已经顶到预算上限（123/100）。共现存储是**旁路数据面**：
 * 它只服务「验证共现信号是否有预测力」这一件事，与崩溃恢复主线没有控制依赖。
 * 混进 store.ts 会让主干的读者多背一层无关分支。
 *
 * ## 为什么全是同步 IO
 *
 * 采集发生在 `publishDecisionOnCrash`（process exit 处理器内），进程随时会死，
 * 不能 await。读取在 `status` 里也走同步（与既有 `readJournalSync` 同风格）。
 *
 * ## 诚实边界
 *
 * 任何失败都返回**空存储**而不是抛：共现验证是观测设施，读不到数据应降级为
 * 「不可判定」，绝不能拖垮崩溃决策。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { candidateNames, pathSafeName } from '../core/path-safe.ts'

/** 一条共现样本（形状与 `cooccurrence.ts` 的同名接口一致，避免循环依赖只用结构类型）。 */
export interface StoredCooccurrenceSample {
  at: string
  officialActive: string[]
  suspects: string[]
  disabled: string[]
}

/** 共现存储的磁盘形状。 */
export interface StoredCooccurrence {
  schemaVersion: 1
  samples: StoredCooccurrenceSample[]
}

/** 空存储。 */
export function emptyStoredCooccurrence(): StoredCooccurrence {
  return { schemaVersion: 1, samples: [] }
}

/** 共现文件相对于分区目录的路径。 */
export const COOCCURRENCE_RELATIVE_PATH = 'cooccurrence.json'

/** 共现文件的绝对路径（参数是**分区目录**）。 */
export function cooccurrencePath(partitionDir: string): string {
  return join(partitionDir, COOCCURRENCE_RELATIVE_PATH)
}

/**
 * 同步读共现样本。
 *
 * 逐条校验形状：磁盘数据可能被手改或由旧版本写入，畸形条目会被**跳过**
 * 而不是让整个文件失效 —— 一条坏样本不该让所有历史证据消失。
 */
export function readCooccurrenceSync(partitionDir: string): StoredCooccurrence {
  try {
    const file = cooccurrencePath(partitionDir)
    if (!existsSync(file)) return emptyStoredCooccurrence()
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown; samples?: unknown }
    if (!Array.isArray(parsed.samples)) return emptyStoredCooccurrence()
    const samples: StoredCooccurrenceSample[] = []
    for (const raw of parsed.samples) {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      if (typeof entry.at !== 'string') continue
      samples.push({
        at: entry.at,
        officialActive: asStringArray(entry.officialActive),
        suspects: asStringArray(entry.suspects),
        disabled: asStringArray(entry.disabled),
      })
    }
    return { schemaVersion: 1, samples }
  } catch {
    return emptyStoredCooccurrence()
  }
}

/** 同步写共现样本（best-effort，失败不抛）。 */
export function writeCooccurrenceSync(partitionDir: string, store: StoredCooccurrence): void {
  try {
    const file = cooccurrencePath(partitionDir)
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

/** 字符串数组的安全投影（非字符串元素被丢弃，不是整体失效）。 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

// ─────────────────────────── 观测快照（官方实验插件） ───────────────────────────

/** 一条观测快照条目。 */
export interface ObservedEntry {
  version?: string
  enabled: boolean
}

/** 观测快照文件相对于分区目录的路径（写路径：64 位指纹新名）。 */
export function observationPath(partitionDir: string, name: string): string {
  return join(partitionDir, `observation-${pathSafeName(name)}.json`)
}

/**
 * 观测快照**读取候选路径**（新名 → 8 位指纹旧名）。
 *
 * TD-7 迁移：v0.18 把指纹从 32 bit 升到 64 bit ⇒ v0.17 写出的文件名变了。
 * 读端双路径让存量观测快照不会「凭空消失」；写端只写新名，
 * 下一次覆盖写即完成迁移。
 */
export function observationCandidatePaths(partitionDir: string, name: string): string[] {
  return candidateNames(name).map((n) => join(partitionDir, `observation-${n}.json`))
}

/**
 * JSON → 观测 Map 的投影（同步/异步两版共用）。
 *
 * 为什么必须共用：两处各写一遍时，「非对象条目跳过」这条判断迟早只改一处
 * —— 畸形数据下两版行为分叉，而分叉只在读到坏文件时才暴露。
 */
export function toObservationMap(parsed: unknown): Map<string, ObservedEntry> {
  const out = new Map<string, ObservedEntry>()
  if (parsed === null || typeof parsed !== 'object') return out
  for (const [bundle, info] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof bundle !== 'string' || info === null || typeof info !== 'object') continue
    const entry = info as { version?: unknown; enabled?: unknown }
    out.set(bundle, {
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      enabled: entry.enabled !== false,
    })
  }
  return out
}

/** 同步读观测快照（崩溃路径不能 await）。双候选：新 64 位指纹名 → 旧 8 位名。 */
export function readObservationSync(partitionDir: string, name: string): Map<string, ObservedEntry> {
  try {
    for (const file of observationCandidatePaths(partitionDir, name)) {
      if (!existsSync(file)) continue
      return toObservationMap(JSON.parse(readFileSync(file, 'utf8')))
    }
    return new Map()
  } catch {
    return new Map()
  }
}

/** 异步读观测快照。双候选：新 64 位指纹名 → 旧 8 位名。 */
export async function readObservation(partitionDir: string, name: string): Promise<Map<string, ObservedEntry>> {
  try {
    for (const file of observationCandidatePaths(partitionDir, name)) {
      if (!existsSync(file)) continue
      return toObservationMap(JSON.parse(await readFile(file, 'utf8')))
    }
    return new Map()
  } catch {
    return new Map()
  }
}

/** 写观测快照（原子写 best-effort）。 */
export async function writeObservation(
  partitionDir: string,
  name: string,
  state: Map<string, ObservedEntry>,
): Promise<void> {
  try {
    const file = observationPath(partitionDir, name)
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await writeFileAtomic(file, JSON.stringify(Object.fromEntries(state), null, 2), { mode: 0o644 })
  } catch {
    /* best effort */
  }
}

