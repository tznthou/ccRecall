// SPDX-License-Identifier: Apache-2.0
/**
 * Offline demonstration — verifies the harness is wired correctly, and nothing
 * else. Makes no model calls, needs no key, costs nothing.
 *
 *   pnpm eval:demo
 *
 * The "model" here is a stub that echoes whatever evidence it was handed. That
 * makes the run fully determined by retrieval: an arm scores exactly when the
 * memory containing the expected terms reached it. Which is the point — it
 * isolates the retrieval comparison from model behaviour, and it means a change
 * to the ranking path shows up here immediately instead of being absorbed by a
 * model that knew the answer anyway.
 *
 * Read the numbers as "did retrieval deliver the deciding memory", never as
 * "does ccRecall make answers better". The second question needs a real model
 * and is a separate, paid run.
 */
import { CASES } from './cases.js'
import { runSuite, formatSummary, type AnswerRequest } from './harness.js'

/** Stub model: repeats its evidence verbatim. No knowledge of its own, so it
 *  cannot answer from priors — an empty-evidence arm necessarily scores zero
 *  unless the expected terms are trivial. */
function echoModel(request: AnswerRequest): string {
  if (request.evidence.length === 0) return 'I do not know; nothing was provided.'
  return request.evidence.join('\n')
}

const { results, summary } = await runSuite(CASES, { answer: echoModel })

console.log('ccRecall three-arm comparison — OFFLINE STUB MODEL, not a quality result\n')
console.log(formatSummary(summary))
console.log(`\ncases: ${results.length}   (n per arm = cases)\n`)

console.log('per case:')
for (const result of results) {
  const cells = result.arms
    .map(a => `${a.arm} ${a.score.toFixed(2)}${a.foundSupporting ? '*' : ' '}`)
    .join('   ')
  console.log(`  ${result.caseId.padEnd(22)} ${cells}`)
}
console.log('\n  * retrieval surfaced the supporting memory')
console.log('\nFloor check: no-answer-in-corpus should score near zero on every arm.')
console.log('If it does not, the metric is reading the model\'s priors, not the memory.')
