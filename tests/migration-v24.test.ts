// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database, hash64 } from '../src/core/database'
import type { MessageInput } from '../src/core/database'

let tmpDir: string

function mkMsg(uuid: string, sequence: number, role: 'user' | 'assistant' = 'user'): MessageInput {
  return {
    uuid, role, type: role, contentText: null, contentJson: null,
    hasToolUse: false, hasToolResult: false, toolNames: [], timestamp: null,
    sequence, rawJson: null, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheCreationTokens: null, model: null,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-mig24-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** Rewind a fresh (v24) DB to a simulated v23 state: restore session_journal /
 *  session_checkpoints, re-add sessions.harvest_text, and swap message_uuids
 *  back to the v20 TEXT shape. Mirrors a v0.4.8 user's DB before upgrading. */
function rewindToV23(db: Database, seedSql?: string): void {
  db.rawExec(`DELETE FROM schema_version WHERE version >= 24`)
  db.rawExec(`
    CREATE TABLE session_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      score INTEGER NOT NULL,
      reasons_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT,
      promoted_memory_id INTEGER REFERENCES memories(id),
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_journal_status ON session_journal(status, expires_at);
    CREATE UNIQUE INDEX idx_journal_session_hash ON session_journal(session_id, content_hash);
    CREATE TABLE session_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      snapshot_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE sessions ADD COLUMN harvest_text TEXT;
    DROP TABLE message_uuids;
    CREATE TABLE message_uuids (
      uuid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_message_uuids_session ON message_uuids(session_id);
  `)
  if (seedSql) db.rawExec(seedSql)
}

describe('v24 migration — fresh DB state', () => {
  it('new DB arrives at v24: no journal/checkpoints tables, no harvest_text, dual-hash message_uuids', () => {
    const db = new Database(path.join(tmpDir, 'fresh.db'))
    try {
      expect(db.getSchemaVersion()).toBeGreaterThanOrEqual(24)

      const tables = db.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      ).map(r => r.name)
      expect(tables).not.toContain('session_journal')
      expect(tables).not.toContain('session_checkpoints')

      const sessionCols = db.rawAll<{ name: string }>('PRAGMA table_info(sessions)').map(c => c.name)
      expect(sessionCols).not.toContain('harvest_text')

      const uuidCols = db.rawAll<{ name: string }>('PRAGMA table_info(message_uuids)').map(c => c.name)
      expect(uuidCols.sort()).toEqual(['session_hash', 'uuid_hash'])

      const idxs = db.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_message_uuids_session'",
      )
      expect(idxs).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe('v24 migration — upgrade from simulated v23', () => {
  it('drops journal/checkpoints (incl. pending rows), drops harvest_text, rehashes message_uuids', () => {
    const dbPath = path.join(tmpDir, 'upgrade.db')

    const dbA = new Database(dbPath)
    dbA.upsertProject('p1', '/p1')
    dbA.rawExec(`
      INSERT INTO sessions (id, project_id, title, file_path, message_count, file_mtime, started_at)
      VALUES ('s1', 'p1', 'v24 upgrade', '/tmp/u.jsonl', 2, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    `)
    rewindToV23(dbA, `
      UPDATE sessions SET harvest_text = 'stale harvest blob' WHERE id = 's1';
      INSERT INTO session_journal (session_id, content, content_hash, score) VALUES
        ('s1', 'pending DLQ entry 1', 'hash-1', 0),
        ('s1', 'pending DLQ entry 2', 'hash-2', 1);
      INSERT INTO session_checkpoints (session_id, project_id, snapshot_text) VALUES
        ('s1', 'p1', 'checkpoint blob');
      INSERT INTO message_uuids (uuid, session_id) VALUES
        ('uuid-aaa', 's1'),
        ('uuid-bbb', 's1');
    `)
    expect(dbA.getSchemaVersion()).toBe(23)
    dbA.close()

    const dbB = new Database(dbPath)
    try {
      expect(dbB.getSchemaVersion()).toBe(24)

      const tables = dbB.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      ).map(r => r.name)
      expect(tables).not.toContain('session_journal')
      expect(tables).not.toContain('session_checkpoints')

      const sessionCols = dbB.rawAll<{ name: string }>('PRAGMA table_info(sessions)').map(c => c.name)
      expect(sessionCols).not.toContain('harvest_text')
      // Other session data survives the column drop
      expect(dbB.getSessionById('s1')?.title).toBe('v24 upgrade')

      // Rehash preserved every row: compare hashes SQL-side (rawAll has no
      // safeIntegers — a hash read into JS here would be lossy).
      for (const uuid of ['uuid-aaa', 'uuid-bbb']) {
        const hit = dbB.rawAll<{ c: number }>(
          `SELECT COUNT(*) AS c FROM message_uuids
           WHERE uuid_hash = ${hash64(uuid)} AND session_hash = ${hash64('s1')}`,
        )[0].c
        expect(hit, uuid).toBe(1)
      }
      expect(dbB.rawAll<{ c: number }>('SELECT COUNT(*) AS c FROM message_uuids')[0].c).toBe(2)
    } finally {
      dbB.close()
    }
  })

  it('dedup semantics survive the rehash: getExistingUuids still hits pre-migration rows', () => {
    const dbPath = path.join(tmpDir, 'dedup.db')

    const dbA = new Database(dbPath)
    dbA.upsertProject('p1', '/p1')
    dbA.rawExec(`
      INSERT INTO sessions (id, project_id, title, file_path, message_count, file_mtime, started_at)
      VALUES ('old-sess', 'p1', 'old', '/tmp/o.jsonl', 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    `)
    rewindToV23(dbA, `
      INSERT INTO message_uuids (uuid, session_id) VALUES ('replayed-uuid', 'old-sess');
    `)
    dbA.close()

    const dbB = new Database(dbPath)
    try {
      // A resumed session replaying the same uuid must be filtered out.
      const hits = dbB.getExistingUuids(['replayed-uuid', 'fresh-uuid'], 'new-sess')
      expect(hits.has('replayed-uuid')).toBe(true)
      expect(hits.has('fresh-uuid')).toBe(false)
      // Same uuid queried from its owning session is NOT a replay.
      const own = dbB.getExistingUuids(['replayed-uuid'], 'old-sess')
      expect(own.size).toBe(0)
    } finally {
      dbB.close()
    }
  })

  it('is idempotent for a repaired DB already in dual-hash shape (rebuild skipped, no throw)', () => {
    const dbPath = path.join(tmpDir, 'repaired.db')

    const dbA = new Database(dbPath)
    // Simulate: v23 DB whose message_uuids went missing and was recreated by
    // initSchema in the final dual-hash shape before v24 ran.
    dbA.rawExec(`DELETE FROM schema_version WHERE version >= 24`)
    dbA.rawExec(`ALTER TABLE sessions ADD COLUMN harvest_text TEXT`)
    dbA.close()

    const dbB = new Database(dbPath)
    try {
      expect(dbB.getSchemaVersion()).toBe(24)
      const uuidCols = dbB.rawAll<{ name: string }>('PRAGMA table_info(message_uuids)').map(c => c.name)
      expect(uuidCols.sort()).toEqual(['session_hash', 'uuid_hash'])
      const sessionCols = dbB.rawAll<{ name: string }>('PRAGMA table_info(sessions)').map(c => c.name)
      expect(sessionCols).not.toContain('harvest_text')
    } finally {
      dbB.close()
    }
  })
})

describe('v24 dual-hash — BigInt read-back regression (plan-critic catch)', () => {
  // better-sqlite3 without .safeIntegers(true) returns INTEGER > 2^53 as a
  // lossy JS number; the Map<bigint,string> reverse lookup in getExistingUuids
  // would then miss EVERY row and dedup would silently die. Pin a uuid whose
  // hash magnitude exceeds 2^53 and assert the round-trip still dedups.
  function findUuidWithHugeHash(prefix: string): string {
    for (let i = 0; i < 10_000; i++) {
      const candidate = `${prefix}-${i}`
      const h = hash64(candidate)
      if (h > 2n ** 53n || h < -(2n ** 53n)) return candidate
    }
    throw new Error('no candidate found — statistically impossible')
  }

  it('getExistingUuids dedups a uuid whose hash exceeds 2^53', () => {
    const db = new Database(path.join(tmpDir, 'bigint.db'))
    try {
      const hugeUuid = findUuidWithHugeHash('huge')
      expect(hash64(hugeUuid) > 2n ** 53n || hash64(hugeUuid) < -(2n ** 53n)).toBe(true)

      db.upsertProject('p1', '/p1')
      db.indexSession({
        sessionId: 'owner-sess', projectId: 'p1', projectDisplayName: '/p1',
        title: null, messageCount: 1, filePath: '/tmp/b.jsonl', fileSize: 0,
        fileMtime: '2024-01-01T00:00:00.000Z', startedAt: null, endedAt: null,
        messages: [mkMsg(hugeUuid, 0)],
      })

      const hits = db.getExistingUuids([hugeUuid], 'other-sess')
      expect(hits.has(hugeUuid)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('indexSession reindex + deleteSubagentSession clear registrations manually (no FK cascade)', () => {
    const db = new Database(path.join(tmpDir, 'manual-cascade.db'))
    try {
      db.upsertProject('p1', '/p1')
      const params = {
        sessionId: 'sess-mc', projectId: 'p1', projectDisplayName: '/p1',
        title: null, messageCount: 2, filePath: '/tmp/mc.jsonl', fileSize: 0,
        fileMtime: '2024-01-01T00:00:00.000Z', startedAt: null, endedAt: null,
        messages: [mkMsg('mc-u1', 0), mkMsg('mc-u2', 1)],
      }
      db.indexSession(params)
      expect(db.rawAll<{ c: number }>(
        `SELECT COUNT(*) AS c FROM message_uuids WHERE session_hash = ${hash64('sess-mc')}`,
      )[0].c).toBe(2)

      // Reindex with fewer messages — stale registration must not survive.
      db.indexSession({ ...params, messageCount: 1, messages: [mkMsg('mc-u1', 0)] })
      expect(db.rawAll<{ c: number }>(
        `SELECT COUNT(*) AS c FROM message_uuids WHERE session_hash = ${hash64('sess-mc')}`,
      )[0].c).toBe(1)

      // Subagent delete path clears its registrations too. Distinct uuids —
      // mc-u1/mc-u2 are already owned by sess-mc (first-writer-wins), so
      // reusing them here would register at most one row.
      db.indexSession({
        ...params, sessionId: 'sub-mc', filePath: '/tmp/sub-mc.jsonl',
        messages: [mkMsg('sub-u1', 0), mkMsg('sub-u2', 1)],
      })
      db.rawExec(`INSERT INTO subagent_sessions (id, parent_session_id, file_path) VALUES ('sub-mc', 'sess-mc', '/tmp/sub-mc.jsonl')`)
      expect(db.rawAll<{ c: number }>(
        `SELECT COUNT(*) AS c FROM message_uuids WHERE session_hash = ${hash64('sub-mc')}`,
      )[0].c).toBe(2)

      db.deleteSubagentSession('sub-mc')
      expect(db.rawAll<{ c: number }>(
        `SELECT COUNT(*) AS c FROM message_uuids WHERE session_hash = ${hash64('sub-mc')}`,
      )[0].c).toBe(0)
    } finally {
      db.close()
    }
  })
})
