// SPDX-License-Identifier: Apache-2.0
import type { ParsedLine } from './types.js'
import { scoreKnowledgeBearing, isProcessReport } from './outcome-scorer.js'

// 從 session 挑「last substantial assistant text」作為記憶候選,餵 outcome-scorer.ts 評分。
// 與 summarizer.ts inferOutcome 區別:inferOutcome 推 OutcomeStatus(committed/tested/...),
// 本檔只解候選文字。Tool 旁證(git commit / files touched)走 inferOutcome 既有路徑——
// 這裡不重複 parse,避免 summarizeSession 三重 JSON.parse。

export interface OutcomeExtraction {
  candidateText: string | null
}

const SUBSTANTIAL_MIN_CHARS = 200
const STRUCTURAL_RES: ReadonlyArray<RegExp> = [
  /^#{1,6}\s/m,         // markdown header
  /```/,                // fenced code
  /^[-*]\s/m,           // bullet list
  /\[\s?[xX ]?\s?\]/,   // checkbox
]

export function extractOutcome(messages: ParsedLine[]): OutcomeExtraction {
  return { candidateText: pickLastSubstantialAssistant(messages) }
}

function pickLastSubstantialAssistant(messages: ParsedLine[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const text = msg.contentText?.trim()
    if (!text) continue
    if (isProcessReport(text)) continue
    if (isSubstantial(text)) return text
  }
  return null
}

// length / markdown 結構是廉價 fast-path;短而高 signal 的純文字結語(例「Root cause:
// x.ts:42。495/495 tests pass.」、「我們決定改用 SQLite」)走 scorer 兜底。
// v0.3.0 (#21 P1): 門檻從 score >= 2 降為 score >= 1。理由——P1 移除 persistence
// gate 後, score 0/1 也應進 journal 留作 candidate, walk-back 上游不該預先濾掉。
// score=0 (含 noise / process-report 短路) 仍擋, 不會引入空字串/純 ack 雜訊。
function isSubstantial(text: string): boolean {
  if (text.length >= SUBSTANTIAL_MIN_CHARS) return true
  if (STRUCTURAL_RES.some(p => p.test(text))) return true
  return scoreKnowledgeBearing(text).score >= 1
}
