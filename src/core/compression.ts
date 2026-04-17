import type { Database, CompressionCandidate } from './database.js'
import type { MemoryService } from './memory-service.js'

/**
 * Phase 4d: mutable-memory compression pipeline.
 *
 * Stages a memory through three levels (L0 raw → L1 summary → L2 conclusion)
 * based on age, access, and effective confidence gates. Session-backed memories
 * sample `sessions.summary_text`/`intent_text` so L1/L2 content is derived from
 * the original source rather than repeatedly truncating a truncated string.
 * Manual memories and orphaned rows fall back to syntactic truncation.
 *
 * Auto-delete at L2 applies only to session-backed memories (`session_id IS NOT NULL`)
 * — a user's manual memory is treated as an explicit intent and capped at L2.
 */

// Gate thresholds — kept as module-scope constants so decay-curve tuning lives
// in one place and tests can reference the same values the pipeline uses.
const L1_AGE_DAYS = 7
const L1_ACCESS_MAX = 2          // compress when access_count < this
const L1_EFFECTIVE_CONFIDENCE_MAX = 0.5
const L2_AGE_DAYS = 30
const L2_ACCESS_MAX = 4
const DELETE_AGE_DAYS = 60

// Syntactic truncation budgets (chars, not tokens — kept deliberately small so
// even multi-byte languages stay well under 1KB of storage per row).
const L1_MANUAL_TRUNCATE = 150
const L2_MANUAL_TRUNCATE = 80
const L2_SUMMARY_TRUNCATE = 100

const DEFAULT_BATCH_SIZE = 50

export type CompressionAction =
  | { kind: 'skip'; reason: string }
  | { kind: 'compress'; toLevel: 1 | 2; newContent: string }
  | { kind: 'delete' }

export interface CompressionStats {
  scanned: number
  compressed: number
  deleted: number
  skipped: number
  errors: number
}

export interface CompressionOptions {
  batchSize?: number
}

/** Truncate to a character budget with a trailing ellipsis marker. Trims
 *  trailing whitespace before appending so the cut point does not look ragged. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars).trimEnd() + '...'
}

function deriveL1Content(c: CompressionCandidate): string {
  // Session-backed: prefer the indexer-written summary as the compressed form.
  // When the session row is missing (deleted manually, or pre-index race) fall
  // through to syntactic truncation — matching the manual-memory path.
  if (c.sessionId) {
    const summary = c.summaryText?.trim()
    if (summary) return summary
  }
  return truncate(c.content, L1_MANUAL_TRUNCATE)
}

function deriveL2Content(c: CompressionCandidate): string {
  if (c.sessionId) {
    const intent = c.intentText?.trim()
    if (intent) return intent
    const summary = c.summaryText?.trim()
    if (summary) return truncate(summary, L2_SUMMARY_TRUNCATE)
  }
  return truncate(c.content, L2_MANUAL_TRUNCATE)
}

export function planTransition(c: CompressionCandidate): CompressionAction {
  const level = c.compressionLevel
  if (level === 0) {
    if (
      c.ageDays >= L1_AGE_DAYS
      && c.accessCount < L1_ACCESS_MAX
      && c.effectiveConfidence < L1_EFFECTIVE_CONFIDENCE_MAX
    ) {
      return { kind: 'compress', toLevel: 1, newContent: deriveL1Content(c) }
    }
    return { kind: 'skip', reason: 'L0 gates not met' }
  }
  if (level === 1) {
    if (c.ageDays >= L2_AGE_DAYS && c.accessCount < L2_ACCESS_MAX) {
      return { kind: 'compress', toLevel: 2, newContent: deriveL2Content(c) }
    }
    return { kind: 'skip', reason: 'L1 gates not met' }
  }
  if (level === 2) {
    if (
      c.ageDays >= DELETE_AGE_DAYS
      && c.sessionId !== null
      && c.sessionExists
      && c.accessCount === 0
    ) {
      return { kind: 'delete' }
    }
    // Orphan (sessionId present but sessions row gone) is deliberately skipped —
    // the source JSONL is already lost, so auto-delete would erase the last
    // surviving copy. Lint surfaces orphans for the user to purge explicitly.
    return { kind: 'skip', reason: 'L2 gates not met' }
  }
  return { kind: 'skip', reason: `unknown compression_level=${level}` }
}

export class CompressionPipeline {
  constructor(
    private readonly db: Database,
    private readonly svc: MemoryService,
  ) {}

  /** Scan up to batchSize candidates (oldest-id first) and apply one transition
   *  per memory. Designed to be called repeatedly by MaintenanceCoordinator —
   *  advancing L0→L1→L2→delete across consecutive passes keeps any single tick
   *  bounded and avoids starving MCP queries under WAL. */
  runOnce(opts: CompressionOptions = {}): CompressionStats {
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
    const stats: CompressionStats = {
      scanned: 0, compressed: 0, deleted: 0, skipped: 0, errors: 0,
    }
    const candidates = this.db.getCompressionCandidates(batchSize)
    stats.scanned = candidates.length
    for (const c of candidates) {
      try {
        const action = planTransition(c)
        if (action.kind === 'compress') {
          this.svc.updateContent(c.id, action.newContent, action.toLevel)
          stats.compressed++
        } else if (action.kind === 'delete') {
          this.svc.delete(c.id)
          stats.deleted++
        } else {
          stats.skipped++
        }
      } catch (err) {
        // Swallow and count — one corrupt row must not abort the whole batch.
        console.warn('[compression] error on memory', c.id, (err as Error).message)
        stats.errors++
      }
    }
    return stats
  }
}
