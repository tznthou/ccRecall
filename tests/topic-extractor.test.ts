import { describe, it, expect } from 'vitest'
import { extractFromSession, normalizeTopicKey } from '../src/core/topic-extractor'
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
