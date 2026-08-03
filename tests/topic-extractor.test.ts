// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { extractFromSession, extractTopicsFromContent, isSegmenterAvailable, normalizeTopicKey } from '../src/core/topic-extractor'
import type { SessionMeta } from '../src/core/types'

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: 'sess-1',
    projectId: 'proj-a',
    title: null,
    messageCount: 0,
    startedAt: null,
    endedAt: null,
    archived: false,
    summaryText: null,
    intentText: null,
    outcomeStatus: null,
    durationSeconds: null,
    activeDurationSeconds: null,
    summaryVersion: null,
    tags: null,
    filesTouched: null,
    toolsUsed: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    ...overrides,
  }
}

describe('normalizeTopicKey', () => {
  it('lowercases', () => {
    expect(normalizeTopicKey('TypeScript')).toBe('typescript')
  })

  it('strips extensions', () => {
    expect(normalizeTopicKey('database.ts')).toBe('database')
    expect(normalizeTopicKey('knowledge-map.test.ts')).toBe('knowledge-map')
  })

  it('normalizes path separators to dash', () => {
    expect(normalizeTopicKey('src/core/database')).toBe('core-database')
  })

  it('filters stopwords', () => {
    expect(normalizeTopicKey('src')).toBeNull()
    expect(normalizeTopicKey('test')).toBeNull()
    expect(normalizeTopicKey('index')).toBeNull()
  })

  it('filters English function words (#84)', () => {
    // The most frequent stopword keys in the corpus before this landed. `when`
    // was the single most frequent key in the entire table — 244 memories.
    expect(normalizeTopicKey('when')).toBeNull()
    expect(normalizeTopicKey('only')).toBeNull()
    expect(normalizeTopicKey('before')).toBeNull()
    expect(normalizeTopicKey('without')).toBeNull()
    expect(normalizeTopicKey('via')).toBeNull()
    expect(normalizeTopicKey('across')).toBeNull()
    expect(normalizeTopicKey('which')).toBeNull()
    expect(normalizeTopicKey('must')).toBeNull()
  })

  it('keeps domain terms that read as generic (#84)', () => {
    // All high-frequency in this corpus and deliberately NOT stopwords: removing
    // them would strip meaning rather than noise. This guards the conservative
    // rule against a future "just add more common English words" pass.
    expect(normalizeTopicKey('code')).toBe('code')
    expect(normalizeTopicKey('session')).toBe('session')
    expect(normalizeTopicKey('memory')).toBe('memory')
    expect(normalizeTopicKey('pattern')).toBe('pattern')
    expect(normalizeTopicKey('state')).toBe('state')
    expect(normalizeTopicKey('zero')).toBe('zero')
    expect(normalizeTopicKey('check')).toBe('check')
    expect(normalizeTopicKey('run')).toBe('run')
  })

  it('enforces min length', () => {
    expect(normalizeTopicKey('a')).toBeNull()
    expect(normalizeTopicKey('ab')).toBeNull()
    expect(normalizeTopicKey('abc')).toBe('abc')
  })

  it('trims whitespace', () => {
    expect(normalizeTopicKey('  typescript  ')).toBe('typescript')
  })

  it('returns null for empty or whitespace', () => {
    expect(normalizeTopicKey('')).toBeNull()
    expect(normalizeTopicKey('   ')).toBeNull()
  })

  it('collapses multiple separators', () => {
    expect(normalizeTopicKey('foo--bar')).toBe('foo-bar')
    expect(normalizeTopicKey('foo//bar')).toBe('foo-bar')
  })

  it('removes leading/trailing separators', () => {
    expect(normalizeTopicKey('-foo-')).toBe('foo')
  })

  it('preserves Han characters', () => {
    expect(normalizeTopicKey('砍刀場')).toBe('砍刀場')
  })

  it('preserves mixed Han + ASCII', () => {
    expect(normalizeTopicKey('database砍刀場')).toBe('database砍刀場')
  })

  it('filters single Han character (too short)', () => {
    expect(normalizeTopicKey('的')).toBeNull()
  })

  it('keeps 2-char Han terms', () => {
    expect(normalizeTopicKey('版本')).toBe('版本')
  })

  it('filters CJK stopwords', () => {
    expect(normalizeTopicKey('這個')).toBeNull()
    expect(normalizeTopicKey('我們')).toBeNull()
    expect(normalizeTopicKey('因為')).toBeNull()
  })

  it('lowercases ASCII in mixed Han content', () => {
    expect(normalizeTopicKey('FTS5觀察')).toBe('fts5觀察')
  })
})

// #80 — runs on every leg of the CI matrix (Node 20 and 22). The issue flagged
// Node 20 as unverified; this asserts the floor instead of assuming it.
// Guards against a small-icu build degrading word granularity silently: without
// it, the CJK cases below would fail with no indication of why.
describe('Intl.Segmenter availability', () => {
  it('the runtime performs dictionary-based CJK segmentation', () => {
    // Fails on a small-icu build, where word granularity degrades for CJK.
    // Every CJK expectation below depends on this; assert it first so the
    // cause is readable instead of showing up as a wall of content failures.
    expect(isSegmenterAvailable()).toBe(true)
  })
})

// #80 — the assertions below were rewritten when Intl.Segmenter replaced the
// character-run splitter. The previous expectations (版本已發布 / 設計價值 /
// 驗證設計 / 獨特設計) asserted clause fragments as correct output — they were
// the bug from #79 written down as a spec, not behaviour worth preserving.
// Every expected value here is taken from measured segmenter output, not guessed.
describe('extractTopicsFromContent — CJK', () => {
  it('extracts Han terms from mixed content', () => {
    const topics = extractTopicsFromContent('v0.5.0 砍刀場 release shipped')
    expect(topics).toContain('砍刀')
    expect(topics).toContain('release')
    expect(topics).toContain('shipped')
  })

  it('segments a clause into words instead of one glued fragment', () => {
    const topics = extractTopicsFromContent('觀察期，版本已發布')
    expect(topics).toContain('版本')
    expect(topics).toContain('發布')
    expect(topics).not.toContain('版本已發布')
  })

  it('separates Han from adjacent Latin', () => {
    const topics = extractTopicsFromContent('patch驗證設計ok')
    expect(topics).toContain('patch')
    expect(topics).toContain('驗證')
    expect(topics).toContain('設計')
  })

  it('segments a long Han run that the old splitter discarded entirely', () => {
    const topics = extractTopicsFromContent('在本地單人多專案場景是獨特設計')
    expect(topics).toContain('本地')
    expect(topics).toContain('專案')
    expect(topics).toContain('場景')
    expect(topics).toContain('設計')
    expect(topics).not.toContain('本地單人多專案場景')
  })

  it('extracts topics from an all-Han prompt with no punctuation (#79 shape A)', () => {
    const topics = extractTopicsFromContent('注入率為什麼掉了')
    expect(topics.length).toBeGreaterThan(0)
    expect(topics).toContain('注入')
  })

  it('yields real words, not glued fragments, for a punctuated prompt (#79 shape B)', () => {
    const topics = extractTopicsFromContent('確認更新後，新的記憶機制是否開始作用？')
    expect(topics).toContain('確認')
    expect(topics).toContain('記憶')
    expect(topics).toContain('機制')
    expect(topics).not.toContain('否開始作用')
    expect(topics).not.toContain('確認更新後')
    expect(topics).not.toContain('記憶機制')
  })

  it('filters CJK stopwords from content', () => {
    const topics = extractTopicsFromContent('這個 不是 確認')
    expect(topics).not.toContain('這個')
    expect(topics).not.toContain('不是')
    expect(topics).toContain('確認')
  })

  it('drops particles as tokens rather than deleting them mid-word', () => {
    const topics = extractTopicsFromContent('流水線的設計價值')
    expect(topics).toContain('設計')
    expect(topics).toContain('價值')
    expect(topics).not.toContain('的')
  })

  it('does not emit single Han characters', () => {
    const topics = extractTopicsFromContent('觀察期，版本已發布')
    expect(topics.filter(t => /^\p{Script=Han}$/u.test(t))).toEqual([])
  })

  it('handles pure English content unchanged', () => {
    const topics = extractTopicsFromContent('database migration strategy')
    expect(topics).toContain('database')
    expect(topics).toContain('migration')
    expect(topics).toContain('strategy')
  })
})

describe('extractFromSession', () => {
  it('extracts tags', () => {
    const topics = extractFromSession(session({ tags: 'refactor,tested,committed' }))
    expect(topics).toEqual(['committed', 'refactor', 'tested'])
  })

  it('extracts file stems from filesTouched (strips dir and ext)', () => {
    const topics = extractFromSession(session({
      filesTouched: 'src/core/database.ts,src/mcp/server.ts',
    }))
    expect(topics).toContain('database')
    expect(topics).toContain('server')
  })

  it('strips .test and .spec suffixes', () => {
    const topics = extractFromSession(session({
      filesTouched: 'tests/knowledge-map.test.ts,tests/foo.spec.ts',
    }))
    expect(topics).toContain('knowledge-map')
    expect(topics).toContain('foo')
  })

  it('combines tags + files and dedupes', () => {
    const topics = extractFromSession(session({
      tags: 'database',
      filesTouched: 'src/core/database.ts',
    }))
    expect(topics).toEqual(['database'])
  })

  it('returns sorted and deduped', () => {
    const topics = extractFromSession(session({
      tags: 'typescript, refactor',
      filesTouched: 'src/core/typescript.ts,src/core/refactor.ts',
    }))
    expect(topics).toEqual(['refactor', 'typescript'])
  })

  it('filters stopword-only file stems', () => {
    const topics = extractFromSession(session({
      filesTouched: 'src/index.ts,src/main.ts,src/core/database.ts',
    }))
    expect(topics).not.toContain('index')
    expect(topics).not.toContain('main')
    expect(topics).toContain('database')
  })

  it('handles empty session', () => {
    expect(extractFromSession(session({}))).toEqual([])
  })

  it('handles empty strings', () => {
    expect(extractFromSession(session({ tags: '', filesTouched: '' }))).toEqual([])
  })

  it('handles messy tag input (spaces, empty items)', () => {
    const topics = extractFromSession(session({ tags: ' refactor , , tested ' }))
    expect(topics).toEqual(['refactor', 'tested'])
  })
})
