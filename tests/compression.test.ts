import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import type { CompressionCandidate } from '../src/core/database'
import { MemoryService } from '../src/core/memory-service'
import { CompressionPipeline, planTransition, truncate } from '../src/core/compression'

let tmpDir: string
let db: Database
let svc: MemoryService
let pipe: CompressionPipeline

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-compress-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  svc = new MemoryService(db)
  pipe = new CompressionPipeline(db, svc)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function candidate(overrides: Partial<CompressionCandidate> = {}): CompressionCandidate {
  return {
    id: 1,
    sessionId: null,
    content: 'body',
    compressionLevel: 0,
    accessCount: 0,
    ageDays: 0,
    effectiveConfidence: 1,
    summaryText: null,
    intentText: null,
    sessionExists: false,
    ...overrides,
  }
}

describe('truncate()', () => {
  it('returns input unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('appends ellipsis when over limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...')
  })

  it('trims trailing whitespace before ellipsis', () => {
    expect(truncate('hello     world', 7)).toBe('hello...')
  })
})

describe('planTransition() — L0 → L1 gates', () => {
  it('compresses L0 when age >= 7d, access < 2, effective < 0.5', () => {
    const a = planTransition(candidate({
      ageDays: 10, accessCount: 0, effectiveConfidence: 0.3, content: 'raw content',
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') expect(a.toLevel).toBe(1)
  })

  it('skips L0 when age < 7d', () => {
    const a = planTransition(candidate({ ageDays: 5, effectiveConfidence: 0.1 }))
    expect(a.kind).toBe('skip')
  })

  it('skips L0 when access_count >= 2 (active memory)', () => {
    const a = planTransition(candidate({
      ageDays: 30, accessCount: 2, effectiveConfidence: 0.1,
    }))
    expect(a.kind).toBe('skip')
  })

  it('skips L0 when effective_confidence >= 0.5 (still useful)', () => {
    const a = planTransition(candidate({ ageDays: 30, effectiveConfidence: 0.6 }))
    expect(a.kind).toBe('skip')
  })
})

describe('planTransition() — L1 → L2 gates', () => {
  it('compresses L1 when age >= 30d and access < 4', () => {
    const a = planTransition(candidate({
      compressionLevel: 1, ageDays: 40, accessCount: 1, content: 'summary text',
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') expect(a.toLevel).toBe(2)
  })

  it('skips L1 when age < 30d', () => {
    const a = planTransition(candidate({ compressionLevel: 1, ageDays: 20 }))
    expect(a.kind).toBe('skip')
  })

  it('skips L1 when access_count >= 4 (frequently used)', () => {
    const a = planTransition(candidate({
      compressionLevel: 1, ageDays: 40, accessCount: 4,
    }))
    expect(a.kind).toBe('skip')
  })
})

describe('planTransition() — L2 → delete gates', () => {
  it('deletes L2 session-backed memory when age >= 60d, access = 0, session exists', () => {
    const a = planTransition(candidate({
      compressionLevel: 2, ageDays: 70, accessCount: 0,
      sessionId: 'sess-1', sessionExists: true,
    }))
    expect(a.kind).toBe('delete')
  })

  it('skips L2 manual memory even at age >= 60d (auto-delete session-backed only)', () => {
    const a = planTransition(candidate({
      compressionLevel: 2, ageDays: 70, accessCount: 0,
      sessionId: null, sessionExists: false,
    }))
    expect(a.kind).toBe('skip')
  })

  it('skips L2 orphan (sessionId present but session row deleted) — preserves last copy', () => {
    const a = planTransition(candidate({
      compressionLevel: 2, ageDays: 70, accessCount: 0,
      sessionId: 'sess-gone', sessionExists: false,
    }))
    expect(a.kind).toBe('skip')
  })

  it('skips L2 with access_count > 0', () => {
    const a = planTransition(candidate({
      compressionLevel: 2, ageDays: 70, accessCount: 1,
      sessionId: 'sess-1', sessionExists: true,
    }))
    expect(a.kind).toBe('skip')
  })

  it('skips L2 when age < 60d', () => {
    const a = planTransition(candidate({
      compressionLevel: 2, ageDays: 45, accessCount: 0,
      sessionId: 'sess-1', sessionExists: true,
    }))
    expect(a.kind).toBe('skip')
  })
})

describe('planTransition() — L1 content source', () => {
  it('uses sessions.summary_text for session-backed L1', () => {
    const a = planTransition(candidate({
      ageDays: 10, effectiveConfidence: 0.3, sessionId: 'sess-1',
      summaryText: '  intent: fixed bug A  ',
      content: 'original long raw conversation log that is definitely not the summary text',
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') expect(a.newContent).toBe('intent: fixed bug A')
  })

  it('falls back to truncate(content, 150) for manual memory L1', () => {
    const longContent = 'a'.repeat(400)
    const a = planTransition(candidate({
      ageDays: 10, effectiveConfidence: 0.3, sessionId: null,
      content: longContent,
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') {
      expect(a.newContent.endsWith('...')).toBe(true)
      expect(a.newContent.length).toBeLessThanOrEqual(153)
    }
  })

  it('falls back to syntactic truncation when session exists but summary_text is NULL', () => {
    const a = planTransition(candidate({
      ageDays: 10, effectiveConfidence: 0.3,
      sessionId: 'sess-1', summaryText: null,
      content: 'x'.repeat(300),
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') expect(a.newContent.endsWith('...')).toBe(true)
  })
})

describe('planTransition() — L2 content source', () => {
  it('uses sessions.intent_text for session-backed L2', () => {
    const a = planTransition(candidate({
      compressionLevel: 1, ageDays: 40, accessCount: 1, sessionId: 'sess-1',
      intentText: '  intent only  ', summaryText: 'summary fallback',
      content: 'original',
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') expect(a.newContent).toBe('intent only')
  })

  it('falls back to truncated summary_text when intent is missing', () => {
    const summary = 's'.repeat(300)
    const a = planTransition(candidate({
      compressionLevel: 1, ageDays: 40, sessionId: 'sess-1',
      intentText: null, summaryText: summary,
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') {
      expect(a.newContent.endsWith('...')).toBe(true)
      expect(a.newContent.length).toBeLessThanOrEqual(103)
    }
  })

  it('falls back to truncate(content, 80) for manual memory L2', () => {
    const long = 'm'.repeat(200)
    const a = planTransition(candidate({
      compressionLevel: 1, ageDays: 40, sessionId: null,
      content: long,
    }))
    expect(a.kind).toBe('compress')
    if (a.kind === 'compress') {
      expect(a.newContent.endsWith('...')).toBe(true)
      expect(a.newContent.length).toBeLessThanOrEqual(83)
    }
  })
})

describe('CompressionPipeline.runOnce() — end-to-end', () => {
  it('compresses an L0 memory to L1 and updates FTS', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'sentinel ' + 'x'.repeat(300),
      confidence: 0.3,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)

    const stats = pipe.runOnce()
    expect(stats.compressed).toBe(1)
    expect(stats.deleted).toBe(0)

    const row = db.rawAll<{
      content: string; compression_level: number; compressed_at: string | null
    }>(
      `SELECT content, compression_level, compressed_at FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.compression_level).toBe(1)
    expect(row.compressed_at).not.toBeNull()
    expect(row.content.length).toBeLessThanOrEqual(153)
  })

  it('deletes L2 session-backed memory when age > 60d and access = 0', () => {
    db.upsertProject('p-del', 'P')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path) VALUES ('s-del', 'p-del', '/tmp/del.jsonl')
    `)
    const id = db.saveMemory({
      sessionId: 's-del', messageId: null, type: 'decision', content: 'old',
    })
    db.rawExec(`
      UPDATE memories SET compression_level = 2, created_at = datetime('now', '-70 days'), access_count = 0 WHERE id = ${id}
    `)

    const stats = pipe.runOnce()
    expect(stats.deleted).toBe(1)
    expect(db.getMemoryCount()).toBe(0)
  })

  it('does NOT delete manual memory even at L2 age > 60d', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'preference', content: 'user policy',
    })
    db.rawExec(`
      UPDATE memories SET compression_level = 2, created_at = datetime('now', '-70 days'), access_count = 0 WHERE id = ${id}
    `)

    const stats = pipe.runOnce()
    // Manual memory is filtered out of scan by the session_id IS NOT NULL gate
    // in getCompressionCandidates — never reaches planTransition.
    expect(stats.deleted).toBe(0)
    expect(stats.scanned).toBe(0)
    expect(db.getMemoryCount()).toBe(1)
  })

  it('does NOT delete orphan L2 memory (session row gone) — integration', () => {
    db.upsertProject('p-orph', 'P')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path) VALUES ('s-orph', 'p-orph', '/tmp/o.jsonl')
    `)
    const id = db.saveMemory({
      sessionId: 's-orph', messageId: null, type: 'decision', content: 'dangling',
    })
    db.rawExec(`
      UPDATE memories SET compression_level = 2, created_at = datetime('now', '-70 days'), access_count = 0 WHERE id = ${id}
    `)
    db.rawExec(`DELETE FROM sessions WHERE id = 's-orph'`)

    const stats = pipe.runOnce()
    expect(stats.deleted).toBe(0)
    expect(db.getMemoryCount()).toBe(1)
  })

  it('leaves fresh memories untouched (pre-filtered out of scan by age < 7d)', () => {
    db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'fresh', confidence: 0.9,
    })
    const stats = pipe.runOnce()
    expect(stats.compressed).toBe(0)
    expect(stats.deleted).toBe(0)
    expect(stats.scanned).toBe(0)
  })

  it('respects batchSize limit', () => {
    for (let i = 0; i < 5; i++) {
      const id = db.saveMemory({
        sessionId: null, messageId: null, type: 'decision',
        content: `dup ${i} ` + 'x'.repeat(300), confidence: 0.2,
      })
      db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)
    }
    const stats = pipe.runOnce({ batchSize: 3 })
    expect(stats.scanned).toBe(3)
  })

  it('does NOT stall on permanently-ineligible head rows — reaches eligible tail', () => {
    // Fill head with L0 memories that can never transition (access_count >= 2
    // locks them out of L1 forever).
    for (let i = 0; i < 10; i++) {
      const id = db.saveMemory({
        sessionId: null, messageId: null, type: 'decision',
        content: `locked ${i}`, confidence: 0.2,
      })
      db.rawExec(`
        UPDATE memories SET created_at = datetime('now', '-30 days'), access_count = 5 WHERE id = ${id}
      `)
    }
    // Then one eligible row
    const target = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'compress-me ' + 'x'.repeat(300), confidence: 0.2,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${target}`)

    const stats = pipe.runOnce({ batchSize: 3 })
    expect(stats.scanned).toBe(1)
    expect(stats.compressed).toBe(1)
    const row = db.rawAll<{ compression_level: number }>(
      `SELECT compression_level FROM memories WHERE id = ${target}`,
    )[0]
    expect(row.compression_level).toBe(1)
  })

  it('session-backed L1 uses sessions.summary_text verbatim', () => {
    db.upsertProject('p1', 'P')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, summary_text, intent_text)
      VALUES ('s1', 'p1', '/tmp/s.jsonl', 'canonical summary', 'canonical intent')
    `)
    const id = db.saveMemory({
      sessionId: 's1', messageId: null, type: 'decision',
      content: 'verbose original content ' + 'z'.repeat(200), confidence: 0.2,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)

    pipe.runOnce()
    const row = db.rawAll<{ content: string }>(
      `SELECT content FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.content).toBe('canonical summary')
  })

  it('session-backed memory with deleted session row falls back to truncation', () => {
    db.upsertProject('p2', 'P')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path) VALUES ('s2', 'p2', '/tmp/s.jsonl')
    `)
    const id = db.saveMemory({
      sessionId: 's2', messageId: null, type: 'decision',
      content: 'ghost session content ' + 'w'.repeat(200), confidence: 0.2,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)
    // Simulate orphaned memory: sessions row deleted manually.
    db.rawExec(`DELETE FROM sessions WHERE id = 's2'`)

    const stats = pipe.runOnce()
    expect(stats.compressed).toBe(1)
    const row = db.rawAll<{ content: string }>(`SELECT content FROM memories WHERE id = ${id}`)[0]
    expect(row.content.endsWith('...')).toBe(true)
  })

  it('compressed memory remains searchable via memories_au FTS trigger', () => {
    db.upsertProject('p3', 'P')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, summary_text)
      VALUES ('s3', 'p3', '/tmp/s.jsonl', 'beacon keyword here')
    `)
    const id = db.saveMemory({
      sessionId: 's3', messageId: null, type: 'decision',
      content: 'original detail ' + 'y'.repeat(200), confidence: 0.2,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)

    pipe.runOnce()
    expect(db.queryMemories('beacon', 10).length).toBe(1)
    expect(db.queryMemories('original', 10).length).toBe(0)
  })
})
