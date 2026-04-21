// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { cleanupOrphans } from '../src/cli/cleanup'

let tmpDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-cleanup-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

/** Seed a session + an orphan memory referencing a sibling session that is
 *  deleted afterward (simulating manual DELETE / test fixture / race). */
function seedOrphan(): void {
  db.upsertProject('p1', '/p1')
  db.indexSession({
    sessionId: 'ghost', projectId: 'p1', projectDisplayName: '/p1',
    title: null, messageCount: 0, filePath: '/tmp/g.jsonl', fileSize: 0,
    fileMtime: '2024-01-01T00:00:00.000Z', startedAt: null, endedAt: null,
    messages: [],
  })
  db.saveMemory({ content: 'orphan-memo', type: 'decision', sessionId: 'ghost', messageId: null })
  db.rawExec("DELETE FROM sessions WHERE id = 'ghost'")
}

describe('cleanupOrphans', () => {
  it('reports 0 when DB has no memories', async () => {
    const n = await cleanupOrphans(db, { yes: false, skipReconcile: true })
    expect(n).toBe(0)
  })

  it('reports 0 when all memories reference live sessions', async () => {
    db.upsertProject('p1', '/p1')
    db.indexSession({
      sessionId: 'live', projectId: 'p1', projectDisplayName: '/p1',
      title: null, messageCount: 0, filePath: '/tmp/l.jsonl', fileSize: 0,
      fileMtime: '2024-01-01T00:00:00.000Z', startedAt: null, endedAt: null,
      messages: [],
    })
    db.saveMemory({ content: 'linked', type: 'decision', sessionId: 'live', messageId: null })

    const n = await cleanupOrphans(db, { yes: false, skipReconcile: true })
    expect(n).toBe(0)

    const remaining = db.rawAll<{ c: number }>("SELECT COUNT(*) AS c FROM memories").at(0)?.c
    expect(remaining).toBe(1)
  })

  it('dry run lists orphans without deleting', async () => {
    seedOrphan()

    const n = await cleanupOrphans(db, { yes: false, skipReconcile: true })
    expect(n).toBe(0) // 0 deleted in dry run

    const remaining = db.rawAll<{ c: number }>("SELECT COUNT(*) AS c FROM memories WHERE content = 'orphan-memo'").at(0)?.c
    expect(remaining).toBe(1)
  })

  it('--yes with assumeConfirmed deletes orphans in a single transaction', async () => {
    seedOrphan()
    db.saveMemory({ content: 'manual-keeper', type: 'decision', sessionId: null, messageId: null })

    const n = await cleanupOrphans(db, { yes: true, skipReconcile: true, assumeConfirmed: true })
    expect(n).toBe(1)

    const orphanGone = db.rawAll<{ c: number }>("SELECT COUNT(*) AS c FROM memories WHERE content = 'orphan-memo'").at(0)?.c
    expect(orphanGone).toBe(0)

    // null-session manual memory 不被動
    const manualStays = db.rawAll<{ c: number }>("SELECT COUNT(*) AS c FROM memories WHERE content = 'manual-keeper'").at(0)?.c
    expect(manualStays).toBe(1)
  })

  it('ignores memories with null session_id even when --yes', async () => {
    db.saveMemory({ content: 'manual', type: 'decision', sessionId: null, messageId: null })
    const n = await cleanupOrphans(db, { yes: true, skipReconcile: true, assumeConfirmed: true })
    expect(n).toBe(0)
    expect(db.rawAll<{ c: number }>("SELECT COUNT(*) AS c FROM memories").at(0)?.c).toBe(1)
  })
})
