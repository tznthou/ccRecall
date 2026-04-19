// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'

let tmpDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-mig19-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('migration v19 — schema', () => {
  it('schema_version contains row 19', () => {
    const versions = db.rawAll<{ version: number }>(
      'SELECT version FROM schema_version ORDER BY version',
    )
    expect(versions.map(v => v.version)).toContain(19)
  })

  it('memories_fts uses trigram tokenizer', () => {
    const rows = db.rawAll<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'memories_fts'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toMatch(/tokenize\s*=\s*['"]trigram['"]/i)
  })

  it('sessions_fts uses trigram tokenizer', () => {
    const rows = db.rawAll<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'sessions_fts'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toMatch(/tokenize\s*=\s*['"]trigram['"]/i)
  })

  it('messages_fts uses trigram tokenizer', () => {
    const rows = db.rawAll<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'messages_fts'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sql).toMatch(/tokenize\s*=\s*['"]trigram['"]/i)
  })

  it('all 3 FTS tables still exist (migration did not accidentally remove one)', () => {
    const names = db.rawAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts' ORDER BY name",
    ).map(r => r.name)
    expect(names).toContain('memories_fts')
    expect(names).toContain('sessions_fts')
    expect(names).toContain('messages_fts')
  })

  it('FTS sync triggers (memories + messages) survive the rebuild', () => {
    const triggers = db.rawAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
    ).map(r => r.name)
    expect(triggers).toContain('memories_ai')
    expect(triggers).toContain('memories_ad')
    expect(triggers).toContain('memories_au')
    expect(triggers).toContain('messages_ai')
    expect(triggers).toContain('messages_ad')
  })
})

describe('migration v19 — backfill from simulated v18 state', () => {
  it('preserves memories content after unicode61 → trigram swap', async () => {
    const dbPath = path.join(tmpDir, 'v18-sim.db')

    // Stage 1: Build fresh DB (runs v1..v19), then seed data
    const dbA = new Database(dbPath)
    dbA.saveMemory({
      content: 'ccRecall 的記憶設計原則',
      type: 'decision',
      sessionId: null,
      messageId: null,
    })

    // Stage 2: Simulate v18 state — rewind schema_version and rebuild
    // memories_fts with unicode61 tokenizer (mirrors what a real v18 DB would
    // look like on disk, without having to reconstruct 18 migrations).
    dbA.rawExec('DELETE FROM schema_version WHERE version = 19')
    dbA.rawExec(`
      DROP TABLE memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='id',
        tokenize='unicode61'
      );
      INSERT INTO memories_fts(rowid, content) SELECT id, COALESCE(content, '') FROM memories;
    `)
    dbA.close()

    // Stage 3: Reopen — migration runner sees current=18 and re-applies v19
    const dbB = new Database(dbPath)

    // Schema now trigram
    const sql = dbB.rawAll<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'memories_fts'",
    )[0].sql
    expect(sql).toMatch(/tokenize\s*=\s*['"]trigram['"]/i)

    // Existing CJK memory still queryable (via LIKE fallback for 2-char query)
    const results = dbB.queryMemories('記憶', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('記憶'))).toBe(true)

    dbB.close()
  })
})
