// SPDX-License-Identifier: Apache-2.0
/** tag/filesTouched 欄位支援：SessionMeta 或 SessionSummary 都能傳入（結構化型別） */
interface TopicSource {
  tags: string | null
  filesTouched: string | null
}

const MIN_TOPIC_LENGTH = 3
const MIN_TOPIC_LENGTH_CJK = 2
const MAX_HAN_RUN = 6

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

const CJK_STOPWORDS = new Set([
  '這個', '我們', '那個', '可以', '什麼', '然後', '因為', '所以',
  '但是', '已經', '沒有', '不是', '一個', '為什麼', '怎麼', '現在',
  '或者', '如果', '雖然', '還是', '他們', '自己', '這些', '那些',
  '而且', '只有', '之後', '以後', '以前', '應該', '需要', '可能',
])

const HAN_RE = /\p{Script=Han}/u

/** 將原始字串正規化為 topic_key：以 / \ . 拆 segment 後各自 normalize、過濾 stopword/太短，再組合 */
export function normalizeTopicKey(raw: string): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  const segments = s.split(/[\\/.]/)
    .map(seg => seg.replace(/[^a-z0-9_\-\p{Script=Han}]/gu, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(seg => {
      if (!seg) return false
      const minLen = HAN_RE.test(seg) ? MIN_TOPIC_LENGTH_CJK : MIN_TOPIC_LENGTH
      return seg.length >= minLen && !STOPWORDS.has(seg) && !CJK_STOPWORDS.has(seg)
    })
  if (segments.length === 0) return null
  return segments.join('-')
}

function extractTopicsFromFile(filePath: string): string[] {
  const basename = filePath.split(/[\\/]/).pop() ?? ''
  const k = normalizeTopicKey(basename)
  return k ? [k] : []
}

/** 從記憶 content 文字抽出 topic keys（用於 recall_save 自動 topic extraction） */
export function extractTopicsFromContent(content: string): string[] {
  if (!content) return []
  const topics = new Set<string>()

  const processed = content
    .replace(/[，。、；：「」（）【】！？…·—]+/g, ' ')
    .replace(/([\p{Script=Han}])([^\p{Script=Han}\s])/gu, '$1 $2')
    .replace(/([^\p{Script=Han}\s])([\p{Script=Han}])/gu, '$1 $2')

  const words = processed.split(/[\s,;:()[\]{}"'`|/\\]+/).filter(Boolean)
  for (const w of words) {
    if (/^\p{Script=Han}+$/u.test(w) && w.length > MAX_HAN_RUN) continue
    const k = normalizeTopicKey(w)
    if (k) topics.add(k)
  }
  return Array.from(topics).sort()
}

/** 從結構化欄位（tags, filesTouched）抽出 topic keys，已 normalize + dedup + sort */
export function extractFromSession(source: TopicSource): string[] {
  const topics = new Set<string>()

  if (source.tags) {
    for (const raw of source.tags.split(',')) {
      const k = normalizeTopicKey(raw)
      if (k) topics.add(k)
    }
  }

  if (source.filesTouched) {
    for (const filePath of source.filesTouched.split(',')) {
      for (const t of extractTopicsFromFile(filePath)) {
        topics.add(t)
      }
    }
  }

  return Array.from(topics).sort()
}
