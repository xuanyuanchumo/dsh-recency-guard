import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  yamlScalar,
  yamlDoubleQuoted,
  parseScalar,
  scanPatchLines,
  isLoaderRowId,
  type ScannedLine,
} from './patch-yaml.ts'

/**
 * The profile patch reader/writer.
 *
 * The guard's pre-boot protection works through a patch row per guarded
 * plugin, and those rows must live in the PROFILE's own patch file
 * (`<profile>/cordis.patch.yml`) — that is the layer the user edits and the
 * layer the plugin manager persists to.
 *
 * The file is YAML, and the loader understands three patch shapes:
 *   - id: <rowId>            → an override of an existing row
 *   - insert: [...]           → new rows
 *   - disabled: !!js "<expr>" → an expression the Loader evaluates
 *
 * This module owns the **document** side (row addressing, emission, backup).
 * The YAML dialect itself — quoting rules, scalar legality, the subset
 * validator — lives in `patch-yaml.ts`, because that is the part with all the
 * branch-heavy edge cases and it is worth testing without any IO.
 *
 * ## Why the quoting bug was a whole-plugin failure
 *
 * v0.6.0 emitted `name: <bundleName>` unquoted. `@` is a reserved indicator in
 * YAML, and every scoped npm package starts with it — so one guarded row turned
 * the entire profile patch into an unparseable document. The guard crashed the
 * profile it was protecting. Emission now always quotes; see `patch-yaml.ts`
 * for the reasoning and `guarded-rows.ts` for the check-and-rollback that backs
 * it up.
 */

/** One row of a profile patch. */
export interface PatchRow {
  id: string
  name?: string
  disabled?: string
  /** 1-based line number of the `- id:` line, for diagnostics. */
  line?: number
}

/**
 * The YAML text of a guarded override row.
 *
 * Both scalars are quoted, for the reason documented on `yamlScalar`. The row
 * id is quoted too: ids come from other people's patches, so they are untrusted
 * input as far as this plugin is concerned.
 */
export function guardedRowText(rowId: string, bundleName: string, expression: string): string {
  return `- id: ${yamlScalar(rowId)}\n  name: ${yamlScalar(bundleName)}\n  disabled: !!js ${yamlDoubleQuoted(expression)}\n`
}

/** Read the patch rows of a profile patch file. */
export function readPatchRows(patchPath: string): PatchRow[] {
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return []
  }
  return readPatchRowsFromText(text)
}

/** {@link readPatchRows} over text (separated so it is testable without IO). */
export function readPatchRowsFromText(text: string): PatchRow[] {
  const rows: PatchRow[] = []
  const seen = new Set<string>()
  const scanned = scanPatchLines(text)
  for (let i = 0; i < scanned.length; i += 1) {
    const line = scanned[i] as ScannedLine
    // A row is declared either at the top level of the sequence ("- id: x") or
    // nested under an "insert:" list ("    - id: x"). Both shapes must be read:
    // a bundle declares its rows under "insert:", while a profile patch
    // overrides rows at the top level. Nested config "id:" keys are NOT rows.
    if (!isLoaderRowId(line)) continue
    const id = parseScalar(line.value ?? '')
    if (id === undefined || id === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    const row: PatchRow = { id, line: line.line }
    // The neighbouring lines carry the row's other keys; pick them up so the
    // guard can reason about rows it did not write.
    for (let j = i + 1; j < scanned.length; j += 1) {
      const next = scanned[j] as ScannedLine
      if (next.indent <= line.indent) break
      if (next.sequenceItem || (next.key !== 'name' && next.key !== 'disabled')) continue
      const parsed = parseScalar(next.value ?? '')
      if (parsed === undefined) continue
      if (next.key === 'name') row.name = parsed
      else row.disabled = parsed
    }
    rows.push(row)
  }
  return rows
}

/* ------------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------------ */

/** Directory (relative to the profile) that holds the guard's own bookkeeping. */
export const GUARD_DIR_NAME = '.recency-guard'

/** File name of the pristine pre-guard copy of the profile patch. */
export const PATCH_BACKUP_NAME = 'cordis.patch.yml.orig'

/** Absolute path of the guard's pristine backup of a profile patch. */
export function patchBackupPath(patchPath: string): string {
  return join(dirname(patchPath), GUARD_DIR_NAME, PATCH_BACKUP_NAME)
}

/**
 * Keep ONE pristine copy of the profile patch, taken before the guard ever
 * modifies it. Bounded (never grows), and it is the copy a human needs when
 * asking "what did the guard actually change?".
 *
 * Best effort by design: a failure here must not stop the guard row install.
 */
export function ensurePatchBackup(patchPath: string, current: string): void {
  try {
    if (current.trim() === '') return
    const backupPath = patchBackupPath(patchPath)
    if (existsSync(backupPath)) return
    const dir = dirname(backupPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(backupPath, current, 'utf8')
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------------ *
 * Re-exports — the YAML layer stays reachable from its historical import site.
 *
 * 为什么保留再导出：repair-patch.mjs、契约/单元测试与外部消费者都经由
 * ./patch.ts 引入这些符号（刻意写成「经由」而非 import 关键字句式——
 * 注释里的同形文本会被基于正则的 import 图工具误判成真边，Q5 曾因此
 * 报出自环假阳性，cycle-18 实测）。拆分是实现细节，不该成为破坏性接口变更。
 * ------------------------------------------------------------------------ */
export {
  yamlScalar,
  yamlDoubleQuoted,
  plainScalarProblem,
  parseScalar,
  validatePatchText,
  scanPatchLines,
  isLoaderRowId,
} from './patch-yaml.ts'
export type { PatchValidation, ScannedLine } from './patch-yaml.ts'