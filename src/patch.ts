import { readFileSync } from 'node:fs'

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
 * This module only needs to READ the file to discover the row ids of the
 * installed third-party plugins, and to WRITE guarded rows. It deliberately
 * avoids a YAML dependency for reading: a regex over the small, well-known
 * patch shape is enough, and it keeps the plugin's dependency surface at the
 * single atomic-write package.
 */

/** One row of a profile patch. */
export interface PatchRow {
  id: string
  name?: string
  disabled?: string
}

/** Read the patch rows of a profile patch file. */
export function readPatchRows(patchPath: string): PatchRow[] {
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return []
  }
  const rows: PatchRow[] = []
  const seen = new Set<string>()
  // A row is declared either at the top level of the sequence ("- id: x") or
  // nested under an "insert:" list ("    - id: x"). Both shapes must be read:
  // a bundle declares its rows under "insert:", while a profile patch
  // overrides rows at the top level.
  const pattern = /^[ \t]*- id:\s*(\S+)\s*$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const id = match[1]
    if (!id || id.startsWith('"') || id.startsWith("'")) continue
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id })
  }
  return rows
}

/**
 * The YAML text of a guarded override row.
 *
 * The `disabled` expression is quoted with double quotes, so the inner
 * single quotes of the expression stay literal. The expression itself contains
 * no double quotes, so no further escaping is needed.
 */
export function guardedRowText(rowId: string, bundleName: string, expression: string): string {
  return `- id: ${rowId}\n  name: ${bundleName}\n  disabled: !!js "${expression}"\n`
}
