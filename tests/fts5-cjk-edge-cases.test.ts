// SPDX-License-Identifier: Apache-2.0
//
// Reproducible failing cases for issue #13 (FTS5 CJK edge cases).
// All three cases store ≥3-char strings with no whitespace, so the
// `hasShortToken` gate does not fire and the LIKE fallback never runs.
// Trigram match runs on raw bytes — visually-equivalent strings with
// different code points produce disjoint trigram sets and return zero hits.
//
// `it.fails()` inverts the assertion: each test passes today *because* the
// expected memory is not found. Once the underlying bug is fixed and the
// memory becomes findable, the assertion succeeds and `it.fails()` flips
// the result to red, prompting removal of the `.fails` marker.
//
// Case 3 from issue #13 (`snippet()` highlight under trigram) is omitted
// because `queryMemories` does not currently use `snippet()`. Reproduction
// requires implementing it first.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import type { MemoryInput } from '../src/core/database'

let tmpDir: string
let db: Database

function mem(overrides: Partial<MemoryInput> & { content: string }): MemoryInput {
  return {
    sessionId: null,
    messageId: null,
    type: 'decision',
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-cjk-edge-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('issue #13 — CJK edge cases (reproducible failing)', () => {
  // Case 1 — full-width CJK punctuation breaks trigram alignment.
  // Stored `記憶，重要` trigrams: 記憶，/ 憶，重 / ，重要
  // Query  `記憶重要`   trigrams: 記憶重 / 憶重要
  // No overlap → MATCH returns nothing.
  it.fails('case 1: full-width comma in stored content breaks unpunctuated query', () => {
    const id = db.saveMemory(mem({ content: '記憶，重要', confidence: 0.8 }))
    expect(id).toBeGreaterThan(0)
    const results = db.queryMemories('記憶重要', 10)
    expect(results.map(r => r.id)).toContain(id)
  })

  // Case 2 — macOS NFC/NFD divergence on Japanese voiced kana.
  // NFC `が` is U+304C (1 codepoint).
  // NFD `が` is U+304B U+3099 (2 codepoints; ka + combining voicing mark).
  // Different byte sequences → different trigrams → zero overlap.
  it.fails('case 2: NFC stored vs NFD query — same visual string, different code points', () => {
    const nfc = 'がっこう'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc) // sanity: normalization actually differs
    expect(nfd.length).toBeGreaterThan(nfc.length)
    const id = db.saveMemory(mem({ content: nfc, confidence: 0.8 }))
    const results = db.queryMemories(nfd, 10)
    expect(results.map(r => r.id)).toContain(id)
  })

  // Case 4 — half-width vs full-width katakana.
  // `ｶﾀｶﾅ` is U+FF76 U+FF80 U+FF76 U+FF85 (Halfwidth Katakana block).
  // `カタカナ` is U+30AB U+30BF U+30AB U+30CA (standard Katakana block).
  // Visually equivalent, byte-disjoint → trigrams never align.
  it.fails('case 4: half-width katakana stored vs full-width katakana query', () => {
    const halfwidth = 'ｶﾀｶﾅ'
    const fullwidth = 'カタカナ'
    expect(halfwidth).not.toBe(fullwidth)
    const id = db.saveMemory(mem({ content: halfwidth, confidence: 0.8 }))
    const results = db.queryMemories(fullwidth, 10)
    expect(results.map(r => r.id)).toContain(id)
  })
})
