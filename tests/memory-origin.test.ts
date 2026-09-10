// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import BetterSqlite3 from 'better-sqlite3'
import { Database } from '../src/core/database'
import type { MemoryInput } from '../src/core/database'

/**
 * v0.7.3 — memory origin.
 *
 * Automatic extraction and hand-written memories both enter through
 * `recall_save`, so the write path cannot tell them apart on its own. Without
 * that distinction a later extraction that happens to pick the same key
 * overwrites a memory the user wrote by hand — content, type, confidence, and
 * (because the upsert resets them) its access history too.
 *
 * The asymmetry is the point: an agent-inferred write must never displace an
 * explicit one, while every other combination keeps the previous
 * last-writer-wins behaviour.
 */

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

function row(id: number) {
  return db.rawAll<{
    content: string
    type: string
    confidence: number
    origin: string
    access_count: number
    compression_level: number
  }>(`SELECT content, type, confidence, origin, access_count, compression_level
      FROM memories WHERE id = ${id}`)[0]
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-origin-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('memories.origin column', () => {
  it('exists with a CHECK constraint limiting it to the two known values', () => {
    const sql = db.rawAll<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
    )[0].sql
    expect(sql).toContain('origin')
    // The constraint is what stops a typo ('inferred', 'auto') from creating a
    // third silent class that neither branch of the upsert guard recognises.
    expect(sql).toMatch(/CHECK\s*\(\s*origin\s+IN\s*\(\s*'explicit'\s*,\s*'agent-inferred'\s*\)\s*\)/)
  })

  it('rejects a value outside the two known origins', () => {
    expect(() => db.rawExec(
      "INSERT INTO memories (content, type, confidence, origin) VALUES ('x', 'decision', 0.8, 'auto')",
    )).toThrow()
  })

  it("defaults to 'explicit' when the caller says nothing", () => {
    // Fail safe: an unlabelled write is treated as the user's, so the guard
    // protects it. The opposite default would let an extraction that forgot the
    // parameter silently overwrite hand-written memories.
    const id = db.saveMemory(mem({ content: 'unlabelled' }))
    expect(row(id).origin).toBe('explicit')
  })

  it('stores an explicitly supplied origin', () => {
    const id = db.saveMemory(mem({ content: 'from extraction', origin: 'agent-inferred' }))
    expect(row(id).origin).toBe('agent-inferred')
  })
})

describe('saveMemory upsert guard', () => {
  it('agent-inferred does NOT overwrite an explicit memory', () => {
    const id = db.saveMemory(mem({
      content: 'hand-written truth', type: 'preference', confidence: 1,
      key: 'k', projectId: 'p', origin: 'explicit',
    }))
    const same = db.saveMemory(mem({
      content: 'extraction guess', type: 'discovery', confidence: 0.8,
      key: 'k', projectId: 'p', origin: 'agent-inferred',
    }))

    expect(same).toBe(id)
    const after = row(id)
    expect(after.content).toBe('hand-written truth')
    expect(after.type).toBe('preference')
    expect(after.confidence).toBe(1)
    expect(after.origin).toBe('explicit')
  })

  it('the guard also protects access history and compression state', () => {
    // The unguarded upsert resets access_count and compression_level. Leaving
    // that in place would let a blocked write still distort decay ranking and
    // re-run the compression pipeline over a memory it never changed.
    const id = db.saveMemory(mem({
      content: 'keep me', key: 'k', projectId: 'p', origin: 'explicit',
    }))
    db.touchMemory([id, id, id])
    db.updateMemoryContent(id, 'keep me', 1, new Date().toISOString())

    db.saveMemory(mem({
      content: 'overwrite attempt', key: 'k', projectId: 'p', origin: 'agent-inferred',
    }))

    const after = row(id)
    expect(after.content).toBe('keep me')
    expect(after.access_count).toBe(3)
    expect(after.compression_level).toBe(1)
  })

  it('explicit DOES overwrite an explicit memory (last writer wins, unchanged)', () => {
    const id = db.saveMemory(mem({
      content: 'v1', key: 'k', projectId: 'p', origin: 'explicit',
    }))
    db.saveMemory(mem({
      content: 'v2', key: 'k', projectId: 'p', origin: 'explicit',
    }))
    expect(row(id).content).toBe('v2')
  })

  it('agent-inferred DOES overwrite an agent-inferred memory', () => {
    const id = db.saveMemory(mem({
      content: 'v1', key: 'k', projectId: 'p', origin: 'agent-inferred',
    }))
    db.saveMemory(mem({
      content: 'v2', key: 'k', projectId: 'p', origin: 'agent-inferred',
    }))
    expect(row(id).content).toBe('v2')
  })

  it('explicit DOES overwrite an agent-inferred memory, and promotes its origin', () => {
    // The user correcting what extraction wrote is the whole point of the
    // asymmetry; the row must end up protected afterwards.
    const id = db.saveMemory(mem({
      content: 'guess', key: 'k', projectId: 'p', origin: 'agent-inferred',
    }))
    db.saveMemory(mem({
      content: 'correction', key: 'k', projectId: 'p', origin: 'explicit',
    }))
    const after = row(id)
    expect(after.content).toBe('correction')
    expect(after.origin).toBe('explicit')
  })

  it('a blocked write still records session provenance it can contribute', () => {
    // Refusing the content change is not a reason to drop a session id the row
    // did not have: provenance is additive and the guard is about content.
    const id = db.saveMemory(mem({
      content: 'kept', key: 'k', projectId: 'p', origin: 'explicit',
    }))
    db.rawExec("INSERT INTO projects (id, display_name) VALUES ('p', 'p')")
    db.rawExec(`INSERT INTO sessions (id, project_id, file_path) VALUES ('s1', 'p', '/tmp/s1.jsonl')`)

    db.saveMemory(mem({
      content: 'blocked', key: 'k', projectId: 'p',
      sessionId: 's1', origin: 'agent-inferred',
    }))

    const after = db.rawAll<{ content: string; session_id: string | null }>(
      `SELECT content, session_id FROM memories WHERE id = ${id}`,
    )[0]
    expect(after.content).toBe('kept')
    expect(after.session_id).toBe('s1')
  })

  it('keys are still scoped per project — the guard does not leak across them', () => {
    const a = db.saveMemory(mem({
      content: 'proj-a', key: 'k', projectId: 'p-a', origin: 'explicit',
    }))
    const b = db.saveMemory(mem({
      content: 'proj-b', key: 'k', projectId: 'p-b', origin: 'agent-inferred',
    }))
    expect(b).not.toBe(a)
    expect(row(a).content).toBe('proj-a')
    expect(row(b).content).toBe('proj-b')
  })
})

describe('migration v26 backfill', () => {
  it('labels pre-existing rows from session_id, and new writes are unaffected', async () => {
    // session_id IS NULL is a proxy, not ground truth: it is how every manual
    // save in the live corpus looks (86 of 86 on 2026-09-11), because nothing in
    // an interactive session knows its own session id to pass. Rows written
    // before this column existed carry no better signal, so the backfill uses it
    // and says so rather than pretending the label was recorded at write time.
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-legacy-'))
    const legacyPath = path.join(legacyDir, 'legacy.db')

    const seed = new Database(legacyPath)
    seed.rawExec("INSERT INTO projects (id, display_name) VALUES ('p', 'p')")
    seed.rawExec("INSERT INTO sessions (id, project_id, file_path) VALUES ('s1', 'p', '/tmp/s1.jsonl')")
    seed.close()

    // Drop the column and rewind the schema version so the migration runs for real.
    const raw = new BetterSqlite3(legacyPath)
    raw.exec('ALTER TABLE memories DROP COLUMN origin')
    raw.exec(`INSERT INTO memories (session_id, content, type, confidence)
              VALUES ('s1', 'from a session', 'discovery', 0.8)`)
    raw.exec(`INSERT INTO memories (session_id, content, type, confidence)
              VALUES (NULL, 'written by hand', 'preference', 1.0)`)
    raw.exec('DELETE FROM schema_version WHERE version = 26')
    raw.close()

    const migrated = new Database(legacyPath)
    const rows = migrated.rawAll<{ content: string; origin: string }>(
      'SELECT content, origin FROM memories ORDER BY id',
    )
    expect(rows).toEqual([
      { content: 'from a session', origin: 'agent-inferred' },
      { content: 'written by hand', origin: 'explicit' },
    ])
    migrated.close()
    await rm(legacyDir, { recursive: true, force: true })
  })
})
