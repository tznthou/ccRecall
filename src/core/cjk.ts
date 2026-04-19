// SPDX-License-Identifier: Apache-2.0
/** Detects CJK characters to decide whether a query needs a LIKE fallback.
 *  FTS5 trigram tokenizer cannot match queries shorter than 3 chars, so CJK
 *  queries of 1–2 chars bypass FTS5 entirely and scan content via LIKE. */
const CJK_PATTERN =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u

export function containsCJK(s: string): boolean {
  return CJK_PATTERN.test(s)
}
