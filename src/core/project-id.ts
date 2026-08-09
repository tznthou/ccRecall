// SPDX-License-Identifier: Apache-2.0

/**
 * Encode a working directory the way Claude Code names its project folders
 * under `~/.claude/projects/`: every character outside `[A-Za-z0-9]` becomes
 * a single `-`.
 *
 * #89: we previously replaced only `/`, which silently diverged for any cwd
 * containing a space, dot, underscore or CJK. The derived key then matched no
 * directory on disk and every lookup keyed on it missed — `/session/last`
 * returned 404, the extraction wrapper saw an empty sessionId and skipped, and
 * the affected project accumulated zero memories with nothing logging an error.
 *
 * Char-wise, not byte-wise: one dash per character. A byte-wise implementation
 * (notably BSD `sed`) emits three dashes per CJK character.
 *
 * This mirrors an encoding Claude Code owns, so it is pinned by
 * `tests/project-id-encoding.test.ts` rather than inferred at runtime.
 */
export function resolveProjectId(cwd: string): string {
  if (!cwd || typeof cwd !== 'string') return ''
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}
