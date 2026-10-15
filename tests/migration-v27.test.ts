// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises'
import BetterSqlite3 from 'better-sqlite3'
import { Database } from '../src/core/database'
import { runIndexer } from '../src/core/indexer'

/**
 * v27 — Claude Code 2.1.300 writes request-replay records (api-request,
 * api-request-shape, api-request-blob) into transcripts, and the parser before
 * this release indexed every one of them as a message. The parser fix stops new
 * damage; this migration is what repairs the sessions already indexed. Nothing
 * else would: the indexer only re-reads a session whose file changed, and a
 * finished session's file never changes again.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'api-request-records.jsonl')

let tmpDir: string
let dbPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-v27-'))
  dbPath = path.join(tmpDir, 'test.db')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** Rewind to before v27 and reopen, so the migration runs against whatever the test left in the DB.
 *  `>=`, not `=`: the runner skips every migration at or below MAX(version). */
function rerunV27(): Database {
  const raw = new BetterSqlite3(dbPath)
  raw.exec('DELETE FROM schema_version WHERE version >= 27')
  raw.close()
  return new Database(dbPath)
}

describe('migration v27', () => {
  it('clears file_mtime only where ended_at is on or after 2026-10-14 (UTC), in both session tables', () => {
    new Database(dbPath).close()

    const raw = new BetterSqlite3(dbPath)
    raw.exec("INSERT INTO projects (id, display_name) VALUES ('p', 'p')")
    const addSession = raw.prepare(
      "INSERT INTO sessions (id, project_id, file_path, file_mtime, ended_at) VALUES (?, 'p', ?, ?, ?)",
    )
    for (const [id, endedAt] of [
      ['before', '2026-10-13T23:59:59.999Z'],
      ['on', '2026-10-14T00:00:00.000Z'],
      ['after', '2026-10-15T05:59:22.329Z'],
      ['no-end', null],
    ] as const) {
      addSession.run(id, `/x/${id}.jsonl`, `mtime-${id}`, endedAt)
    }
    const addSubagent = raw.prepare(
      "INSERT INTO subagent_sessions (id, parent_session_id, file_path, file_mtime, ended_at) VALUES (?, 'after', ?, ?, ?)",
    )
    addSubagent.run('after/agent-before', '/x/b.jsonl', 'mtime-agent-before', '2026-10-13T23:59:59.999Z')
    addSubagent.run('after/agent-on', '/x/o.jsonl', 'mtime-agent-on', '2026-10-14T00:00:00.000Z')
    addSubagent.run('after/agent-after', '/x/a.jsonl', 'mtime-agent-after', '2026-10-15T05:18:57.632Z')
    raw.close()

    const db = rerunV27()
    expect(db.rawAll('SELECT id, file_mtime FROM sessions ORDER BY id')).toEqual([
      { id: 'after', file_mtime: null },
      { id: 'before', file_mtime: 'mtime-before' },
      { id: 'no-end', file_mtime: 'mtime-no-end' },
      { id: 'on', file_mtime: null },
    ])
    expect(db.rawAll('SELECT id, file_mtime FROM subagent_sessions ORDER BY id')).toEqual([
      { id: 'after/agent-after', file_mtime: null },
      { id: 'after/agent-before', file_mtime: 'mtime-agent-before' },
      { id: 'after/agent-on', file_mtime: null },
    ])
    db.close()
  })

  it('lets the indexer repair a session and a subagent the old parser inflated', async () => {
    const projectDir = path.join(tmpDir, 'projects', '-Users-test-proj')
    await mkdir(path.join(projectDir, 's-api', 'subagents'), { recursive: true })
    await copyFile(FIXTURE, path.join(projectDir, 's-api.jsonl'))
    await copyFile(FIXTURE, path.join(projectDir, 's-api', 'subagents', 'agent-x.jsonl'))
    const baseDir = path.join(tmpDir, 'projects')
    const counts = (db: Database) => db.rawAll<{ id: string; message_count: number }>(`
      SELECT id, message_count FROM sessions
      UNION ALL SELECT 'subagent_sessions:' || id, message_count FROM subagent_sessions
      ORDER BY 1
    `)

    const db = new Database(dbPath)
    await runIndexer(db, undefined, baseDir)
    expect(counts(db)).toEqual([
      { id: 's-api', message_count: 2 },
      { id: 's-api/agent-x', message_count: 2 },
      { id: 'subagent_sessions:s-api/agent-x', message_count: 2 },
    ])

    // What the old parser left behind: all 7 lines counted as messages. The files
    // are untouched, so their mtimes still match and a plain re-run skips them.
    db.rawExec('UPDATE sessions SET message_count = 7')
    db.rawExec('UPDATE subagent_sessions SET message_count = 7')
    await runIndexer(db, undefined, baseDir)
    expect(counts(db).map(r => r.message_count)).toEqual([7, 7, 7])
    db.close()

    const migrated = rerunV27()
    await runIndexer(migrated, undefined, baseDir)
    expect(counts(migrated).map(r => r.message_count)).toEqual([2, 2, 2])
    migrated.close()
  })
})
