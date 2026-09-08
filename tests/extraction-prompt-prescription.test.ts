// SPDX-License-Identifier: Apache-2.0
//
// Guards the "lead with the prescription" rule in the extraction prompt.
//
// Background (2026-09-08 L3 measurement, n=714 over 30 days): of the memories
// carrying a locatable prescription, 98.2% had it sitting past the per-row
// truncation applied before injection — median prescription offset 451 chars
// against a 149-char cap. Those memories reach a future session as a symptom
// report with the actionable half cut off. One measured instance: memory #1627
// was injected at 09-06 04:57 and the same lesson was re-derived and re-saved
// as #1634 at 05:59, because #1627's `Mitigation:` sat at offset ~330.
//
// Two failure modes are guarded here, both silent:
//   1. The cap in token-budget.ts changes and the prompt keeps quoting the old
//      number, so the model optimises for a budget that no longer exists.
//   2. extraction-prompt.md gains the rule but the wrapper's inline fallback
//      does not. The fallback is not hypothetical: CCRECALL_SCRIPT_DIR used to
//      resolve to $PWD under zsh, and the fallback ran silently for a month
//      (see the #89 note in post-session-extract.sh).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(__dirname, '..')
const PROMPT = path.join(ROOT, 'scripts', 'extraction-prompt.md')
const WRAPPER = path.join(ROOT, 'scripts', 'post-session-extract.sh')
const BUDGET = path.join(ROOT, 'src', 'core', 'token-budget.ts')

/** The live per-row cap, read from the module that actually truncates. */
function liveCap(): number {
  const src = readFileSync(BUDGET, 'utf8')
  const m = src.match(/DEFAULT_PER_ROW_CHAR_CAP\s*=\s*(\d+)/)
  if (!m) throw new Error('DEFAULT_PER_ROW_CHAR_CAP not found in token-budget.ts')
  return Number(m[1])
}

/** The wrapper's inline fallback prompt, pulled from source so it cannot drift. */
function fallbackPrompt(): string {
  const src = readFileSync(WRAPPER, 'utf8')
  const m = src.match(/^\s*prompt="(You are a memory extraction agent[\s\S]*?)"\s*$/m)
  if (!m) throw new Error('inline fallback prompt not found in post-session-extract.sh')
  return m[1]
}

describe('extraction prompt: lead with the prescription (L3)', () => {
  it('states the truncation budget the memory has to fit its prescription into', () => {
    const prompt = readFileSync(PROMPT, 'utf8')
    const cap = liveCap()
    // truncateToChars keeps cap - 1 chars and appends an ellipsis, so what a
    // memory actually gets is cap - 1. Accept either that surviving count or
    // the raw constant; reject anything else as drift.
    const quoted = prompt.match(/\b(\d{2,4})\s*character/i)
    expect(quoted, 'prompt must state a character budget for the opening').not.toBeNull()
    const n = Number(quoted![1])
    expect(
      n === cap || n === cap - 1,
      `prompt quotes ${n} chars but token-budget.ts caps rows at ${cap} ` +
      `(${cap - 1} survive after the ellipsis) — update the prompt when the cap moves`,
    ).toBe(true)
  })

  it('carries the rule as its own section, ahead of the writing rules', () => {
    // Asserting "the phrase appears somewhere in the file" does not hold: the
    // prompt says "lead with" again in the no-action caveat, so deleting the
    // rule itself still left that assertion green (caught by mutation probe,
    // 2026-09-08). Pin the section and its position instead — position is how
    // the prompt signals priority to the model.
    const prompt = readFileSync(PROMPT, 'utf8')
    const headings = [...prompt.matchAll(/^##\s+(.+)$/gm)]
    const ruleIdx = headings.findIndex(h => /prescription|lead with/i.test(h[1]))
    const writeIdx = headings.findIndex(h => /how to write each memory/i.test(h[1]))

    expect(ruleIdx, 'no "## Lead with the prescription" style section found').toBeGreaterThanOrEqual(0)
    expect(writeIdx, '"## How to write each memory" section is missing').toBeGreaterThanOrEqual(0)
    expect(
      ruleIdx < writeIdx,
      'the prescription rule must come before the general writing rules',
    ).toBe(true)

    // Body of that section only, so unrelated prose cannot satisfy this.
    const start = headings[ruleIdx].index!
    const end = ruleIdx + 1 < headings.length ? headings[ruleIdx + 1].index! : prompt.length
    const body = prompt.slice(start, end).toLowerCase()
    expect(body, 'section must tell the model to open with the action').toMatch(
      /open with|lead with|first sentence/,
    )

    // Check the explanation, not the worked examples: the GOOD/BAD example
    // labels themselves contain "survives the cut", which kept this assertion
    // green when the mechanism sentence was deleted (mutation probe 2c).
    const exampleStart = body.search(/^\s*-\s+(bad|good)\b/m)
    const rationale = exampleStart >= 0 ? body.slice(0, exampleStart) : body
    expect(rationale, 'section must explain that the tail is truncated away').toMatch(
      /truncat|survive/,
    )
  })

  it('keeps the inline fallback aligned with the same rule', () => {
    // If the fallback omits it, any run that misresolves the script dir emits
    // memories with the old shape and nothing reports the divergence.
    const fb = fallbackPrompt().toLowerCase()
    expect(fb).toMatch(/lead with|open with|first sentence/)
  })
})
