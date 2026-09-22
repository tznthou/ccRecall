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

  it('rejects a non-boolean wait with 400', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
      wait: 'nope',
    })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/wait/)
  })

  it('returns 200 for an already-indexed session even with wait:false', async () => {
    // wait only governs the rescue path; a hit never needed to block.
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
      wait: false,
    })
    expect(status).toBe(200)
    expect((body as { ok: boolean }).ok).toBe(true)
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

describe('POST /session/end — non-blocking opt-out (wait:false)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  let rescueRun: Promise<void> | null
  const freshSessionId = 'fresh-session-nonblocking-001'
  // Long enough that a blocking implementation cannot come in under it.
  const RESCUE_DELAY_MS = 500

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-nonblock-'))
    const projectsDir = path.join(tmpDir, 'projects')
    const projectDir = path.join(projectsDir, '-test-nonblock')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${freshSessionId}.jsonl`),
      sampleSession.map(l => JSON.stringify(l)).join('\n'),
    )

    db = new Database(path.join(tmpDir, 'test.db'))
    rescueRun = null

    server = createServer(db, {
      // Deliberately slow, standing in for the ~1.55s real rescue reindex that
      // outlived Claude Code's SessionEnd hook abort window.
      rescueReindex: () => {
        rescueRun = (async () => {
          await new Promise(resolve => setTimeout(resolve, RESCUE_DELAY_MS))
          await runIndexer(db, undefined, projectsDir)
        })()
        return rescueRun
      },
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    // Let the queued run settle first, or it writes into a closed DB handle.
    if (rescueRun) await rescueRun.catch(() => {})
    server.close()
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns 202 without waiting for the reindex, which still lands', async () => {
    expect(db.getSessionById(freshSessionId)).toBeNull()

    const t0 = Date.now()
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: freshSessionId,
      wait: false,
    })
    const elapsed = Date.now() - t0

    expect(status).toBe(202)
    const b = body as { ok: boolean; sessionId: string; reindex: string }
    expect(b.ok).toBe(true)
    expect(b.sessionId).toBe(freshSessionId)
    expect(b.reindex).toBe('queued')
    // Regression guard: re-adding `await` to this path pushes the response
    // past RESCUE_DELAY_MS and fails here.
    expect(elapsed).toBeLessThan(RESCUE_DELAY_MS)

    // Queued, not dropped — this is the run /session/last joins via coalesceRescue.
    expect(rescueRun).not.toBeNull()
    await rescueRun
    expect(db.getSessionById(freshSessionId)).not.toBeNull()
  })

  it('still answers 202 when the queued reindex fails', async () => {
    server.close()
    await new Promise(resolve => server.on('close', resolve))
    rescueRun = null
    server = createServer(db, {
      rescueReindex: () => {
        rescueRun = (async () => { throw new Error('indexer failed') })()
        return rescueRun
      },
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })

    const { status } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: freshSessionId,
      wait: false,
    })
    // A background failure must not turn into a hook-visible error.
    expect(status).toBe(202)
  })
})
