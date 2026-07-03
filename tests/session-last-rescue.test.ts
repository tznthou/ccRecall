// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { runIndexer } from '../src/core/indexer.js'
import { createServer } from '../src/api/server.js'
import { fetchJson } from './fixtures/helpers.js'

// #55: the extraction wrapper queries /session/last within seconds of session
// close, before the watcher/indexer has picked up the fresh JSONL. Observed
// 2026-07-03: four skips each exactly ~2s before the session row appeared —
// so /session/last needs the same rescue-reindex fallback /session/end has.
//
// Minimal indexable session — /session/last only needs the row to exist,
// unlike /session/end's outcome-scoring fixtures.
const simpleSession = [
  { type: 'user', uuid: 'u1', timestamp: '2026-07-03T10:00:00Z', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-07-03T10:00:30Z', message: { role: 'assistant', content: 'world' } },
]

// UUID-shaped id: the extraction wrapper validates the returned sessionId
// against a UUID regex, so the fixture mirrors production ids.
const freshSessionId = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'

describe('GET /session/last — rescue reindex (fresh session race)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  let projectsDir: string

  async function listen(s: http.Server): Promise<number> {
    return new Promise((resolve) => {
      s.listen(0, '127.0.0.1', () => {
        resolve((s.address() as { port: number }).port)
      })
    })
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-last-rescue-'))
    projectsDir = path.join(tmpDir, 'projects')
    const projectDir = path.join(projectsDir, '-test-rescue')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${freshSessionId}.jsonl`),
      simpleSession.map(l => JSON.stringify(l)).join('\n'),
    )

    db = new Database(path.join(tmpDir, 'test.db'))
    // Intentionally skip runIndexer here — simulate the race where the
    // wrapper queries before the daemon has indexed the fresh JSONL.

    server = createServer(db, {
      rescueReindex: () => runIndexer(db, undefined, projectsDir),
    })
    port = await listen(server)
  })

  afterEach(async () => {
    server.close()
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('rescues a fresh session: reindexes on miss then returns it', async () => {
    expect(db.getLastSession('-test-rescue')).toBeNull()

    const { status, body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue`,
    )
    expect(status).toBe(200)
    expect((body as { sessionId: string }).sessionId).toBe(freshSessionId)
    expect(db.getLastSession('-test-rescue')).not.toBeNull()
  })

  it('still returns 404 if rescue cannot locate any session for the project', async () => {
    const { status } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/nonexistent/place`,
    )
    expect(status).toBe(404)
  })

  it('rescue failure does not crash: returns 404 if project still has no session', async () => {
    server.close()
    await new Promise(resolve => server.on('close', resolve))
    server = createServer(db, {
      rescueReindex: async () => { throw new Error('indexer failed') },
    })
    port = await listen(server)

    const { status } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue`,
    )
    expect(status).toBe(404)
  })

  it('without a rescueReindex option, a fresh session still 404s (no fallback)', async () => {
    server.close()
    await new Promise(resolve => server.on('close', resolve))
    server = createServer(db)
    port = await listen(server)

    const { status } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue`,
    )
    expect(status).toBe(404)
  })
})
