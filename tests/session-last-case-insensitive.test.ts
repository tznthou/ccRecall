// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { runIndexer } from '../src/core/indexer.js'
import { createServer } from '../src/api/server.js'
import { fetchJson } from './fixtures/helpers.js'

// macOS APFS is case-insensitive: `cd ~/notes` succeeds against a directory
// really named `Notes`, and $PWD keeps whatever the user typed. Claude Code
// names its project folder from the real path, so the wrapper's derived id
// (`-Users-…-notes`) and the indexed one (`-Users-…-Notes`)
// differ by case alone. resolveProjectId is a pure encoder and cannot know
// this; the exact-match lookup then misses and the wrapper logs
// `mode=skip reason=no-session-id` — extraction never runs and nothing reports
// an error.
//
// Measured 2026-09-21 on the live telemetry: of the 14 no-session-id skips
// carrying a cwd (the field landed 2026-08-10), 7 were this and 7 had an
// exactly matching directory. Four of those sessions still had their
// transcripts on disk, 575KB–1.7MB each, with zero memories extracted.
//
// The fallback must stay a fallback. On a case-sensitive filesystem `/foo` and
// `/Foo` are genuinely different projects, so an exact hit always wins and an
// ambiguous case-insensitive hit resolves to nothing rather than guessing.

function makeSession(prefix: string, t1: string, t2: string) {
  return [
    { type: 'user', uuid: `${prefix}-u1`, timestamp: t1, message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: `${prefix}-a1`, timestamp: t2, message: { role: 'assistant', content: 'world' } },
  ]
}

const upperSessionId = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
const lowerSessionId = '99998888-7777-4666-8555-444433332222'

async function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port))
  })
}

describe('getLastSession — case-insensitive fallback', () => {
  let tmpDir: string
  let db: Database
  let projectsDir: string

  async function writeProject(dirName: string, sessionId: string, prefix: string, t: string) {
    const dir = path.join(projectsDir, dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      makeSession(prefix, t, t).map(l => JSON.stringify(l)).join('\n'),
    )
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-last-case-'))
    projectsDir = path.join(tmpDir, 'projects')
    await mkdir(projectsDir, { recursive: true })
    db = new Database(path.join(tmpDir, 'test.db'))
  })

  afterEach(async () => {
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('finds a session whose indexed project id differs only by case', async () => {
    await writeProject('-test-Obsidian-Blog', upperSessionId, 'up', '2026-09-12T10:00:00Z')
    await runIndexer(db, undefined, projectsDir)

    expect(db.getLastSession('-test-Obsidian-Blog')?.id).toBe(upperSessionId)
    // What the wrapper actually derives from a lowercase $PWD:
    expect(db.getLastSession('-test-obsidian-blog')?.id).toBe(upperSessionId)
  })

  // Two project ids differing only by case cannot be produced through the
  // filesystem here: macOS tmpdir is itself case-insensitive, so the second
  // mkdir lands in the first directory and both sessions index under one id
  // (verified 2026-09-21 — the earlier filesystem-based version of these two
  // tests failed for exactly that reason, not because of the lookup). Rows go
  // in directly instead, which is also how the pair arises in practice: a
  // directory whose case changed leaves the old spelling behind in the DB.
  function insertSessionRow(projectId: string, sessionId: string, startedAt: string) {
    db.upsertProject(projectId, projectId)
    db.rawExec(
      `INSERT INTO sessions (id, project_id, file_path, started_at, ended_at, message_count, archived)
       VALUES ('${sessionId}', '${projectId}', '/dev/null', '${startedAt}', '${startedAt}', 2, 0)`,
    )
  }

  it('prefers an exact match over a case variant', () => {
    // The variant carries the NEWER session, so a fallback that ignores the
    // exact hit would return it.
    insertSessionRow('-test-Dup', upperSessionId, '2026-09-12T12:00:00Z')
    insertSessionRow('-test-dup', lowerSessionId, '2026-09-12T09:00:00Z')

    expect(db.getLastSession('-test-dup')?.id).toBe(lowerSessionId)
    expect(db.getLastSession('-test-Dup')?.id).toBe(upperSessionId)
  })

  it('refuses to guess when several projects differ only by case', () => {
    insertSessionRow('-test-Amb', upperSessionId, '2026-09-12T12:00:00Z')
    insertSessionRow('-test-aMb', lowerSessionId, '2026-09-12T09:00:00Z')

    // Neither is an exact match for this spelling, and picking either one
    // would extract the wrong project's session.
    expect(db.getLastSession('-test-amb')).toBeNull()
  })

  it('does not count a variant holding only unusable rows as ambiguity', () => {
    // The guards run on the variant scan as well as the row fetch, so a
    // spelling whose every session is archived drops out before the ambiguity
    // check instead of blocking a sibling that does have a live session.
    // Without them this resolves to null and extraction skips — the very
    // failure the fallback exists to stop. (Mutation-checked 2026-09-21:
    // stripping the guards from the variant scan leaves every other test in
    // this file green.)
    insertSessionRow('-test-Dead', upperSessionId, '2026-09-12T12:00:00Z')
    db.rawExec(`UPDATE sessions SET archived = 1 WHERE id = '${upperSessionId}'`)
    insertSessionRow('-test-dead', lowerSessionId, '2026-09-12T09:00:00Z')

    expect(db.getLastSession('-test-DEAD')?.id).toBe(lowerSessionId)
  })

  it('still returns null when no project matches in any case', async () => {
    await writeProject('-test-Real', upperSessionId, 'up', '2026-09-12T10:00:00Z')
    await runIndexer(db, undefined, projectsDir)

    expect(db.getLastSession('-test-absent')).toBeNull()
  })

  it('applies the archived filter on the fallback path too', async () => {
    await writeProject('-test-Arch', upperSessionId, 'up', '2026-09-12T10:00:00Z')
    await runIndexer(db, undefined, projectsDir)
    db.rawExec(`UPDATE sessions SET archived = 1 WHERE id = '${upperSessionId}'`)

    // The exact-match path excludes archived rows; the fallback must not become
    // a way around that guard.
    expect(db.getLastSession('-test-Arch')).toBeNull()
    expect(db.getLastSession('-test-arch')).toBeNull()
  })

  it('applies the subagent filter on the fallback path too', async () => {
    await writeProject('-test-Sub', upperSessionId, 'up', '2026-09-12T10:00:00Z')
    await runIndexer(db, undefined, projectsDir)
    // A composite "<parent>/agent-…" id is never a main session. Mirrors the
    // registry-timing window getLastSession's exact path already guards.
    db.rawExec(
      `INSERT INTO sessions (id, project_id, file_path, started_at, ended_at, message_count, archived)
       VALUES ('${upperSessionId}/agent-deadbeef', '-test-Sub', '/dev/null',
               '2026-09-12T23:00:00Z', '2026-09-12T23:01:00Z', 2, 0)`,
    )

    expect(db.getLastSession('-test-Sub')?.id).toBe(upperSessionId)
    expect(db.getLastSession('-test-sub')?.id).toBe(upperSessionId)
  })
})

describe('GET /session/last — case-insensitive cwd', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-last-case-http-'))
    const projectsDir = path.join(tmpDir, 'projects')
    const dir = path.join(projectsDir, '-test-Obsidian-Blog')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, `${upperSessionId}.jsonl`),
      makeSession('up', '2026-09-12T10:00:00Z', '2026-09-12T10:00:30Z')
        .map(l => JSON.stringify(l)).join('\n'),
    )
    db = new Database(path.join(tmpDir, 'test.db'))
    await runIndexer(db, undefined, projectsDir)
    server = createServer(db, { rescueReindex: () => runIndexer(db, undefined, projectsDir) })
    port = await listen(server)
  })

  afterEach(async () => {
    server.close()
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('resolves a lowercase cwd to the differently-cased indexed project', async () => {
    // Exactly the shape that skipped extraction in production: the user typed
    // a lowercase path, the directory on disk is capitalised.
    const { status, body } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=${encodeURIComponent('/test/obsidian/blog')}`,
    )
    expect(status).toBe(200)
    expect((body as { sessionId: string }).sessionId).toBe(upperSessionId)
    // projectId must be the INDEXED spelling: the wrapper builds
    // ~/.claude/projects/<projectId>/<sessionId>.jsonl from it, and the
    // lowercase spelling names no directory on a case-sensitive filesystem.
    expect((body as { projectId: string }).projectId).toBe('-test-Obsidian-Blog')
  })

  it('still 404s for a project that does not exist in any case', async () => {
    const { status } = await fetchJson(
      `http://127.0.0.1:${port}/session/last?cwd=${encodeURIComponent('/test/nowhere')}`,
    )
    expect(status).toBe(404)
  })
})
