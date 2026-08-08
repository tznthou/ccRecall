// SPDX-License-Identifier: Apache-2.0

/**
 * Encode a working directory the way Claude Code names its project folders
 * under `~/.claude/projects/`: every character outside `[A-Za-z0-9]` becomes
 * a single `-`.
 *
 * Deliberate duplicate of `src/core/project-id.ts`. The hooks ship as
 * standalone .mjs installed straight from the npm package — they are never
 * bundled through `dist/`, so they cannot import the TypeScript module.
 * `tests/project-id-encoding.test.ts` asserts both copies against the same
 * fixtures, which is what keeps them from drifting apart.
 *
 * See #89 for what the previous slash-only rule cost.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveProjectId(cwd) {
  if (!cwd || typeof cwd !== 'string') return ''
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}
