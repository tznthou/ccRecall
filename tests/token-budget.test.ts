// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  approximateTokens,
  truncateToChars,
  applyRowBudget,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PER_ROW_CHAR_CAP,
} from '../src/core/token-budget'

describe('approximateTokens', () => {
  it('returns 0 for empty', () => {
    expect(approximateTokens('')).toBe(0)
  })

  it('ASCII: ceil(chars * 0.3)', () => {
    expect(approximateTokens('hello')).toBe(Math.ceil(5 * 0.3)) // 2
    expect(approximateTokens('The quick brown fox')).toBe(Math.ceil(19 * 0.3)) // 6
  })

  it('Han CJK: 1 token per char', () => {
    expect(approximateTokens('記憶')).toBe(2)
    expect(approximateTokens('我在ccRecall專案做開發')).toBe(
      Math.ceil(7 + 9 * 0.3), // 7 Han + 9 Latin = 10
    )
  })

  it('Hiragana at 1/char', () => {
    expect(approximateTokens('あいうえお')).toBe(5)
  })

  it('Katakana at 1/char', () => {
    expect(approximateTokens('カタカナ')).toBe(4)
  })

  it('Hangul at 1/char', () => {
    expect(approximateTokens('안녕하세요')).toBe(5)
  })

  it('mixed CJK + ASCII', () => {
    // 4 Han + 5 ASCII = 4 + 1.5 = 5.5 -> ceil 6
    expect(approximateTokens('繁體中文 test')).toBe(Math.ceil(4 + 5 * 0.3))
  })

  it('digits + punctuation count as non-CJK', () => {
    // 10 non-CJK = 3 tokens
    expect(approximateTokens('abc 123!?.')).toBe(Math.ceil(10 * 0.3))
  })

  it('long Traditional Chinese approximates close to char count', () => {
    const text = '這是一段比較長的繁體中文測試文字用來驗證估計值' // 23 Han
    expect(approximateTokens(text)).toBe(23)
  })
})

describe('truncateToChars', () => {
  it('returns text unchanged when shorter than maxChars', () => {
    expect(truncateToChars('hello', 10)).toBe('hello')
  })

  it('returns text unchanged when exactly maxChars', () => {
    expect(truncateToChars('hello', 5)).toBe('hello')
  })

  it('truncates and appends ellipsis when longer', () => {
    // maxChars=5 reserves 1 for ellipsis -> first 4 chars + '…'
    expect(truncateToChars('hello world', 5)).toBe('hell…')
  })

  it('CJK truncation counts by code point', () => {
    expect(truncateToChars('繁體中文測試', 4)).toBe('繁體中…')
  })

  it('returns empty when maxChars <= 0', () => {
    expect(truncateToChars('hello', 0)).toBe('')
    expect(truncateToChars('hello', -5)).toBe('')
  })

  it('maxChars=1 returns ellipsis only', () => {
    expect(truncateToChars('hello', 1)).toBe('…')
  })

  it('empty input returns empty', () => {
    expect(truncateToChars('', 10)).toBe('')
  })

  it('surrogate pair (emoji) not split', () => {
    // '😀' is 2 UTF-16 units but 1 code point
    const input = '😀😀😀😀'
    expect(truncateToChars(input, 2)).toBe('😀…')
  })
})

describe('constants', () => {
  it('defaults match plan', () => {
    expect(DEFAULT_MAX_TOKENS).toBe(300)
    expect(DEFAULT_PER_ROW_CHAR_CAP).toBe(150)
  })
})

describe('applyRowBudget', () => {
  it('passes rows through when under budget', () => {
    const rows = [{ id: 1, content: 'hello', type: 'discovery' }]
    const result = applyRowBudget(rows, 300, 150)
    expect(result.emitted).toHaveLength(1)
    expect(result.emitted[0].id).toBe(1)
    expect(result.emitted[0].content).toBe('hello')
    expect(result.droppedCount).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('per-row truncates content beyond perRowCharCap', () => {
    const rows = [{ id: 1, content: 'a'.repeat(200) }]
    const result = applyRowBudget(rows, 300, 150)
    expect(result.emitted[0].content).toBe('a'.repeat(149) + '…')
    expect(result.truncated).toBe(true)
  })

  it('drops trailing rows when cumulative budget exceeded', () => {
    // CJK 1 token/char, so 100 CJK chars = 100 tokens
    const rows = [
      { id: 1, content: '中'.repeat(100) }, // 100 tokens; cumulative 100
      { id: 2, content: '文'.repeat(100) }, // 100 tokens; cumulative 200
      { id: 3, content: '測'.repeat(100) }, // 100 tokens; cumulative 300 (== budget, allowed)
      { id: 4, content: '試'.repeat(100) }, // would push to 400 > 300, dropped
    ]
    const result = applyRowBudget(rows, 300, 150)
    expect(result.emitted.map(r => r.id)).toEqual([1, 2, 3])
    expect(result.droppedCount).toBe(1)
    expect(result.usedTokens).toBe(300)
  })

  it('preserves non-content fields on emitted rows', () => {
    const rows = [{ id: 42, content: 'x', type: 'discovery', confidence: 0.9 }]
    const result = applyRowBudget(rows, 300, 150)
    expect(result.emitted[0]).toMatchObject({ id: 42, type: 'discovery', confidence: 0.9 })
  })

  it('returns empty for empty input', () => {
    const result = applyRowBudget([], 300, 150)
    expect(result.emitted).toEqual([])
    expect(result.droppedCount).toBe(0)
    expect(result.usedTokens).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('drops first row if it exceeds budget alone', () => {
    const rows = [
      { id: 1, content: '中'.repeat(150) }, // truncates to 150 CJK chars = 150 tokens
      { id: 2, content: '文'.repeat(150) }, // would push to 300; tied, allowed
    ]
    // budget is 100, first row alone (150 tokens after truncation) exceeds it
    const result = applyRowBudget(rows, 100, 150)
    expect(result.emitted).toEqual([])
    expect(result.droppedCount).toBe(2)
  })
})
