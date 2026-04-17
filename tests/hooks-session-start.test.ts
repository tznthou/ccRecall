import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/session-start.mjs',
)

type MemoryShape = { content: string; source: string; confidence: number; depth: null }
type Received = { path: string | undefined; method: string | undefined }

function startMockServer(
  responder: (received: Received) => { status: number; memories: MemoryShape[] },
): Promise<{ server: http.Server; port: number; received: Received[] }> {
  return new Promise((resolve) => {
    const received: Received[] = []
    const server = http.createServer((req, res) => {
      const entry: Received = { path: req.url, method: req.method }
      received.push(entry)
      const { status, memories } = responder(entry)
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ memories, totalTokenEstimate: 0, query: '', limit: 5 }))
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, port, received })
    })
  })
}

function runHook(
  port: number,
  stdinData: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CCRECALL_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
    proc.on('error', reject)
    proc.stdin.write(stdinData)
    proc.stdin.end()
  })
}

describe('hooks/session-start.mjs', () => {
  let server: http.Server | null = null

  afterEach(() => {
    if (server && server.listening) server.close()
    server = null
  })

  it('queries /memory/query with cwd basename and writes memories to stdout', async () => {
    const ctx = await startMockServer(() => ({
      status: 200,
      memories: [
        { content: 'ccRecall uses Apache-2.0 license', source: 's1:session', confidence: 0.9, depth: null },
        { content: 'prefer pnpm over npm', source: 's2:session', confidence: 1, depth: null },
      ],
    }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, JSON.stringify({
      session_id: 'abc',
      cwd: '/Users/tznthou/Documents/ccRecall',
      source: 'startup',
      hook_event_name: 'SessionStart',
    }))

    expect(code).toBe(0)
    expect(ctx.received).toHaveLength(1)
    expect(ctx.received[0].method).toBe('GET')
    expect(ctx.received[0].path).toContain('/memory/query')
    expect(ctx.received[0].path).toContain('q=ccRecall')
    expect(ctx.received[0].path).toContain('limit=5')

    expect(stdout).toContain('[ccRecall memory recall]')
    expect(stdout).toContain('ccRecall uses Apache-2.0 license')
    expect(stdout).toContain('(conf 0.90)')
    expect(stdout).toContain('prefer pnpm over npm')
    expect(stdout).toContain('matched via project keyword: "ccRecall"')
  })

  it('writes nothing when no memories match', async () => {
    const ctx = await startMockServer(() => ({ status: 200, memories: [] }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, JSON.stringify({
      session_id: 'x',
      cwd: '/Users/tznthou/Documents/empty-project',
      source: 'startup',
      hook_event_name: 'SessionStart',
    }))

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(ctx.received).toHaveLength(1)
  })

  it('skips when source is "resume"', async () => {
    const ctx = await startMockServer(() => ({ status: 200, memories: [] }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, JSON.stringify({
      session_id: 'x',
      cwd: '/Users/tznthou/Documents/ccRecall',
      source: 'resume',
      hook_event_name: 'SessionStart',
    }))

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(ctx.received).toHaveLength(0)
  })

  it('skips when cwd is missing', async () => {
    const ctx = await startMockServer(() => ({ status: 200, memories: [] }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, JSON.stringify({
      session_id: 'x',
      source: 'startup',
      hook_event_name: 'SessionStart',
    }))

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(ctx.received).toHaveLength(0)
  })

  it('exits 0 with empty stdout on invalid JSON stdin', async () => {
    const ctx = await startMockServer(() => ({ status: 200, memories: [] }))
    server = ctx.server

    const { code, stdout, stderr } = await runHook(ctx.port, 'not json {{')
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('failed to parse')
    expect(ctx.received).toHaveLength(0)
  })

  it('exits 0 with empty stdout when service unreachable', async () => {
    const ctx = await startMockServer(() => ({ status: 200, memories: [] }))
    ctx.server.close()
    await new Promise<void>((resolve) => ctx.server.on('close', () => resolve()))

    const { code, stdout, stderr } = await runHook(ctx.port, JSON.stringify({
      session_id: 'x',
      cwd: '/Users/tznthou/Documents/ccRecall',
      source: 'startup',
      hook_event_name: 'SessionStart',
    }))
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('query error')
  })
})
