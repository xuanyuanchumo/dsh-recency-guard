/**
 * YAML scalar layer: emit a scalar, read a scalar, judge a plain scalar's
 * legality.
 *
 * ## Why this is its own module
 *
 * The v0.6.0 crash was a *scalar* decision: `name: @linxin666/...` was emitted
 * as a plain scalar, and `@` is a reserved indicator, so the whole profile
 * patch became unparseable. Emission rules and legality rules are the same
 * question asked from two directions — keeping them in one place means the
 * validator and the emitter cannot drift apart.
 *
 * No YAML dependency by design: this plugin exists to survive third-party code,
 * so it must not put third-party code on its own boot path.
 */

/**
 * Emit a string as a single-quoted YAML scalar.
 *
 * Why "always quote" instead of "quote only when needed": every plain-scalar
 * safety rule is a rule we have to remember and re-check forever. The bug above
 * was exactly a forgotten one. Single-quoted style has a single escape (`''`
 * for a literal `'`), no backslash processing, and no reserved leading
 * indicators — so its output is valid for ANY input that has no control
 * characters. That is a property we can test once and rely on.
 *
 * Values containing control characters (including newlines, which would fold
 * inside single quotes) fall back to {@link yamlDoubleQuoted}.
 */
export function yamlScalar(value: string): string {
  if (/[\u0000-\u001F\u007F]/.test(value)) return yamlDoubleQuoted(value)
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Emit a string as a double-quoted YAML scalar with full escaping.
 *
 * Used for the `!!js "<expression>"` payload. The expression is full of single
 * quotes (`includes('pkg')`), which need no escaping here — that keeps the row
 * readable — while `\` and `"` MUST be escaped or the expression that the Loader
 * evaluates would differ from the expression we intended to write.
 */
export function yamlDoubleQuoted(value: string): string {
  let out = '"'
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `${out}"`
}

/** Leading characters YAML forbids (or that change meaning) in a plain scalar. */
const RESERVED_LEAD = new Set([
  ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`',
])

/**
 * Is this text a legal plain (unquoted, single-line) YAML scalar?
 *
 * Returns `undefined` when legal, otherwise the reason it is not. This is the
 * exact check that would have caught the `name: @scope/pkg` defect.
 */
export function plainScalarProblem(value: string): string | undefined {
  if (value === '') return 'plain scalar is empty'
  if (/^\s|\s$/.test(value)) return 'plain scalar has leading/trailing whitespace'
  if (/[\u0000-\u001F\u007F]/.test(value)) return 'plain scalar contains a control character'
  const lead = value[0] as string
  if (lead === '-' || lead === '?' || lead === ':') {
    // These three only change meaning when followed by a space (or alone).
    if (value.length === 1 || value[1] === ' ') return `plain scalar starts with the indicator ${JSON.stringify(lead)}`
  } else if (RESERVED_LEAD.has(lead)) {
    return `plain scalar starts with the reserved indicator ${JSON.stringify(lead)}`
  }
  if (value.includes(': ')) return 'plain scalar contains ": " (read as a nested key)'
  if (value.endsWith(':')) return 'plain scalar ends with ":"'
  if (/\s#/.test(value)) return 'plain scalar contains " #" (read as a comment)'
  return undefined
}

/** Validate a single-quoted scalar; `undefined` when legal. */
function singleQuotedProblem(value: string): string | undefined {
  let i = 1
  while (i < value.length) {
    if (value[i] === "'") {
      if (value[i + 1] === "'") {
        i += 2
        continue
      }
      return i === value.length - 1 ? undefined : 'single-quoted scalar has trailing content after its closing quote'
    }
    i += 1
  }
  return 'single-quoted scalar is not terminated'
}

/** Escape sequences YAML double-quoted scalars define (plus the numeric ones). */
const DOUBLE_ESCAPES = new Set(['0', 'a', 'b', 't', 'n', 'v', 'f', 'r', 'e', ' ', '"', '/', '\\', 'N', '_', 'L', 'P'])

/** Validate a double-quoted scalar; `undefined` when legal. */
function doubleQuotedProblem(value: string): string | undefined {
  let i = 1
  while (i < value.length) {
    const ch = value[i] as string
    if (ch === '\\') {
      const esc = value[i + 1]
      if (esc === undefined) return 'double-quoted scalar ends with a dangling backslash'
      if (esc === 'x' || esc === 'u' || esc === 'U') {
        const width = esc === 'x' ? 2 : esc === 'u' ? 4 : 8
        const digits = value.slice(i + 2, i + 2 + width)
        if (digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) {
          return `double-quoted scalar has a malformed \\${esc} escape`
        }
        i += 2 + width
        continue
      }
      if (!DOUBLE_ESCAPES.has(esc)) return `double-quoted scalar has an unknown escape \\${esc}`
      i += 2
      continue
    }
    if (ch === '"') {
      return i === value.length - 1 ? undefined : 'double-quoted scalar has trailing content after its closing quote'
    }
    i += 1
  }
  return 'double-quoted scalar is not terminated'
}

function quotedOrPlainProblem(v: string): string | undefined {
  if (v.startsWith("'")) return singleQuotedProblem(v)
  if (v.startsWith('"')) return doubleQuotedProblem(v)
  if (v.startsWith('[') || v.startsWith('{')) return undefined
  if (v.startsWith('|') || v.startsWith('>')) return undefined
  if (v.startsWith('&') || v.startsWith('*')) return undefined
  return plainScalarProblem(v)
}

/**
 * Validate a scalar as it appears to the right of `key:`.
 *
 * Flow collections and block scalars are accepted without deep inspection —
 * this validator exists to protect the shape the guard itself writes, not to be
 * a full YAML implementation. It deliberately stays conservative on the cases
 * that can silently change meaning.
 */
export function scalarProblem(value: string): string | undefined {
  const v = value.trim()
  if (v === '') return undefined
  if (v.startsWith('!')) {
    // An explicit tag, e.g. `!!js "<expr>"` — the payload must follow.
    const space = v.search(/\s/)
    if (space === -1) return 'tagged node has no value'
    const payload = v.slice(space + 1).trim()
    if (payload === '') return 'tagged node has no value'
    return quotedOrPlainProblem(payload)
  }
  return quotedOrPlainProblem(v)
}

/**
 * Read a scalar that was written as a key value: unquote it.
 *
 * Needed because the guard always quotes its own output, while the file may hold
 * a mix of quoted (ours) and plain (legacy/hand-written) values.
 */
export function parseScalar(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  let v = trimmed
  if (v.startsWith('!')) {
    const space = v.search(/\s/)
    if (space === -1) return undefined
    v = v.slice(space + 1).trim()
    if (v === '') return undefined
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) return undefined
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) return undefined
    return decodeDoubleQuoted(v.slice(1, -1))
  }
  return v
}

/** Decode the escape sequences a double-quoted scalar may contain. */
function decodeDoubleQuoted(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string
    if (ch !== '\\') {
      out += ch
      continue
    }
    const esc = body[(i += 1)]
    if (esc === undefined) break
    if (esc === 'n') out += '\n'
    else if (esc === 't') out += '\t'
    else if (esc === 'r') out += '\r'
    else if (esc === '0') out += '\0'
    else if (esc === 'x' || esc === 'u' || esc === 'U') {
      const width = esc === 'x' ? 2 : esc === 'u' ? 4 : 8
      const digits = body.slice(i + 1, i + 1 + width)
      out += String.fromCodePoint(Number.parseInt(digits, 16) || 0)
      i += width
    } else out += esc
  }
  return out
}