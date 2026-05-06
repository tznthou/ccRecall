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
  buildJournalCandidate,
} from '../src/api/routes.js'
import type { SessionMeta } from '../src/core/types.js'
import { postJson } from './fixtures/helpers.js'

// Outcome-bearing fixture (issue #18 step 3): user prompt → tool work → git
// commit invocation → last substantial assistant message with cause-effect
// + impl-facts + validation signals. Designed to clear scorer threshold (>=2).
const outcomeSession = [
  { type: 'user', uuid: 'o1', timestamp: '2026-04-15T10:00:00Z', message: { role: 'user', content: 'Fix the login bug in auth.ts' } },
  { type: 'assistant', uuid: 'o2', timestamp: '2026-04-15T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } }] } },
  { type: 'assistant', uuid: 'o3', timestamp: '2026-04-15T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix(auth): propagate token expiry to refresh handler"' } }] } },
  { type: 'assistant', uuid: 'o4', timestamp: '2026-04-15T10:03:00Z', message: { role: 'assistant', content: '## Auth fix shipped\n\nRoot cause: token expiry was not propagated to the refresh handler in /src/auth.ts:42. After first session expiry the silent fail looked like a stale UI bug.\n\nFix verified: 495/495 tests pass.' } },
]

// Sub-threshold fixture: short Q&A, no category match (score=0). v0.3.0 P1
// lowered isSubstantial to score >= 1, so we use a phrase that doesn't trigger
// any of the 5 category regexes (decision/impl-facts/constraints/cause-effect/
// validation). "unclear without more info" matches none. Pre-0.3.0 fixture
// "I cannot tell time directly." actually matches `cannot` (constraints) → score 1
// — would now write to journal under P1 design.
const subThresholdSession = [
  { type: 'user', uuid: 's1', timestamp: '2026-04-15T11:00:00Z', message: { role: 'user', content: 'Anything?' } },
  { type: 'assistant', uuid: 's2', timestamp: '2026-04-15T11:00:30Z', message: { role: 'assistant', content: 'unclear without more info' } },
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

  it('saves a journal entry whose content is the outcome cluster (NOT the user prompt)', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; journalSaved: number[]; dryRun: boolean }
    expect(b.ok).toBe(true)
    expect(b.journalSaved).toHaveLength(1)
    expect(b.dryRun).toBe(false)

    // P1 (#21): hook auto-harvest 不再寫 memories table
    expect(db.getMemoryCount()).toBe(0)

    const journalRows = db.rawAll<{ session_id: string; content: string; score: number }>(
      "SELECT session_id, content, score FROM session_journal ORDER BY id ASC",
    )
    expect(journalRows).toHaveLength(1)
    expect(journalRows[0].session_id).toBe(sessionId)
    expect(journalRows[0].content).toContain('Root cause')
    expect(journalRows[0].content).not.toContain('[intent]')
    expect(journalRows[0].content).not.toContain('Fix the login bug in auth.ts')
    expect(journalRows[0].score).toBeGreaterThanOrEqual(2) // outcome fixture clears scorer
  })

  it('is idempotent: repeat call dedupes via content_hash UNIQUE INDEX', async () => {
    const first = await postJson(`http://127.0.0.1:${port}/session/end`, { sessionId })
    const firstBody = first.body as { journalSaved: number[] }
    expect(firstBody.journalSaved).toHaveLength(1)

    const second = await postJson(`http://127.0.0.1:${port}/session/end`, { sessionId })
    const secondBody = second.body as { journalSaved: number[] }
    expect(secondBody.journalSaved).toHaveLength(0) // dedup → no new write

    expect(db.getJournalPendingCount()).toBe(1)
  })

  it('respects dryRun: returns candidate but does not save', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId, dryRun: true,
    })
    expect(status).toBe(200)
    const b = body as {
      ok: boolean
      journalSaved: number[]
      dryRun: boolean
      candidate: { content: string; score: number }
    }
    expect(b.journalSaved).toHaveLength(0)
    expect(b.dryRun).toBe(true)
    expect(b.candidate.content).toContain('Root cause')
    expect(db.getJournalPendingCount()).toBe(0)
  })
})

describe('POST /session/end — sub-threshold session (P1: still journals, no threshold gate)', () => {
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

  // P1 (#21): 移除 score >= 2 persistence gate。sub-threshold candidate
  // (例如 "I cannot tell time directly.") 仍會進 journal,只要不是 noise / process-report。
  // 但若 summarizer extractOutcome 因 fixture 太短、無 substantial assistant 而沒產
  // candidateText, harvest_text 仍是 null,journal 也不會寫。本 fixture 屬後者。
  it('produces no harvest candidate when session lacks substantial assistant text', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; journalSaved: number[]; reason?: string }
    expect(b.ok).toBe(true)
    expect(b.journalSaved).toHaveLength(0)
    expect(b.reason).toBeTruthy()

    expect(db.getSessionById(sessionId)).not.toBeNull()
    expect(db.getJournalPendingCount()).toBe(0)
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

  it('rescues a fresh session: reindexes on miss then harvests to journal', async () => {
    expect(db.getSessionById(freshSessionId)).toBeNull()

    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: freshSessionId,
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; journalSaved: number[] }
    expect(b.ok).toBe(true)
    expect(b.journalSaved).toHaveLength(1)
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
    // 留給 promote 路徑 (C4) 在升級 journal entry 到 memories 時推導 confidence。
    expect(inferConfidence('committed')).toBe(0.9)
    expect(inferConfidence('tested')).toBe(0.8)
    expect(inferConfidence('in-progress')).toBe(0.7)
    expect(inferConfidence(null)).toBe(0.7)
  })

  it('buildJournalCandidate: returns null when harvestText empty', () => {
    expect(buildJournalCandidate({ ...baseSession, harvestText: null })).toBeNull()
    expect(buildJournalCandidate({ ...baseSession, harvestText: '   ' })).toBeNull()
  })

  it('buildJournalCandidate: content is harvestText verbatim — no [intent] prefix, no summary join', () => {
    const result = buildJournalCandidate(baseSession)
    expect(result).not.toBeNull()
    expect(result!.content).toBe(baseSession.harvestText!.trim())
    expect(result!.content).not.toContain('[intent]')
    expect(result!.content).not.toContain('Fix the login bug in auth.ts')
    expect(result!.content).not.toContain('| Edit×1')
    expect(result!.sessionId).toBe('s1')
    expect(result!.messageId).toBeNull()
  })

  it('buildJournalCandidate: stores score and reasonsJson from re-scoring', () => {
    const result = buildJournalCandidate(baseSession)
    expect(result).not.toBeNull()
    expect(result!.score).toBeGreaterThanOrEqual(2) // outcome fixture clears scorer
    const reasons = JSON.parse(result!.reasonsJson!)
    expect(Array.isArray(reasons)).toBe(true)
    expect(reasons.length).toBeGreaterThan(0)
  })

  it('buildJournalCandidate: ignores intent / summary / outcome when harvestText is null', () => {
    // Old source (intentText + summaryText) MUST NOT leak back as a fallback.
    const result = buildJournalCandidate({
      ...baseSession,
      harvestText: null,
      intentText: 'A real-looking decision intent',
      summaryText: 'A summary that would have passed isHarvestNoise',
      outcomeStatus: 'committed',
    })
    expect(result).toBeNull()
  })

  it('buildJournalCandidate: hard-floor short-circuits noise / process-report (defense in depth)', () => {
    // process-report (save-t style 收尾報告) 即便繞過 summarizer 直接餵 SessionMeta
    // 也應被 buildJournalCandidate 擋下,否則 journal 會被 process meta 污染。
    const processReport = buildJournalCandidate({
      ...baseSession,
      harvestText: '## save-t 完成 ✓\n\n寫入摘要表格',
    })
    expect(processReport).toBeNull()
  })
})
