// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { extractTopicsFromContent } from '../src/core/topic-extractor'

let tmpDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-scope-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('saveMemory — project_id denormalize', () => {
  it('auto-derives project_id from sessions.project_id for session-backed memory', () => {
    db.upsertProject('proj-A', 'Project A')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sess-1', 'proj-A', '/tmp/a.jsonl', '2026-04-17T00:00:00Z', '2026-04-17T00:10:00Z')
    `)
    const id = db.saveMemory({
      sessionId: 'sess-1', messageId: null, type: 'decision',
      content: 'session-backed auto-derive',
    })
    const row = db.rawAll<{ project_id: string | null }>(
      `SELECT project_id FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.project_id).toBe('proj-A')
  })

  it('ignores caller-supplied projectId when sessionId is set (anti-forge)', () => {
    // Phase 4 decision: session-backed memories always trust sessions.project_id.
    // This blocks a caller from claiming a forged scope via a valid sessionId.
    db.upsertProject('proj-A', 'Project A')
    db.upsertProject('proj-B', 'Project B')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sess-2', 'proj-A', '/tmp/a.jsonl', '2026-04-17T00:00:00Z', '2026-04-17T00:10:00Z')
    `)
    const id = db.saveMemory({
      sessionId: 'sess-2', messageId: null, type: 'decision',
      content: 'attempted forge',
      projectId: 'proj-B',  // caller claim — must be ignored
    })
    const row = db.rawAll<{ project_id: string | null }>(
      `SELECT project_id FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.project_id).toBe('proj-A')
  })

  it('session-backed memory with missing session stores project_id=NULL', () => {
    // Edge case: sessionId points to a non-existent sessions row (e.g. deleted).
    // Never trust caller-supplied projectId in this case — drop to NULL rather
    // than let a forged scope survive session deletion.
    const id = db.saveMemory({
      sessionId: 'ghost-session', messageId: null, type: 'decision',
      content: 'orphan',
      projectId: 'proj-forged',
    })
    const row = db.rawAll<{ project_id: string | null }>(
      `SELECT project_id FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.project_id).toBeNull()
  })

  it('manual memory without projectId stores NULL', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'global manual',
    })
    const row = db.rawAll<{ project_id: string | null }>(
      `SELECT project_id FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.project_id).toBeNull()
  })

  it('manual memory with projectId gets scoped', () => {
    db.upsertProject('proj-X', 'Project X')
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'scoped manual',
      projectId: 'proj-X',
    })
    const row = db.rawAll<{ project_id: string | null }>(
      `SELECT project_id FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.project_id).toBe('proj-X')
  })
})

describe('queryMemories — explicit scope predicate (session-backed vs manual)', () => {
  beforeEach(() => {
    db.upsertProject('proj-A', 'A')
    db.upsertProject('proj-B', 'B')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sess-A', 'proj-A', '/tmp/a.jsonl', '2026-04-17T00:00:00Z', '2026-04-17T00:10:00Z'),
             ('sess-B', 'proj-B', '/tmp/b.jsonl', '2026-04-17T00:00:00Z', '2026-04-17T00:10:00Z')
    `)
    db.saveMemory({ sessionId: 'sess-A', messageId: null, type: 'decision', content: 'alpha sessA' })
    db.saveMemory({ sessionId: 'sess-B', messageId: null, type: 'decision', content: 'alpha sessB' })
    db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'alpha manualA', projectId: 'proj-A',
    })
    db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'alpha manualB', projectId: 'proj-B',
    })
    db.saveMemory({ sessionId: null, messageId: null, type: 'preference', content: 'alpha global' })
  })

  it('query with projectId=proj-A returns A-scoped + global memories', () => {
    const results = db.queryMemories('alpha', 20, 'proj-A')
    const contents = results.map(r => r.content).sort()
    expect(contents).toEqual(['alpha global', 'alpha manualA', 'alpha sessA'])
  })

  it('query with projectId=proj-B returns B-scoped + global memories', () => {
    const results = db.queryMemories('alpha', 20, 'proj-B')
    const contents = results.map(r => r.content).sort()
    expect(contents).toEqual(['alpha global', 'alpha manualB', 'alpha sessB'])
  })

  it('query without projectId returns everything including global', () => {
    const results = db.queryMemories('alpha', 20)
    expect(results.length).toBe(5)
  })

  it('manual memory without projectId (global) is visible in per-project queries', () => {
    const a = db.queryMemories('alpha', 20, 'proj-A')
    const b = db.queryMemories('alpha', 20, 'proj-B')
    expect(a.map(r => r.content)).toContain('alpha global')
    expect(b.map(r => r.content)).toContain('alpha global')
  })
})

// ── Phase 3: Cross-Project Memory Visibility (v0.4.1) ──

describe('backfillMemoryTopics', () => {
  it('extracts topics for memories that have no memory_topics entries', () => {
    db.upsertProject('proj-A', 'A')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('s1', 'proj-A', '/tmp/s1.jsonl', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')
    `)
    db.saveMemory({ sessionId: 's1', messageId: null, type: 'decision', content: 'SQLite WAL mode is optimal for ccRecall' })
    db.saveMemory({ sessionId: null, messageId: null, type: 'preference', content: 'Always use pnpm over npm', projectId: 'proj-A' })

    const count = db.backfillMemoryTopics(extractTopicsFromContent)
    expect(count).toBe(2)

    const topicRows = db.rawAll<{ memory_id: number; topic_key: string }>(
      'SELECT memory_id, topic_key FROM memory_topics ORDER BY memory_id, topic_key',
    )
    expect(topicRows.length).toBeGreaterThan(0)
    expect(topicRows.some(r => r.topic_key === 'sqlite')).toBe(true)
    expect(topicRows.some(r => r.topic_key === 'pnpm')).toBe(true)
  })

  it('is idempotent — second call backfills 0', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'Vitest supports concurrent tests' })
    db.backfillMemoryTopics(extractTopicsFromContent)
    const second = db.backfillMemoryTopics(extractTopicsFromContent)
    expect(second).toBe(0)
  })

  it('resolves projectId from session for session-backed memories', () => {
    db.upsertProject('proj-X', 'X')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sx', 'proj-X', '/tmp/sx.jsonl', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')
    `)
    db.saveMemory({ sessionId: 'sx', messageId: null, type: 'decision', content: 'TypeScript strict mode enabled' })
    db.backfillMemoryTopics(extractTopicsFromContent)

    const rows = db.rawAll<{ project_id: string }>('SELECT project_id FROM memory_topics LIMIT 1')
    expect(rows[0].project_id).toBe('proj-X')
  })

  it('uses empty string as projectId for global memories', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'preference', content: 'Prettier is configured globally' })
    db.backfillMemoryTopics(extractTopicsFromContent)

    const rows = db.rawAll<{ project_id: string }>('SELECT project_id FROM memory_topics LIMIT 1')
    expect(rows[0].project_id).toBe('')
  })
})

// #80 — backfillMemoryTopics only touches memories with zero topics, so once
// the corpus is fully backfilled it is a no-op. Changing the extractor needs a
// path that re-derives rows that already exist.
describe('rebuildMemoryTopics', () => {
  it('recomputes memories that already have topics (backfill cannot reach these)', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'vitest concurrency' })
    db.backfillMemoryTopics(extractTopicsFromContent)
    const before = db.rawAll<{ topic_key: string }>('SELECT topic_key FROM memory_topics')
    expect(before.length).toBeGreaterThan(0)
    expect(db.backfillMemoryTopics(extractTopicsFromContent)).toBe(0)

    // A different extractor stands in for "the extractor changed".
    const result = db.rebuildMemoryTopics(() => ['rebuilt-topic'])
    expect(result.scanned).toBe(1)
    expect(result.changed).toBe(1)

    const after = db.rawAll<{ topic_key: string }>('SELECT topic_key FROM memory_topics')
    expect(after.map(r => r.topic_key)).toEqual(['rebuilt-topic'])
  })

  it('dry run reports what would change without writing', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'alpha beta gamma' })
    db.backfillMemoryTopics(extractTopicsFromContent)
    const before = db.rawAll<{ topic_key: string }>('SELECT topic_key FROM memory_topics ORDER BY topic_key')

    const result = db.rebuildMemoryTopics(() => ['would-change'], { dryRun: true })
    expect(result.changed).toBe(1)

    const after = db.rawAll<{ topic_key: string }>('SELECT topic_key FROM memory_topics ORDER BY topic_key')
    expect(after).toEqual(before)
  })

  it('dry run projects the real row total, not the unchanged one', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'alpha beta gamma' })
    db.backfillMemoryTopics(extractTopicsFromContent)
    const startingRows = db.rawAll<{ topic_key: string }>('SELECT topic_key FROM memory_topics').length
    expect(startingRows).toBe(3)

    // 3 existing rows collapse to 1 — reporting topicsAfter === topicsBefore
    // here would read as a no-op next to changed: 1.
    const shrink = db.rebuildMemoryTopics(() => ['only-one'], { dryRun: true })
    expect(shrink.topicsBefore).toBe(3)
    expect(shrink.topicsAfter).toBe(1)

    const grow = db.rebuildMemoryTopics(() => ['a1', 'b2', 'c3', 'd4', 'e5'], { dryRun: true })
    expect(grow.topicsAfter).toBe(5)

    // Still a dry run: nothing on disk moved.
    expect(db.rawAll('SELECT topic_key FROM memory_topics').length).toBe(3)
  })

  it('dry run projection matches what the real run produces', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'alpha beta gamma' })
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'delta epsilon' })
    db.backfillMemoryTopics(extractTopicsFromContent)

    const extractor = (c: string) => (c.startsWith('alpha') ? ['x1', 'x2'] : ['y1'])
    const predicted = db.rebuildMemoryTopics(extractor, { dryRun: true })
    const actual = db.rebuildMemoryTopics(extractor)

    expect(actual.topicsAfter).toBe(predicted.topicsAfter)
    expect(actual.changed).toBe(predicted.changed)
  })

  it('dedupes extractor output rather than hitting the composite primary key', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'alpha beta gamma' })
    db.backfillMemoryTopics(extractTopicsFromContent)

    // memory_topics is PRIMARY KEY (memory_id, topic_key) — a repeated key
    // would abort the write on a UNIQUE violation.
    const result = db.rebuildMemoryTopics(() => ['same', 'same', 'other'])
    expect(result.topicsAfter).toBe(2)

    const keys = db.rawAll<{ topic_key: string }>('SELECT topic_key FROM memory_topics ORDER BY topic_key')
    expect(keys.map(k => k.topic_key)).toEqual(['other', 'same'])
  })

  it('reports before/after topic totals', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'alpha beta gamma' })
    db.backfillMemoryTopics(extractTopicsFromContent)
    const result = db.rebuildMemoryTopics(() => ['one', 'two'])
    expect(result.topicsAfter).toBe(2)
    expect(result.topicsBefore).toBeGreaterThan(0)
  })

  it('does not count memories whose topics are unchanged', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'alpha beta gamma' })
    db.backfillMemoryTopics(extractTopicsFromContent)
    const result = db.rebuildMemoryTopics(extractTopicsFromContent)
    expect(result.scanned).toBe(1)
    expect(result.changed).toBe(0)
  })

  it('resolves projectId from session, matching backfill behaviour', () => {
    db.upsertProject('proj-R', 'R')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sr', 'proj-R', '/tmp/sr.jsonl', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')
    `)
    db.saveMemory({ sessionId: 'sr', messageId: null, type: 'decision', content: 'strict mode enabled' })
    db.rebuildMemoryTopics(() => ['scoped'])

    const rows = db.rawAll<{ project_id: string }>('SELECT project_id FROM memory_topics')
    expect(rows[0].project_id).toBe('proj-R')
  })

  it('clears topics when the extractor now yields none', () => {
    db.saveMemory({ sessionId: null, messageId: null, type: 'discovery', content: 'alpha beta gamma' })
    db.backfillMemoryTopics(extractTopicsFromContent)
    const result = db.rebuildMemoryTopics(() => [])
    expect(result.changed).toBe(1)
    expect(result.topicsAfter).toBe(0)
    expect(db.rawAll('SELECT topic_key FROM memory_topics')).toEqual([])
  })
})

describe('cleanOrphanedMemoryTopics', () => {
  it('removes memory_topics entries referencing deleted memories', () => {
    // Insert orphan directly (bypasses FK check) to simulate leftover from bulk cleanup
    db.rawExec("PRAGMA foreign_keys = OFF")
    db.rawExec("INSERT INTO memory_topics (memory_id, topic_key, project_id) VALUES (99999, 'sqlite', 'proj-X')")
    db.rawExec("PRAGMA foreign_keys = ON")
    expect(db.rawAll('SELECT * FROM memory_topics').length).toBe(1)

    const removed = db.cleanOrphanedMemoryTopics()
    expect(removed).toBe(1)
    expect(db.rawAll('SELECT * FROM memory_topics').length).toBe(0)
  })
})

describe('getStartupMemories — Tier 0 cross-project', () => {
  beforeEach(() => {
    db.upsertProject('proj-A', 'Project A')
    db.upsertProject('proj-B', 'Project B')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at) VALUES
        ('sa', 'proj-A', '/tmp/sa.jsonl', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z'),
        ('sb', 'proj-B', '/tmp/sb.jsonl', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')
    `)
    // proj-B session has 'sqlite' topic → knowledge_map for proj-B
    db.saveSessionTopics('sb', 'proj-B', ['sqlite', 'database'])
    db.rebuildKnowledgeMap('proj-B')
  })

  it('surfaces cross-project memory via shared topic', () => {
    // Memory in proj-A about sqlite
    const memId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'SQLite WAL checkpoint should use TRUNCATE mode',
    })
    db.saveMemoryTopics(memId, 'proj-A', ['sqlite', 'checkpoint'])

    const results = db.getStartupMemories('proj-B', 10)
    expect(results.some(m => m.content.includes('WAL checkpoint'))).toBe(true)
  })

  it('surfaces global memory (project_id=NULL) via topic intersection', () => {
    const memId = db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'Always use WAL mode for SQLite databases',
    })
    db.saveMemoryTopics(memId, '', ['sqlite', 'wal-mode'])

    const results = db.getStartupMemories('proj-B', 10)
    expect(results.some(m => m.content.includes('WAL mode'))).toBe(true)
  })

  it('does NOT leak project-specific memory without topic intersection', () => {
    // Memory in proj-A about 'react' — proj-B has no react topic
    const memId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'Use React Server Components for the dashboard',
    })
    db.saveMemoryTopics(memId, 'proj-A', ['react', 'server-components'])

    const results = db.getStartupMemories('proj-B', 10)
    expect(results.every(m => !m.content.includes('React Server'))).toBe(true)
  })

  it('respects confidence >= 0.8 gate', () => {
    const memId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'discovery',
      content: 'SQLite FTS5 trigram low confidence finding',
      confidence: 0.5,
    })
    db.saveMemoryTopics(memId, 'proj-A', ['sqlite', 'fts5'])

    const results = db.getStartupMemories('proj-B', 10)
    expect(results.every(m => !m.content.includes('trigram low confidence'))).toBe(true)
  })

  it('returns empty Tier 0 when knowledge_map has no entries (new project)', () => {
    db.upsertProject('proj-new', 'New Project')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sn', 'proj-new', '/tmp/sn.jsonl', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')
    `)
    // No knowledge_map for proj-new

    const memId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'SQLite cross-project test memory',
    })
    db.saveMemoryTopics(memId, 'proj-A', ['sqlite'])

    // proj-new has no topics → Tier 0 returns nothing, falls through to Tier 1-3
    const results = db.getStartupMemories('proj-new', 10)
    expect(results.every(m => !m.content.includes('cross-project test'))).toBe(true)
  })

  it('Tier 0 max 3 rows — does not consume all startup slots', () => {
    // Create 5 cross-project memories all matching sqlite topic
    for (let i = 0; i < 5; i++) {
      const id = db.saveMemory({
        sessionId: 'sa', messageId: null, type: 'decision',
        content: `SQLite cross-project finding number ${i}`,
      })
      db.saveMemoryTopics(id, 'proj-A', ['sqlite'])
    }
    // Also create a proj-B local memory (should appear via Tier 1)
    db.saveMemory({
      sessionId: 'sb', messageId: null, type: 'decision',
      content: 'proj-B local memory about routing',
    })

    const results = db.getStartupMemories('proj-B', 10)
    const crossProject = results.filter(m => m.content.includes('cross-project finding'))
    const local = results.filter(m => m.content.includes('proj-B local'))

    expect(crossProject.length).toBeLessThanOrEqual(3)
    expect(local.length).toBe(1)
  })

  // NOTE: all three fixtures below carry the default confidence (0.8), so
  // "same confidence group" is vacuously true — this assertion holds under BOTH
  // `confidence DESC` first and `injected_at ASC` first. It therefore proves
  // rotation works *within* a tie, not that rotation outranks confidence.
  // The `ranks a never-injected memory above` test below covers that gap.
  it('Tier 0 rotates within same confidence group by injection recency', () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) {
      const id = db.saveMemory({
        sessionId: 'sa', messageId: null, type: 'decision',
        content: `SQLite rotation test memory ${i}`,
      })
      db.saveMemoryTopics(id, 'proj-A', ['sqlite'])
      ids.push(id)
    }

    // Before injection: all NULL injected_at, all present
    let results = db.getStartupMemories('proj-B', 3)
    let rotated = results.filter(m => m.content.includes('rotation test'))
    expect(rotated.length).toBe(3)

    // Inject memory 2 — it should drop to the back (most recently injected)
    db.logInjection([{ memoryId: ids[2], source: 'startup', sessionId: 'sb' }])

    results = db.getStartupMemories('proj-B', 3)
    rotated = results.filter(m => m.content.includes('rotation test'))
    expect(rotated.length).toBe(3)
    // NULL injected_at (memories 0,1) sort before non-NULL (memory 2) in ASC
    expect(rotated[2].content).toContain('memory 2')
  })

  it('Tier 0 ranks a never-injected memory above a higher-confidence recently-injected one', () => {
    // Pins rotation as the FIRST sort key. Under `confidence DESC` first the
    // 1.0 memory wins the single slot; under `MAX(injected_at) ASC` first the
    // never-injected 0.8 memory does. Both sit above the >= 0.8 Tier 0 gate,
    // and created_at never breaks the tie because the keys above it differ.
    const injectedId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'SQLite high confidence memory already injected',
      confidence: 1.0,
    })
    db.saveMemoryTopics(injectedId, 'proj-A', ['sqlite'])

    const freshId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'SQLite lower confidence memory never injected',
      confidence: 0.8,
    })
    db.saveMemoryTopics(freshId, 'proj-A', ['sqlite'])

    db.logInjection([{ memoryId: injectedId, source: 'startup', sessionId: 'sb' }])

    // limit=1 → Tier 0 gets exactly one slot, so the winner is unambiguous.
    const results = db.getStartupMemories('proj-B', 1)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe(freshId)
  })

  it('dedupes between Tier 0 and Tier 1 (global memory appears once)', () => {
    // Global memory with sqlite topic — visible in both Tier 0 (topic intersection) and Tier 1 (project_id IS NULL)
    const memId = db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'Global SQLite preference for dedup test',
    })
    db.saveMemoryTopics(memId, '', ['sqlite'])

    const results = db.getStartupMemories('proj-B', 10)
    const matches = results.filter(m => m.content.includes('dedup test'))
    expect(matches.length).toBe(1)
  })

  // Both tests below need more than TIER0_RELEVANCE_MIN_POOL candidates. Under
  // the rank floor a pool of 12 or fewer is entirely in-band, so the relevance
  // key cannot separate anything — the same mechanism that puts 52 of 80 real
  // projects on the floor path rather than the ratio threshold.
  it('Tier 0 gives two projects different results from one shared candidate pool', () => {
    db.upsertProject('proj-C', 'Project C')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sc', 'proj-C', '/tmp/sc.jsonl', '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')
    `)
    db.saveSessionTopics('sc', 'proj-C', ['sqlite', 'react'])
    db.rebuildKnowledgeMap('proj-C')

    // Fillers: ratio 1.0 for proj-B, 0.5 for proj-C. They occupy the floor and
    // push each project's irrelevant memory past rank 12.
    for (let i = 0; i < Database.TIER0_RELEVANCE_MIN_POOL; i++) {
      const id = db.saveMemory({
        sessionId: 'sa', messageId: null, type: 'decision',
        content: `SQLite filler memory ${i}`,
      })
      db.saveMemoryTopics(id, 'proj-A', ['sqlite', 'database'])
    }

    // ratio 1/3 for proj-B, 2/3 for proj-C
    const reactId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'SQLite query state lives in the React store',
    })
    db.saveMemoryTopics(reactId, 'proj-A', ['sqlite', 'react', 'redux'])

    // ratio 2/3 for proj-B, 1/3 for proj-C. Highest id, so without a relevance
    // band it wins the slot for BOTH projects on `m.id DESC` alone — that is
    // what makes this red until the band exists.
    const ormId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'SQLite schema is generated by the ORM layer',
    })
    db.saveMemoryTopics(ormId, 'proj-A', ['sqlite', 'database', 'orm'])

    expect(db.getStartupMemories('proj-B', 1)[0].id).toBe(ormId)
    expect(db.getStartupMemories('proj-C', 1)[0].id).toBe(reactId)
  })

  it('Tier 0 ranks by topic ratio, not raw intersection count', () => {
    for (let i = 0; i < Database.TIER0_RELEVANCE_MIN_POOL; i++) {
      const id = db.saveMemory({
        sessionId: 'sa', messageId: null, type: 'decision',
        content: `SQLite ratio filler ${i}`,
      })
      db.saveMemoryTopics(id, 'proj-A', ['sqlite', `filler-topic-${i}`]) // ratio 0.5
    }

    // One topic, fully matched → ratio 1.0.
    const shortId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'SQLite pragma synchronous NORMAL is enough under WAL',
    })
    db.saveMemoryTopics(shortId, 'proj-A', ['sqlite'])

    // Matches TWO topics — a higher raw intersection than shortId — but out of
    // ten, so ratio 0.2. Created last, so raw recency would hand it the slot.
    // Raw intersection count is a length proxy (r=0.791); the ratio is not
    // (r=0.055), and this pins which one the query uses.
    const longId = db.saveMemory({
      sessionId: 'sa', messageId: null, type: 'decision',
      content: 'A sprawling memory touching sqlite and database among many other things',
    })
    db.saveMemoryTopics(longId, 'proj-A', [
      'sqlite', 'database', 'deploy', 'testing', 'ci',
      'docs', 'auth', 'cache', 'queue', 'metrics',
    ])

    expect(db.getStartupMemories('proj-B', 1)[0].id).toBe(shortId)
  })

  it('Tier 0 keeps below-threshold memories reachable when the pool is under the floor', () => {
    // Every memory here is below TIER0_RELEVANCE_RATIO. With a pool this small
    // the floor puts all of them in-band, so none is structurally unreachable.
    // This is the majority path, not an edge case: 52 of 80 real projects have
    // fewer than TIER0_RELEVANCE_MIN_POOL memories above the ratio.
    const ids: number[] = []
    for (let i = 0; i < 3; i++) {
      const id = db.saveMemory({
        sessionId: 'sa', messageId: null, type: 'decision',
        content: `SQLite small pool memory ${i}`,
      })
      db.saveMemoryTopics(id, 'proj-A', ['sqlite', `only-${i}-a`, `only-${i}-b`]) // ratio 1/3
      ids.push(id)
    }

    const results = db.getStartupMemories('proj-B', 3)
    expect(results.map(m => m.id).sort()).toEqual(ids.sort())
  })

  it('Tier 0 still admits a global memory (project_id IS NULL) into the band', () => {
    for (let i = 0; i < Database.TIER0_RELEVANCE_MIN_POOL; i++) {
      const id = db.saveMemory({
        sessionId: 'sa', messageId: null, type: 'decision',
        content: `SQLite band filler ${i}`,
      })
      db.saveMemoryTopics(id, 'proj-A', ['sqlite', `x-${i}`, `y-${i}`, `z-${i}`]) // ratio 0.25
    }

    // Global memory, both topics intersect proj-B → ratio 1.0. The pool is over
    // the floor here, so this asserts the band admits it on relevance rather
    // than on the floor sweeping everything in.
    const globalId = db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'Global SQLite database preference that should stay reachable',
    })
    db.saveMemoryTopics(globalId, '', ['sqlite', 'database'])

    const results = db.getStartupMemories('proj-B', 3)
    expect(results.some(m => m.id === globalId)).toBe(true)
  })
})
