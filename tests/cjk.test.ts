// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { containsCJK } from '../src/core/cjk'

describe('containsCJK', () => {
  describe('Han (CJK Unified + extensions)', () => {
    it('detects CJK Unified Ideographs (common Chinese)', () => {
      expect(containsCJK('記憶')).toBe(true)
      expect(containsCJK('開發')).toBe(true)
      expect(containsCJK('中文')).toBe(true)
      expect(containsCJK('身為')).toBe(true)
    })

    it('detects single CJK character', () => {
      expect(containsCJK('身')).toBe(true)
      expect(containsCJK('一')).toBe(true)
    })

    it('detects CJK Extension A (rare traditional)', () => {
      expect(containsCJK('\u{3400}')).toBe(true)
      expect(containsCJK('\u{4DBF}')).toBe(true)
    })

    it('detects CJK Extension B (supplementary plane, surrogate pair)', () => {
      expect(containsCJK('\u{20000}')).toBe(true)
      expect(containsCJK('\u{2A6DF}')).toBe(true)
    })
  })

  describe('Japanese', () => {
    it('detects Hiragana', () => {
      expect(containsCJK('ひらがな')).toBe(true)
      expect(containsCJK('あ')).toBe(true)
    })

    it('detects Katakana', () => {
      expect(containsCJK('カタカナ')).toBe(true)
      expect(containsCJK('ア')).toBe(true)
    })
  })

  describe('Korean', () => {
    it('detects Hangul Syllables', () => {
      expect(containsCJK('한글')).toBe(true)
      expect(containsCJK('가')).toBe(true)
    })
  })

  describe('Mixed content', () => {
    it('detects CJK when mixed with English', () => {
      expect(containsCJK('Vibe Coding 開發')).toBe(true)
      expect(containsCJK('記憶 is stored')).toBe(true)
    })

    it('detects CJK at any position (start/middle/end)', () => {
      expect(containsCJK('開hello')).toBe(true)
      expect(containsCJK('hel開lo')).toBe(true)
      expect(containsCJK('hello開')).toBe(true)
    })
  })

  describe('Non-CJK inputs', () => {
    it('returns false for pure ASCII', () => {
      expect(containsCJK('hello world')).toBe(false)
      expect(containsCJK('Vibe')).toBe(false)
      expect(containsCJK('a')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(containsCJK('')).toBe(false)
    })

    it('returns false for numbers and punctuation', () => {
      expect(containsCJK('123')).toBe(false)
      expect(containsCJK('!@#$%')).toBe(false)
    })

    it('returns false for emoji', () => {
      expect(containsCJK('😀')).toBe(false)
      expect(containsCJK('🎉🚀')).toBe(false)
    })

    it('returns false for Latin accented chars', () => {
      expect(containsCJK('café')).toBe(false)
      expect(containsCJK('naïve')).toBe(false)
      expect(containsCJK('für')).toBe(false)
    })
  })
})
