// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import type { MessageInput, MemoryInput } from '../src/core/database'

let tmpDir: string
let db: Database

function msg(overrides: Partial<MessageInput> & { type: string; sequence: number }): MessageInput {
  return {
    uuid: null,
    role: null,
    contentText: null,
    contentJson: null,
    hasToolUse: false,
    hasToolResult: false,
    toolNames: [],
    timestamp: null,
    rawJson: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    model: null,
    ...overrides,
  }
}

function mem(overrides: Partial<MemoryInput> & { content: string }): MemoryInput {
  return {
    sessionId: null,
    messageId: null,
    type: 'decision',
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-fts5-cjk-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('FTS5 CJK — queryMemories', () => {
  beforeEach(() => {
    db.saveMemory(mem({ content: '身為一個從 Vibe Coding 開始的開發者', type: 'discovery' }))
    db.saveMemory(mem({ content: 'ccRecall 記憶系統的設計思路', type: 'decision' }))
    db.saveMemory(mem({ content: '考慮移除 rtk 的相關決策', type: 'discovery' }))
    db.saveMemory(mem({ content: 'Vibe Coding in English only', type: 'discovery' }))
    db.saveMemory(mem({ content: 'ひらがなのテスト文字', type: 'discovery' }))
    db.saveMemory(mem({ content: 'カタカナテストデータ', type: 'discovery' }))
    db.saveMemory(mem({ content: '한글 검색 테스트', type: 'discovery' }))
    db.saveMemory(mem({ content: 'Use UI library for the dashboard', type: 'decision' }))
  })

  it('matches 2-char Chinese (身為) via LIKE fallback', () => {
    const results = db.queryMemories('身為', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('身為'))).toBe(true)
  })

  it('matches 2-char Chinese (記憶) via LIKE fallback', () => {
    const results = db.queryMemories('記憶', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('記憶'))).toBe(true)
  })

  it('matches 4-char Chinese (考慮移除) via trigram', () => {
    const results = db.queryMemories('考慮移除', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('考慮移除'))).toBe(true)
  })

  it('matches Hiragana query (ひらがな)', () => {
    const results = db.queryMemories('ひらがな', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('ひらがな'))).toBe(true)
  })

  it('matches Katakana query (カタカナ)', () => {
    const results = db.queryMemories('カタカナ', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('カタカナ'))).toBe(true)
  })

  it('matches Hangul query (한글)', () => {
    const results = db.queryMemories('한글', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('한글'))).toBe(true)
  })

  it('matches 1-char CJK (身) via LIKE fallback', () => {
    const results = db.queryMemories('身', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('身'))).toBe(true)
  })

  it('matches English query (Vibe) via trigram — no regression', () => {
    const results = db.queryMemories('Vibe', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('Vibe'))).toBe(true)
  })

  it('matches 2-char Latin acronym (UI) via LIKE fallback', () => {
    const results = db.queryMemories('UI', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(m => m.content.includes('UI'))).toBe(true)
  })

  it('returns [] for empty query', () => {
    expect(db.queryMemories('', 10)).toEqual([])
  })
})

describe('FTS5 CJK — search (messages)', () => {
  beforeEach(() => {
    db.indexSession({
      sessionId: 'cjk-sess',
      projectId: 'proj-cjk',
      projectDisplayName: '/test',
      title: 'CJK test session',
      messageCount: 3,
      filePath: '/tmp/cjk.jsonl',
      fileSize: 0,
      fileMtime: '2026-04-19T00:00:00.000Z',
      startedAt: null,
      endedAt: null,
      messages: [
        msg({ type: 'user', role: 'user', contentText: '請幫我檢查記憶系統的狀態', sequence: 0 }),
        msg({ type: 'assistant', role: 'assistant', contentText: '好的，我會查看 ccRecall 的開發進度', sequence: 1 }),
        msg({ type: 'user', role: 'user', contentText: 'English baseline query content', sequence: 2 }),
      ],
    })
  })

  it('finds messages by 2-char CJK (記憶) via LIKE fallback', () => {
    const page = db.search('記憶')
    expect(page.results.length).toBeGreaterThan(0)
  })

  it('finds messages by 1-char CJK (請) via LIKE fallback', () => {
    const page = db.search('請')
    expect(page.results.length).toBeGreaterThan(0)
  })

  it('finds messages by English (baseline) — no regression', () => {
    const page = db.search('English')
    expect(page.results.length).toBeGreaterThan(0)
  })
})

describe('FTS5 CJK — searchSessions', () => {
  beforeEach(() => {
    db.indexSession({
      sessionId: 'cjk-session-title',
      projectId: 'proj-st',
      projectDisplayName: '/test',
      title: '中文標題測試',
      messageCount: 1,
      filePath: '/tmp/st.jsonl',
      fileSize: 0,
      fileMtime: '2026-04-19T00:00:00.000Z',
      startedAt: null,
      endedAt: null,
      messages: [msg({ type: 'user', role: 'user', contentText: 'placeholder', sequence: 0 })],
    })
  })

  it('matches CJK session title (中文) via LIKE fallback', () => {
    const page = db.searchSessions('中文')
    expect(page.results.length).toBeGreaterThan(0)
  })

  it('matches 1-char CJK session title (中) via LIKE fallback', () => {
    const page = db.searchSessions('中')
    expect(page.results.length).toBeGreaterThan(0)
  })
})
