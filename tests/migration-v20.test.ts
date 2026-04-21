// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import BetterSqlite3 from 'better-sqlite3'
import { Database } from '../src/core/database'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-mig20-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** Rewind a fresh-migrated DB back to a simulated v19 state by restoring the
 *  4 legacy tables + triggers and removing the v20 schema_version row. The
 *  on-disk result mirrors what an existing v0.1.7 user's DB looks like before
 *  upgrading to 0.2.0. */
function rewindToV19(db: Database, seedSql?: string): void {
  db.rawExec(`DELETE FROM schema_version WHERE version = 20`)
  db.rawExec(`DROP TABLE message_uuids`)
  db.rawExec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL,
      role TEXT,
      content_text TEXT,
      has_tool_use INTEGER DEFAULT 0,
      has_tool_result INTEGER DEFAULT 0,
      tool_names TEXT,
      timestamp TEXT,
      sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      model TEXT, uuid TEXT
    );
    CREATE INDEX idx_messages_session ON messages(session_id, sequence);
    CREATE INDEX idx_messages_uuid ON messages(uuid);
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content_text, content='messages', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
    END;
    CREATE TABLE message_content (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      content_json TEXT
    );
    CREATE TABLE message_archive (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      raw_json TEXT
    );
  `)
  if (seedSql) db.rawExec(seedSql)
}

describe('v20 migration — fresh DB state', () => {
  it('new DB arrives at v20 with message_uuids and no legacy message tables', () => {
    const db = new Database(path.join(tmpDir, 'fresh.db'))
    try {
      expect(db.getSchemaVersion()).toBe(20)

      const tables = db.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).map(r => r.name)
      expect(tables).toContain('message_uuids')
      expect(tables).not.toContain('messages')
      expect(tables).not.toContain('messages_fts')
      expect(tables).not.toContain('message_content')
      expect(tables).not.toContain('message_archive')

      const triggers = db.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='trigger'",
      ).map(r => r.name)
      expect(triggers).not.toContain('messages_ai')
      expect(triggers).not.toContain('messages_ad')

      const idxs = db.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_message_uuids_session'",
      )
      expect(idxs).toHaveLength(1)

      const vrow = db.rawAll<{ description: string }>(
        "SELECT description FROM schema_version WHERE version = 20",
      )
      expect(vrow).toHaveLength(1)
      expect(vrow[0].description).toContain('message_uuids')
    } finally {
      db.close()
    }
  })

  it('no pre-v20 backup file is created for a brand-new DB', () => {
    const dbPath = path.join(tmpDir, 'new-no-backup.db')
    const db = new Database(dbPath)
    try {
      expect(existsSync(dbPath + '.pre-v20.bak')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('reopen does not resurrect dropped legacy tables (no schema drift)', () => {
    const dbPath = path.join(tmpDir, 'reopen.db')

    const db1 = new Database(dbPath)
    expect(db1.getSchemaVersion()).toBe(20)
    db1.close()

    // On reopen, initSchema re-runs. Legacy messages tables MUST stay dropped —
    // otherwise the destructive migration silently un-persists.
    const db2 = new Database(dbPath)
    try {
      const tables = db2.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).map(r => r.name)
      expect(tables).toContain('message_uuids')
      expect(tables).not.toContain('messages')
      expect(tables).not.toContain('messages_fts')
      expect(tables).not.toContain('message_content')
      expect(tables).not.toContain('message_archive')

      const triggers = db2.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='trigger'",
      ).map(r => r.name)
      expect(triggers).not.toContain('messages_ai')
      expect(triggers).not.toContain('messages_ad')

      expect(db2.getSchemaVersion()).toBe(20)
    } finally {
      db2.close()
    }
  })

  it('FK CASCADE: deleting a session clears its message_uuids rows', () => {
    const db = new Database(path.join(tmpDir, 'cascade.db'))
    try {
      db.upsertProject('p1', '/p1')
      db.indexSession({
        sessionId: 'sess-casc', projectId: 'p1', projectDisplayName: '/p1',
        title: null, messageCount: 2, filePath: '/tmp/c.jsonl', fileSize: 0,
        fileMtime: '2024-01-01T00:00:00.000Z', startedAt: null, endedAt: null,
        messages: [
          { uuid: 'c-u1', role: 'user', type: 'user', contentText: null, contentJson: null,
            hasToolUse: false, hasToolResult: false, toolNames: [], timestamp: null,
            sequence: 0, rawJson: null, inputTokens: null, outputTokens: null,
            cacheReadTokens: null, cacheCreationTokens: null, model: null },
          { uuid: 'c-a1', role: 'assistant', type: 'assistant', contentText: null, contentJson: null,
            hasToolUse: false, hasToolResult: false, toolNames: [], timestamp: null,
            sequence: 1, rawJson: null, inputTokens: null, outputTokens: null,
            cacheReadTokens: null, cacheCreationTokens: null, model: null },
        ],
      })
      expect(db.rawAll<{ c: number }>(
        "SELECT COUNT(*) AS c FROM message_uuids WHERE session_id = 'sess-casc'",
      )[0].c).toBe(2)

      db.rawExec("DELETE FROM sessions WHERE id = 'sess-casc'")

      expect(db.rawAll<{ c: number }>(
        "SELECT COUNT(*) AS c FROM message_uuids WHERE session_id = 'sess-casc'",
      )[0].c).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('v20 migration — upgrade from simulated v19', () => {
  it('happy path: creates backup, backfills message_uuids, drops legacy tables', () => {
    const dbPath = path.join(tmpDir, 'upgrade.db')

    const dbA = new Database(dbPath)
    dbA.upsertProject('p1', '/p1')
    dbA.rawExec(`
      INSERT INTO sessions (id, project_id, title, file_path, message_count, file_mtime, started_at)
      VALUES ('s1', 'p1', 'upgrade test', '/tmp/u.jsonl', 2, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    `)
    rewindToV19(dbA, `
      INSERT INTO messages (session_id, type, role, content_text, timestamp, sequence, uuid) VALUES
        ('s1', 'user', 'user', 'hello', '2024-01-01T00:00:00.000Z', 0, 'u1'),
        ('s1', 'assistant', 'assistant', 'hi', '2024-01-01T00:00:01.000Z', 1, 'a1');
    `)
    expect(dbA.getSchemaVersion()).toBe(19)
    dbA.close()

    const dbB = new Database(dbPath)
    try {
      expect(dbB.getSchemaVersion()).toBe(20)
      expect(existsSync(dbPath + '.pre-v20.bak')).toBe(true)

      const uuids = dbB.rawAll<{ uuid: string; session_id: string }>(
        'SELECT uuid, session_id FROM message_uuids ORDER BY uuid',
      )
      expect(uuids).toEqual([
        { uuid: 'a1', session_id: 's1' },
        { uuid: 'u1', session_id: 's1' },
      ])

      const tables = dbB.rawAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      ).map(r => r.name)
      expect(tables).not.toContain('messages')
      expect(tables).not.toContain('messages_fts')
      expect(tables).not.toContain('message_content')
      expect(tables).not.toContain('message_archive')
    } finally {
      dbB.close()
    }
  })

  it('backfill ordered by session age: earliest session owns shared uuid', () => {
    const dbPath = path.join(tmpDir, 'order.db')

    const dbA = new Database(dbPath)
    dbA.upsertProject('p1', '/p1')
    dbA.rawExec(`
      INSERT INTO sessions (id, project_id, title, file_path, message_count, file_mtime, started_at) VALUES
        ('older', 'p1', 'older', '/tmp/o.jsonl', 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'),
        ('newer', 'p1', 'newer', '/tmp/n.jsonl', 1, '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z');
    `)
    rewindToV19(dbA, `
      INSERT INTO messages (session_id, type, role, content_text, timestamp, sequence, uuid) VALUES
        ('newer', 'user', 'user', 'replay', '2024-02-01T00:00:00.000Z', 0, 'shared-uuid'),
        ('older', 'user', 'user', 'original', '2024-01-01T00:00:00.000Z', 0, 'shared-uuid');
    `)
    dbA.close()

    const dbB = new Database(dbPath)
    try {
      const row = dbB.rawAll<{ session_id: string }>(
        "SELECT session_id FROM message_uuids WHERE uuid = 'shared-uuid'",
      )
      expect(row).toHaveLength(1)
      expect(row[0].session_id).toBe('older')
    } finally {
      dbB.close()
    }
  })

  it('aborts with clear error when backfill is incomplete', () => {
    const dbPath = path.join(tmpDir, 'abort.db')

    const dbA = new Database(dbPath)
    dbA.upsertProject('p1', '/p1')
    dbA.rawExec(`
      INSERT INTO sessions (id, project_id, title, file_path, message_count, file_mtime, started_at)
      VALUES ('real-s1', 'p1', 'r', '/tmp/r.jsonl', 2, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    `)
    // Rewind to a corrupt state: one message row points to a session_id that does
    // not exist in `sessions`, so the backfill JOIN drops it and the count check trips.
    dbA.rawExec(`DELETE FROM schema_version WHERE version = 20`)
    dbA.rawExec(`DROP TABLE message_uuids`)
    dbA.rawExec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        uuid TEXT,
        sequence INTEGER NOT NULL,
        timestamp TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO messages (session_id, uuid, sequence, timestamp) VALUES
        ('real-s1', 'u1', 0, '2024-01-01T00:00:00.000Z'),
        ('real-s1', 'u2', 1, '2024-01-01T00:00:01.000Z'),
        ('ghost-s1', 'u3', 0, '2024-01-01T00:00:02.000Z');
    `)
    dbA.close()

    expect(() => new Database(dbPath)).toThrow(/v20 UUID backfill count mismatch/)

    // Rollback verification via raw SQLite: v20 row absent, message_uuids absent,
    // messages table still present (the throw undid v20's transaction).
    const raw = new BetterSqlite3(dbPath, { readonly: true })
    try {
      const maxV = (raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
      expect(maxV).toBe(19)
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      const names = tables.map(t => t.name)
      expect(names).toContain('messages')
      expect(names).not.toContain('message_uuids')
    } finally {
      raw.close()
    }
  })
})
