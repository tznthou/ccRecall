// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { extractOutcome } from '../src/core/outcome-extractor'
import type { ParsedLine } from '../src/core/types'

function makeMsg(opts: Partial<ParsedLine>): ParsedLine {
  return {
    type: 'message',
    uuid: null,
    parentUuid: null,
    sessionId: null,
    timestamp: null,
    role: null,
    contentText: null,
    contentJson: null,
    hasToolUse: false,
    hasToolResult: false,
    toolNames: [],
    rawJson: '{}',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    model: null,
    requestId: null,
    ...opts,
  }
}

describe('extractOutcome — candidateText', () => {
  it('picks last assistant message with >=200 chars', () => {
    const long = 'x'.repeat(250)
    const msgs = [
      makeMsg({ role: 'user', contentText: 'q' }),
      makeMsg({ role: 'assistant', contentText: 'short' }),
      makeMsg({ role: 'assistant', contentText: long }),
    ]
    expect(extractOutcome(msgs).candidateText).toBe(long)
  })

  it('walks backward, takes the last substantial assistant message even if earlier ones are longer', () => {
    const earlier = 'a'.repeat(500)
    const later = 'b'.repeat(220)
    const msgs = [
      makeMsg({ role: 'assistant', contentText: earlier }),
      makeMsg({ role: 'user', contentText: 'follow up' }),
      makeMsg({ role: 'assistant', contentText: later }),
    ]
    expect(extractOutcome(msgs).candidateText).toBe(later)
  })

  it('treats short assistant text with markdown header as substantial', () => {
    const text = '## Decision\nuse SQLite'
    const msgs = [makeMsg({ role: 'assistant', contentText: text })]
    expect(extractOutcome(msgs).candidateText).toBe(text)
  })

  it('treats short assistant text with code fence as substantial', () => {
    const text = '```ts\nconst x = 1\n```'
    const msgs = [makeMsg({ role: 'assistant', contentText: text })]
    expect(extractOutcome(msgs).candidateText).toBe(text)
  })

  it('treats short assistant text with bullet list as substantial', () => {
    const text = '- decision A\n- decision B'
    const msgs = [makeMsg({ role: 'assistant', contentText: text })]
    expect(extractOutcome(msgs).candidateText).toBe(text)
  })

  it('skips user messages even when long', () => {
    const longUser = 'u'.repeat(500)
    const msgs = [makeMsg({ role: 'user', contentText: longUser })]
    expect(extractOutcome(msgs).candidateText).toBeNull()
  })

  it('returns null when all assistant messages are short and unstructured', () => {
    const msgs = [
      makeMsg({ role: 'assistant', contentText: 'ok' }),
      makeMsg({ role: 'assistant', contentText: 'done' }),
    ]
    expect(extractOutcome(msgs).candidateText).toBeNull()
  })

  it('returns null on empty session', () => {
    expect(extractOutcome([])).toEqual({ candidateText: null })
  })

  it('treats short plain-text outcome as substantial when scorer threshold reached', () => {
    // Short (<200 chars) plain text without markdown structure — would be dropped
    // by the length / structural gate alone. Scorer fallback rescues it via
    // cause-effect + impl-facts + validation hits.
    const text = 'Root cause: token expiry not propagated in src/auth.ts:42. 495/495 tests pass.'
    expect(text.length).toBeLessThan(200)
    const msgs = [makeMsg({ role: 'assistant', contentText: text })]
    expect(extractOutcome(msgs).candidateText).toBe(text)
  })

  it('still drops short text that scorer rejects (single weak signal)', () => {
    // Single category match (decision-language only) — under threshold, no rescue.
    const text = '我們決定先吃飯'
    const msgs = [makeMsg({ role: 'assistant', contentText: text })]
    expect(extractOutcome(msgs).candidateText).toBeNull()
  })

  it('skips trailing save-t process report and falls back to real outcome', () => {
    // dogfood pattern: session 末尾常常是 save-t 收尾報告（非 outcome）,
    // 真實 implementation outcome 在 save-t 之前。extractor 應 skip save-t 往前找。
    const realOutcome =
      'Root cause: WAL never truncates, fixed at src/core/database.ts:1552. ' +
      'Verified: 495/495 tests pass after the change. We decided to add TRUNCATE at end of indexer.'
    const saveTReport =
      '## save-t 完成 ✓\n\n寫入摘要：\n| 檔案 | 動作 |\n|---|---|\n| RESUME.md | 更新 |'
    const msgs = [
      makeMsg({ role: 'assistant', contentText: realOutcome }),
      makeMsg({ role: 'user', contentText: '/save-t' }),
      makeMsg({ role: 'assistant', contentText: saveTReport }),
    ]
    expect(extractOutcome(msgs).candidateText).toBe(realOutcome)
  })

  it('returns null when only save-t reports exist', () => {
    const msgs = [
      makeMsg({ role: 'assistant', contentText: 'Save-T 完成。\n\n## 輸出摘要\n更新了 3 個檔案。' }),
      makeMsg({ role: 'assistant', contentText: '## save-t 完成 ✓\n\n寫入動作完成' }),
    ]
    expect(extractOutcome(msgs).candidateText).toBeNull()
  })
})
