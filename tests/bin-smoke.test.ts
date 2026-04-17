import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, mkdtemp, rm, stat, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.js')
const DIST_MCP = path.join(REPO_ROOT, 'dist', 'mcp', 'server.js')

async function assertBuilt(): Promise<void> {
  try {
    await stat(DIST_INDEX)
    await stat(DIST_MCP)
  } catch {
    throw new Error('dist bins missing — run `pnpm build` before `pnpm vitest run`')
  }
}

describe('bin packaging — shebang & permissions', () => {
  beforeAll(async () => {
    await assertBuilt()
  })

  it('dist/index.js starts with #!/usr/bin/env node', async () => {
    const content = await readFile(DIST_INDEX, 'utf8')
    expect(content.split('\n', 1)[0]).toBe('#!/usr/bin/env node')
  })

  it('dist/mcp/server.js starts with #!/usr/bin/env node', async () => {
    const content = await readFile(DIST_MCP, 'utf8')
    expect(content.split('\n', 1)[0]).toBe('#!/usr/bin/env node')
  })

  it('dist/index.js is executable', async () => {
    await expect(access(DIST_INDEX, fsConstants.X_OK)).resolves.toBeUndefined()
  })

  it('dist/mcp/server.js is executable', async () => {
    await expect(access(DIST_MCP, fsConstants.X_OK)).resolves.toBeUndefined()
  })
})

describe('bin packaging — MCP stdio boot', () => {
  let tmpDir: string
  let child: ChildProcessWithoutNullStreams | null = null

  beforeAll(async () => {
    await assertBuilt()
  })

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 50))
      if (!child.killed) child.kill('SIGKILL')
    }
    child = null
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  it('node dist/mcp/server.js responds to MCP initialize + tools/list', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-bin-smoke-'))
    const dbPath = path.join(tmpDir, 'ccrecall.db')

    child = spawn('node', [DIST_MCP], {
      env: { ...process.env, CCRECALL_DB_PATH: dbPath },
      cwd: REPO_ROOT,
    }) as ChildProcessWithoutNullStreams

    let stdoutBuf = ''
    const responses: Record<string, unknown>[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      let nl = stdoutBuf.indexOf('\n')
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line) as Record<string, unknown>)
          } catch {
            // Non-JSON line — ignore (should not happen on stdout for MCP)
          }
        }
        nl = stdoutBuf.indexOf('\n')
      }
    })

    const initialize = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bin-smoke', version: '1.0.0' },
      },
    }
    child.stdin.write(JSON.stringify(initialize) + '\n')

    // Poll for the initialize response, then send tools/list.
    const deadline = Date.now() + 5000
    while (!responses.find(r => r.id === 1) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const initResponse = responses.find(r => r.id === 1)
    expect(initResponse).toBeDefined()

    // MCP spec: client sends `notifications/initialized` after handshake so the
    // server flips to "initialized" state before accepting further requests.
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
    child.stdin.write(JSON.stringify(initialized) + '\n')

    const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    child.stdin.write(JSON.stringify(toolsList) + '\n')

    const deadline2 = Date.now() + 5000
    while (!responses.find(r => r.id === 2) && Date.now() < deadline2) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const listResponse = responses.find(r => r.id === 2) as
      | { result?: { tools?: Array<{ name: string }> } } | undefined
    expect(listResponse).toBeDefined()
    const toolNames = (listResponse?.result?.tools ?? []).map(t => t.name)
    expect(toolNames).toContain('recall_query')
  }, 15_000)
})
