// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database'
import { runIndexer } from '../src/core/indexer'
import { createServer } from '../src/api/server'
import { postJson, fetchJson as fetch } from './fixtures/helpers.js'

describe('E2E: index → search → HTTP', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const originalTelemetryPath = process.env.CCRECALL_RECALL_TELEMETRY_PATH
  const originalTelemetryOff = process.env.CCRECALL_RECALL_TELEMETRY_OFF

  // issue #18: harvest source switched from first user prompt to scored outcome
  // cluster — sample needs commit invocation + a last assistant message that
  // clears scorer threshold (cause-effect + impl-facts + validation = 3 cats).
  const sampleSession = [
    { type: 'user', uuid: 'u1', timestamp: '2026-04-15T10:00:00Z', message: { role: 'user', content: 'Fix the authentication bug in login.ts' } },
    { type: 'assistant', uuid: 'u2', timestamp: '2026-04-15T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/login.ts' } }] } },
    { type: 'assistant', uuid: 'u3', timestamp: '2026-04-15T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix(auth): propagate token in login flow"' } }] } },
    { type: 'assistant', uuid: 'u4', timestamp: '2026-04-15T10:03:00Z', message: { role: 'assistant', content: '## Authentication fix shipped\n\nRoot cause: login flow at /src/login.ts:88 was not propagating the session token. Fix verified: 495/495 tests pass.' } },
  ]

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-e2e-'))

    // Create mock ~/.claude/projects/ structure
    const projectDir = path.join(tmpDir, 'projects', '-test-project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, 'test-session-001.jsonl'),
      sampleSession.map(l => JSON.stringify(l)).join('\n'),
    )

    // Init DB
    db = new Database(path.join(tmpDir, 'test.db'))

    // Run indexer
    await runIndexer(db, undefined, path.join(tmpDir, 'projects'))

    // Isolate recall-telemetry writes so /memory/query tests don't append
    // to the real ~/.ccrecall/recall-query.log.jsonl on the host.
    process.env.CCRECALL_RECALL_TELEMETRY_PATH = path.join(tmpDir, 'recall-query.log.jsonl')
    delete process.env.CCRECALL_RECALL_TELEMETRY_OFF

    // Start server on random port
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
    if (originalTelemetryPath === undefined) {
      delete process.env.CCRECALL_RECALL_TELEMETRY_PATH
    } else {
      process.env.CCRECALL_RECALL_TELEMETRY_PATH = originalTelemetryPath
    }
    if (originalTelemetryOff === undefined) {
      delete process.env.CCRECALL_RECALL_TELEMETRY_OFF
    } else {
      process.env.CCRECALL_RECALL_TELEMETRY_OFF = originalTelemetryOff
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('indexes sessions and populates DB', () => {
    const rows = db.rawAll<{ c: number }>('SELECT COUNT(*) AS c FROM sessions')
    expect(rows[0].c).toBeGreaterThan(0)
  })

  it('session search returns results for tags/intent', () => {
    const page = db.searchSessions('auth', null, 0, 10)
    expect(page.results.length).toBeGreaterThan(0)
  })

  it('GET /health returns real session count', async () => {
    const { status, body } = await fetch(`http://127.0.0.1:${port}/health`)
    expect(status).toBe(200)
    const b = body as { status: string; sessionCount: number }
    expect(b.status).toBe('ok')
    expect(b.sessionCount).toBeGreaterThan(0)
  })

  it('saveMemory → GET /memory/query round-trip', async () => {
    // v0.5.0: /memory/save HTTP endpoint removed (MCP recall_save writes via
    // DB directly) — seed through the same saveMemory path the MCP tool uses.
    const id = db.saveMemory({
      sessionId: null,
      messageId: null,
      content: 'prefer pnpm over npm for monorepos',
      type: 'preference',
      confidence: 0.9,
    })
    expect(id).toBeGreaterThan(0)

    const { status, body } = await fetch(`http://127.0.0.1:${port}/memory/query?q=pnpm&limit=5`)
    expect(status).toBe(200)
    const b = body as { memories: Array<{ content: string; confidence: number }>; totalTokenEstimate: number }
    expect(b.memories.length).toBe(1)
    expect(b.memories[0].content).toContain('pnpm')
    expect(b.memories[0].confidence).toBe(0.9)
    expect(b.totalTokenEstimate).toBeGreaterThan(0)
  })

  it('GET /memory/query with empty q returns empty', async () => {
    const { status, body } = await fetch(`http://127.0.0.1:${port}/memory/query?q=`)
    expect(status).toBe(200)
    const b = body as { memories: unknown[] }
    expect(b.memories).toEqual([])
  })

  it('GET /memory/query maxTokens truncates long content + touches only emitted', async () => {
    // Two memories: short pnpm (should emit), long block (truncated to 150 chars)
    db.saveMemory({
      sessionId: null, messageId: null,
      content: 'short fact about pnpm',
      type: 'discovery',
      projectId: '-test-project',
    })
    db.saveMemory({
      sessionId: null, messageId: null,
      content: 'pnpm pnpm pnpm '.repeat(50), // ~750 chars, truncates to 150
      type: 'discovery',
      projectId: '-test-project',
    })

    const { status, body } = await fetch(
      `http://127.0.0.1:${port}/memory/query?q=pnpm&limit=10&maxTokens=50`,
    )
    expect(status).toBe(200)
    const b = body as {
      memories: Array<{ content: string }>
      droppedCount: number
      truncated: boolean
      totalTokenEstimate: number
    }
    // Long row truncated to 150 chars; if its 0.3*150=45 tokens fits before
    // budget exhausted, it stays. Either way one row emits and the second
    // gets dropped (cumulative > 50).
    expect(b.memories.length).toBeGreaterThan(0)
    expect(b.memories.length).toBeLessThanOrEqual(2)
    expect(b.totalTokenEstimate).toBeLessThanOrEqual(50)
    // truncated should fire on at least one of them
    expect(b.truncated || b.droppedCount > 0).toBe(true)
  })

  it('GET /memory/query writes telemetry row per call (with 80-char query truncation)', async () => {
    db.saveMemory({
      sessionId: null, messageId: null,
      content: 'evidence-first debugging principles',
      type: 'pattern',
      projectId: '-test-project',
      confidence: 0.8,
    })

    await fetch(`http://127.0.0.1:${port}/memory/query?q=evidence&limit=5&project=-test-project`)

    const longQuery = 'a'.repeat(200)
    await fetch(`http://127.0.0.1:${port}/memory/query?q=${encodeURIComponent(longQuery)}&limit=5`)

    const logPath = process.env.CCRECALL_RECALL_TELEMETRY_PATH!
    const content = await readFile(logPath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    const row1 = JSON.parse(lines[0])
    expect(row1.query).toBe('evidence')
    expect(row1.queryLen).toBe(8)
    expect(row1.hitCount).toBeGreaterThan(0)
    expect(row1.projectId).toBe('-test-project')
    expect(row1.limit).toBe(5)
    expect(row1.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const row2 = JSON.parse(lines[1])
    expect(row2.query.length).toBe(80)
    expect(row2.queryLen).toBe(200)
    expect(row2.hitCount).toBe(0)
  })

  it('GET /memory/query telemetry write does not block endpoint (timing under 100ms wall)', async () => {
    db.saveMemory({
      sessionId: null, messageId: null,
      content: 'telemetry timing sentinel',
      type: 'discovery',
      projectId: '-test-project',
    })

    const t0 = Date.now()
    await fetch(`http://127.0.0.1:${port}/memory/query?q=telemetry&limit=5&project=-test-project`)
    const elapsed = Date.now() - t0
    // Wall-time budget is generous (100ms) to absorb CI flake; the goal is to
    // catch a regression where appendFileSync blocks for hundreds of ms,
    // not to micro-benchmark sync I/O.
    expect(elapsed).toBeLessThan(100)
  })

  it('GET /memory/startup surfaces project memory NOT containing project name (closes echo chamber)', async () => {
    // Memory whose content does NOT contain "ccRecall" or any project-name keyword
    const saveId = db.saveMemory({
      sessionId: null, messageId: null,
      content: '漸進披露探索法：處理大量檔案前先用最便宜工具拿訊息',
      type: 'pattern',
      projectId: '-test-project',
      confidence: 0.9,
    })
    expect(saveId).toBeGreaterThan(0)

    const { status, body } = await fetch(
      `http://127.0.0.1:${port}/memory/startup?project=-test-project&limit=5&maxTokens=300`,
    )
    expect(status).toBe(200)
    const b = body as {
      memories: Array<{ id: number; content: string }>
      emittedIds: number[]
      candidateCount: number
      droppedCount: number
    }
    expect(b.memories.length).toBeGreaterThan(0)
    // Content does NOT mention project name — this is the whole point of the fix
    const found = b.memories.find(m => m.content.includes('漸進披露'))
    expect(found).toBeDefined()
    expect(b.emittedIds).toContain(found!.id)
  })

  it('GET /memory/startup rejects without project param', async () => {
    const { status, body } = await fetch(`http://127.0.0.1:${port}/memory/startup`)
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/project is required/)
  })

  it('POST body over size limit returns 413 (parseJsonBody cap via /session/end)', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024) // 2 MB > 1 MB cap
    const { status, body } = await postJson(`http://127.0.0.1:${port}/session/end`, {
      sessionId: huge,
    })
    expect(status).toBe(413)
    expect((body as { error: string }).error).toBe('body too large')
  })

  it('GET unknown path returns generic 404 without reflecting input', async () => {
    const { status, body } = await fetch(`http://127.0.0.1:${port}/does-not-exist`)
    expect(status).toBe(404)
    const err = (body as { error: string }).error
    expect(err).toBe('Not found')
    expect(err).not.toContain('does-not-exist')
  })

  it('GET /health reports memoryCount after save', async () => {
    db.saveMemory({ sessionId: null, messageId: null, content: 'a', type: 'decision' })
    db.saveMemory({ sessionId: null, messageId: null, content: 'b', type: 'pattern' })
    const { body } = await fetch(`http://127.0.0.1:${port}/health`)
    expect((body as { memoryCount: number }).memoryCount).toBe(2)
  })

  it('v0.5.0: GET /health no longer reports journalPendingCount', async () => {
    const { body } = await fetch(`http://127.0.0.1:${port}/health`)
    expect(body as object).not.toHaveProperty('journalPendingCount')
  })

  it('Phase 3c: indexer populates knowledge_map from session topics', () => {
    const topics = db.rawAll<{ topic_key: string; mention_count: number }>(
      'SELECT topic_key, mention_count FROM knowledge_map ORDER BY topic_key',
    )
    expect(topics.length).toBeGreaterThan(0)
    // sample session edits /src/login.ts → basename login.ts → stem "login"
    const loginTopic = topics.find(t => t.topic_key === 'login')
    expect(loginTopic).toBeTruthy()
  })

  it('v0.5.0: POST /session/end has no write side effects (memories / memory_topics untouched)', async () => {
    const sessions = db.rawAll<{ id: string }>('SELECT id FROM sessions LIMIT 1')
    const sessionId = sessions[0].id

    const { status } = await postJson(
      `http://127.0.0.1:${port}/session/end`,
      { sessionId },
    )
    expect(status).toBe(200)

    const memTopicsAfter = db.rawAll<{ topic_key: string }>(
      'SELECT topic_key FROM memory_topics',
    )
    expect(memTopicsAfter).toHaveLength(0)
    expect(db.getMemoryCount()).toBe(0)
  })

  it('v0.5.0: removed endpoints return 404', async () => {
    for (const deadPath of [
      '/memory/context?session_id=x',
      '/journal/pending',
      '/metacognition/check?projectId=x',
      '/lint/warnings',
    ]) {
      const { status } = await fetch(`http://127.0.0.1:${port}${deadPath}`)
      expect(status, deadPath).toBe(404)
    }
    for (const deadPost of ['/memory/save', '/journal/promote', '/journal/reject', '/session/checkpoint']) {
      const { status } = await postJson(`http://127.0.0.1:${port}${deadPost}`, {})
      expect(status, deadPost).toBe(404)
    }
  })

  it('GET /session/last?cwd=... returns most recent session', async () => {
    const { status, body } = await fetch(
      `http://127.0.0.1:${port}/session/last?cwd=/test/project`,
    )
    expect(status).toBe(200)
    const b = body as { sessionId: string; projectId: string; title: string | null }
    expect(b.sessionId).toBe('test-session-001')
    expect(b.projectId).toBe('-test-project')
  })

  it('GET /session/last without cwd returns 400', async () => {
    const { status, body } = await fetch(`http://127.0.0.1:${port}/session/last`)
    expect(status).toBe(400)
    expect((body as { error: string }).error).toContain('cwd')
  })

  it('GET /session/last with unknown project returns 404', async () => {
    const { status } = await fetch(
      `http://127.0.0.1:${port}/session/last?cwd=/nonexistent/project`,
    )
    expect(status).toBe(404)
  })
})

describe('GET /health version + dbPath propagation', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number
  const TEST_DB_PATH = '/tmp/ccrecall-health-test.db'
  const TEST_VERSION = '9.9.9-test'

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-health-'))
    db = new Database(path.join(tmpDir, 'unused.db'))
    server = createServer(db, { version: TEST_VERSION, dbPath: TEST_DB_PATH })
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

  it('reports version passed via createServer options', async () => {
    const { body } = await fetch(`http://127.0.0.1:${port}/health`)
    expect((body as { version: string }).version).toBe(TEST_VERSION)
  })

  it('reports dbPath passed via createServer options', async () => {
    const { body } = await fetch(`http://127.0.0.1:${port}/health`)
    expect((body as { dbPath: string }).dbPath).toBe(TEST_DB_PATH)
  })
})

describe('GET /health defaults when options omitted', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-health-defaults-'))
    db = new Database(path.join(tmpDir, 'unused.db'))
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

  it("falls back to 'unknown' + empty dbPath when options omitted", async () => {
    const { body } = await fetch(`http://127.0.0.1:${port}/health`)
    const b = body as { version: string; dbPath: string }
    expect(b.version).toBe('unknown')
    expect(b.dbPath).toBe('')
  })
})
