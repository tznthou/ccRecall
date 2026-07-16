// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { runIndexer } from '../src/core/indexer.js'
import { createServer } from '../src/api/server.js'
import { coalesceRescue } from '../src/api/routes.js'
import { fetchJson } from './fixtures/helpers.js'

// #55: the extraction wrapper queries /session/last within seconds of session
// close, before the watcher/indexer has picked up the fresh JSONL. Observed
// 2026-07-03: four skips each exactly ~2s before the session row appeared —
// so /session/last needs the same rescue-reindex fallback /session/end has.
//
// The stale variant of the same race: when the project already has an older
// indexed session, getLastSession happily returns it and the wrapper extracts
// the WRONG session (6 duplicate extractions observed in telemetry). The
// wrapper passes notBefore=<its launch time>; a session whose endedAt predates
// it cannot be the one that just closed. endedAt (not startedAt) so resumed
// sessions — old start, fresh messages — survive the check.
//
// Minimal indexable session — /session/last only needs the row to exist,
// unlike /session/end's outcome-scoring fixtures. Message uuids must be
// unique per session: the indexer dedups messages by uuid across sessions
// (resume support), so shared uuids silently empty the later session.
function makeSession(prefix: string, t1: string, t2: string) {
  return [
    { type: 'user', uuid: `${prefix}-u1`, timestamp: t1, message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: `${prefix}-a1`, timestamp: t2, message: { role: 'assistant', content: 'world' } },
  ]
}
const simpleSession = makeSession('solo', '2026-07-03T10:00:00Z', '2026-07-03T10:00:30Z')

// UUID-shaped ids: the extraction wrapper validates the returned sessionId
// against a UUID regex, so fixtures mirror production ids.
const freshSessionId = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
const oldSessionId = '99998888-7777-4666-8555-444433332222'

async function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      resolve((s.address() as { port: number }).port)
    })
  })
}

describe('GET /session/last — rescue reindex (fresh session race)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  let projectsDir: string

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

describe('GET /session/last — notBefore staleness (stale-session race)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  let projectsDir: string
  let projectDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-last-stale-'))
    projectsDir = path.join(tmpDir, 'projects')
    projectDir = path.join(projectsDir, '-test-rescue')
    await mkdir(projectDir, { recursive: true })

    // Older session, indexed up front — the stale candidate.
    await writeFile(
      path.join(projectDir, `${oldSessionId}.jsonl`),
      makeSession('old', '2026-07-03T08:00:00Z', '2026-07-03T08:30:00Z')
        .map(l => JSON.stringify(l)).join('\n'),
    )
    db = new Database(path.join(tmpDir, 'test.db'))
    await runIndexer(db, undefined, projectsDir)

    // Fresh session written AFTER the initial index — unindexed, like the
    // JSONL the watcher has not picked up yet.
    await writeFile(
      path.join(projectDir, `${freshSessionId}.jsonl`),
      makeSession('fresh', '2026-07-03T10:00:00Z', '2026-07-03T10:00:30Z')
        .map(l => JSON.stringify(l)).join('\n'),
    )

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

  it('stale hit triggers rescue and returns the fresh session, not the old one', async () => {
    // Wrapper launched at 09:00 — the 08:30-ended session cannot be "the one
    // that just closed", even though getLastSession would happily return it.
    const { status, body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue&notBefore=2026-07-03T09:00:00Z`,
    )
    expect(status).toBe(200)
    expect((body as { sessionId: string }).sessionId).toBe(freshSessionId)
  })

  it('returns 404 when rescue still finds nothing fresh enough', async () => {
    const { status } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue&notBefore=2026-07-03T12:00:00Z`,
    )
    expect(status).toBe(404)
  })

  it('without notBefore keeps the old behavior: returns the latest indexed session', async () => {
    const { status, body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue`,
    )
    expect(status).toBe(200)
    expect((body as { sessionId: string }).sessionId).toBe(oldSessionId)
  })

  it('ignores an unparseable notBefore and returns the latest indexed session', async () => {
    const { status, body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue&notBefore=not-a-date`,
    )
    expect(status).toBe(200)
    expect((body as { sessionId: string }).sessionId).toBe(oldSessionId)
  })

  it('ignores a far-future notBefore (rescue-forcing DoS guard)', async () => {
    // A spoofed far-future timestamp would otherwise mark EVERY session
    // permanently stale, forcing a full reindex on each call. The wrapper
    // only ever sends "now", so anything beyond clock skew is invalid.
    const { status, body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=/test/rescue&notBefore=9999-01-01T00:00:00Z`,
    )
    expect(status).toBe(200)
    expect((body as { sessionId: string }).sessionId).toBe(oldSessionId)
  })
})

describe('getLastSession — subagent shadow + archived filtering', () => {
  let tmpDir: string
  let db: Database

  // Minimal direct insert — these are unit tests against the SQL, no HTTP.
  function insertSession(sessionId: string, startedAt: string, endedAt: string) {
    db.indexSession({
      sessionId,
      projectId: '-test-shadow',
      projectDisplayName: '/test/shadow',
      title: 'fixture',
      messageCount: 1,
      filePath: `/fake/${sessionId}.jsonl`,
      fileSize: 100,
      fileMtime: endedAt,
      startedAt,
      endedAt,
      messages: [],
    })
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-last-shadow-'))
    db = new Database(path.join(tmpDir, 'test.db'))
  })

  afterEach(async () => {
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('never returns a subagent-shaped id, even when its registry row is missing', () => {
    // Observed live 2026-07-13: a subagent row existed in `sessions` while its
    // `subagent_sessions` registry row was momentarily absent, so the NOT IN
    // exclusion failed and /session/last returned "<parent>/agent-…" — which
    // the wrapper's UUID check rejects, silently skipping extraction. The id
    // shape alone (composite path) marks it as not a main session; filtering
    // on it must not depend on registry timing.
    insertSession(oldSessionId, '2026-07-13T03:49:00Z', '2026-07-13T04:54:00Z')
    insertSession(`${oldSessionId}/agent-a970426ecaa2dd5d0`, '2026-07-13T04:25:00Z', '2026-07-13T04:30:00Z')

    const last = db.getLastSession('-test-shadow')
    expect(last).not.toBeNull()
    expect(last!.id).toBe(oldSessionId)
  })

  it('skips archived sessions (their JSONL is gone — they cannot be the one that just closed)', () => {
    insertSession(oldSessionId, '2026-07-13T08:00:00Z', '2026-07-13T08:30:00Z')
    insertSession(freshSessionId, '2026-07-13T10:00:00Z', '2026-07-13T10:30:00Z')
    // Archive the newer one: JSONL vanished from disk.
    db.archiveStaleSessionsExcept(new Set([oldSessionId]))

    const last = db.getLastSession('-test-shadow')
    expect(last).not.toBeNull()
    expect(last!.id).toBe(oldSessionId)
  })
})

describe('coalesceRescue — concurrent rescues share one run', () => {
  it('two concurrent callers trigger a single underlying run', async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const rescue = coalesceRescue(async () => { runs++; await gate })

    const p1 = rescue()
    const p2 = rescue()
    release()
    await Promise.all([p1, p2])
    expect(runs).toBe(1)
  })

  it('a new call after completion runs again', async () => {
    let runs = 0
    const rescue = coalesceRescue(async () => { runs++ })
    await rescue()
    await rescue()
    expect(runs).toBe(2)
  })

  it('a failed run clears the slot so the next call retries', async () => {
    let runs = 0
    const rescue = coalesceRescue(async () => {
      runs++
      if (runs === 1) throw new Error('boom')
    })
    await expect(rescue()).rejects.toThrow('boom')
    await rescue()
    expect(runs).toBe(2)
  })
})
