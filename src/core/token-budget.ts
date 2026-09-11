// SPDX-License-Identifier: Apache-2.0

/**
 * Token budget primitives for recall output (Issue #12).
 * Implementation of the injection budget contract documented in tutorial.md.
 * The number lives in DEFAULT_MAX_TOKENS below, not in this sentence: stating
 * it twice is how the file came to say "<300 tokens" three lines above the
 * constant that reads 400.
 */

/** Total output budget for one SessionStart injection.
 *
 *  Raised from 300 on 2026-09-11 alongside honest accounting. The old number
 *  was not a smaller budget, it was a wrong one: measured against the real hook
 *  with a corpus-shaped payload, a "300 token" injection emitted 363 because
 *  only `content` was priced. 400 keeps the same five rows reaching the reader
 *  now that the prefix, confidence suffix, [key: …] handle, header and footer
 *  are all counted. It buys no extra content — it stops the contract lying. */
export const DEFAULT_MAX_TOKENS = 400
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

/** What a row costs once the hook has rendered it — prefix, suffixes and all.
 *  Receives the clipped content so the caller never re-derives the clipping. */
export type RowCostFn<R extends BudgetRow> = (clipped: string, row: R) => number

export interface BudgetOptions<R extends BudgetRow> {
  /** Price of a rendered row. Defaults to the content alone, which is what the
   *  budget did before it learned about the decoration around it. */
  costOf?: RowCostFn<R>
  /** Fixed output the caller will add regardless of how many rows survive —
   *  a header, a footer. Charged up front, and included in `usedTokens`, so
   *  the reported number is the size of the whole emission. */
  reservedTokens?: number
  /** When the first row will not fit, trim it to what remains instead of
   *  emitting nothing. Off by default: this changes what callers receive.
   *
   *  Exists because honest accounting makes "nothing fits" common on the
   *  mid-conversation path, where one CJK memory costs one token per character
   *  and alone exceeds the budget. Silence there is indistinguishable from
   *  "no relevant memory", so the failure was invisible. Trimming keeps the
   *  contract intact — the budget is never exceeded — while still saying
   *  something. */
  minimumOneRow?: boolean
}

/** Number of code points of `text` that fit in `budget` tokens.
 *
 *  Walks from the front accumulating real cost rather than dividing by an
 *  average: the two scripts price an order of magnitude apart (CJK 1.0,
 *  Latin 0.3), so an average is wrong for any mixed string and silently
 *  overshoots on the CJK-heavy ones this exists to serve. */
function charsWithin(text: string, budget: number): number {
  if (budget <= 0) return 0
  let used = 0
  let count = 0
  for (const ch of text) {
    used += CJK_REGEX.test(ch) ? 1 : 0.3
    if (Math.ceil(used) > budget) break
    count++
  }
  return count
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
  options: BudgetOptions<R> = {},
): BudgetResult<R> {
  const costOf = options.costOf ?? ((clipped: string) => approximateTokens(clipped))
  const reserved = options.reservedTokens ?? 0
  const emitted: R[] = []
  let used = reserved
  let truncated = false

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const clipped = truncateToChars(row.content, perRowCharCap)
    if (clipped !== row.content) truncated = true
    const cost = costOf(clipped, row)

    if (used + cost > maxTokens) {
      // The floor applies only to the first row: once something has been
      // emitted, silence is no longer the failure mode this guards against.
      if (options.minimumOneRow && emitted.length === 0) {
        const trimmed = trimToBudget(clipped, row, maxTokens - used, costOf, perRowCharCap)
        if (trimmed !== null) {
          emitted.push({ ...row, content: trimmed } as R)
          return {
            emitted,
            droppedCount: rows.length - 1,
            usedTokens: used + costOf(trimmed, row),
            truncated: true,
          }
        }
      }
      return { emitted, droppedCount: rows.length - i, usedTokens: used, truncated }
    }

    emitted.push({ ...row, content: clipped } as R)
    used += cost
  }
  return { emitted, droppedCount: 0, usedTokens: used, truncated }
}

// ── What the hooks actually render ──────────────────────────────────────────
//
// These mirror `formatStartupV1` in hooks/session-start.mjs and `formatRecall`
// in hooks/user-prompt-submit.mjs. Two copies of a format is how they drift
// apart, so tests/token-budget-honesty.test.ts spawns the real hooks and
// asserts the prediction against their actual stdout. Change a hook's
// rendering and that test fails — which is the point.

/** A key longer than this is dropped by both hooks rather than truncated, so
 *  it costs nothing. Mirrors MAX_KEY_CHARS in both hook files. */
export const MAX_KEY_CHARS = 60

/** Header, blank lines and footer the startup hook wraps around the rows.
 *  Sized against the longest footer variant (the one carrying the corpus
 *  count), so the reservation cannot come up short as the corpus grows. */
export const STARTUP_CHROME_TOKENS = 52

/** Same for the mid-conversation hook, whose footer is a single short line. */
export const PROMPT_CHROME_TOKENS = 31

/** Only the fields the hooks render alongside the content. Deliberately not
 *  extending BudgetRow: these functions receive the clipped text as their first
 *  argument and must never read `row.content`, which is the unclipped original. */
interface DecoratedRow {
  confidence?: number
  key?: string | null
}

function handleFor(row: DecoratedRow): string {
  return row.key && row.key.length <= MAX_KEY_CHARS ? ` [key: ${row.key}]` : ''
}

/** Cost of one startup line: `- <content>[ (conf N.NN)][ [key: …]]` plus the
 *  newline joining it to the previous line. */
export function startupLineCost(clipped: string, row: DecoratedRow): number {
  const conf = row.confidence != null && row.confidence !== 1
    ? ` (conf ${Number(row.confidence).toFixed(2)})`
    : ''
  return approximateTokens(`- ${clipped}${conf}${handleFor(row)}`) + 1
}

/** Cost of one mid-conversation line. No confidence suffix — that hook does
 *  not render one. */
export function promptLineCost(clipped: string, row: DecoratedRow): number {
  return approximateTokens(`- ${clipped}${handleFor(row)}`) + 1
}

/** Longest prefix of `clipped` whose *rendered* cost fits `budget`, or null if
 *  even a minimal one does not.
 *
 *  Budgets against the rendered cost, not the content's own: the decoration is
 *  charged per row whether the content is 150 characters or 5, so trimming
 *  against the raw length would overshoot by exactly the amount this change
 *  exists to stop hiding. Returns null rather than an empty string — an empty
 *  bullet costs the reader a line and tells them nothing. */
function trimToBudget<R extends BudgetRow>(
  clipped: string,
  row: R,
  budget: number,
  costOf: RowCostFn<R>,
  perRowCharCap: number,
): string | null {
  if (budget <= 0) return null
  const overhead = costOf('', row)
  let chars = Math.min(charsWithin(clipped, budget - overhead), perRowCharCap)
  // charsWithin works off raw content cost; the ellipsis truncateToChars adds
  // and any rounding in costOf can still push it over. Walk down until it fits
  // rather than trusting the estimate.
  //
  // Stops at MIN_TRIMMED_CHARS rather than 1: truncateToChars(text, 1) returns
  // the ellipsis alone, and a bullet reading "- …" costs the reader a line to
  // learn nothing. Below the floor there is no row worth emitting.
  while (chars >= MIN_TRIMMED_CHARS) {
    const candidate = truncateToChars(clipped, chars)
    if (costOf(candidate, row) <= budget) return candidate
    chars--
  }
  return null
}

/** Shortest trimmed row worth emitting. Under this the line is an ellipsis and
 *  a word or two — it occupies a slot and conveys nothing. */
const MIN_TRIMMED_CHARS = 12
