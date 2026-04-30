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

function toolUseMsg(blocks: Array<{ name: string; input: Record<string, unknown> }>): ParsedLine {
  const json = JSON.stringify(
    blocks.map(b => ({ type: 'tool_use', name: b.name, input: b.input })),
  )
  return makeMsg({
    role: 'assistant',
    hasToolUse: true,
    contentJson: json,
    toolNames: blocks.map(b => b.name),
  })
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
    expect(extractOutcome([])).toEqual({ candidateText: null, hasCommitInvoked: false, filesTouched: [] })
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
})

describe('extractOutcome — commit + files evidence', () => {
  it('detects git commit invocation in Bash tool_use', () => {
    const msgs = [toolUseMsg([{ name: 'Bash', input: { command: 'git commit -m "feat: x"' } }])]
    expect(extractOutcome(msgs).hasCommitInvoked).toBe(true)
  })

  it('does not flag git status / git diff as commit', () => {
    const msgs = [toolUseMsg([{ name: 'Bash', input: { command: 'git status && git diff' } }])]
    expect(extractOutcome(msgs).hasCommitInvoked).toBe(false)
  })

  it('collects file_path from Edit and Write tools, dedups', () => {
    const msgs = [
      toolUseMsg([{ name: 'Edit', input: { file_path: '/a/b.ts', old_string: '', new_string: '' } }]),
      toolUseMsg([{ name: 'Write', input: { file_path: '/c/d.ts', content: '' } }]),
      toolUseMsg([{ name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' } }]),
    ]
    const result = extractOutcome(msgs)
    expect(result.filesTouched.sort()).toEqual(['/a/b.ts', '/c/d.ts'])
  })

  it('ignores Read / Grep / Bash for filesTouched', () => {
    const msgs = [
      toolUseMsg([{ name: 'Read', input: { file_path: '/should-not-count.ts' } }]),
      toolUseMsg([{ name: 'Grep', input: { pattern: 'foo', path: '/x' } }]),
      toolUseMsg([{ name: 'Bash', input: { command: 'cat foo' } }]),
    ]
    expect(extractOutcome(msgs).filesTouched).toEqual([])
  })

  it('survives malformed contentJson without throwing', () => {
    const msgs = [
      makeMsg({ role: 'assistant', hasToolUse: true, contentJson: '{not valid json' }),
      toolUseMsg([{ name: 'Bash', input: { command: 'git commit -m "ok"' } }]),
    ]
    const result = extractOutcome(msgs)
    expect(result.hasCommitInvoked).toBe(true)
  })

  it('survives non-array contentJson without throwing', () => {
    const msgs = [
      makeMsg({ role: 'assistant', hasToolUse: true, contentJson: '{"type":"text"}' }),
    ]
    const result = extractOutcome(msgs)
    expect(result.hasCommitInvoked).toBe(false)
    expect(result.filesTouched).toEqual([])
  })
})
