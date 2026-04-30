// SPDX-License-Identifier: Apache-2.0
import type { ParsedLine } from './types.js'
import { scoreKnowledgeBearing, KNOWLEDGE_THRESHOLD } from './outcome-scorer.js'

// 從 session 抓「可作為記憶候選的 assistant 文字」+ 結構化證據(filesTouched /
// hasCommitInvoked),餵 outcome-scorer.ts 評分。與 summarizer.ts inferOutcome 區別：
// inferOutcome 推 OutcomeStatus(committed/tested/...),本檔挑 last substantial assistant
// text 並收集旁證——commit 訊號是 ctx,不解 git commit -m 內容(留 follow-up)。

export interface OutcomeExtraction {
  candidateText: string | null
  hasCommitInvoked: boolean
  filesTouched: string[]
}

const SUBSTANTIAL_MIN_CHARS = 200
const STRUCTURAL_RE = /(?:^#{1,6}\s|```|^[-*]\s|\[\s?[xX ]?\s?\])/m
const GIT_COMMIT_RE = /\bgit\s+commit\b/

export function extractOutcome(messages: ParsedLine[]): OutcomeExtraction {
  const candidateText = pickLastSubstantialAssistant(messages)
  const { hasCommitInvoked, filesTouched } = collectToolEvidence(messages)
  return { candidateText, hasCommitInvoked, filesTouched }
}

function pickLastSubstantialAssistant(messages: ParsedLine[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const text = msg.contentText?.trim()
    if (!text) continue
    if (isSubstantial(text)) return text
  }
  return null
}

// length / markdown 結構是廉價 fast-path;短而高 signal 的純文字結語(例「Root cause:
// x.ts:42。495/495 tests pass.」)走 scorer 兜底——避免 length gate 在 scorer 之前就濾掉
// plan 想抓的真實 outcome。summarizer 仍會再跑 scorer 確認 score>=threshold 才 persist。
function isSubstantial(text: string): boolean {
  if (text.length >= SUBSTANTIAL_MIN_CHARS) return true
  if (STRUCTURAL_RE.test(text)) return true
  return scoreKnowledgeBearing(text).score >= KNOWLEDGE_THRESHOLD
}

function collectToolEvidence(messages: ParsedLine[]): { hasCommitInvoked: boolean; filesTouched: string[] } {
  let hasCommitInvoked = false
  const files = new Set<string>()

  for (const msg of messages) {
    if (!msg.hasToolUse || !msg.contentJson) continue
    let blocks: unknown
    try {
      blocks = JSON.parse(msg.contentJson)
    } catch {
      continue
    }
    if (!Array.isArray(blocks)) continue

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use') continue
      const name = b.name
      const input = b.input as Record<string, unknown> | undefined
      if (!input) continue

      if (name === 'Bash') {
        const cmd = (input.command as string) ?? ''
        if (GIT_COMMIT_RE.test(cmd)) hasCommitInvoked = true
      } else if (name === 'Edit' || name === 'Write') {
        const fp = input.file_path
        if (typeof fp === 'string' && fp.length > 0) files.add(fp)
      }
    }
  }

  return { hasCommitInvoked, filesTouched: Array.from(files) }
}
