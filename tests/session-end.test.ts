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
import type { OutcomeStatus, SessionMeta } from '../src/core/types.js'

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

// Outcome-bearing fixture (issue #18 step 3): user prompt → tool work → git
// commit invocation → last substantial assistant message with cause-effect
// + impl-facts + validation signals. Designed to clear scorer threshold (>=2).
const outcomeSession = [
  { type: 'user', uuid: 'o1', timestamp: '2026-04-15T10:00:00Z', message: { role: 'user', content: 'Fix the login bug in auth.ts' } },
  { type: 'assistant', uuid: 'o2', timestamp: '2026-04-15T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } }] } },
  { type: 'assistant', uuid: 'o3', timestamp: '2026-04-15T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix(auth): propagate token expiry to refresh handler"' } }] } },
  { type: 'assistant', uuid: 'o4', timestamp: '2026-04-15T10:03:00Z', message: { role: 'assistant', content: '## Auth fix shipped\n\nRoot cause: token expiry was not propagated to the refresh handler in /src/auth.ts:42. After first session expiry the silent fail looked like a stale UI bug.\n\nFix verified: 495/495 tests pass.' } },
]

// Sub-threshold fixture: short Q&A, no structural markers, no high-signal
// patterns, no git commit. Indexer must still write the session row, but
// buildMemoryFromSession must skip the memory.
const subThresholdSession = [
  { type: 'user', uuid: 's1', timestamp: '2026-04-15T11:00:00Z', message: { role: 'user', content: 'What time is it' } },
  { type: 'assistant', uuid: 's2', timestamp: '2026-04-15T11:00:30Z', message: { role: 'assistant', content: 'I cannot tell time directly.' } },
]

describe('POST /session/end — outcome-bearing session', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const sessionId = 'test-session-end-outcome'

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-sessend-'))
    const projectDir = path.join(tmpDir, 'projects', '-test-project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      outcomeSession.map(l => JSON.stringify(l)).join('\n'),
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

  it('saves a memory whose content is the outcome cluster (NOT the user prompt)', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; memoriesSaved: number[]; dryRun: boolean }
    expect(b.ok).toBe(true)
    expect(b.memoriesSaved).toHaveLength(1)
    expect(b.dryRun).toBe(false)

    const saved = db.queryMemories('Auth fix shipped', 10)
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[0].sessionId).toBe(sessionId)
    expect(saved[0].content).toContain('Root cause')
    expect(saved[0].content).not.toContain('[intent]')
    expect(saved[0].content).not.toContain('Fix the login bug in auth.ts')
    expect(saved[0].type).toBe('query')
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
    expect(b.candidate.content).toContain('Root cause')
    expect(db.getMemoryCount()).toBe(0)
  })
})

describe('POST /session/end — sub-threshold session (no harvest)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const sessionId = 'test-session-end-subthreshold'

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-sessend-sub-'))
    const projectDir = path.join(tmpDir, 'projects', '-test-project-sub')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      subThresholdSession.map(l => JSON.stringify(l)).join('\n'),
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

  it('skips memory but keeps session row when no candidate clears threshold', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; memoriesSaved: number[]; reason?: string }
    expect(b.ok).toBe(true)
    expect(b.memoriesSaved).toHaveLength(0)
    expect(b.reason).toBeTruthy()

    expect(db.getSessionById(sessionId)).not.toBeNull()
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
      outcomeSession.map(l => JSON.stringify(l)).join('\n'),
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
    messageCount: 4,
    startedAt: '2026-04-15T10:00:00Z',
    endedAt: '2026-04-15T10:05:00Z',
    archived: false,
    summaryText: 'Fix shipped | Edit×1, Bash×1, 1 files | → committed',
    intentText: 'Fix the login bug in auth.ts',
    outcomeStatus: 'committed',
    durationSeconds: 300,
    activeDurationSeconds: 250,
    summaryVersion: 2,
    tags: null,
    filesTouched: '/src/auth.ts',
    toolsUsed: 'Edit:1,Bash:1',
    totalInputTokens: null,
    totalOutputTokens: null,
    harvestText: '## Auth fix shipped\n\nRoot cause: token expiry not propagated. Fix verified: 495/495 tests pass at /src/auth.ts:42.',
  }

  it('inferConfidence: committed 0.9, tested 0.8, else 0.7', () => {
    expect(inferConfidence('committed')).toBe(0.9)
    expect(inferConfidence('tested')).toBe(0.8)
    expect(inferConfidence('in-progress')).toBe(0.7)
    expect(inferConfidence(null)).toBe(0.7)
  })

  it('buildMemoryFromSession: returns null when harvestText empty', () => {
    expect(buildMemoryFromSession({ ...baseSession, harvestText: null })).toBeNull()
    expect(buildMemoryFromSession({ ...baseSession, harvestText: '   ' })).toBeNull()
  })

  it('buildMemoryFromSession: content is harvestText verbatim — no [intent] prefix, no summary join', () => {
    const result = buildMemoryFromSession(baseSession)
    expect(result).not.toBeNull()
    expect(result!.content).toBe(baseSession.harvestText!.trim())
    expect(result!.content).not.toContain('[intent]')
    expect(result!.content).not.toContain('Fix the login bug in auth.ts')
    expect(result!.content).not.toContain('| Edit×1')
    expect(result!.sessionId).toBe('s1')
    expect(result!.messageId).toBeNull()
  })

  it('buildMemoryFromSession: type=query invariant across ALL outcomes (Issue #19), confidence varies', () => {
    // Pre-0.2.5 harvester used outcome→decision/discovery classification. 0.2.5
    // hard-coded type='query' to drop classification; #18 keeps that invariant
    // unchanged while switching the source from intent to harvestText. Auto-
    // harvest type must remain 'query' for every outcome value — semantic kind
    // (decision/discovery) stays the realm of explicit recall_save until #21.
    const cases: Array<[OutcomeStatus, number]> = [
      ['committed', 0.9],
      ['tested', 0.8],
      ['in-progress', 0.7],
      [null, 0.7],
    ]
    for (const [outcome, expectedConfidence] of cases) {
      const result = buildMemoryFromSession({ ...baseSession, outcomeStatus: outcome })
      expect(result!.type).toBe('query')
      expect(result!.confidence).toBe(expectedConfidence)
    }
  })

  it('buildMemoryFromSession: ignores intent / summary / outcome when harvestText is null', () => {
    // Old source (intentText + summaryText) MUST NOT leak back as a fallback —
    // otherwise the 60-80% planned write reduction collapses.
    const result = buildMemoryFromSession({
      ...baseSession,
      harvestText: null,
      intentText: 'A real-looking decision intent',
      summaryText: 'A summary that would have passed isHarvestNoise',
      outcomeStatus: 'committed',
    })
    expect(result).toBeNull()
  })
})
