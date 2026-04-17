// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'

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

  it('query with projectId=proj-A returns only A-scoped memories (session + manual)', () => {
    const results = db.queryMemories('alpha', 20, 'proj-A')
    const contents = results.map(r => r.content).sort()
    expect(contents).toEqual(['alpha manualA', 'alpha sessA'])
  })

  it('query with projectId=proj-B returns only B-scoped memories', () => {
    const results = db.queryMemories('alpha', 20, 'proj-B')
    const contents = results.map(r => r.content).sort()
    expect(contents).toEqual(['alpha manualB', 'alpha sessB'])
  })

  it('query without projectId returns everything including global', () => {
    const results = db.queryMemories('alpha', 20)
    expect(results.length).toBe(5)
  })

  it('manual memory without projectId (global) is excluded from per-project queries', () => {
    const a = db.queryMemories('alpha', 20, 'proj-A')
    const b = db.queryMemories('alpha', 20, 'proj-B')
    expect(a.map(r => r.content)).not.toContain('alpha global')
    expect(b.map(r => r.content)).not.toContain('alpha global')
  })
})
