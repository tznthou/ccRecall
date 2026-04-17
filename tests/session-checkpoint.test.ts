import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import type { IndexSessionParams } from '../src/core/database.js'
import { createServer } from '../src/api/server.js'

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

function sessionParams(o: Partial<IndexSessionParams> & { sessionId: string; projectId: string }): IndexSessionParams {
  return {
    projectDisplayName: 'test',
    title: null,
    messageCount: 0,
    filePath: `/tmp/${o.sessionId}.jsonl`,
    fileSize: 0,
    fileMtime: '2026-04-17T00:00:00Z',
    startedAt: '2026-04-17T00:00:00Z',
    endedAt: '2026-04-17T01:00:00Z',
    messages: [],
    ...o,
  }
}

describe('POST /session/checkpoint', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-cp-'))
    db = new Database(path.join(tmpDir, 'test.db'))
    db.upsertProject('proj-a', 'Project A')
    db.indexSession(sessionParams({ sessionId: 'sess-1', projectId: 'proj-a' }))

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

  it('saves checkpoint and returns id', async () => {
    const { status, body } = await postJson(
      `http://127.0.0.1:${port}/session/checkpoint`,
      { sessionId: 'sess-1', snapshot: 'mid-session snapshot content' },
    )
    expect(status).toBe(200)
    const b = body as { ok: boolean; checkpointId: number }
    expect(b.ok).toBe(true)
    expect(b.checkpointId).toBeGreaterThan(0)

    const cp = db.getCheckpointById(b.checkpointId)
    expect(cp?.snapshotText).toBe('mid-session snapshot content')
    expect(cp?.projectId).toBe('proj-a')
  })

  it('does NOT write to memories table (independent of harvest)', async () => {
    await postJson(
      `http://127.0.0.1:${port}/session/checkpoint`,
      { sessionId: 'sess-1', snapshot: 'x' },
    )
    expect(db.getMemoryCount()).toBe(0)
  })

  it('allows multiple checkpoints per session', async () => {
    await postJson(`http://127.0.0.1:${port}/session/checkpoint`, { sessionId: 'sess-1', snapshot: 'cp1' })
    await postJson(`http://127.0.0.1:${port}/session/checkpoint`, { sessionId: 'sess-1', snapshot: 'cp2' })
    await postJson(`http://127.0.0.1:${port}/session/checkpoint`, { sessionId: 'sess-1', snapshot: 'cp3' })
    const cps = db.getCheckpointsBySessionId('sess-1')
    expect(cps.length).toBe(3)
    expect(cps.map(c => c.snapshotText).sort()).toEqual(['cp1', 'cp2', 'cp3'])
  })

  it('rejects empty sessionId', async () => {
    const { status } = await postJson(
      `http://127.0.0.1:${port}/session/checkpoint`,
      { sessionId: '', snapshot: 'x' },
    )
    expect(status).toBe(400)
  })

  it('rejects empty snapshot', async () => {
    const { status } = await postJson(
      `http://127.0.0.1:${port}/session/checkpoint`,
      { sessionId: 'sess-1', snapshot: '' },
    )
    expect(status).toBe(400)
  })

  it('404 for unknown session', async () => {
    const { status } = await postJson(
      `http://127.0.0.1:${port}/session/checkpoint`,
      { sessionId: 'nonexistent', snapshot: 'x' },
    )
    expect(status).toBe(404)
  })

  it('rejects cross-origin', async () => {
    const { status } = await postJson(
      `http://127.0.0.1:${port}/session/checkpoint`,
      { sessionId: 'sess-1', snapshot: 'x' },
      { Origin: 'https://evil.example.com' },
    )
    expect(status).toBe(403)
  })

  it('rejects invalid JSON', async () => {
    const u = new URL(`http://127.0.0.1:${port}/session/checkpoint`)
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname, port: u.port, path: u.pathname,
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.on('data', () => {})
        res.on('end', () => resolve({ status: res.statusCode! }))
        res.on('error', reject)
      })
      req.write('not json')
      req.end()
    })
    expect(response.status).toBe(400)
  })
})
