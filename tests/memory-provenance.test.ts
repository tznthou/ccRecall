// SPDX-License-Identifier: Apache-2.0
//
// Q1 (2026-09-11) — message-level provenance for extracted memories.
//
// Background: 0 of 1,639 memories carried a `message_id`. The column and the
// `recall_save` parameter both existed; nothing ever filled them, because the
// extraction transcript carried no message identity at all — the model was
// shown `--- human ---` headers and had nothing to point at. A memory that
// turns out to be wrong is therefore unattributable: no way to tell an
// extraction hallucination from something that really was said.
//
// The fix has three parts and this file guards the third:
//   1. the wrapper stamps each transcript header with the message uuid,
//   2. the prompt tells the model to pass the uuid it drew the memory from,
//   3. the write path REFUSES a uuid it cannot find in this session.
//
// Part 3 exists because part 2 is a small model copying a 36-char hex string
// out of a 200KB transcript. `message_id` is only worth having if a value in
// it means something, so an unverifiable uuid is dropped (the memory is still
// saved — provenance is additive, never a reason to lose the insight).
//
// 🔴 What this DOES NOT claim: that the cited message entails the memory. The
// check is existence and session ownership only. A model can pass a real uuid
// from an unrelated turn and it will be stored. Borrowed from cairn-memory's
// extract prompt, which states the same boundary outright: "selecting an index
// is not proof of entailment". Anything stronger needs the message text
// compared against the memory, which is the heavyweight receipts design we
// deliberately did not build.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import type { IndexSessionParams, MessageInput } from '../src/core/database'
import { recallSaveHandler } from '../src/mcp/tools'

let tmpDir: string
let db: Database

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

function msg(uuid: string | null, sequence: number): MessageInput {
  return {
    type: 'user',
    uuid,
    role: 'user',
    contentText: `message ${sequence}`,
    contentJson: null,
    hasToolUse: false,
    hasToolResult: false,
    toolNames: [],
    timestamp: '2026-09-11T00:00:00Z',
    sequence,
    rawJson: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    model: null,
  }
}

function indexSession(sessionId: string, uuids: Array<string | null>): void {
  const params: IndexSessionParams = {
    sessionId,
    projectId: '-tmp-proj',
    projectDisplayName: 'proj',
    title: 'test session',
    messageCount: uuids.length,
    filePath: `/tmp/${sessionId}.jsonl`,
    fileSize: 100,
    fileMtime: '2026-09-11T00:00:00Z',
    startedAt: '2026-09-11T00:00:00Z',
    endedAt: '2026-09-11T01:00:00Z',
    messages: uuids.map((u, i) => msg(u, i)),
  }
  db.indexSession(params)
}

function messageIdOf(memoryId: number): string | null {
  return db.rawAll<{ message_id: string | null }>(
    `SELECT message_id FROM memories WHERE id = ${memoryId}`,
  )[0].message_id
}

function savedId(text: string): number {
  const m = text.match(/Saved memory #(\d+)/)
  if (!m) throw new Error(`no memory id in result: ${text}`)
  return Number(m[1])
}

const UUID_A1 = randomUUID()
const UUID_A2 = randomUUID()
const UUID_B1 = randomUUID()

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-provenance-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  indexSession(SESSION_A, [UUID_A1, UUID_A2])
  indexSession(SESSION_B, [UUID_B1])
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('Database.hasMessageUuid', () => {
  it('accepts a uuid indexed under the session that cites it', () => {
    expect(db.hasMessageUuid(UUID_A1, SESSION_A)).toBe(true)
    expect(db.hasMessageUuid(UUID_A2, SESSION_A)).toBe(true)
  })

  it("rejects a uuid belonging to a different session", () => {
    // The uuid is real; it is just not this session's. Accepting it would let
    // an extraction attribute a memory to a conversation it never read.
    expect(db.hasMessageUuid(UUID_B1, SESSION_A)).toBe(false)
  })

  it('rejects a uuid that was never indexed', () => {
    expect(db.hasMessageUuid(randomUUID(), SESSION_A)).toBe(false)
  })

  it('falls back to existence-only when the caller names no session', () => {
    // A hand-written recall_save has no session id. Ownership is unverifiable
    // there, so the weaker check is the honest one — but a fabricated uuid
    // still fails it, which is the property that makes the column meaningful.
    expect(db.hasMessageUuid(UUID_B1, null)).toBe(true)
    expect(db.hasMessageUuid(randomUUID(), null)).toBe(false)
  })

  it('rejects empty input and anything that is not a known uuid', () => {
    // Note what is NOT asserted: that the shape is validated. There is no uuid
    // regex in the check — a malformed value simply hashes to something no row
    // holds. Adding a format gate would make the column break the day Claude
    // Code changes its id format, and break silently.
    expect(db.hasMessageUuid('', SESSION_A)).toBe(false)
    expect(db.hasMessageUuid('   ', SESSION_A)).toBe(false)
    expect(db.hasMessageUuid('not-a-uuid', SESSION_A)).toBe(false)
    expect(db.hasMessageUuid(null, SESSION_A)).toBe(false)
  })

  it('tolerates the surrounding brackets the transcript header prints', () => {
    // The header reads `--- human [<uuid>] ---`; a model that copies the
    // bracket with the value should not lose its provenance over punctuation.
    expect(db.hasMessageUuid(`[${UUID_A1}]`, SESSION_A)).toBe(true)
  })
})

describe('recall_save: message provenance', () => {
  it('stores a verified uuid', () => {
    const res = recallSaveHandler(db, {
      content: 'Pre-verify a grep pattern before encoding it into an assertion.',
      type: 'pattern',
      sessionId: SESSION_A,
      messageId: UUID_A1,
      key: 'grep-preverify',
      origin: 'agent-inferred',
    })
    const id = savedId(res.content[0].text)
    expect(messageIdOf(id)).toBe(UUID_A1)
    // A verified citation is silent — the note exists to report a loss, and a
    // model told "dropped" on a successful save would learn to stop citing.
    expect(res.content[0].text).not.toMatch(/dropped/i)
  })

  it('normalises a bracketed uuid to the bare value', () => {
    const res = recallSaveHandler(db, {
      content: 'Bracketed citation still resolves.',
      type: 'discovery',
      sessionId: SESSION_A,
      messageId: `[${UUID_A2}]`,
      key: 'bracket-norm',
      origin: 'agent-inferred',
    })
    expect(messageIdOf(savedId(res.content[0].text))).toBe(UUID_A2)
  })

  it('saves the memory but drops a uuid it cannot verify', () => {
    const ghost = randomUUID()
    const res = recallSaveHandler(db, {
      content: 'An insight whose citation was invented.',
      type: 'discovery',
      sessionId: SESSION_A,
      messageId: ghost,
      key: 'ghost-citation',
      origin: 'agent-inferred',
    })
    const text = res.content[0].text
    const id = savedId(text)
    // The memory survives — provenance is additive, never a gate on content.
    expect(db.rawAll<{ content: string }>(
      `SELECT content FROM memories WHERE id = ${id}`,
    )[0].content).toContain('invented')
    expect(messageIdOf(id)).toBeNull()
    // And the drop is stated back to the caller. An extraction run has a hard
    // turn budget, so the wording must also tell it not to spend a turn
    // retrying.
    //
    // ⚠️ Both patterns are words only the note contains. The obvious third
    // assertion — that the note says the memory was saved — is unusable: the
    // line always opens `Saved memory #N`, so /saved/i passes with the note
    // deleted outright. Same self-satisfying shape the extraction-prompt test
    // has been caught by three times.
    expect(text).toMatch(/dropped/i)
    expect(text).toMatch(/do not retry/i)
    // The rejected value is not echoed back: it is a string the model invented,
    // and handing it straight back invites it to cite the same ghost again.
    expect(text).not.toContain(ghost)
  })

  it('drops a uuid that belongs to another session', () => {
    const res = recallSaveHandler(db, {
      content: 'Cited a message from an unrelated session.',
      type: 'discovery',
      sessionId: SESSION_A,
      messageId: UUID_B1,
      key: 'cross-session-citation',
      origin: 'agent-inferred',
    })
    expect(messageIdOf(savedId(res.content[0].text))).toBeNull()
  })

  it('says nothing about provenance when no uuid was offered', () => {
    const res = recallSaveHandler(db, {
      content: 'No citation attempted.',
      type: 'decision',
      sessionId: SESSION_A,
      key: 'no-citation',
      origin: 'agent-inferred',
    })
    const text = res.content[0].text
    expect(messageIdOf(savedId(text))).toBeNull()
    expect(text).not.toMatch(/dropped/i)
  })

  it('keeps provenance additive across an upsert that refuses the content', () => {
    // v0.7.3 guard: agent-inferred cannot overwrite explicit content, but it
    // may still contribute a message id the row is missing. Verification has
    // to run on that path too, or the guard becomes a way in for a uuid the
    // normal path would have rejected.
    const first = recallSaveHandler(db, {
      content: 'Hand-written original.',
      type: 'decision',
      sessionId: SESSION_A,
      key: 'shared-key',
    })
    const id = savedId(first.content[0].text)
    expect(messageIdOf(id)).toBeNull()

    recallSaveHandler(db, {
      content: 'Extraction rewrite, should not land.',
      type: 'discovery',
      sessionId: SESSION_A,
      messageId: UUID_B1, // wrong session — must not be adopted
      key: 'shared-key',
      origin: 'agent-inferred',
    })
    expect(messageIdOf(id)).toBeNull()

    recallSaveHandler(db, {
      content: 'Extraction rewrite, still should not land.',
      type: 'discovery',
      sessionId: SESSION_A,
      messageId: UUID_A1, // this session — additive, allowed
      key: 'shared-key',
      origin: 'agent-inferred',
    })
    expect(messageIdOf(id)).toBe(UUID_A1)
    expect(db.rawAll<{ content: string }>(
      `SELECT content FROM memories WHERE id = ${id}`,
    )[0].content).toBe('Hand-written original.')
  })
})
