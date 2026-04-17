import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { runLint } from '../src/core/lint'

let tmpDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-lint-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  db.upsertProject('proj-x', 'X')
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function addSession(id: string): void {
  db.rawExec(`
    INSERT INTO sessions (id, project_id, file_path) VALUES ('${id}', 'proj-x', '/tmp/${id}.jsonl')
  `)
}

describe('runLint — orphan detection', () => {
  it('flags memory whose session_id no longer exists', () => {
    addSession('ghost')
    const id = db.saveMemory({
      sessionId: 'ghost', messageId: null, type: 'decision', content: 'orphan-me',
    })
    db.rawExec(`DELETE FROM sessions WHERE id = 'ghost'`)

    const report = runLint(db)
    expect(report.counts.orphan).toBe(1)
    const w = report.warnings.find(x => x.kind === 'orphan')
    expect(w?.memoryId).toBe(id)
    expect(w?.details).toContain('ghost')
  })

  it('does NOT flag session-backed memory whose session still exists', () => {
    addSession('alive')
    db.saveMemory({
      sessionId: 'alive', messageId: null, type: 'decision', content: 'still-valid',
    })
    const report = runLint(db)
    expect(report.counts.orphan).toBe(0)
  })

  it('does NOT flag manual memory (session_id = NULL is not an orphan)', () => {
    db.saveMemory({
      sessionId: null, messageId: null, type: 'preference', content: 'manual rule',
    })
    const report = runLint(db)
    expect(report.counts.orphan).toBe(0)
  })
})

describe('runLint — stale detection', () => {
  it('flags memory with effective < 0.1, access = 0, age > 90d', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'forgotten',
      confidence: 1,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-120 days') WHERE id = ${id}`)

    const report = runLint(db)
    expect(report.counts.stale).toBe(1)
    const w = report.warnings.find(x => x.kind === 'stale')
    expect(w?.memoryId).toBe(id)
  })

  it('does NOT flag memory with any access_count (still referenced)', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'used',
      confidence: 1,
    })
    db.rawExec(`
      UPDATE memories SET created_at = datetime('now', '-120 days'), access_count = 1 WHERE id = ${id}
    `)

    const report = runLint(db)
    expect(report.counts.stale).toBe(0)
  })

  it('does NOT flag memory under 90 days old', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'recent',
      confidence: 0.1,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-60 days') WHERE id = ${id}`)
    const report = runLint(db)
    expect(report.counts.stale).toBe(0)
  })

  it('boundary: age = 89d is NOT stale (age gate requires > 90)', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'near-edge',
      confidence: 1,
    })
    db.rawExec(`
      UPDATE memories SET created_at = datetime('now', '-89 days'), access_count = 0 WHERE id = ${id}
    `)
    const report = runLint(db)
    expect(report.counts.stale).toBe(0)
  })
})

describe('runLint — edge cases and aggregation', () => {
  it('returns empty report when no issues', () => {
    addSession('ok')
    db.saveMemory({ sessionId: 'ok', messageId: null, type: 'decision', content: 'ok' })
    const report = runLint(db)
    expect(report.counts.total).toBe(0)
    expect(report.warnings).toEqual([])
  })

  it('memory can carry both orphan and stale warnings simultaneously', () => {
    addSession('both')
    const id = db.saveMemory({
      sessionId: 'both', messageId: null, type: 'decision', content: 'double',
      confidence: 1,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-120 days') WHERE id = ${id}`)
    db.rawExec(`DELETE FROM sessions WHERE id = 'both'`)

    const report = runLint(db)
    const forMem = report.warnings.filter(w => w.memoryId === id)
    const kinds = forMem.map(w => w.kind).sort()
    expect(kinds).toEqual(['orphan', 'stale'])
    expect(report.counts.total).toBe(2)
  })

  it('sorts warnings by memory_id ascending', () => {
    const id1 = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'a', confidence: 1,
    })
    const id2 = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'b', confidence: 1,
    })
    db.rawExec(`
      UPDATE memories SET created_at = datetime('now', '-120 days') WHERE id IN (${id1}, ${id2})
    `)
    const report = runLint(db)
    const ids = report.warnings.map(w => w.memoryId)
    // non-decreasing order
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThanOrEqual(ids[i - 1])
    }
  })
})
