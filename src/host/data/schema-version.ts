import type { GuardState, PrebootDecision } from './store.ts'

/**
 * 数据文件的 schema 版本判据（T15-03，从 `store.ts` 纯提取）。
 *
 * ## 为什么统一用 `schemaVersion` 而不是更短的 `v`
 *
 * `cooccurrence-store.ts` 与归档 manifest 已经用 `schemaVersion: 1`。
 * 三个数据文件用同一个字段名，读的人不必记「哪个文件用哪个写法」；
 * 代价是每次崩溃多写 17 字节 —— 相对「版本判据统一」可以忽略。
 *
 * ## 三条读取路径（判据本身是契约）
 *
 * 1. `schemaVersion === 1` ⇒ 正常读；
 * 2. **缺失** ⇒ 按 v1 宽容读（v0.16 及更早的文件没有该字段，老 profile 必须能读）；
 * 3. **其它值** ⇒ 返回 `corrupt` 标记（调用方据此降级为安全空态并留痕）。
 *
 * 为什么第 3 条不能「尽力解释」：`crashSeq` / `autoDisabled` / `disable` 的
 * 语义可能在新版本里已经变了，按旧语义解释会做出**错误的恢复决策**
 * （例如把新语义下的字段当旧计数用），那比没有数据更危险。
 */
export const SCHEMA_VERSION = 1 as const

/** state 文本的解析结果：要么是状态，要么是「版本不受支持」。 */
export type StateParseResult =
  | { state: GuardState; corruptVersion?: undefined }
  | { state?: undefined; corruptVersion: unknown }

/**
 * 解析 state 文本（纯函数：不读盘、不写盘，便于单测直接喂字符串）。
 *
 * 非法 JSON 由调用方的 try/catch 处理（那是「读坏了」，与「版本不认识」
 * 是两件事：前者返回空态不报警，后者必须报警并保留现场）。
 */
export function parseStateText(text: string): StateParseResult {
  const parsed = JSON.parse(text) as GuardState
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) {
    return { corruptVersion: parsed.schemaVersion }
  }
  return {
    state: Object.assign(
      { bootMarker: null, crashSeq: 0, autoDisabled: [], stabilized: false, restored: [] } as GuardState,
      parsed,
    ),
  }
}

/** 决策文本的解析结果。 */
export type DecisionParseResult =
  | { decision: PrebootDecision; corruptVersion?: undefined }
  | { decision: null; corruptVersion?: undefined; absent: true }
  | { decision?: undefined; corruptVersion: unknown }

/** 解析 decision 文本（同上；`null` 文本由调用方按「文件不存在」处理）。 */
export function parseDecisionText(text: string): DecisionParseResult {
  const parsed = JSON.parse(text) as PrebootDecision
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) {
    return { corruptVersion: parsed.schemaVersion }
  }
  return { decision: parsed }
}

/** 未知版本的人读说明（journal note 的文案单一来源）。 */
export function unsupportedVersionDetail(file: string, version: unknown): string {
  return `[recency-guard] ${file} 的 schemaVersion=${String(version)} 不受支持（本实现只认 ${SCHEMA_VERSION}）；文件未被修改，按安全空态降级。`
}