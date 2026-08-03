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
  // #84 — the English half of the list was ~21 words while the CJK half had 56,
  // so English function words dominated the index: `when` was the single most
  // frequent key in the whole table (244 memories). 133 distinct stopwords
  // covered 2,224 of 24,047 topic rows (9.2%). Every topic-driven path matches
  // on this table — Tier 0 startup selection, recall_context, and L1 recall —
  // so a key this frequent creates spurious matches everywhere.
  //
  // Same discipline as the CJK pass: pure function words only. Terms that carry
  // meaning in this domain stay out even when they read as generic — `code`,
  // `session`, `memory`, `files`, `state`, `pattern`, `check`, `run` and `zero`
  // are all high-frequency here and all deliberately absent.
  //
  // Verified before landing: adding these leaves **zero** memories without any
  // topic (567 lose some but none go empty), so nothing drops out of
  // knowledge_map or becomes unreachable by topic-driven selection.
  'about', 'above', 'across', 'after', 'again', 'against', 'also', 'always', 'among',
  'another', 'because', 'been', 'before', 'being', 'below', 'beside', 'best', 'better',
  'both', 'cannot', 'could', 'did', 'does', 'doing', 'done', 'down', 'during',
  'each', 'either', 'else', 'enough', 'even', 'ever', 'every', 'few', 'first',
  'further', 'get', 'gets', 'getting', 'give', 'given', 'goes', 'going', 'gone',
  'got', 'have', 'having', 'here', 'hers', 'him', 'his', 'how', 'however',
  'into', 'itself', 'just', 'keep', 'kept', 'last', 'least', 'less', 'let',
  'like', 'likely', 'made', 'make', 'makes', 'making', 'many', 'may', 'maybe',
  'mean', 'means', 'might', 'more', 'most', 'much', 'must', 'need', 'needs',
  'neither', 'never', 'next', 'non', 'nor', 'now', 'off', 'often', 'once',
  'one', 'only', 'onto', 'other', 'others', 'ought', 'ours', 'out', 'over',
  'own', 'per', 'perhaps', 'put', 'quite', 'rather', 'really', 'said', 'same',
  'say', 'says', 'see', 'seen', 'shall', 'she', 'should', 'since', 'some',
  'soon', 'still', 'such', 'take', 'taken', 'than', 'their', 'them', 'then',
  'there', 'these', 'they', 'thing', 'things', 'those', 'though', 'three', 'through',
  'thus', 'too', 'two', 'under', 'until', 'upon', 'use', 'used', 'uses',
  'using', 'very', 'via', 'want', 'way', 'well', 'were', 'what', 'when',
  'where', 'whether', 'which', 'while', 'who', 'whom', 'whose', 'why', 'within',
  'without', 'would', 'yet', 'your',
])

const CJK_STOPWORDS = new Set([
  '這個', '我們', '那個', '可以', '什麼', '然後', '因為', '所以',
  '但是', '已經', '沒有', '不是', '一個', '為什麼', '怎麼', '現在',
  '或者', '如果', '雖然', '還是', '他們', '自己', '這些', '那些',
  '而且', '只有', '之後', '以後', '以前', '應該', '需要', '可能',
  // #80 — particles and function words now arrive as their own tokens from the
  // segmenter instead of being deleted mid-word by a character substitution.
  // Deliberately conservative: only pure function words. Terms that carry
  // project meaning (一手/三路/修法…) stay out even when they look generic.
  '是否', '新的', '出來', '掉了', '下個', '任何', '多個', '同一',
  '不會', '不要', '不只', '詳見', '以及', '或是', '還有', '然而',
  '因此', '於是', '目前', '剛才', '後來', '接著', '這樣', '那樣',
])

const HAN_RE = /\p{Script=Han}/u
const HAN_ONLY_RE = /^\p{Script=Han}+$/u

/** #80 — ICU word segmentation for Han runs. Latin is deliberately NOT routed
    through the segmenter: it splits `better-sqlite3` into `better`/`sqlite3`,
    which would invalidate the ~97% of the index that is Latin.

    Constructed lazily behind hasIcuData() because calling segment() on a
    small-icu build without runtime ICU data is a SIGSEGV, not an exception —
    see nodejs/node#51752 (still open). A try/catch cannot save us there, and
    this module is imported by the daemon and the MCP server, so the crash
    would take down the whole process at import time. Fedora's `nodejs`
    package without `nodejs-full-i18n` is exactly this build. */
function hasIcuData(): boolean {
  // icu_small === true means the build ships only the English locale stub.
  // Bail out even when NODE_ICU_DATA might supply real data: degrading to the
  // legacy splitter is safe, probing to find out is not.
  const vars = process.config?.variables as { icu_small?: boolean } | undefined
  if (vars?.icu_small === true) return false
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
}

const hanSegmenter = hasIcuData()
  ? new Intl.Segmenter('zh-TW', { granularity: 'word' })
  : null

/** Confirms the runtime does dictionary-based CJK segmentation rather than
    falling back to per-character breaks. Only ever runs once hasIcuData() has
    ruled out the build that would crash. */
function probeSegmenter(): boolean {
  if (!hanSegmenter) return false
  try {
    const out = [...hanSegmenter.segment('確認更新')]
      .filter(s => s.isWordLike)
      .map(s => s.segment)
    return out.length === 2 && out[0] === '確認' && out[1] === '更新'
  } catch {
    return false
  }
}

const SEGMENTER_OK = probeSegmenter()

/** Exposed so CI can assert the runtime actually segments rather than silently
    falling back. Without this a small-icu build would degrade quietly and the
    CJK assertions would fail for a reason no one could read off the output. */
export function isSegmenterAvailable(): boolean {
  return SEGMENTER_OK
}

/** Splits one all-Han run into words. Returns the run unchanged when the
    runtime cannot segment, preserving the legacy MAX_HAN_RUN discard upstream. */
function segmentHanRun(run: string): string[] {
  if (!SEGMENTER_OK || !hanSegmenter) return [run]
  return [...hanSegmenter.segment(run)]
    .filter(s => s.isWordLike)
    .map(s => s.segment)
}

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

  // #80 — the particle substitution `.replace(/[的了是在]/g, ' ')` used to live
  // here. It deleted characters mid-word (是 out of 是否 → the `否開始作用`
  // fragment in #79) and is now handled by segmentation + CJK_STOPWORDS.
  const processed = content
    .replace(/[，。、；：「」（）【】！？…·—]+/g, ' ')
    .replace(/([\p{Script=Han}])([^\p{Script=Han}\s])/gu, '$1 $2')
    .replace(/([^\p{Script=Han}\s])([\p{Script=Han}])/gu, '$1 $2')

  const words = processed.split(/[\s,;:()[\]{}"'`|/\\]+/).filter(Boolean)
  for (const w of words) {
    if (HAN_ONLY_RE.test(w)) {
      // Han runs go through ICU. Without a working segmenter this yields the
      // run itself, so the legacy length guard still applies.
      for (const piece of segmentHanRun(w)) {
        if (!SEGMENTER_OK && piece.length > MAX_HAN_RUN) continue
        const k = normalizeTopicKey(piece)
        if (k) topics.add(k)
      }
      continue
    }
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
