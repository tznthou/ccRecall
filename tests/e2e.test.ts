// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database'
import { runIndexer } from '../src/core/indexer'
import { createServer } from '../src/api/server'

function fetch(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        resolve({ status: res.statusCode!, body })
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

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

describe('E2E: index → search → HTTP', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  const sampleSession = [
    { type: 'user', uuid: 'u1', timestamp: '2026-04-15T10:00:00Z', message: { role: 'user', content: 'Fix the authentication bug in login.ts' } },
    { type: 'assistant', uuid: 'u2', timestamp: '2026-04-15T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will fix the authentication issue.' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/src/login.ts' } }] } },
    { type: 'assistant', uuid: 'u3', timestamp: '2026-04-15T10:02:00Z', message: { role: 'assistant', content: 'The authentication bug has been fixed.' } },
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

  it('POST /memory/save → GET /memory/query round-trip', async () => {
    const save = await postJson(`http://127.0.0.1:${port}/memory/save`, {
      content: 'prefer pnpm over npm for monorepos',
      type: 'preference',
      confidence: 0.9,
    })
    expect(save.status).toBe(200)
    const saveBody = save.body as { ok: boolean; id: number }
    expect(saveBody.ok).toBe(true)
    expect(saveBody.id).toBeGreaterThan(0)

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

  it('POST /memory/save rejects cross-origin request', async () => {
    const { status, body } = await postJson(
      `http://127.0.0.1:${port}/memory/save`,
      { content: 'x', type: 'decision' },
      { Origin: 'https://evil.example.com' },
    )
    expect(status).toBe(403)
    expect((body as { error: string }).error).toMatch(/cross-origin/)
  })

  it('POST /memory/save rejects invalid type', async () => {
    const { status, body } = await postJson(`http://127.0.0.1:${port}/memory/save`, {
      content: 'x', type: 'invalid-type',
    })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/type must be one of/)
  })

  it('POST /memory/save rejects body over size limit (413)', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024) // 2 MB > 1 MB cap
    const { status, body } = await postJson(`http://127.0.0.1:${port}/memory/save`, {
      content: huge, type: 'decision',
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
    await postJson(`http://127.0.0.1:${port}/memory/save`, { content: 'a', type: 'decision' })
    await postJson(`http://127.0.0.1:${port}/memory/save`, { content: 'b', type: 'pattern' })
    const { body } = await fetch(`http://127.0.0.1:${port}/health`)
    expect((body as { memoryCount: number }).memoryCount).toBe(2)
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

  it('Phase 3c: POST /session/end harvest inherits session topics into memory_topics', async () => {
    const sessions = db.rawAll<{ id: string }>('SELECT id FROM sessions LIMIT 1')
    const sessionId = sessions[0].id
    const sessionTopicsBefore = db.getSessionTopicKeys(sessionId)
    expect(sessionTopicsBefore.length).toBeGreaterThan(0)

    const { status, body } = await postJson(
      `http://127.0.0.1:${port}/session/end`,
      { sessionId },
    )
    expect(status).toBe(200)
    const savedIds = (body as { memoriesSaved: number[] }).memoriesSaved
    expect(savedIds.length).toBe(1)

    const memTopics = db.rawAll<{ topic_key: string }>(
      `SELECT topic_key FROM memory_topics WHERE memory_id = ${savedIds[0]} ORDER BY topic_key`,
    ).map(r => r.topic_key)
    expect(memTopics).toEqual(sessionTopicsBefore)
  })

  it('Phase 4d: GET /lint/warnings returns orphan + stale report', async () => {
    // Seed one orphan and verify the endpoint surfaces it.
    db.upsertProject('lint-p', 'lint-p')
    db.rawExec(`
      INSERT INTO sessions (id, project_id, file_path) VALUES ('lint-s', 'lint-p', '/tmp/l.jsonl')
    `)
    const mid = db.saveMemory({
      sessionId: 'lint-s', messageId: null, type: 'decision', content: 'dangling',
    })
    db.rawExec(`DELETE FROM sessions WHERE id = 'lint-s'`)

    const { status, body } = await fetch(`http://127.0.0.1:${port}/lint/warnings`)
    expect(status).toBe(200)
    const b = body as {
      warnings: Array<{ memoryId: number; kind: string; details: string }>
      counts: { orphan: number; stale: number; total: number }
    }
    expect(b.counts.orphan).toBe(1)
    expect(b.warnings.some(w => w.memoryId === mid && w.kind === 'orphan')).toBe(true)
  })

  it('Phase 4d: GET /lint/warnings rejects cross-origin origin', async () => {
    const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1', port, path: '/lint/warnings',
        headers: { Origin: 'https://evil.example.com' },
      }, (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => resolve({
          status: r.statusCode!,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        }))
        r.on('error', reject)
      }).on('error', reject)
    })
    expect(res.status).toBe(403)
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
