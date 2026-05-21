// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  analyzeRecallTelemetry,
  formatRecallHitRateReport,
} from '../src/core/recall-hit-rate-report'
import type { RecallTelemetryEntry } from '../src/core/recall-telemetry'

function entry(over: Partial<RecallTelemetryEntry> = {}): RecallTelemetryEntry {
  return {
    ts: '2026-05-21T00:00:00.000Z',
    query: 'q',
    queryLen: 1,
    hitCount: 0,
    projectId: null,
    limit: 5,
    maxTokens: null,
    ...over,
  }
}

describe('analyzeRecallTelemetry', () => {
  it('returns all zeros for empty input', () => {
    const a = analyzeRecallTelemetry([], () => false)
    expect(a.totalQueries).toBe(0)
    expect(a.hitRate).toBe(0)
    expect(a.literalMismatchRate).toBe(0)
    expect(a.queryLenDistribution.p50).toBe(0)
  })

  it('100% hit when every entry has hitCount > 0', () => {
    const entries = [
      entry({ query: 'q1', hitCount: 1 }),
      entry({ query: 'q2', hitCount: 3 }),
    ]
    const a = analyzeRecallTelemetry(entries, () => false)
    expect(a.hitCount).toBe(2)
    expect(a.zeroHitCount).toBe(0)
    expect(a.hitRate).toBe(1)
    expect(a.literalMismatch).toBe(0)
    expect(a.trulyAbsent).toBe(0)
  })

  it('classifies zero-hit by matcher: matcher true → literalMismatch', () => {
    const entries = [
      entry({ query: 'echo chamber', hitCount: 0 }),
      entry({ query: 'foo bar', hitCount: 0 }),
    ]
    const a = analyzeRecallTelemetry(entries, (q) => q === 'echo chamber')
    expect(a.literalMismatch).toBe(1)
    expect(a.trulyAbsent).toBe(1)
    expect(a.zeroHitCount).toBe(2)
    expect(a.literalMismatchRate).toBe(0.5)
  })

  it('groups by projectId and uses "(none)" for null', () => {
    const entries = [
      entry({ projectId: '-A', hitCount: 1 }),
      entry({ projectId: '-A', hitCount: 0 }),
      entry({ projectId: '-B', hitCount: 2 }),
      entry({ projectId: null, hitCount: 0 }),
    ]
    const a = analyzeRecallTelemetry(entries, () => false)
    expect(a.byProject['-A']).toEqual({ total: 2, hit: 1, zeroHit: 1 })
    expect(a.byProject['-B']).toEqual({ total: 1, hit: 1, zeroHit: 0 })
    expect(a.byProject['(none)']).toEqual({ total: 1, hit: 0, zeroHit: 1 })
  })

  it('computes queryLenDistribution percentiles', () => {
    const entries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) =>
      entry({ queryLen: n, hitCount: 1 }),
    )
    const a = analyzeRecallTelemetry(entries, () => false)
    expect(a.queryLenDistribution.p50).toBe(60)
    expect(a.queryLenDistribution.p90).toBe(100)
    expect(a.queryLenDistribution.max).toBe(100)
  })

  it('caps samples at 10 per category', () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      entry({ query: `q${i}`, hitCount: 0 }),
    )
    const a = analyzeRecallTelemetry(entries, () => true)
    expect(a.literalMismatch).toBe(25)
    expect(a.samples.literalMismatch.length).toBe(10)
  })
})

describe('formatRecallHitRateReport', () => {
  it('renders markdown headers and key metrics', () => {
    const entries = [
      entry({ query: 'pnpm', hitCount: 2, projectId: '-test' }),
      entry({ query: 'echo chamber', hitCount: 0, queryLen: 12 }),
    ]
    const a = analyzeRecallTelemetry(entries, (q) => q === 'echo chamber')
    const md = formatRecallHitRateReport(a)

    expect(md).toContain('# recall_hit_rate report')
    expect(md).toContain('## Totals')
    expect(md).toContain('Total queries: 2')
    expect(md).toContain('Hit (≥1 memory): 1 (50.0%)')
    expect(md).toContain('## Zero-hit breakdown')
    expect(md).toContain('Literal mismatch')
    expect(md).toContain('## By project')
    expect(md).toContain('-test')
    expect(md).toContain('## Sample: literal mismatch')
    expect(md).toContain('`echo chamber`')
  })

  it('skips empty sample sections', () => {
    const a = analyzeRecallTelemetry([entry({ hitCount: 1 })], () => false)
    const md = formatRecallHitRateReport(a)
    expect(md).not.toContain('## Sample: literal mismatch')
    expect(md).not.toContain('## Sample: truly absent')
  })
})
