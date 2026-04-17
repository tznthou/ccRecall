import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { sessionParams } from './fixtures/helpers.js'

let tmpDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-km-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('Phase 3a schema', () => {
  it('creates knowledge_map, session_topics, memory_topics, session_checkpoints tables', () => {
    const objs = db.rawAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    const names = objs.map(r => r.name)
    expect(names).toContain('knowledge_map')
    expect(names).toContain('session_topics')
    expect(names).toContain('memory_topics')
    expect(names).toContain('session_checkpoints')
  })

  it('knowledge_map has 4 columns only (minimal schema)', () => {
    const cols = db.rawAll<{ name: string }>("PRAGMA table_info(knowledge_map)")
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual(['last_touched', 'mention_count', 'project_id', 'topic_key'])
  })

  it('session_topics has no weight column (simplified)', () => {
    const cols = db.rawAll<{ name: string }>("PRAGMA table_info(session_topics)")
    const names = cols.map(c => c.name)
    expect(names).not.toContain('weight')
  })

  it('session_checkpoints has no topics_json column (simplified)', () => {
    const cols = db.rawAll<{ name: string }>("PRAGMA table_info(session_checkpoints)")
    const names = cols.map(c => c.name)
    expect(names).not.toContain('topics_json')
  })
})

describe('saveSessionTopics', () => {
  beforeEach(() => {
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'sess-1', projectId: 'proj-a' }))
  })

  it('inserts topics for a session', () => {
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript', 'sqlite'])
    const rows = db.rawAll<{ topic_key: string }>(
      "SELECT topic_key FROM session_topics WHERE session_id='sess-1' ORDER BY topic_key",
    )
    expect(rows.map(r => r.topic_key)).toEqual(['sqlite', 'typescript'])
  })

  it('replaces topics on reindex (idempotent — no double count)', () => {
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript', 'sqlite'])
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript', 'mcp'])
    const rows = db.rawAll<{ topic_key: string }>(
      "SELECT topic_key FROM session_topics WHERE session_id='sess-1' ORDER BY topic_key",
    )
    expect(rows.map(r => r.topic_key)).toEqual(['mcp', 'typescript'])
  })

  it('empty topics clears existing', () => {
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript'])
    db.saveSessionTopics('sess-1', 'proj-a', [])
    const rows = db.rawAll<{ topic_key: string }>("SELECT topic_key FROM session_topics WHERE session_id='sess-1'")
    expect(rows).toEqual([])
  })
})

describe('saveMemoryTopics', () => {
  let memId: number

  beforeEach(() => {
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'sess-1', projectId: 'proj-a' }))
    memId = db.saveMemory({
      sessionId: 'sess-1', messageId: null, content: 'x', type: 'decision',
    })
  })

  it('inserts topics for a memory', () => {
    db.saveMemoryTopics(memId, 'proj-a', ['typescript', 'sqlite'])
    const rows = db.rawAll<{ topic_key: string }>(
      `SELECT topic_key FROM memory_topics WHERE memory_id=${memId} ORDER BY topic_key`,
    )
    expect(rows.map(r => r.topic_key)).toEqual(['sqlite', 'typescript'])
  })

  it('replaces topics idempotently', () => {
    db.saveMemoryTopics(memId, 'proj-a', ['a', 'b'])
    db.saveMemoryTopics(memId, 'proj-a', ['b', 'c'])
    const rows = db.rawAll<{ topic_key: string }>(
      `SELECT topic_key FROM memory_topics WHERE memory_id=${memId} ORDER BY topic_key`,
    )
    expect(rows.map(r => r.topic_key)).toEqual(['b', 'c'])
  })

  it('cascade deletes when memory is deleted', () => {
    db.saveMemoryTopics(memId, 'proj-a', ['typescript'])
    db.rawExec(`DELETE FROM memories WHERE id=${memId}`)
    const rows = db.rawAll<{ c: number }>(`SELECT COUNT(*) AS c FROM memory_topics WHERE memory_id=${memId}`)
    expect(rows[0].c).toBe(0)
  })
})

describe('rebuildKnowledgeMap', () => {
  beforeEach(() => {
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'sess-1', projectId: 'proj-a', startedAt: '2026-04-16T00:00:00Z', endedAt: '2026-04-16T01:00:00Z' }))
    db.indexSession(sessionParams({ sessionId: 'sess-2', projectId: 'proj-a', startedAt: '2026-04-17T00:00:00Z', endedAt: '2026-04-17T01:00:00Z' }))
  })

  it('aggregates mention_count from session_topics and memory_topics', () => {
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript', 'sqlite'])
    db.saveSessionTopics('sess-2', 'proj-a', ['typescript'])
    const memId = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: 'x', type: 'decision' })
    db.saveMemoryTopics(memId, 'proj-a', ['typescript'])

    db.rebuildKnowledgeMap('proj-a')
    const topics = db.getKnowledgeMap('proj-a')
    const ts = topics.find(t => t.topicKey === 'typescript')
    const sql = topics.find(t => t.topicKey === 'sqlite')
    expect(ts?.mentionCount).toBe(3) // 2 sessions + 1 memory
    expect(sql?.mentionCount).toBe(1)
  })

  it('is idempotent — rebuild 3x yields same counts', () => {
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript'])
    db.rebuildKnowledgeMap('proj-a')
    db.rebuildKnowledgeMap('proj-a')
    db.rebuildKnowledgeMap('proj-a')
    const topics = db.getKnowledgeMap('proj-a')
    expect(topics.find(t => t.topicKey === 'typescript')?.mentionCount).toBe(1)
  })

  it('last_touched reflects most recent session/memory', () => {
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript'])
    db.saveSessionTopics('sess-2', 'proj-a', ['typescript'])
    db.rebuildKnowledgeMap('proj-a')
    const topics = db.getKnowledgeMap('proj-a')
    const ts = topics.find(t => t.topicKey === 'typescript')
    expect(ts?.lastTouched).toBeTruthy()
    // sess-2 ended 2026-04-17T01:00:00Z is most recent
    expect(ts?.lastTouched).toContain('2026-04-17')
  })

  it('only rebuilds target project (cross-project isolation)', () => {
    db.upsertProject('proj-b', 'Project B')
    db.indexSession(sessionParams({ sessionId: 'sess-b1', projectId: 'proj-b' }))
    db.saveSessionTopics('sess-1', 'proj-a', ['typescript'])
    db.saveSessionTopics('sess-b1', 'proj-b', ['python'])

    db.rebuildKnowledgeMap('proj-a')

    const aTopics = db.getKnowledgeMap('proj-a')
    const bTopics = db.getKnowledgeMap('proj-b')
    expect(aTopics.map(t => t.topicKey)).toEqual(['typescript'])
    expect(bTopics).toEqual([]) // proj-b not rebuilt yet
  })
})

describe('subagent exclusion', () => {
  it('knowledge_map ignores topics from subagent sessions', () => {
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'main-1', projectId: 'proj-a' }))
    db.indexSession(sessionParams({ sessionId: 'sub-1', projectId: 'proj-a' }))
    // mark sub-1 as subagent
    db.rawExec(`INSERT INTO subagent_sessions (id, parent_session_id, file_path) VALUES ('sub-1', 'main-1', '/tmp/sub-1.jsonl')`)

    db.saveSessionTopics('main-1', 'proj-a', ['typescript'])
    db.saveSessionTopics('sub-1', 'proj-a', ['typescript', 'golang'])
    db.rebuildKnowledgeMap('proj-a')

    const topics = db.getKnowledgeMap('proj-a')
    expect(topics.find(t => t.topicKey === 'typescript')?.mentionCount).toBe(1) // only main-1
    expect(topics.find(t => t.topicKey === 'golang')).toBeUndefined()
  })
})

describe('getMemoriesByTopics', () => {
  beforeEach(() => {
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'sess-1', projectId: 'proj-a' }))
  })

  it('returns memories linked to given topics', () => {
    const m1 = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: 'use vitest', type: 'decision' })
    const m2 = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: 'prefer pnpm', type: 'preference' })
    const m3 = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: 'unrelated', type: 'pattern' })
    db.saveMemoryTopics(m1, 'proj-a', ['testing'])
    db.saveMemoryTopics(m2, 'proj-a', ['testing', 'tooling'])
    db.saveMemoryTopics(m3, 'proj-a', ['other'])

    const results = db.getMemoriesByTopics('proj-a', ['testing'], 10)
    const ids = results.map(r => r.id).sort()
    expect(ids).toEqual([m1, m2].sort())
    expect(results.find(r => r.id === m3)).toBeUndefined()
  })

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      const mid = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: `m${i}`, type: 'decision' })
      db.saveMemoryTopics(mid, 'proj-a', ['testing'])
    }
    const results = db.getMemoriesByTopics('proj-a', ['testing'], 2)
    expect(results.length).toBe(2)
  })

  it('returns [] for no matching topic', () => {
    expect(db.getMemoriesByTopics('proj-a', ['nonexistent'], 10)).toEqual([])
  })

  it('respects project isolation', () => {
    db.upsertProject('proj-b', 'Project B')
    db.indexSession(sessionParams({ sessionId: 'sess-b1', projectId: 'proj-b' }))
    const ma = db.saveMemory({ sessionId: 'sess-1', messageId: null, content: 'a', type: 'decision' })
    const mb = db.saveMemory({ sessionId: 'sess-b1', messageId: null, content: 'b', type: 'decision' })
    db.saveMemoryTopics(ma, 'proj-a', ['shared'])
    db.saveMemoryTopics(mb, 'proj-b', ['shared'])

    const aResults = db.getMemoriesByTopics('proj-a', ['shared'], 10)
    expect(aResults.map(r => r.id)).toEqual([ma])
  })
})

describe('getTopicCount', () => {
  it('returns 0 on empty', () => {
    expect(db.getTopicCount()).toBe(0)
  })

  it('counts all topics when no project given', () => {
    db.upsertProject('proj-a', 'A')
    db.upsertProject('proj-b', 'B')
    db.indexSession(sessionParams({ sessionId: 'a1', projectId: 'proj-a' }))
    db.indexSession(sessionParams({ sessionId: 'b1', projectId: 'proj-b' }))
    db.saveSessionTopics('a1', 'proj-a', ['t1', 't2'])
    db.saveSessionTopics('b1', 'proj-b', ['t3'])
    db.rebuildKnowledgeMap('proj-a')
    db.rebuildKnowledgeMap('proj-b')
    expect(db.getTopicCount()).toBe(3)
  })

  it('counts per project when project given', () => {
    db.upsertProject('proj-a', 'A')
    db.upsertProject('proj-b', 'B')
    db.indexSession(sessionParams({ sessionId: 'a1', projectId: 'proj-a' }))
    db.indexSession(sessionParams({ sessionId: 'b1', projectId: 'proj-b' }))
    db.saveSessionTopics('a1', 'proj-a', ['t1', 't2'])
    db.saveSessionTopics('b1', 'proj-b', ['t3'])
    db.rebuildKnowledgeMap('proj-a')
    db.rebuildKnowledgeMap('proj-b')
    expect(db.getTopicCount('proj-a')).toBe(2)
    expect(db.getTopicCount('proj-b')).toBe(1)
  })
})
