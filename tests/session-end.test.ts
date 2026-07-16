// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { runIndexer } from '../src/core/indexer.js'
import { createServer } from '../src/api/server.js'
import { postJson } from './fixtures/helpers.js'

// Minimal valid session JSONL — /session/end (v0.5.0) only confirms the session
// is indexed (rescue-reindex on miss); no harvest/journal side effects remain.
const sampleSession = [
  { type: 'user', uuid: 'o1', timestamp: '2026-04-15T10:00:00Z', message: { role: 'user', content: 'Fix the login bug in auth.ts' } },
  { type: 'assistant', uuid: 'o2', timestamp: '2026-04-15T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } }] } },
  { type: 'assistant', uuid: 'o3', timestamp: '2026-04-15T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix(auth): propagate token expiry to refresh handler"' } }] } },
  { type: 'assistant', uuid: 'o4', timestamp: '2026-04-15T10:03:00Z', message: { role: 'assistant', content: '## Auth fix shipped\n\nRoot cause: token expiry was not propagated to the refresh handler in /src/auth.ts:42.\n\nFix verified: 495/495 tests pass.' } },
]

describe('POST /session/end — indexed session', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const sessionId = 'test-session-end-basic'

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

  it('returns 404 for non-existent session', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: 'does-not-exist',
    })
    expect(status).toBe(404)
    expect((body as { error: string }).error).toMatch(/not found/)
  })

  it('returns 200 { ok, sessionId } for an indexed session with no side effects', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; sessionId: string }
    expect(b.ok).toBe(true)
    expect(b.sessionId).toBe(sessionId)
    // v0.5.0: the endpoint no longer harvests — no memories are written.
    expect(db.getMemoryCount()).toBe(0)
  })
})

describe('POST /session/end — rescue reindex (fresh session race)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const freshSessionId = 'fresh-session-rescue-001'

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

  it('rescues a fresh session: reindexes on miss then returns 200', async () => {
    expect(db.getSessionById(freshSessionId)).toBeNull()

    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: freshSessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; sessionId: string }
    expect(b.ok).toBe(true)
    expect(b.sessionId).toBe(freshSessionId)
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
