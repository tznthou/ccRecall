import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'

let tmpDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-mig18-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('migration v18 — schema', () => {
  it('adds 5 new columns with correct types and defaults', () => {
    const cols = db.rawAll<{ name: string; dflt_value: string | null; notnull: number; type: string }>(
      'PRAGMA table_info(memories)',
    )
    const byName = Object.fromEntries(cols.map(c => [c.name, c]))

    expect(byName.last_accessed?.type).toBe('TEXT')
    expect(byName.last_accessed?.notnull).toBe(0)

    expect(byName.access_count?.type).toBe('INTEGER')
    expect(byName.access_count?.notnull).toBe(1)
    expect(byName.access_count?.dflt_value).toBe('0')

    expect(byName.compressed_at?.type).toBe('TEXT')
    expect(byName.compressed_at?.notnull).toBe(0)

    expect(byName.compression_level?.type).toBe('INTEGER')
    expect(byName.compression_level?.notnull).toBe(1)
    expect(byName.compression_level?.dflt_value).toBe('0')

    expect(byName.project_id?.type).toBe('TEXT')
    expect(byName.project_id?.notnull).toBe(0)
  })

  it('creates memories_au trigger targeting content UPDATE', () => {
    const triggers = db.rawAll<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name='memories_au'",
    )
    expect(triggers).toHaveLength(1)
    expect(triggers[0].sql).toContain('AFTER UPDATE')
    expect(triggers[0].sql).toContain('content')
  })

  it('creates idx_memories_project and idx_memories_access indexes', () => {
    const indexes = db.rawAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memories_%'",
    )
    const names = indexes.map(i => i.name)
    expect(names).toContain('idx_memories_project')
    expect(names).toContain('idx_memories_access')
  })

  it('schema_version records v18 with Phase 4 description', () => {
    const rows = db.rawAll<{ version: number; description: string }>(
      'SELECT version, description FROM schema_version WHERE version = 18',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toContain('Phase 4')
  })
})

describe('migration v18 — FTS UPDATE trigger', () => {
  it('re-indexes memories_fts when memory.content is updated', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'original sentinel token',
    })

    expect(db.queryMemories('sentinel', 10).length).toBe(1)
    expect(db.queryMemories('beacon', 10).length).toBe(0)

    db.rawExec(`UPDATE memories SET content = 'updated beacon text' WHERE id = ${id}`)

    expect(db.queryMemories('sentinel', 10).length).toBe(0)
    expect(db.queryMemories('beacon', 10).length).toBe(1)
  })
})

describe('migration v18 — project_id backfill logic', () => {
  it('backfill SQL populates session-backed memories and leaves manual NULL', () => {
    db.upsertProject('test-project', 'test')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path, started_at, ended_at)
      VALUES ('sess-1', 'test-project', '/tmp/foo.jsonl', '2026-04-17T00:00:00Z', '2026-04-17T00:10:00Z')
    `)

    const sessionBackedId = db.saveMemory({
      sessionId: 'sess-1', messageId: null, type: 'decision',
      content: 'session-backed memory',
    })
    const manualId = db.saveMemory({
      sessionId: null, messageId: null, type: 'preference',
      content: 'manual memory',
    })

    // Simulate pre-backfill state (v17 had no project_id column; newly added is NULL).
    db.rawExec('UPDATE memories SET project_id = NULL')

    // Re-run the exact backfill SQL used in migration v18.
    db.rawExec(`
      UPDATE memories
      SET project_id = (SELECT project_id FROM sessions WHERE sessions.id = memories.session_id)
      WHERE session_id IS NOT NULL
    `)

    const rows = db.rawAll<{ id: number; project_id: string | null }>(
      'SELECT id, project_id FROM memories',
    )
    const backfilled = rows.find(r => r.id === sessionBackedId)
    const manual = rows.find(r => r.id === manualId)
    expect(backfilled?.project_id).toBe('test-project')
    expect(manual?.project_id).toBeNull()
  })
})

describe('migration v18 — defaults on new memories', () => {
  it('new memory has access_count=0, compression_level=0, last_accessed=NULL, compressed_at=NULL', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'fresh',
    })
    const row = db.rawAll<{
      access_count: number; compression_level: number;
      last_accessed: string | null; compressed_at: string | null;
    }>(
      `SELECT access_count, compression_level, last_accessed, compressed_at FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.access_count).toBe(0)
    expect(row.compression_level).toBe(0)
    expect(row.last_accessed).toBeNull()
    expect(row.compressed_at).toBeNull()
  })
})
