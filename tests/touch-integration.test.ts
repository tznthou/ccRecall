// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Database } from '../src/core/database.js'
import { MemoryService } from '../src/core/memory-service.js'
import { recallQueryHandler, recallContextHandler } from '../src/mcp/tools.js'
import { sessionParams } from './fixtures/helpers.js'

let tmpDir: string
let db: Database
let svc: MemoryService

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ccrecall-touch-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  svc = new MemoryService(db)
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function accessCount(id: number): number {
  return db.rawAll<{ access_count: number }>(
    `SELECT access_count FROM memories WHERE id = ${id}`,
  )[0].access_count
}

describe('recallQueryHandler — touch integration', () => {
  it('increments access_count for every returned memory', () => {
    const id1 = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'alpha one',
    })
    const id2 = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'alpha two',
    })
    expect(accessCount(id1)).toBe(0)
    expect(accessCount(id2)).toBe(0)

    recallQueryHandler(db, svc, { query: 'alpha' })

    expect(accessCount(id1)).toBe(1)
    expect(accessCount(id2)).toBe(1)
  })

  it('does not touch memories that were not surfaced', () => {
    const surfacedId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'beta matched',
    })
    const untouchedId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'gamma unmatched',
    })
    recallQueryHandler(db, svc, { query: 'beta' })
    expect(accessCount(surfacedId)).toBe(1)
    expect(accessCount(untouchedId)).toBe(0)
  })

  it('touches same memory twice on separate calls', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'repeated',
    })
    recallQueryHandler(db, svc, { query: 'repeated' })
    recallQueryHandler(db, svc, { query: 'repeated' })
    expect(accessCount(id)).toBe(2)
  })

  it('noops on empty result set (touch never called)', () => {
    // No memories at all — handler should not throw.
    expect(() => recallQueryHandler(db, svc, { query: 'nothing' })).not.toThrow()
  })
})

describe('recallContextHandler — touch + dedup across clusters', () => {
  beforeEach(() => {
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'sess-1', projectId: 'proj-a' }))
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript', 'mcp'])
  })

  it('touches a memory only once even if it appears in multiple clusters', () => {
    const shared = db.saveMemory({
      sessionId: 'sess-1', messageId: null, type: 'pattern',
      content: 'shared cross-topic memory',
    })
    // Link the same memory to BOTH topics — it will surface in two clusters.
    db.saveMemoryTopics(shared, 'proj-a', ['typescript', 'mcp'])
    db.rebuildKnowledgeMap('proj-a')

    const r = recallContextHandler(db, svc, {
      projectId: 'proj-a', keywords: ['typescript', 'mcp'],
    })
    // Confirm the memory really appears in both clusters of the rendered output.
    expect(r.content[0].text).toContain('## Topic: typescript')
    expect(r.content[0].text).toContain('## Topic: mcp')

    // Dedup proof: access_count bumped by 1, not 2.
    expect(accessCount(shared)).toBe(1)
  })

  it('touches each distinct memory exactly once across clusters', () => {
    const a = db.saveMemory({
      sessionId: 'sess-1', messageId: null, type: 'decision', content: 'only typescript',
    })
    const b = db.saveMemory({
      sessionId: 'sess-1', messageId: null, type: 'decision', content: 'only mcp',
    })
    const c = db.saveMemory({
      sessionId: 'sess-1', messageId: null, type: 'decision', content: 'both topics',
    })
    db.saveMemoryTopics(a, 'proj-a', ['typescript'])
    db.saveMemoryTopics(b, 'proj-a', ['mcp'])
    db.saveMemoryTopics(c, 'proj-a', ['typescript', 'mcp'])
    db.rebuildKnowledgeMap('proj-a')

    recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['typescript', 'mcp'] })

    expect(accessCount(a)).toBe(1)
    expect(accessCount(b)).toBe(1)
    expect(accessCount(c)).toBe(1)
  })

  it('touches fallback-path memories when no topic matches', () => {
    const id = db.saveMemory({
      sessionId: 'sess-1', messageId: null, type: 'decision',
      content: 'orphan keyword xenon',
    })
    // No topics → recall_context falls back to per-keyword FTS.
    db.rebuildKnowledgeMap('proj-a')

    const r = recallContextHandler(db, svc, {
      projectId: 'proj-a', keywords: ['xenon'],
    })
    expect(r.content[0].text).toContain('FTS fallback')
    expect(accessCount(id)).toBe(1)
  })
})
