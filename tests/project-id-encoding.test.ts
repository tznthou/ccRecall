// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { runIndexer } from '../src/core/indexer.js'
import { createServer } from '../src/api/server.js'
import { resolveProjectId } from '../src/core/project-id.js'
import { resolveProjectId as resolveProjectIdMjs } from '../hooks/lib/project-id.mjs'
import { fetchJson } from './fixtures/helpers.js'

// #89: cwd → project_id encoding drift.
//
// Claude Code encodes a project directory under ~/.claude/projects/ by
// replacing every character outside [A-Za-z0-9] with '-'. ccRecall replaced
// only '/', so any cwd containing a space, a dot, an underscore or CJK
// produced a key that matches no directory on disk. Every lookup keyed on it
// missed silently: /session/last 404s, the extraction wrapper reads an empty
// sessionId and skips with reason "no-session-id", and the project stores
// zero memories forever with no error anywhere.
//
// Verified 2026-08-08 against every project directory on a real machine that
// carried a recoverable cwd: char-wise reproduced 24/24 directory names,
// slash-only reproduced 21/24. The three misses were a space, a dot, and CJK.
//
// These cases are the regression floor. The encoding is Claude Code's, not
// ours — if it ever changes, these assertions are what tells us.
const CASES: Array<{ name: string; cwd: string; expected: string }> = [
  {
    name: 'space (the #89 field case)',
    cwd: '/home/user/Documents/Practice/6 novel writing',
    expected: '-home-user-Documents-Practice-6-novel-writing',
  },
  {
    name: 'CJK — one dash per character, never per byte',
    cwd: '/home/user/Documents/專案',
    expected: '-home-user-Documents---',
  },
  {
    name: 'dot',
    cwd: '/tmp/claude-review-demo.AbCdEf',
    expected: '-tmp-claude-review-demo-AbCdEf',
  },
  {
    name: 'underscore',
    cwd: '/home/user/my_project',
    expected: '-home-user-my-project',
  },
  {
    name: 'plain path — unchanged behaviour',
    cwd: '/home/user/Documents/markdown-tool',
    expected: '-home-user-Documents-markdown-tool',
  },
  {
    name: 'mixed: CJK plus space plus digits',
    cwd: '/home/user/Documents/Obsidian/60-Blog/AI 專案-20260722',
    expected: '-home-user-Documents-Obsidian-60-Blog-AI----20260722',
  },
]

describe('#89 resolveProjectId — char-wise encoding', () => {
  // BSD sed is byte-wise: s|[^A-Za-z0-9]|-|g emits three dashes per CJK
  // character. The assertion below is what makes a byte-wise implementation
  // fail loudly instead of drifting again.
  for (const c of CASES) {
    it(`src: ${c.name}`, () => {
      expect(resolveProjectId(c.cwd)).toBe(c.expected)
    })
  }

  // The hooks ship as standalone .mjs (installed via npm, not bundled through
  // dist), so they cannot import the TypeScript module. The duplicate is
  // deliberate; this loop is what keeps the two copies from diverging.
  for (const c of CASES) {
    it(`hooks/lib: ${c.name}`, () => {
      expect(resolveProjectIdMjs(c.cwd)).toBe(c.expected)
    })
  }

  it('both implementations agree on every case', () => {
    for (const c of CASES) {
      expect(resolveProjectIdMjs(c.cwd)).toBe(resolveProjectId(c.cwd))
    }
  })

  it('handles empty and non-string input without throwing', () => {
    expect(resolveProjectId('')).toBe('')
    expect(resolveProjectIdMjs('')).toBe('')
    expect(resolveProjectId(undefined as unknown as string)).toBe('')
    expect(resolveProjectIdMjs(undefined as unknown as string)).toBe('')
  })
})

// UUID-shaped: the extraction wrapper validates the returned sessionId
// against a UUID regex before using it in a filesystem path.
const sessionId = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'

// Message uuids must be unique per session — the indexer dedups by uuid
// across sessions (resume support), so shared uuids silently empty a session.
const session = [
  { type: 'user', uuid: 'enc-u1', timestamp: '2026-08-08T10:00:00Z', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'enc-a1', timestamp: '2026-08-08T10:00:30Z', message: { role: 'assistant', content: 'world' } },
]

async function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port))
  })
}

describe('#89 GET /session/last — resolves a cwd containing a space', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  // The cwd that reproduced the field failure: on disk Claude Code writes
  // "...-Practice-6-novel-writing", the old rule asked for
  // "...-Practice-6 novel writing", and the two never met.
  const cwd = '/home/user/Documents/Practice/6 novel writing'
  const encodedDir = '-home-user-Documents-Practice-6-novel-writing'

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-pid-enc-'))
    const projectsDir = path.join(tmpDir, 'projects')
    await mkdir(path.join(projectsDir, encodedDir), { recursive: true })
    await writeFile(
      path.join(projectsDir, encodedDir, `${sessionId}.jsonl`),
      session.map(l => JSON.stringify(l)).join('\n'),
    )

    db = new Database(path.join(tmpDir, 'test.db'))
    await runIndexer(db, undefined, projectsDir)
    server = createServer(db)
    port = await listen(server)
  })

  afterEach(async () => {
    server.close()
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the session instead of 404', async () => {
    const { status, body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=${encodeURIComponent(cwd)}`,
    )
    expect(status).toBe(200)
    expect((body as { sessionId: string }).sessionId).toBe(sessionId)
  })

  it('returns the on-disk project id, so callers never re-derive it', async () => {
    const { body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=${encodeURIComponent(cwd)}`,
    )
    expect((body as { projectId: string }).projectId).toBe(encodedDir)
  })
})
