// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { Database } from '../src/core/database.js'
import { createServer } from '../src/api/server.js'

function postJson(
  url: string,
  payload: unknown,
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

describe('POST /journal/promote (#21 P1 step 6)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-promote-'))
    db = new Database(path.join(tmpDir, 'test.db'))
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

  it('promotes a pending journal entry to memories with default type/confidence', async () => {
    const journalId = db.saveJournalEntry({
      content: 'Root cause: token expiry. Fix verified.',
      score: 3,
      reasonsJson: '["decision-language","cause-effect","validation"]',
    })
    expect(db.getMemoryCount()).toBe(0)

    const { status, body } = await postJson(
      `http://127.0.0.1:${port}/journal/promote`,
      { id: journalId },
    )
    expect(status).toBe(200)
    const b = body as { ok: boolean; memoryId: number; journalId: number }
    expect(b.ok).toBe(true)
    expect(b.journalId).toBe(journalId)
    expect(b.memoryId).toBeGreaterThan(0)

    // Memories table now has the row
    expect(db.getMemoryCount()).toBe(1)

    // Journal status flipped
    const after = db.getJournalEntry(journalId)
    expect(after?.status).toBe('promoted')
    expect(after?.promotedMemoryId).toBe(b.memoryId)
  })

  it('respects type / confidence overrides', async () => {
    const journalId = db.saveJournalEntry({
      content: 'A decision the user wants tagged explicitly.',
      score: 2,
    })
    const { status } = await postJson(
      `http://127.0.0.1:${port}/journal/promote`,
      { id: journalId, type: 'decision', confidence: 0.9 },
    )
    expect(status).toBe(200)

    const memories = db.queryMemories('decision the user', 10)
    expect(memories).toHaveLength(1)
    expect(memories[0].type).toBe('decision')
    expect(memories[0].confidence).toBe(0.9)
  })

  it('returns 404 for non-existent id', async () => {
    const { status, body } = await postJson(
      `http://127.0.0.1:${port}/journal/promote`,
      { id: 99999 },
    )
    expect(status).toBe(404)
    expect((body as { error: string }).error).toMatch(/not found/)
  })

  it('returns 409 when entry is already promoted (idempotency boundary)', async () => {
    const journalId = db.saveJournalEntry({ content: 'one-shot promote', score: 2 })
    const first = await postJson(
      `http://127.0.0.1:${port}/journal/promote`,
      { id: journalId },
    )
    expect(first.status).toBe(200)

    const second = await postJson(
      `http://127.0.0.1:${port}/journal/promote`,
      { id: journalId },
    )
    expect(second.status).toBe(409)
    expect((second.body as { error: string }).error).toMatch(/promoted/)
  })

  it('rejects invalid id with 400', async () => {
    const { status } = await postJson(
      `http://127.0.0.1:${port}/journal/promote`,
      { id: -1 },
    )
    expect(status).toBe(400)
  })

  it('rejects invalid confidence with 400', async () => {
    const journalId = db.saveJournalEntry({ content: 'bad confidence', score: 0 })
    const { status } = await postJson(
      `http://127.0.0.1:${port}/journal/promote`,
      { id: journalId, confidence: 1.5 },
    )
    expect(status).toBe(400)
  })
})

describe('POST /journal/reject (#21 P1 step 6)', () => {
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-reject-'))
    db = new Database(path.join(tmpDir, 'test.db'))
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

  it('flips status to rejected and sets expires_at ~7 days out', async () => {
    const journalId = db.saveJournalEntry({ content: 'noise candidate', score: 0 })

    const before = Date.now()
    const { status, body } = await postJson(
      `http://127.0.0.1:${port}/journal/reject`,
      { id: journalId },
    )
    expect(status).toBe(200)
    const b = body as { ok: boolean; journalId: number; expiresAt: string }
    expect(b.ok).toBe(true)
    expect(b.journalId).toBe(journalId)

    const expiresMs = Date.parse(b.expiresAt)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000)
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + sevenDaysMs + 1000)

    const after = db.getJournalEntry(journalId)
    expect(after?.status).toBe('rejected')
    expect(after?.expiresAt).toBe(b.expiresAt)
  })

  it('does not affect memories table', async () => {
    const journalId = db.saveJournalEntry({ content: 'reject-only', score: 0 })
    await postJson(`http://127.0.0.1:${port}/journal/reject`, { id: journalId })
    expect(db.getMemoryCount()).toBe(0)
  })

  it('returns 404 for already-rejected entries', async () => {
    const journalId = db.saveJournalEntry({ content: 'double reject', score: 0 })
    await postJson(`http://127.0.0.1:${port}/journal/reject`, { id: journalId })
    const second = await postJson(
      `http://127.0.0.1:${port}/journal/reject`,
      { id: journalId },
    )
    expect(second.status).toBe(404)
  })
})
