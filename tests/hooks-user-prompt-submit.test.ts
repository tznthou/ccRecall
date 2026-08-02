// SPDX-License-Identifier: Apache-2.0
//
// L1 mid-conversation recall hook. SessionStart fires once and everything after
// it ran with no memory access; this hook is the second trigger point.
//
// It runs on EVERY prompt and blocks the user's keystroke-to-response path, so
// the assertions here are mostly about restraint: skip cheaply, fail open, and
// never let a slow or dead daemon cost the user anything.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/user-prompt-submit.mjs',
)

let tmpHome: string

type PromptMemory = { id: number; content: string; source: string; confidence: number; key: string | null }

function startMockServer(
  respond: (url: string) => { memories: PromptMemory[]; throttled?: boolean },
): Promise<{ server: http.Server; port: number; urls: string[] }> {
  return new Promise((resolve) => {
    const urls: string[] = []
    const server = http.createServer((req, res) => {
      urls.push(req.url ?? '')
      const { memories, throttled } = respond(req.url ?? '')
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = 200
      res.end(JSON.stringify({
        memories,
        emittedIds: memories.map(m => m.id),
        droppedCount: 0,
        throttled: throttled ?? false,
      }))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port, urls })
    })
  })
}

function runHook(port: number, input: unknown): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CCRECALL_PORT: String(port), HOME: tmpHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on('data', () => { /* diagnostics only */ })
    proc.on('close', code => resolve({ code, stdout }))
    proc.on('error', reject)
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}

const basePrompt = {
  session_id: 'sess-1',
  cwd: '/Users/tznthou/Documents/ccRecall',
  hook_event_name: 'UserPromptSubmit',
}

describe('hooks/user-prompt-submit.mjs', () => {
  let server: http.Server | null = null

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-l1-home-'))
  })

  afterEach(async () => {
    if (server && server.listening) server.close()
    server = null
    await rm(tmpHome, { recursive: true, force: true })
  })

  it('injects a matching memory with its key as a handle', async () => {
    const ctx = await startMockServer(() => ({
      memories: [{
        id: 5,
        content: 'BSD mktemp only substitutes trailing X characters',
        source: 's:5',
        confidence: 0.9,
        key: 'bsd-mktemp-trailing-x-only',
      }],
    }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, {
      ...basePrompt,
      prompt: 'why does our mktemp call collapse onto one path',
    })

    expect(code).toBe(0)
    expect(stdout).toContain('BSD mktemp only substitutes')
    expect(stdout).toContain('bsd-mktemp-trailing-x-only')
    expect(stdout).toMatch(/excerpt/i)
  })

  it('passes project, session and prompt through to the daemon', async () => {
    const ctx = await startMockServer(() => ({ memories: [] }))
    server = ctx.server

    await runHook(ctx.port, { ...basePrompt, prompt: 'how do we handle zsh escaping here' })

    expect(ctx.urls).toHaveLength(1)
    const u = ctx.urls[0]
    expect(u).toContain('/memory/prompt')
    expect(u).toContain('project=-Users-tznthou-Documents-ccRecall')
    expect(u).toContain('sessionId=sess-1')
    expect(u).toContain('zsh')
  })

  it('stays silent when the daemon reports the session is throttled', async () => {
    const ctx = await startMockServer(() => ({ memories: [], throttled: true }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, {
      ...basePrompt,
      prompt: 'another question about the extraction pipeline',
    })

    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('skips short prompts without calling the daemon at all', async () => {
    const ctx = await startMockServer(() => ({ memories: [] }))
    server = ctx.server

    for (const prompt of ['ok', '繼續', 'yes do it']) {
      const { code, stdout } = await runHook(ctx.port, { ...basePrompt, prompt })
      expect(code).toBe(0)
      expect(stdout).toBe('')
    }
    // Continuations carry no new subject — spending a round trip on them would
    // be pure latency on the user's critical path.
    expect(ctx.urls).toHaveLength(0)
  })

  it('skips slash commands without calling the daemon', async () => {
    const ctx = await startMockServer(() => ({ memories: [] }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, {
      ...basePrompt,
      prompt: '/save-t wrap up this session please',
    })

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(ctx.urls).toHaveLength(0)
  })

  it('fails open when the daemon is unreachable', async () => {
    // Port with nothing listening — the hook must not block or error the prompt.
    const { code, stdout } = await runHook(1, {
      ...basePrompt,
      prompt: 'a perfectly reasonable question about mktemp behaviour',
    })
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('does nothing at all when disabled by env', async () => {
    const ctx = await startMockServer(() => ({
      memories: [{ id: 1, content: 'x', source: 's', confidence: 1, key: 'k' }],
    }))
    server = ctx.server

    const proc = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const p = spawn('node', [SCRIPT_PATH], {
        env: { ...process.env, CCRECALL_PORT: String(ctx.port), HOME: tmpHome, CCRECALL_PROMPT_RECALL: 'off' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      p.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
      p.on('close', code => resolve({ code, stdout }))
      p.on('error', reject)
      p.stdin.write(JSON.stringify({ ...basePrompt, prompt: 'a question that would otherwise match' }))
      p.stdin.end()
    })

    expect(proc.code).toBe(0)
    expect(proc.stdout).toBe('')
    expect(ctx.urls).toHaveLength(0)
  })

  it('emits nothing when there is no relevant memory', async () => {
    const ctx = await startMockServer(() => ({ memories: [] }))
    server = ctx.server

    const { code, stdout } = await runHook(ctx.port, {
      ...basePrompt,
      prompt: 'a question about something we have never discussed',
    })

    expect(code).toBe(0)
    expect(stdout).toBe('')
  })
})
