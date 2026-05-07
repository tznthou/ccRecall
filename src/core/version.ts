// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Read the package.json version shipped next to this bundle. Works across
 *  layouts: src/core/version.ts (tsx) → ../../package.json,
 *  dist/core/version.js → ../../package.json,
 *  node_modules/@tznthou/ccrecall/dist/core/version.js → ../../package.json.
 *  Falls back to 'unknown' if the file is missing or unreadable. */
export function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
