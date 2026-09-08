// SPDX-License-Identifier: Apache-2.0
//
// Guards the "lead with the prescription" rule in the extraction prompt.
//
// Background (2026-09-08 L3 measurement, n=429 uncompressed rows over 30 days):
// of the memories carrying a locatable prescription, 98.3% had it sitting past
// the per-row truncation applied before injection — median prescription offset
// 446 chars against a 149-char cap. Those memories reach a future session as a
// symptom report with the actionable half cut off. One measured instance: memory
// #1627 was injected at 09-06 04:57 and the same lesson was re-derived and
// re-saved as #1634 at 05:59, because #1627's `Mitigation:` sat at offset ~330.
//
// Three failure modes are guarded here, all silent:
//   1. The cap in token-budget.ts changes and the prompt keeps quoting the old
//      number, so the model optimises for a budget that no longer exists.
//   2. extraction-prompt.md gains the rule but the wrapper's inline fallback
//      does not. The fallback is not hypothetical: CCRECALL_SCRIPT_DIR used to
//      resolve to $PWD under zsh, and the fallback ran silently for a month
//      (see the #89 note in post-session-extract.sh).
//   3. The section survives but says the opposite thing.
//
// 🔴 Every assertion here has been caught satisfying itself at least once. The
// pattern repeats because the subject under test is prose, and prose about a
// rule contains the words of the rule:
//   - "the phrase appears in the file" — the no-action caveat says "lead with"
//     too, so deleting the rule left it green (probe 2b, 09-08).
//   - "the section explains truncation" — the label `GOOD — survives the cut`
//     satisfied /truncat|survive/ on its own (probe 2c, 09-08).
//   - "the section body says open with" — the body was sliced FROM the heading
//     `## Lead with the prescription`, so the heading satisfied it and the rule
//     could be inverted outright while staying green (found in review, 09-08,
//     by the fix for the two above).
// So: slice past the heading, assert against the rationale prose only, and
// prefer a mechanical property of the worked examples over any phrase at all.
// CONTRIBUTING.md:70-72 — if flipping the logic would not fail the test, it is
// not a test.
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

/**
 * The prescription section, sliced from AFTER its heading line to the next
 * heading. Excluding the heading is load-bearing: it is the only reason an
 * assertion here can distinguish the rule from the rule's own title.
 */
function ruleSection(prompt: string): { body: string; ruleIdx: number; writeIdx: number } {
  const headings = [...prompt.matchAll(/^##\s+(.+)$/gm)]
  const ruleIdx = headings.findIndex(h => /prescription|lead with/i.test(h[1]))
  const writeIdx = headings.findIndex(h => /how to write each memory/i.test(h[1]))
  if (ruleIdx < 0) return { body: '', ruleIdx, writeIdx }
  const start = headings[ruleIdx].index! + headings[ruleIdx][0].length
  const end = ruleIdx + 1 < headings.length ? headings[ruleIdx + 1].index! : prompt.length
  return { body: prompt.slice(start, end), ruleIdx, writeIdx }
}

/** The quoted memory text of one worked example. */
function example(body: string, label: 'BAD' | 'GOOD'): string {
  const m = body.match(new RegExp(`-\\s*${label}\\b[^\\n]*\\n\\s*"([\\s\\S]*?)"`, 'm'))
  if (!m) throw new Error(`no ${label} worked example found in the prescription section`)
  return m[1]
}

/**
 * Same locator the acceptance script uses (scripts/l3-prescription-position.py),
 * kept deliberately simple: this only has to find the marker in two short
 * hand-written strings.
 */
const MARKER =
  /(?:^\s*(?:[-*]\s*)?|[.,;:!?。，、；！？]\s*)(Mitigation|Solution|Fix|Prevention|Workaround|Remedy|Correction|Lesson|Rule|解法|修法|判準)\s*[:：]/im

describe('extraction prompt: lead with the prescription (L3)', () => {
  it('states the truncation budget the memory has to fit its prescription into', () => {
    const prompt = readFileSync(PROMPT, 'utf8')
    const cap = liveCap()
    // Scoped to the rule's own section. Reading the first "<number> character"
    // in the whole file meant any future rule mentioning a character count —
    // "keep lines under 100 characters" — would be captured instead, silently
    // disarming the one assertion that pins the prompt to the live constant.
    const { body } = ruleSection(prompt)
    // truncateToChars keeps cap - 1 chars and appends an ellipsis, so what a
    // memory actually gets is cap - 1. Accept either that surviving count or
    // the raw constant; reject anything else as drift.
    const quoted = body.match(/\b(\d{2,4})\s*character/i)
    expect(quoted, 'the rule section must state a character budget for the opening').not.toBeNull()
    const n = Number(quoted![1])
    expect(
      n === cap || n === cap - 1,
      `prompt quotes ${n} chars but token-budget.ts caps rows at ${cap} ` +
      `(${cap - 1} survive after the ellipsis) — update the prompt when the cap moves`,
    ).toBe(true)
  })

  it('carries the rule as its own section, ahead of the writing rules', () => {
    const prompt = readFileSync(PROMPT, 'utf8')
    const { body, ruleIdx, writeIdx } = ruleSection(prompt)

    expect(ruleIdx, 'no "## Lead with the prescription" style section found').toBeGreaterThanOrEqual(0)
    expect(writeIdx, '"## How to write each memory" section is missing').toBeGreaterThanOrEqual(0)
    expect(
      ruleIdx < writeIdx,
      'the prescription rule must come before the general writing rules — ' +
      'position is how this prompt signals priority to the model',
    ).toBe(true)

    // Check the explanation, not the worked examples: the example labels contain
    // "survives the cut" and satisfied this on their own (probe 2c).
    const exampleStart = body.search(/^\s*-\s+(bad|good)\b/im)
    const rationale = (exampleStart >= 0 ? body.slice(0, exampleStart) : body).toLowerCase()
    expect(rationale, 'section must explain that the tail is truncated away').toMatch(
      /truncat|survive/,
    )
    expect(rationale, 'section must tell the model what to put first').toMatch(/open with/)
  })

  it('demonstrates the rule in its own worked examples', () => {
    // The direction of the rule, asserted as a measurable property rather than a
    // phrase — this is what survives someone rewriting the prose, and what fails
    // if BAD and GOOD are swapped. BAD must show a prescription arriving too
    // late to be delivered; GOOD must not repeat the mistake it contrasts with.
    const cap = liveCap() - 1
    const { body } = ruleSection(readFileSync(PROMPT, 'utf8'))

    const bad = example(body, 'BAD')
    const badMarker = bad.match(MARKER)
    expect(badMarker, 'the BAD example must contain a prescription marker to be an example at all').not.toBeNull()
    expect(
      badMarker!.index! + badMarker![0].length - badMarker![1].length >= cap,
      `the BAD example's prescription sits at ${badMarker!.index} — inside the ${cap}-char cut, ` +
      `so it does not demonstrate the failure it is captioned with`,
    ).toBe(true)

    const good = example(body, 'GOOD')
    const goodMarker = good.match(MARKER)
    expect(
      goodMarker === null || goodMarker.index! < cap,
      'the GOOD example carries a prescription marker past the cut — it demonstrates the BAD case',
    ).toBe(true)
  })

  it('keeps the inline fallback aligned with the same rule', () => {
    // If the fallback omits it, any run that misresolves the script dir emits
    // memories with the old shape and nothing reports the divergence.
    const cap = liveCap()
    const fb = fallbackPrompt()
    expect(fb.toLowerCase()).toMatch(/lead with|open with|first sentence/)
    // The number too. Until 2026-09-08 this test read only the phrase while a
    // comment above the fallback claimed the test "pins both copies" — the .sh
    // could say 999 characters and stay green. A false claim of coverage is
    // worse than no coverage: it is what the next person reads instead of the
    // assertion.
    const quoted = fb.match(/\b(\d{2,4})\s*character/i)
    expect(quoted, 'the fallback must state its character budget too').not.toBeNull()
    const n = Number(quoted![1])
    expect(
      n === cap || n === cap - 1,
      `fallback quotes ${n} chars but token-budget.ts caps rows at ${cap}`,
    ).toBe(true)
  })
})
