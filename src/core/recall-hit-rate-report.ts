// SPDX-License-Identifier: Apache-2.0
import type { RecallTelemetryEntry } from './recall-telemetry.js'

const SAMPLE_CAP = 10

/** Given a (possibly truncated) query string, return whether ANY memory.content
 *  contains it as a substring. Injected so the analyzer stays pure / testable. */
export type ContentMatcher = (query: string) => boolean

export interface ProjectBucket {
  total: number
  hit: number
  zeroHit: number
}

export interface QueryLenPercentiles {
  p50: number
  p90: number
  p99: number
  max: number
}

export interface RecallHitRateAnalysis {
  totalQueries: number
  hitCount: number
  zeroHitCount: number
  literalMismatch: number
  trulyAbsent: number
  hitRate: number
  literalMismatchRate: number
  byProject: Record<string, ProjectBucket>
  queryLenDistribution: QueryLenPercentiles
  samples: {
    literalMismatch: Array<{ query: string; queryLen: number }>
    trulyAbsent: Array<{ query: string; queryLen: number }>
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

export function analyzeRecallTelemetry(
  entries: RecallTelemetryEntry[],
  matchesAnyMemory: ContentMatcher,
): RecallHitRateAnalysis {
  const total = entries.length
  let hitCount = 0
  let zeroHitCount = 0
  let literalMismatch = 0
  let trulyAbsent = 0
  const byProject: Record<string, ProjectBucket> = {}
  const literalMismatchSamples: Array<{ query: string; queryLen: number }> = []
  const trulyAbsentSamples: Array<{ query: string; queryLen: number }> = []
  const queryLens: number[] = []

  for (const e of entries) {
    queryLens.push(e.queryLen)

    const proj = e.projectId ?? '(none)'
    if (!byProject[proj]) byProject[proj] = { total: 0, hit: 0, zeroHit: 0 }
    byProject[proj].total++

    if (e.hitCount > 0) {
      hitCount++
      byProject[proj].hit++
    } else {
      zeroHitCount++
      byProject[proj].zeroHit++

      if (matchesAnyMemory(e.query)) {
        literalMismatch++
        if (literalMismatchSamples.length < SAMPLE_CAP) {
          literalMismatchSamples.push({ query: e.query, queryLen: e.queryLen })
        }
      } else {
        trulyAbsent++
        if (trulyAbsentSamples.length < SAMPLE_CAP) {
          trulyAbsentSamples.push({ query: e.query, queryLen: e.queryLen })
        }
      }
    }
  }

  queryLens.sort((a, b) => a - b)

  return {
    totalQueries: total,
    hitCount,
    zeroHitCount,
    literalMismatch,
    trulyAbsent,
    hitRate: total === 0 ? 0 : hitCount / total,
    literalMismatchRate: zeroHitCount === 0 ? 0 : literalMismatch / zeroHitCount,
    byProject,
    queryLenDistribution: {
      p50: percentile(queryLens, 0.5),
      p90: percentile(queryLens, 0.9),
      p99: percentile(queryLens, 0.99),
      max: queryLens.length === 0 ? 0 : queryLens[queryLens.length - 1],
    },
    samples: {
      literalMismatch: literalMismatchSamples,
      trulyAbsent: trulyAbsentSamples,
    },
  }
}

export function formatRecallHitRateReport(a: RecallHitRateAnalysis): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  const lines: string[] = []

  lines.push('# recall_hit_rate report')
  lines.push('')
  lines.push('## Totals')
  lines.push('')
  lines.push(`- Total queries: ${a.totalQueries}`)
  lines.push(`- Hit (≥1 memory): ${a.hitCount} (${pct(a.hitRate)})`)
  lines.push(`- Zero-hit: ${a.zeroHitCount}`)
  lines.push('')
  lines.push('## Zero-hit breakdown (cold rate root cause)')
  lines.push('')
  lines.push(`- Literal mismatch (keyword in DB but query missed): ${a.literalMismatch} (${pct(a.literalMismatchRate)} of zero-hit)`)
  lines.push(`- Truly absent (keyword NOT in any memory): ${a.trulyAbsent}`)
  lines.push('')
  lines.push('## By project')
  lines.push('')
  lines.push('| projectId | total | hit | zeroHit |')
  lines.push('|---|---|---|---|')
  for (const [proj, b] of Object.entries(a.byProject)) {
    lines.push(`| ${proj} | ${b.total} | ${b.hit} | ${b.zeroHit} |`)
  }
  lines.push('')
  lines.push('## Query length distribution')
  lines.push('')
  lines.push(`- p50: ${a.queryLenDistribution.p50}`)
  lines.push(`- p90: ${a.queryLenDistribution.p90}`)
  lines.push(`- p99: ${a.queryLenDistribution.p99}`)
  lines.push(`- max: ${a.queryLenDistribution.max}`)
  lines.push('')
  if (a.samples.literalMismatch.length > 0) {
    lines.push('## Sample: literal mismatch (top 10)')
    lines.push('')
    for (const s of a.samples.literalMismatch) {
      lines.push(`- \`${s.query}\` (len ${s.queryLen})`)
    }
    lines.push('')
  }
  if (a.samples.trulyAbsent.length > 0) {
    lines.push('## Sample: truly absent (top 10)')
    lines.push('')
    for (const s of a.samples.trulyAbsent) {
      lines.push(`- \`${s.query}\` (len ${s.queryLen})`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
