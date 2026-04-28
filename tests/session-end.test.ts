// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { runIndexer } from '../src/core/indexer.js'
import { createServer } from '../src/api/server.js'
import {
  inferConfidence,
  buildMemoryFromSession,
} from '../src/api/routes.js'
import type { SessionMeta } from '../src/core/types.js'

function postJson(
  url: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(payload)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        resolve({ status: res.statusCode!, body })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('POST /session/end', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const sessionId = 'test-session-end-001'

  const sampleSession = [
    { type: 'user', uuid: 'u1', timestamp: '2026-04-15T10:00:00Z', message: { role: 'user', content: 'Fix the login bug in auth.ts' } },
    { type: 'assistant', uuid: 'u2', timestamp: '2026-04-15T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will fix the login.' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } }] } },
    { type: 'assistant', uuid: 'u3', timestamp: '2026-04-15T10:02:00Z', message: { role: 'assistant', content: 'Login bug fixed.' } },
  ]

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-sessend-'))
    const projectDir = path.join(tmpDir, 'projects', '-test-project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      sampleSession.map(l => JSON.stringify(l)).join('\n'),
    )

    db = new Database(path.join(tmpDir, 'test.db'))
    await runIndexer(db, undefined, path.join(tmpDir, 'projects'))

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

  it('rejects cross-origin request with 403', async () => {
    const { status, body } = await postJson(
      `http://127.0.0.1:${port}/session/end`,
      { sessionId },
      { Origin: 'https://evil.example.com' },
    )
    expect(status).toBe(403)
    expect((body as { error: string }).error).toMatch(/cross-origin/)
  })

  it('rejects missing sessionId with 400', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {})
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/sessionId/)
  })

  it('rejects non-boolean dryRun with 400', async () => {
    const { status } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId, dryRun: 'yes',
    })
    expect(status).toBe(400)
  })

  it('returns 404 for non-existent session', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: 'does-not-exist',
    })
    expect(status).toBe(404)
    expect((body as { error: string }).error).toMatch(/not found/)
  })

  it('saves a memory from session summary on success', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; memoriesSaved: number[]; dryRun: boolean }
    expect(b.ok).toBe(true)
    expect(b.memoriesSaved).toHaveLength(1)
    expect(b.dryRun).toBe(false)

    const saved = db.queryMemories('auth', 10)
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[0].sessionId).toBe(sessionId)
  })

  it('is idempotent: repeat call returns existing memory id', async () => {
    const first = await postJson(`http://127.0.0.1:${port}/session/end`, { sessionId })
    const firstBody = first.body as { memoriesSaved: number[]; alreadyHarvested?: boolean }
    expect(firstBody.memoriesSaved).toHaveLength(1)
    expect(firstBody.alreadyHarvested).toBeUndefined()
    const firstId = firstBody.memoriesSaved[0]

    const second = await postJson(`http://127.0.0.1:${port}/session/end`, { sessionId })
    const secondBody = second.body as { memoriesSaved: number[]; alreadyHarvested?: boolean }
    expect(secondBody.memoriesSaved).toEqual([firstId])
    expect(secondBody.alreadyHarvested).toBe(true)
    expect(db.getMemoryCount()).toBe(1)
  })

  it('respects dryRun: returns candidate but does not save', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId, dryRun: true,
    })
    expect(status).toBe(200)
    const b = body as {
      ok: boolean
      memoriesSaved: number[]
      dryRun: boolean
      candidate: { content: string; type: string }
    }
    expect(b.memoriesSaved).toHaveLength(0)
    expect(b.dryRun).toBe(true)
    expect(b.candidate.content).toBeTruthy()
    expect(db.getMemoryCount()).toBe(0)
  })

})

describe('POST /session/end — rescue reindex (fresh session race)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const freshSessionId = 'fresh-session-rescue-001'

  const sampleSession = [
    { type: 'user', uuid: 'r1', timestamp: '2026-04-17T10:00:00Z', message: { role: 'user', content: 'Deploy to staging' } },
    { type: 'assistant', uuid: 'r2', timestamp: '2026-04-17T10:01:00Z', message: { role: 'assistant', content: 'Deploy complete.' } },
  ]

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-rescue-'))
    const projectsDir = path.join(tmpDir, 'projects')
    const projectDir = path.join(projectsDir, '-test-rescue')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${freshSessionId}.jsonl`),
      sampleSession.map(l => JSON.stringify(l)).join('\n'),
    )

    db = new Database(path.join(tmpDir, 'test.db'))
    // Intentionally skip runIndexer here — simulate the race where the hook
    // fires before the daemon has indexed the fresh JSONL.

    server = createServer(db, {
      rescueReindex: () => runIndexer(db, undefined, projectsDir),
    })
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

  it('rescues a fresh session: reindexes on miss then harvests', async () => {
    expect(db.getSessionById(freshSessionId)).toBeNull()

    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: freshSessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; memoriesSaved: number[] }
    expect(b.ok).toBe(true)
    expect(b.memoriesSaved).toHaveLength(1)
    expect(db.getSessionById(freshSessionId)).not.toBeNull()
  })

  it('still returns 404 if rescue cannot locate the session', async () => {
    const { status } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: 'does-not-exist-anywhere',
    })
    expect(status).toBe(404)
  })

  it('rescue failure does not crash: returns 404 if session still missing', async () => {
    server.close()
    await new Promise(resolve => server.on('close', resolve))
    // Replace server with one whose rescue throws — mimics indexer error.
    server = createServer(db, {
      rescueReindex: async () => { throw new Error('indexer failed') },
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })

    const { status } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: freshSessionId,
    })
    expect(status).toBe(404)
  })
})

describe('session-end helpers (unit)', () => {
  const baseSession: SessionMeta = {
    id: 's1',
    projectId: 'p1',
    title: 't',
    messageCount: 3,
    startedAt: '2026-04-15T10:00:00Z',
    endedAt: '2026-04-15T10:05:00Z',
    archived: false,
    summaryText: 'Fixed auth bug; tests green.',
    intentText: 'fix login',
    outcomeStatus: null,
    durationSeconds: 300,
    activeDurationSeconds: 250,
    summaryVersion: 1,
    tags: null,
    filesTouched: null,
    toolsUsed: null,
    totalInputTokens: null,
    totalOutputTokens: null,
  }

  it('inferConfidence: committed 0.9, tested 0.8, else 0.7', () => {
    expect(inferConfidence('committed')).toBe(0.9)
    expect(inferConfidence('tested')).toBe(0.8)
    expect(inferConfidence('in-progress')).toBe(0.7)
    expect(inferConfidence(null)).toBe(0.7)
  })

  it('buildMemoryFromSession: returns null when summary empty', () => {
    expect(buildMemoryFromSession({ ...baseSession, summaryText: null })).toBeNull()
    expect(buildMemoryFromSession({ ...baseSession, summaryText: '   ' })).toBeNull()
  })

  it('buildMemoryFromSession: uses intent + summary in content', () => {
    const result = buildMemoryFromSession(baseSession)
    expect(result).not.toBeNull()
    expect(result!.content).toBe('[intent] fix login\nFixed auth bug; tests green.')
    expect(result!.sessionId).toBe('s1')
    expect(result!.messageId).toBeNull()
  })

  it('buildMemoryFromSession: omits intent when empty', () => {
    const result = buildMemoryFromSession({ ...baseSession, intentText: null })
    expect(result!.content).toBe('Fixed auth bug; tests green.')
  })

  it('buildMemoryFromSession: hook auto-harvest is always type=query, confidence varies by outcome', () => {
    const committed = buildMemoryFromSession({ ...baseSession, outcomeStatus: 'committed' })
    expect(committed!.type).toBe('query')
    expect(committed!.confidence).toBe(0.9)

    const tested = buildMemoryFromSession({ ...baseSession, outcomeStatus: 'tested' })
    expect(tested!.type).toBe('query')
    expect(tested!.confidence).toBe(0.8)
  })

  it('buildMemoryFromSession: skips noise prompts (slash command / progress shell / reflection)', () => {
    expect(buildMemoryFromSession({ ...baseSession, intentText: '/clear', summaryText: '/clear | Edit×1' })).toBeNull()
    expect(buildMemoryFromSession({ ...baseSession, intentText: '繼續我們的進度', summaryText: '繼續我們的進度 | Edit×3' })).toBeNull()
    expect(buildMemoryFromSession({ ...baseSession, intentText: '我們剛是不是討論到 X', summaryText: 's' })).toBeNull()
  })

  it('buildMemoryFromSession: keeps audit query carrying concrete technical detail', () => {
    const intent = '確認一下工作進度,以及目前我們在CCRecall的MCP裡面,現在存了多少筆記憶,容量又是多少?'
    const result = buildMemoryFromSession({ ...baseSession, intentText: intent, summaryText: 'audit summary' })
    expect(result).not.toBeNull()
    expect(result!.type).toBe('query')
  })
})
