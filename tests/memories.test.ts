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
