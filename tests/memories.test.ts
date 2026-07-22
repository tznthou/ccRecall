// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import type { MemoryInput } from '../src/core/database'

let tmpDir: string
let db: Database

function mem(overrides: Partial<MemoryInput> & { content: string }): MemoryInput {
  return {
    sessionId: null,
    messageId: null,
    type: 'decision',
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-mem-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('memories schema', () => {
  it('memories table, memories_fts and triggers exist', () => {
    const objs = db.rawAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name",
    )
    const names = objs.map(r => r.name)
    expect(names).toContain('memories')
    expect(names).toContain('memories_fts')
    expect(names).toContain('memories_ai')
    expect(names).toContain('memories_ad')
    expect(names).toContain('memories_au')
  })

  it('memories table has expected columns', () => {
    const cols = db.rawAll<{ name: string }>("PRAGMA table_info(memories)")
    const names = cols.map(c => c.name)
    expect(names).toEqual([
      'id', 'session_id', 'message_id', 'content', 'type', 'confidence', 'created_at',
      'last_accessed', 'access_count', 'compressed_at', 'compression_level', 'project_id',
      'key',
    ])
  })
})

describe('saveMemory', () => {
  it('inserts and returns new id', () => {
    const id = db.saveMemory(mem({ content: 'prefer pnpm over npm', type: 'preference' }))
    expect(id).toBeGreaterThan(0)
    expect(db.getMemoryCount()).toBe(1)
  })

  it('defaults confidence to 0.8', () => {
    const id = db.saveMemory(mem({ content: 'x' }))
    const row = db.rawAll<{ confidence: number }>(`SELECT confidence FROM memories WHERE id = ${id}`)[0]
    expect(row.confidence).toBe(0.8)
  })

  it('persists session_id and message_id when provided', () => {
    const id = db.saveMemory(mem({
      content: 'y', sessionId: 'sess-1', messageId: 'msg-1', confidence: 0.95,
    }))
    const row = db.rawAll<{ session_id: string; message_id: string; confidence: number }>(
      `SELECT session_id, message_id, confidence FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.session_id).toBe('sess-1')
    expect(row.message_id).toBe('msg-1')
    expect(row.confidence).toBe(0.95)
  })

  it('persists key column', () => {
    const id = db.saveMemory(mem({ content: 'WAL mode', key: 'sqlite-wal-mode' }))
    const row = db.rawAll<{ key: string }>(`SELECT key FROM memories WHERE id = ${id}`)[0]
    expect(row.key).toBe('sqlite-wal-mode')
  })

  it('key defaults to NULL when omitted', () => {
    const id = db.saveMemory(mem({ content: 'no key' }))
    const row = db.rawAll<{ key: string | null }>(`SELECT key FROM memories WHERE id = ${id}`)[0]
    expect(row.key).toBeNull()
  })
})

describe('saveMemory key-based upsert', () => {
  it('same key + same project_id updates instead of inserting', () => {
    const id1 = db.saveMemory(mem({ content: 'v1', key: 'slug-a', projectId: 'proj-1' }))
    const id2 = db.saveMemory(mem({ content: 'v2', key: 'slug-a', projectId: 'proj-1', confidence: 0.95 }))
    expect(id2).toBe(id1)
    expect(db.getMemoryCount()).toBe(1)
    const row = db.rawAll<{ content: string; confidence: number }>(
      `SELECT content, confidence FROM memories WHERE id = ${id1}`,
    )[0]
    expect(row.content).toBe('v2')
    expect(row.confidence).toBe(0.95)
  })

  it('upsert resets access_count and last_accessed', () => {
    const id = db.saveMemory(mem({ content: 'v1', key: 'slug-b', projectId: 'proj-1' }))
    db.touchMemory([id])
    const before = db.rawAll<{ access_count: number; last_accessed: string | null }>(
      `SELECT access_count, last_accessed FROM memories WHERE id = ${id}`,
    )[0]
    expect(before.access_count).toBe(1)
    expect(before.last_accessed).not.toBeNull()

    db.saveMemory(mem({ content: 'v2', key: 'slug-b', projectId: 'proj-1' }))
    const after = db.rawAll<{ access_count: number; last_accessed: string | null }>(
      `SELECT access_count, last_accessed FROM memories WHERE id = ${id}`,
    )[0]
    expect(after.access_count).toBe(0)
    expect(after.last_accessed).toBeNull()
  })

  it('different key same project inserts new row', () => {
    db.saveMemory(mem({ content: 'v1', key: 'slug-a', projectId: 'proj-1' }))
    db.saveMemory(mem({ content: 'v2', key: 'slug-b', projectId: 'proj-1' }))
    expect(db.getMemoryCount()).toBe(2)
  })

  it('same key different project inserts new row', () => {
    db.saveMemory(mem({ content: 'v1', key: 'slug-a', projectId: 'proj-1' }))
    db.saveMemory(mem({ content: 'v2', key: 'slug-a', projectId: 'proj-2' }))
    expect(db.getMemoryCount()).toBe(2)
  })

  it('same key with NULL project_id (global) upserts correctly', () => {
    const id1 = db.saveMemory(mem({ content: 'global v1', key: 'global-slug' }))
    const id2 = db.saveMemory(mem({ content: 'global v2', key: 'global-slug' }))
    expect(id2).toBe(id1)
    expect(db.getMemoryCount()).toBe(1)
    const row = db.rawAll<{ content: string }>(`SELECT content FROM memories WHERE id = ${id1}`)[0]
    expect(row.content).toBe('global v2')
  })

  it('no key always inserts (no upsert)', () => {
    db.saveMemory(mem({ content: 'same content' }))
    db.saveMemory(mem({ content: 'same content' }))
    expect(db.getMemoryCount()).toBe(2)
  })
})

describe('queryMemories', () => {
  beforeEach(() => {
    db.saveMemory(mem({ content: 'prefer pnpm over npm', type: 'preference', confidence: 0.9 }))
    db.saveMemory(mem({ content: 'use vitest for tests', type: 'decision', confidence: 0.8 }))
    db.saveMemory(mem({ content: 'FTS5 quoting bug fix', type: 'discovery', confidence: 0.7 }))
  })

  it('returns matching memories with FTS5', () => {
    const results = db.queryMemories('pnpm', 10)
    expect(results.length).toBe(1)
    expect(results[0].content).toBe('prefer pnpm over npm')
    expect(results[0].type).toBe('preference')
  })

  it('returns [] for no match', () => {
    expect(db.queryMemories('nonexistent', 10)).toEqual([])
  })

  it('respects limit', () => {
    const results = db.queryMemories('tests OR pnpm OR FTS5', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('survives FTS5 operator injection attempt', () => {
    expect(() => db.queryMemories('pnpm AND NOT', 10)).not.toThrow()
    expect(() => db.queryMemories('"unterminated', 10)).not.toThrow()
  })

  it('handles empty query gracefully', () => {
    expect(db.queryMemories('', 10)).toEqual([])
  })
})

describe('queryMemories LIKE fallback (short tokens)', () => {
  // Trigram tokenizer cannot index tokens shorter than 3 chars. The fallback
  // path runs LIKE on raw memory content. Single-token queries keep the simple
  // substring behavior; multi-token queries (e.g. mixed Latin acronyms + CJK
  // like `UI 記憶`, `DB 查詢`) AND each token, so a doc only matches when every
  // token appears somewhere in content.

  it('single short CJK token still hits via single-LIKE', () => {
    db.saveMemory(mem({ content: '記憶系統設計', confidence: 0.8 }))
    db.saveMemory(mem({ content: '無關內容', confidence: 0.8 }))
    const results = db.queryMemories('記憶', 10)
    expect(results.map(r => r.content)).toEqual(['記憶系統設計'])
  })

  it('single short Latin acronym still hits via single-LIKE', () => {
    db.saveMemory(mem({ content: 'UI element refactor', confidence: 0.8 }))
    db.saveMemory(mem({ content: 'unrelated', confidence: 0.8 }))
    const results = db.queryMemories('UI', 10)
    expect(results.map(r => r.content)).toEqual(['UI element refactor'])
  })

  it('mixed Latin + CJK uses AND across tokens (Case 5)', () => {
    db.saveMemory(mem({ content: 'UI 元件設計優化記憶', confidence: 0.9 }))
    db.saveMemory(mem({ content: '後台 API 跟前台 UI 的記憶共用', confidence: 0.85 }))
    db.saveMemory(mem({ content: '純 UI 改動，沒動到資料層', confidence: 0.8 }))
    db.saveMemory(mem({ content: '記憶系統的單元測試覆蓋率', confidence: 0.8 }))

    const results = db.queryMemories('UI 記憶', 10)
    const contents = results.map(r => r.content).sort()
    expect(contents).toEqual([
      'UI 元件設計優化記憶',
      '後台 API 跟前台 UI 的記憶共用',
    ].sort())
  })

  it('token order in query does not matter (AND is commutative)', () => {
    db.saveMemory(mem({ content: 'UI 元件設計優化記憶', confidence: 0.9 }))
    db.saveMemory(mem({ content: '純 UI 改動', confidence: 0.8 }))

    const a = db.queryMemories('UI 記憶', 10)
    const b = db.queryMemories('記憶 UI', 10)
    expect(a.map(r => r.content)).toEqual(b.map(r => r.content))
    expect(a.length).toBe(1)
  })

  it('extra whitespace between tokens is normalized', () => {
    db.saveMemory(mem({ content: 'UI 元件設計記憶', confidence: 0.9 }))
    const results = db.queryMemories('UI    記憶', 10)
    expect(results.length).toBe(1)
  })

  it('caps token count to bound SQL prepare cost (DoS guard)', () => {
    db.saveMemory(mem({ content: 'UI memory only', confidence: 0.9 }))
    // Generate a giant query: 1000 unique short tokens. Without the cap this
    // would build a 1000-clause SQL string (~hundreds of KB of SQL text + 1000
    // bind params) on the synchronous event loop.
    const giant = Array.from({ length: 1000 }, (_, i) => `t${i}`).join(' ')
    const before = Date.now()
    expect(() => db.queryMemories(giant, 10)).not.toThrow()
    const elapsed = Date.now() - before
    // Loose ceiling — capped query stays well under 100ms. Without the cap
    // this regularly exceeds 500ms or hits SQLITE_RANGE.
    expect(elapsed).toBeLessThan(500)
  })

  it('LIKE wildcards in tokens are escaped (security)', () => {
    db.saveMemory(mem({ content: 'UI percent% sign', confidence: 0.9 }))
    db.saveMemory(mem({ content: 'UI no special', confidence: 0.8 }))

    const results = db.queryMemories('UI %', 10)
    // The literal `%` token must match only the doc that actually contains `%`,
    // not match every doc as it would if `%` were treated as a wildcard.
    expect(results.map(r => r.content)).toEqual(['UI percent% sign'])
  })
})

describe('queryMemories FTS ranking — relevance over recency', () => {
  it('high FTS relevance beats high EC when text match is stronger', () => {
    // A: strong match for "database migration" — query terms repeated
    const idA = db.saveMemory(mem({
      content: 'database migration strategy for production database migration rollback',
      confidence: 0.9,
    }))
    // B: weak match — both terms present but buried in unrelated text
    const idB = db.saveMemory(mem({
      content: 'prefer pnpm config for general projects setup with notes on database and migration tooling compatibility and package management',
      confidence: 0.9,
    }))

    // A: 14 days old, moderate access → moderate EC (~0.57)
    db.rawExec(`UPDATE memories SET
      created_at = datetime('now', '-14 days'),
      last_accessed = datetime('now', '-14 days'),
      access_count = 2
      WHERE id = ${idA}`)
    // B: fresh, higher access → high EC (~0.90)
    db.rawExec(`UPDATE memories SET
      created_at = datetime('now', '-1 day'),
      last_accessed = datetime('now'),
      access_count = 5
      WHERE id = ${idB}`)

    const results = db.queryMemories('database migration', 5)
    expect(results.length).toBe(2)
    expect(results[0].id).toBe(idA)
  })

  it('same FTS relevance falls back to EC (recency tiebreaker)', () => {
    const idOld = db.saveMemory(mem({
      content: 'sandbox configuration for isolated testing environment',
      confidence: 0.9,
    }))
    const idNew = db.saveMemory(mem({
      content: 'sandbox configuration for isolated testing environment',
      confidence: 0.9,
    }))

    db.rawExec(`UPDATE memories SET
      created_at = datetime('now', '-60 days'),
      last_accessed = datetime('now', '-60 days'),
      access_count = 1
      WHERE id = ${idOld}`)
    db.rawExec(`UPDATE memories SET
      created_at = datetime('now', '-1 day'),
      last_accessed = datetime('now'),
      access_count = 10
      WHERE id = ${idNew}`)

    const results = db.queryMemories('sandbox configuration', 5)
    expect(results.length).toBe(2)
    expect(results[0].id).toBe(idNew)
  })
})

describe('getMemoryCount', () => {
  it('returns 0 on empty', () => {
    expect(db.getMemoryCount()).toBe(0)
  })

  it('reflects inserts', () => {
    db.saveMemory(mem({ content: 'a' }))
    db.saveMemory(mem({ content: 'b' }))
    expect(db.getMemoryCount()).toBe(2)
  })
})
