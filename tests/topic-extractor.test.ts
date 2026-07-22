// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { extractFromSession, extractTopicsFromContent, normalizeTopicKey } from '../src/core/topic-extractor'
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

describe('extractTopicsFromContent — CJK', () => {
  it('extracts Han terms from mixed content', () => {
    const topics = extractTopicsFromContent('v0.5.0 砍刀場 release shipped')
    expect(topics).toContain('砍刀場')
    expect(topics).toContain('release')
    expect(topics).toContain('shipped')
  })

  it('splits on Chinese punctuation', () => {
    const topics = extractTopicsFromContent('觀察期，版本已發布')
    expect(topics).toContain('觀察期')
    expect(topics).toContain('版本已發布')
  })

  it('inserts boundary between Han and non-Han', () => {
    const topics = extractTopicsFromContent('patch驗證設計ok')
    expect(topics).toContain('patch')
    expect(topics).toContain('驗證設計')
  })

  it('skips long Han-only runs but extracts segments split by particles', () => {
    const topics = extractTopicsFromContent('在本地單人多專案場景是獨特設計')
    expect(topics).toContain('獨特設計')
    expect(topics).not.toContain('本地單人多專案場景')
  })

  it('filters CJK stopwords from content', () => {
    const topics = extractTopicsFromContent('這個 不是 確認')
    expect(topics).not.toContain('這個')
    expect(topics).not.toContain('不是')
    expect(topics).toContain('確認')
  })

  it('splits on common particles (的/了/是/在)', () => {
    const topics = extractTopicsFromContent('流水線的設計價值')
    expect(topics).toContain('流水線')
    expect(topics).toContain('設計價值')
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
