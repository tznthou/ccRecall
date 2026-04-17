import type { SessionMeta } from './types.js'

const MIN_TOPIC_LENGTH = 3

const STOPWORDS = new Set([
  // 通用英文
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'not', 'but', 'are', 'was',
  'has', 'had', 'can', 'will', 'you', 'all', 'any', 'new', 'old', 'our',
  // 通用 code words（會混淆 topic）
  'index', 'main', 'test', 'tests', 'spec', 'specs', 'types', 'type', 'util', 'utils',
  'helper', 'helpers', 'common', 'shared', 'src', 'lib', 'dist', 'build',
  'node_modules', 'tmp', 'temp', 'mock', 'mocks', 'fixture', 'fixtures',
  'config', 'constants', 'const', 'let', 'var', 'function', 'return', 'error',
  'data', 'value', 'result',
])

/** 將原始字串正規化為 topic_key：以 / \ . 拆 segment 後各自 normalize、過濾 stopword/太短，再組合 */
export function normalizeTopicKey(raw: string): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  const segments = s.split(/[\\/.]/)
    .map(seg => seg.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(seg => seg.length >= MIN_TOPIC_LENGTH && !STOPWORDS.has(seg))
  if (segments.length === 0) return null
  return segments.join('-')
}

function extractTopicsFromFile(filePath: string): string[] {
  const basename = filePath.split(/[\\/]/).pop() ?? ''
  const k = normalizeTopicKey(basename)
  return k ? [k] : []
}

/** 從 session 的結構化欄位（tags, filesTouched）抽出 topic keys，已 normalize + dedup + sort */
export function extractFromSession(session: SessionMeta): string[] {
  const topics = new Set<string>()

  if (session.tags) {
    for (const raw of session.tags.split(',')) {
      const k = normalizeTopicKey(raw)
      if (k) topics.add(k)
    }
  }

  if (session.filesTouched) {
    for (const filePath of session.filesTouched.split(',')) {
      for (const t of extractTopicsFromFile(filePath)) {
        topics.add(t)
      }
    }
  }

  return Array.from(topics).sort()
}
