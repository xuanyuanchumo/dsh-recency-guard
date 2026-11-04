// Resolve the harness packages from the extracted DSH runtime.
//
// The harness packages (cordis, dsh-tools, …) are provided by the DSH
// application, not by a profile's node_modules, so a test that mounts the
// plugin directly needs them on disk. `scripts/extract-runtime.mjs` writes
// them to `runtime/`.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const runtimeDir = fileURLToPath(new URL('../../runtime/', import.meta.url))

/** Whether the extracted runtime is present. */
export function hasRuntime(): boolean {
  return existsSync(join(runtimeDir, 'cordis', 'package.json'))
}

/** A `require` rooted at the extracted runtime. */
export const runtimeRequire = createRequire(join(runtimeDir, 'package.json'))

/** Import a harness package from the extracted runtime. */
export async function importRuntime<T = unknown>(specifier: string): Promise<T> {
  const resolved = runtimeRequire.resolve(specifier)
  return (await import(pathToFileURL(resolved).href)) as T
}
