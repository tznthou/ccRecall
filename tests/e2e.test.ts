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

  it('FTS5 search returns results for indexed content', () => {
    const page = db.search('authentication', null, 0, 10)
    expect(page.results.length).toBeGreaterThan(0)
    expect(page.results[0].snippet).toContain('authentication')
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
})
