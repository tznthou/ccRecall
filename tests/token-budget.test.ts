// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  approximateTokens,
  truncateToChars,
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
