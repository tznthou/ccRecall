import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/session-end.mjs',
)

type Received = { path: string | undefined; method: string | undefined; body: string }

function startMockServer(): Promise<{ server: http.Server; port: number; received: Received[] }> {
  return new Promise((resolve) => {
    const received: Received[] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString() })
      req.on('end', () => {
        received.push({ path: req.url, method: req.method, body })
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, memoriesSaved: [1] }))
      })
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

describe('hooks/session-end.mjs', () => {
  let server: http.Server
  let port: number
  let received: Received[]

  beforeEach(async () => {
    const ctx = await startMockServer()
    server = ctx.server
    port = ctx.port
    received = ctx.received
  })

  afterEach(() => {
    if (server.listening) server.close()
  })

  it('POSTs sessionId to /session/end on normal end', async () => {
    const { code } = await runHook(port, JSON.stringify({
      session_id: 'abc-123',
      transcript_path: '/tmp/x',
      cwd: '/tmp',
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    }))
    expect(code).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0].path).toBe('/session/end')
    expect(received[0].method).toBe('POST')
    expect(JSON.parse(received[0].body)).toEqual({ sessionId: 'abc-123' })
  })

  it('skips POST when reason is "resume"', async () => {
    const { code } = await runHook(port, JSON.stringify({
      session_id: 'abc',
      reason: 'resume',
      hook_event_name: 'SessionEnd',
    }))
    expect(code).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('skips POST when session_id is missing', async () => {
    const { code } = await runHook(port, JSON.stringify({
      reason: 'logout',
      hook_event_name: 'SessionEnd',
    }))
    expect(code).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('exits 0 and logs on invalid JSON stdin', async () => {
    const { code, stderr } = await runHook(port, 'not valid json {{{')
    expect(code).toBe(0)
    expect(stderr).toContain('failed to parse')
    expect(received).toHaveLength(0)
  })

  it('exits 0 and logs when service unreachable', async () => {
    server.close()
    await new Promise<void>((resolve) => server.on('close', () => resolve()))
    const { code, stderr } = await runHook(port, JSON.stringify({
      session_id: 'x',
      reason: 'logout',
      hook_event_name: 'SessionEnd',
    }))
    expect(code).toBe(0)
    expect(stderr).toContain('harvest error')
  })
})
