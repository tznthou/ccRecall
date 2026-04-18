// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { createServer } from '../src/api/server.js'
import { sessionParams, fetchJson as fetch } from './fixtures/helpers.js'

describe('GET /metacognition/check', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-meta-'))
    db = new Database(path.join(tmpDir, 'test.db'))

    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 's1', projectId: 'proj-a', startedAt: '2026-04-10T00:00:00Z', endedAt: '2026-04-10T01:00:00Z' }))
    db.indexSession(sessionParams({ sessionId: 's2', projectId: 'proj-a', startedAt: '2026-04-17T00:00:00Z', endedAt: '2026-04-17T01:00:00Z' }))
    db.saveSessionTopics('s1', 'proj-a', ['typescript', 'old-stuff'])
    db.saveSessionTopics('s2', 'proj-a', ['typescript', 'sqlite', 'mcp'])
    const m1 = db.saveMemory({ sessionId: 's2', messageId: null, content: 'use vitest', type: 'decision' })
    db.saveMemoryTopics(m1, 'proj-a', ['typescript'])
    db.rebuildKnowledgeMap('proj-a')

    server = createServer(db)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    server.close()
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('requires projectId', async () => {
    const { status, body } = await fetch(`http://127.0.0.1:${port}/metacognition/check`)
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/projectId/)
  })

  it('summary mode: returns topTopics/recentTopics/staleTopics/counts', async () => {
    const { status, body } = await fetch(`http://127.0.0.1:${port}/metacognition/check?projectId=proj-a`)
    expect(status).toBe(200)
    const b = body as {
      projectId: string
      topTopics: Array<{ topicKey: string; mentionCount: number; depth: string }>
      recentTopics: Array<{ topicKey: string; lastTouched: string }>
      staleTopics: Array<{ topicKey: string; lastTouched: string }>
      counts: { totalTopics: number; totalMemories: number; totalSessions: number }
    }
    expect(b.projectId).toBe('proj-a')
    expect(b.topTopics.length).toBeGreaterThan(0)
    expect(b.topTopics[0].topicKey).toBe('typescript') // mention_count 最高
    expect(b.topTopics[0].depth).toBeDefined()
    // recent 第一個 topic 應該是最新 touched：typescript 有 memory m1（created_at=now）
    // 比 s2.ended_at (2026-04-17) 還新，所以排在最前。避開硬編日期 — MAX(touched_at)
    // 會隨執行當天變動，昨天綠今天紅的 flaky 根因。
    expect(b.recentTopics[0].topicKey).toBe('typescript')
    // stale 第一個應該是最舊的
    expect(b.staleTopics[0].topicKey).toBe('old-stuff')
    expect(b.counts.totalTopics).toBeGreaterThan(0)
    expect(b.counts.totalSessions).toBe(2)
    expect(b.counts.totalMemories).toBe(1)
  })

  it('detail mode: returns topic + memories + relatedTopics', async () => {
    const { status, body } = await fetch(
      `http://127.0.0.1:${port}/metacognition/check?projectId=proj-a&topic=typescript`,
    )
    expect(status).toBe(200)
    const b = body as {
      topicKey: string; mentionCount: number; depth: string
      memories: Array<{ content: string }>; relatedTopics: string[]
    }
    expect(b.topicKey).toBe('typescript')
    expect(b.mentionCount).toBeGreaterThan(0)
    expect(b.depth).toBeDefined()
    expect(b.memories.length).toBe(1)
    expect(b.memories[0].content).toBe('use vitest')
    // related: 共現的其他 topics
    expect(b.relatedTopics).toContain('sqlite')
    expect(b.relatedTopics).toContain('mcp')
    expect(b.relatedTopics).toContain('old-stuff')
    expect(b.relatedTopics).not.toContain('typescript')
  })

  it('detail mode: 404 for unknown topic', async () => {
    const { status } = await fetch(
      `http://127.0.0.1:${port}/metacognition/check?projectId=proj-a&topic=nonexistent`,
    )
    expect(status).toBe(404)
  })

  it('depth: deep (>=5), medium (>=2), shallow (>=1)', async () => {
    db.upsertProject('proj-b', 'Project B')
    // 5 sessions hit "hot" topic
    for (let i = 0; i < 5; i++) {
      const sid = `sb${i}`
      db.indexSession(sessionParams({ sessionId: sid, projectId: 'proj-b' }))
      db.saveSessionTopics(sid, 'proj-b', ['hot'])
    }
    // 2 sessions hit "warm"
    for (let i = 0; i < 2; i++) {
      const sid = `sw${i}`
      db.indexSession(sessionParams({ sessionId: sid, projectId: 'proj-b' }))
      db.saveSessionTopics(sid, 'proj-b', ['warm'])
    }
    // 1 session hit "cold"
    db.indexSession(sessionParams({ sessionId: 'sc1', projectId: 'proj-b' }))
    db.saveSessionTopics('sc1', 'proj-b', ['cold'])
    db.rebuildKnowledgeMap('proj-b')

    const { body } = await fetch(`http://127.0.0.1:${port}/metacognition/check?projectId=proj-b`)
    const b = body as { topTopics: Array<{ topicKey: string; depth: string }> }
    const byName = Object.fromEntries(b.topTopics.map(t => [t.topicKey, t.depth]))
    expect(byName['hot']).toBe('deep')
    expect(byName['warm']).toBe('medium')
    expect(byName['cold']).toBe('shallow')
  })

  it('cross-project isolation: topics of proj-a not shown for proj-b', async () => {
    db.upsertProject('proj-b', 'Project B')
    const { body } = await fetch(`http://127.0.0.1:${port}/metacognition/check?projectId=proj-b`)
    expect((body as { topTopics: unknown[] }).topTopics).toEqual([])
  })

  it('rejects cross-origin requests with 403', async () => {
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/metacognition/check?projectId=proj-a',
        method: 'GET', headers: { Origin: 'https://evil.example.com' },
      }, (res) => {
        res.on('data', () => {})
        res.on('end', () => resolve({ status: res.statusCode! }))
        res.on('error', reject)
      })
      req.end()
    })
    expect(response.status).toBe(403)
  })
})
