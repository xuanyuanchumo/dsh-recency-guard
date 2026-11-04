// Generate guarded patch rows for the sandbox test.
//
// A row's `disabled` expression is evaluated by the Loader BEFORE it imports
// the row's module. The expression asks the decision file whether the BUNDLE
// should stay off — the row id addresses the row, the bundle name is what the
// decision lists.
import { writeFileSync } from 'node:fs'

function guardExpression(bundleName) {
  const escaped = bundleName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return [
    '(() => { try {',
    "const fs = process.getBuiltinModule('fs');",
    "const profile = ctx.get('profileContext');",
    'if (!profile || !profile.dir) return false;',
    "const file = profile.dir + '/.recency-guard/decision.json';",
    'if (!fs.existsSync(file)) return false;',
    "const decision = JSON.parse(fs.readFileSync(file, 'utf8'));",
    `return Array.isArray(decision.disable) && decision.disable.includes('${escaped}');`,
    '} catch { return false } })()',
  ].join(' ')
}

// Each argument is "<rowId>:<bundleName>".
const pairs = process.argv.slice(3).map((arg) => {
  const [rowId, bundleName] = arg.split(':')
  return { rowId, bundleName: bundleName ?? rowId }
})
const out = process.argv[2]

const header =
  '# Guard rows for the sandbox test.\n' +
  "# The Loader evaluates a row's disabled expression BEFORE it imports that\n" +
  "# row's module, so a decision published at crash time keeps the suspect out.\n"

const rows = pairs
  .map(
    ({ rowId, bundleName }) =>
      `- id: ${rowId}\n  name: ${bundleName}\n  disabled: !!js "${guardExpression(bundleName)}"\n`,
  )
  .join('\n')

writeFileSync(out, header + rows, 'utf8')
console.log('patch written to', out)
