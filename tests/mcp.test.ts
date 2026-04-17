import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Database } from '../src/core/database.js'
import { MemoryService } from '../src/core/memory-service.js'
import type { Memory } from '../src/core/types.js'
import { recallQueryHandler, recallSaveHandler, formatMemories, recallContextHandler } from '../src/mcp/tools.js'
import { sessionParams } from './fixtures/helpers.js'

describe('MCP recall_query handler', () => {
  let tmpDir: string
  let db: Database
  let svc: MemoryService

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ccrecall-mcp-test-'))
    db = new Database(path.join(tmpDir, 'test.db'))
    svc = new MemoryService(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty-result message when no memories match', () => {
    const result = recallQueryHandler(db, svc, { query: 'nonexistent' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('No memories found')
  })

  it('returns formatted memory on hit', () => {
    db.saveMemory({
      sessionId: null,
      messageId: null,
      content: 'Use Apache-2.0 license for ccRecall',
      type: 'decision',
      confidence: 0.9,
    })
    const result = recallQueryHandler(db, svc, { query: 'Apache' })
    expect(result.content[0].text).toContain('[decision]')
    expect(result.content[0].text).toContain('Apache-2.0')
    expect(result.content[0].text).toContain('conf 0.90')
  })

  it('honors limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      db.saveMemory({
        sessionId: null,
        messageId: null,
        content: `test memory ${i} apache`,
        type: 'discovery',
        confidence: 1,
      })
    }
    const result = recallQueryHandler(db, svc, { query: 'apache', limit: 2 })
    const lines = result.content[0].text.split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
  })

  it('defaults limit to 10 when not provided', () => {
    for (let i = 0; i < 15; i++) {
      db.saveMemory({
        sessionId: null,
        messageId: null,
        content: `memory ${i} keyword`,
        type: 'pattern',
        confidence: 1,
      })
    }
    const result = recallQueryHandler(db, svc, { query: 'keyword' })
    const lines = result.content[0].text.split('\n').filter(Boolean)
    expect(lines.length).toBe(10)
  })
})

describe('formatMemories', () => {
  const baseMemory: Memory = {
    id: 1,
    sessionId: null,
    messageId: null,
    content: 'sample content',
    type: 'decision',
    confidence: 1,
    createdAt: '2026-04-17T00:00:00Z',
  }

  it('shows confidence when not 1', () => {
    const text = formatMemories([{ ...baseMemory, confidence: 0.85 }], 'q')
    expect(text).toBe('- [decision] (conf 0.85) sample content')
  })

  it('omits confidence when equal to 1', () => {
    const text = formatMemories([{ ...baseMemory, type: 'pattern' }], 'q')
    expect(text).toBe('- [pattern] sample content')
  })

  it('returns empty-result message for empty array', () => {
    expect(formatMemories([], 'missing')).toBe('No memories found for: missing')
  })
})

describe('MCP recall_save handler', () => {
  let tmpDir: string
  let db: Database
  let svc: MemoryService

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ccrecall-mcp-save-'))
    db = new Database(path.join(tmpDir, 'test.db'))
    svc = new MemoryService(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('saves a memory and returns confirmation with id', () => {
    const result = recallSaveHandler(db, {
      content: 'ccRecall uses Apache-2.0 license',
      type: 'decision',
      confidence: 0.95,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toMatch(/Saved memory #\d+ \(type: decision\)/)
  })

  it('defaults confidence to 1 when not provided', () => {
    recallSaveHandler(db, { content: 'default conf test content', type: 'pattern' })
    const memories = db.queryMemories('default', 10)
    expect(memories).toHaveLength(1)
    expect(memories[0].confidence).toBe(1)
  })

  it('accepts null sessionId and messageId', () => {
    const result = recallSaveHandler(db, {
      content: 'orphan memory without origin',
      type: 'discovery',
      sessionId: null,
      messageId: null,
    })
    expect(result.isError).toBeUndefined()
  })

  it('persists memory queryable via recallQueryHandler', () => {
    recallSaveHandler(db, { content: 'searchable via mcp tool', type: 'discovery' })
    const result = recallQueryHandler(db, svc, { query: 'searchable' })
    expect(result.content[0].text).toContain('searchable via mcp tool')
    expect(result.content[0].text).toContain('[discovery]')
  })
})

describe('MCP recall_context handler', () => {
  let tmpDir: string
  let db: Database
  let svc: MemoryService

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ccrecall-mcp-ctx-'))
    db = new Database(path.join(tmpDir, 'test.db'))
    svc = new MemoryService(db)
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'sess-1', projectId: 'proj-a' }))
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript', 'mcp', 'sqlite'])
    const m1 = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: 'use vitest', type: 'decision', confidence: 0.9 })
    const m2 = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: 'prefer FTS5', type: 'pattern' })
    db.saveMemoryTopics(m1, 'proj-a', ['typescript'])
    db.saveMemoryTopics(m2, 'proj-a', ['sqlite'])
    db.rebuildKnowledgeMap('proj-a')
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns clusters for matched topics', () => {
    const r = recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['typescript', 'sqlite'] })
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toContain('## Topic: typescript')
    expect(r.content[0].text).toContain('## Topic: sqlite')
    expect(r.content[0].text).toContain('use vitest')
    expect(r.content[0].text).toContain('prefer FTS5')
  })

  it('shows depth label based on mention count', () => {
    const r = recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['typescript'] })
    // typescript: 1 session mention + 1 memory mention = 2 → medium
    expect(r.content[0].text).toContain('medium,')
  })

  it('reports unmatched keywords', () => {
    const r = recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['typescript', 'unknownxyz'] })
    expect(r.content[0].text).toContain('## Topic: typescript')
    expect(r.content[0].text).toContain('No topic match for: unknownxyz')
  })

  it('falls back to FTS when no topic matches', () => {
    const r = recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['vitest'] })
    // vitest 不是 topic，但 memory content 包含 "vitest"
    expect(r.content[0].text).toContain('FTS fallback')
    expect(r.content[0].text).toContain('use vitest')
  })

  it('returns empty-result message when nothing matches at all', () => {
    const r = recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['absolutelyzzzzz'] })
    expect(r.content[0].text).toContain('No relevant memories')
  })

  it('respects project isolation', () => {
    db.upsertProject('proj-b', 'Project B')
    const r = recallContextHandler(db, svc, { projectId: 'proj-b', keywords: ['typescript'] })
    // proj-b has no topics at all, no memories → should be empty or fallback empty
    expect(r.content[0].text).toContain('No relevant memories')
  })

  it('normalizes keywords (e.g. TypeScript → typescript)', () => {
    const r = recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['TypeScript'] })
    expect(r.content[0].text).toContain('## Topic: typescript')
  })

  it('respects memoryLimit', () => {
    // 先清掉原本的 memories 與 topics，避免干擾
    db.rawExec("DELETE FROM memories; DELETE FROM memory_topics")
    for (let i = 0; i < 10; i++) {
      const mid = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: `mem ${i} content`, type: 'decision' })
      db.saveMemoryTopics(mid, 'proj-a', ['typescript'])
    }
    db.rebuildKnowledgeMap('proj-a')
    const r = recallContextHandler(db, svc, { projectId: 'proj-a', keywords: ['typescript'], memoryLimit: 3 })
    const memLines = r.content[0].text.split('\n').filter(l => l.startsWith('- ['))
    expect(memLines.length).toBe(3)
  })
})
