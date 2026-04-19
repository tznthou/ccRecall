// SPDX-License-Identifier: Apache-2.0

/**
 * Token budget primitives for recall output (Issue #12).
 * Implementation of the "<300 tokens" contract documented in tutorial.md.
 */

export const DEFAULT_MAX_TOKENS = 300
export const DEFAULT_PER_ROW_CHAR_CAP = 150

const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Conservative token estimate without a real tokenizer.
 * CJK chars at 1.0 (close to Claude tokenizer for Traditional Chinese),
 * non-CJK at 0.3 (slight over-estimate of real ~0.25 for Latin, biasing
 * toward under-delivery over contract breach).
 */
export function approximateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other * 0.3)
}

const ELLIPSIS = '…'

/**
 * Truncate to at most maxChars code points (not UTF-16 units), appending an
 * ellipsis when clipped. Code-point safe so surrogate pairs are not split.
 */
export function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  if (maxChars === 1) return ELLIPSIS
  return chars.slice(0, maxChars - 1).join('') + ELLIPSIS
}
