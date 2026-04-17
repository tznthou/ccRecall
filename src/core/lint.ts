import type { Database } from './database.js'

/**
 * Phase 4d: memory health lint — emits warnings, never mutates.
 *
 * Two checks:
 *  - `orphan`: memory.session_id references a session row that no longer exists.
 *    Usually a manual scrub of ~/.claude/projects, but also a symptom of a
 *    partial reindex. The compression auto-delete path needs `session_id IS
 *    NOT NULL`, so orphans accumulate silently without this warning.
 *  - `stale`: memory has effectively zero residual confidence, has never been
 *    accessed, and is older than 90 days. Compression would already have
 *    demoted it to L2; lint surfaces the long-dead tail so the user can
 *    decide whether to purge.
 *
 * Deliberately on-demand (no persisted `lint_warnings` table). Lint output is
 * always fresh against the current decay formula and avoids a separate write
 * path that could drift from the source of truth.
 */

const STALE_EFFECTIVE_CONFIDENCE = 0.1
const STALE_AGE_DAYS = 90

export type LintKind = 'orphan' | 'stale'

export interface LintWarning {
  memoryId: number
  kind: LintKind
  details: string
}

export interface LintReport {
  warnings: LintWarning[]
  counts: {
    orphan: number
    stale: number
    total: number
  }
}

export function runLint(db: Database): LintReport {
  const orphans = db.getOrphanMemoryIds()
  const stales = db.getStaleMemoryIds({
    effectiveConfidence: STALE_EFFECTIVE_CONFIDENCE,
    ageDays: STALE_AGE_DAYS,
  })

  const warnings: LintWarning[] = []
  for (const o of orphans) {
    warnings.push({
      memoryId: o.memoryId,
      kind: 'orphan',
      details: `session ${o.sessionId} no longer exists in sessions table`,
    })
  }
  for (const s of stales) {
    warnings.push({
      memoryId: s.memoryId,
      kind: 'stale',
      details: `age=${s.ageDays.toFixed(1)}d effective=${s.effectiveConfidence.toFixed(4)} access=0`,
    })
  }
  warnings.sort((a, b) => a.memoryId - b.memoryId)

  return {
    warnings,
    counts: {
      orphan: orphans.length,
      stale: stales.length,
      total: warnings.length,
    },
  }
}
