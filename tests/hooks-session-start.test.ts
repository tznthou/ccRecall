// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/session-start.mjs',
)

// Default HOME for spawned hooks — telemetry writes go to $HOME/.ccrecall,
// so every test must run against a throwaway HOME, never the real one.
let defaultTmpHome: string

type MemoryShape = { content: string; source: string; confidence: number; depth: null }
type Received = { path: string | undefined; method: string | undefined }

function startMockServer(
  responder: (received: Received) => { status: number; memories: MemoryShape[]; extra?: Record<string, unknown> },
  opts?: { memoryCount?: number },
): Promise<{ server: http.Server; port: number; received: Received[] }> {
  return new Promise((resolve) => {
    const received: Received[] = []
    const server = http.createServer((req, res) => {
      const entry: Received = { path: req.url, method: req.method }
      received.push(entry)
      res.setHeader('Content-Type', 'application/json')

      if (req.url?.startsWith('/health')) {
        res.statusCode = 200
        res.end(JSON.stringify({ status: 'ok', memoryCount: opts?.memoryCount ?? 31 }))
        return
      }

      const { status, memories, extra } = responder(entry)
      res.statusCode = status
      const body = { memories, totalTokenEstimate: 0, query: '', limit: 5, ...(extra ?? {}) }
      res.end(JSON.stringify(body))
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
  envOverrides: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SCRIPT_PATH], {
      env: {
        ...process.env,
        // Strip operator env overrides so the default-strategy and telemetry
        // assertions pass under a parent shell that exports them.
        CCRECALL_SESSION_START_STRATEGY: undefined,
        CCRECALL_TELEMETRY: undefined,
        HOME: defaultTmpHome,
        CCRECALL_PORT: String(port),
        ...envOverrides,
      },
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

  beforeAll(async () => {
    defaultTmpHome = await mkdtemp(path.join(os.tmpdir(), 'cchooks-home-'))
  })

  afterAll(async () => {
    await rm(defaultTmpHome, { recursive: true, force: true })
  })

  afterEach(() => {
    if (server && server.listening) server.close()
    server = null
  })

  it('legacy strategy queries /memory/query with cwd basename and writes memories to stdout', async () => {
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
    }), { CCRECALL_SESSION_START_STRATEGY: 'legacy' })

    expect(code).toBe(0)
    expect(ctx.received).toHaveLength(1)
    expect(ctx.received[0].method).toBe('GET')
    expect(ctx.received[0].path).toContain('/memory/query')
    expect(ctx.received[0].path).toContain('q=ccRecall')
    expect(ctx.received[0].path).toContain('limit=5')
    expect(ctx.received[0].path).toContain('project=-Users-tznthou-Documents-ccRecall')

    expect(stdout).toContain('[ccRecall memory recall]')
    expect(stdout).toContain('ccRecall uses Apache-2.0 license')
    expect(stdout).toContain('(conf 0.90)')
    expect(stdout).toContain('prefer pnpm over npm')
    expect(stdout).toContain('matched via project keyword: "ccRecall"')
  })

  it('writes nothing when no memories match', async () => {
    const ctx = await startMockServer(() => ({ status: 200, memories: [] }), { memoryCount: 0 })
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, JSON.stringify({
      session_id: 'x',
      cwd: '/Users/tznthou/Documents/empty-project',
      source: 'startup',
      hook_event_name: 'SessionStart',
    }))

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(ctx.received).toHaveLength(2)
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

  it('default (startup-v1) strategy hits /memory/startup and /health', async () => {
    const ctx = await startMockServer(() => ({
      status: 200,
      memories: [],
      extra: { emittedIds: [], candidateCount: 0, droppedCount: 0 },
    }))
    server = ctx.server
    await runHook(ctx.port, JSON.stringify({
      session_id: 'x',
      cwd: '/Users/tznthou/Documents/ccRecall',
      source: 'startup',
      hook_event_name: 'SessionStart',
    }))
    expect(ctx.received).toHaveLength(2)
    const startupReq = ctx.received.find(r => r.path?.includes('/memory/startup'))
    const healthReq = ctx.received.find(r => r.path?.includes('/health'))
    expect(startupReq).toBeDefined()
    expect(startupReq!.path).toContain('maxTokens=300')
    expect(healthReq).toBeDefined()
  })

  it('startup-v1 strategy hits /memory/startup and writes telemetry JSONL', async () => {
    const ctx = await startMockServer(() => ({
      status: 200,
      memories: [
        { content: '漸進披露探索法', source: 'manual', confidence: 0.9, depth: null },
      ],
      extra: { emittedIds: [42], candidateCount: 3, droppedCount: 1 },
    }))
    server = ctx.server

    const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'cchooks-'))
    try {
      const { code, stdout } = await runHook(ctx.port, JSON.stringify({
        session_id: 'x',
        cwd: '/Users/tznthou/Documents/ccRecall',
        source: 'startup',
        hook_event_name: 'SessionStart',
      }), { CCRECALL_SESSION_START_STRATEGY: 'startup-v1', HOME: tmpHome })

      expect(code).toBe(0)
      expect(ctx.received).toHaveLength(2)
      const startupReq = ctx.received.find(r => r.path?.includes('/memory/startup'))
      expect(startupReq).toBeDefined()
      expect(startupReq!.path).toContain('project=-Users-tznthou-Documents-ccRecall')
      expect(startupReq!.path).toContain('maxTokens=300')
      expect(stdout).toContain('漸進披露探索法')
      expect(stdout).toContain('memories available')

      const logPath = path.join(tmpHome, '.ccrecall', 'startup-recall.log.jsonl')
      const logContent = await readFile(logPath, 'utf8')
      const lines = logContent.trim().split('\n')
      expect(lines).toHaveLength(1)
      const record = JSON.parse(lines[0])
      expect(record.emittedIds).toEqual([42])
      expect(record.droppedCount).toBe(1)
      expect(record.projectId).toBe('-Users-tznthou-Documents-ccRecall')
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })

  it('off strategy makes no HTTP call and emits nothing', async () => {
    const ctx = await startMockServer(() => ({ status: 200, memories: [] }))
    server = ctx.server
    const { code, stdout } = await runHook(ctx.port, JSON.stringify({
      session_id: 'x',
      cwd: '/Users/tznthou/Documents/ccRecall',
      source: 'startup',
      hook_event_name: 'SessionStart',
    }), { CCRECALL_SESSION_START_STRATEGY: 'off' })
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(ctx.received).toHaveLength(0)
  })
})
