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

export interface BudgetRow {
  content: string
}

export interface BudgetResult<R extends BudgetRow> {
  emitted: R[]
  droppedCount: number
  usedTokens: number
  truncated: boolean
}

/**
 * Apply a token budget to a list of row-like objects with a `content` field.
 * Per-row content is truncated to perRowCharCap (ellipsis-aware), cumulative
 * cost tracked; rows that would exceed maxTokens are dropped. Non-content
 * fields pass through unchanged (caller's row shape preserved).
 *
 * Callers should touch/log only `emitted` ids — dropped rows never reached
 * the client.
 */
export function applyRowBudget<R extends BudgetRow>(
  rows: R[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
  perRowCharCap: number = DEFAULT_PER_ROW_CHAR_CAP,
): BudgetResult<R> {
  const emitted: R[] = []
  let used = 0
  let truncated = false
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const clipped = truncateToChars(row.content, perRowCharCap)
    if (clipped !== row.content) truncated = true
    const cost = approximateTokens(clipped)
    if (used + cost > maxTokens) {
      return {
        emitted,
        droppedCount: rows.length - i,
        usedTokens: used,
        truncated,
      }
    }
    emitted.push({ ...row, content: clipped } as R)
    used += cost
  }
  return { emitted, droppedCount: 0, usedTokens: used, truncated }
}
