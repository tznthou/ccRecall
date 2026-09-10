// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  ARMS, runCase, runSuite, keywordScore, lexicalRetrieve, formatSummary,
  type EvalCase, type AnswerRequest,
} from '../evaluation/harness'
import { CASES } from '../evaluation/cases'

/**
 * Tests for the evaluation harness itself.
 *
 * A comparison harness that quietly leaks the answer, shares state between
 * cases, or scores everything the same produces numbers that look publishable
 * and mean nothing. These are the properties that make its output worth
 * reading at all — so they are asserted, not assumed.
 */

function caseFixture(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'fixture',
    projectId: '-eval-fixture',
    question: 'what checkpoint mode truncates the write-ahead log',
    reference: 'TRUNCATE',
    expects: ['truncate'],
    corpus: [
      { content: 'A TRUNCATE checkpoint resets the write-ahead log to zero bytes.', supporting: true },
      { content: 'Readers holding a snapshot can make a checkpoint return busy.' },
    ],
    ...overrides,
  }
}

const echo = (r: AnswerRequest) => r.evidence.join('\n') || 'nothing provided'

describe('blinding', () => {
  it('the answering model never receives the reference, the expectations, or the arm', async () => {
    // The whole comparison collapses if the answerer can tell which condition
    // it is in: it could answer the grader instead of the question.
    //
    // Sentinels rather than realistic wording. The first version asserted on a
    // phrase from the reference — which was also the corpus text, so it appeared
    // in `evidence` legitimately and the test failed for the wrong reason. A
    // leak check has to watch for a string that can only have come from the
    // field it is guarding.
    const seen: AnswerRequest[] = []
    await runCase(caseFixture({
      reference: 'SENTINEL_REFERENCE',
      expects: ['SENTINEL_EXPECTATION'],
    }), {
      answer: (r) => { seen.push(r); return 'x' },
    })

    expect(seen).toHaveLength(ARMS.length)
    for (const request of seen) {
      expect(Object.keys(request).sort()).toEqual(['evidence', 'question'])
      const serialized = JSON.stringify(request)
      expect(serialized).not.toContain('SENTINEL_REFERENCE')
      expect(serialized).not.toContain('SENTINEL_EXPECTATION')
      expect(serialized).not.toContain('ccrecall')
      expect(serialized).not.toContain('lexical')
    }
  })

  it('passes the same question to every arm — only the evidence differs', async () => {
    const seen: AnswerRequest[] = []
    await runCase(caseFixture(), { answer: (r) => { seen.push(r); return 'x' } })
    const questions = new Set(seen.map(r => r.question))
    expect(questions.size).toBe(1)
  })
})

describe('arms', () => {
  it('the no-memory arm gets no evidence at all', async () => {
    const result = await runCase(caseFixture(), { answer: echo })
    const none = result.arms.find(a => a.arm === 'none')!
    expect(none.evidence).toEqual([])
    expect(none.foundSupporting).toBe(false)
  })

  it('retrieval arms actually retrieve something for a matching question', async () => {
    // Guards against the harness reporting a clean sweep because every arm
    // silently returned nothing.
    const result = await runCase(caseFixture(), { answer: echo })
    for (const arm of ['ccrecall', 'lexical'] as const) {
      expect(result.arms.find(a => a.arm === arm)!.evidence.length).toBeGreaterThan(0)
    }
  })

  it('runs only the requested arms', async () => {
    const result = await runCase(caseFixture(), { answer: echo, arms: ['none'] })
    expect(result.arms.map(a => a.arm)).toEqual(['none'])
  })

  it('the lexical baseline ranks by term overlap and ignores unrelated memories', () => {
    const hits = lexicalRetrieve('checkpoint truncate', [
      { content: 'a truncate checkpoint resets the log' },
      { content: 'unrelated note about tokenizers' },
      { content: 'checkpoint modes: passive, full, truncate, restart' },
    ], 5)
    expect(hits).toHaveLength(2)
    expect(hits.every(h => h.includes('checkpoint'))).toBe(true)
  })
})

describe('isolation', () => {
  it('one case cannot retrieve another case\'s corpus', async () => {
    // Cross-case leakage is the failure that makes a comparison look decisive
    // while measuring contamination. Same projectId on purpose: if the corpora
    // shared a database, the second case would surface the first one's memory.
    const first = caseFixture({
      id: 'leak-a',
      projectId: '-eval-shared',
      corpus: [{ content: 'A TRUNCATE checkpoint resets the write-ahead log to zero bytes.', supporting: true }],
    })
    const second = caseFixture({
      id: 'leak-b',
      projectId: '-eval-shared',
      corpus: [{ content: 'Readers holding a snapshot can make a checkpoint return busy.' }],
      expects: ['truncate'],
    })

    const { results } = await runSuite([first, second], { answer: echo })
    const secondCcrecall = results[1].arms.find(a => a.arm === 'ccrecall')!
    expect(secondCcrecall.evidence.join(' ')).not.toContain('TRUNCATE')
    expect(secondCcrecall.score).toBe(0)
  })
})

describe('scoring', () => {
  it('discriminates: a correct answer outscores a wrong one', () => {
    // A scorer that returns the same number either way turns the whole suite
    // into an expensive way to print a constant.
    expect(keywordScore('use a TRUNCATE checkpoint', ['truncate'])).toBe(1)
    expect(keywordScore('use a passive checkpoint', ['truncate'])).toBe(0)
  })

  it('scores partial coverage proportionally', () => {
    expect(keywordScore('trigram tokenizer', ['trigram', 'three'])).toBe(0.5)
  })

  it('an empty expectation list scores zero rather than dividing by zero', () => {
    expect(keywordScore('anything', [])).toBe(0)
  })

  it('a supplied scorer replaces the default', async () => {
    const result = await runCase(caseFixture(), { answer: echo, score: () => 0.42 })
    expect(result.arms.every(a => a.score === 0.42)).toBe(true)
  })
})

describe('summary', () => {
  it('reports n per arm and averages only that arm\'s rows', async () => {
    const { summary } = await runSuite([caseFixture({ id: 'a' }), caseFixture({ id: 'b' })], {
      answer: echo,
    })
    expect(summary).toHaveLength(ARMS.length)
    for (const s of summary) expect(s.n).toBe(2)

    const none = summary.find(s => s.arm === 'none')!
    expect(none.meanScore).toBe(0)
    expect(none.supportingRecall).toBe(0)
  })

  it('renders every arm with its n, so a number is never quoted without one', () => {
    const text = formatSummary([
      { arm: 'ccrecall', n: 5, meanScore: 0.4, supportingRecall: 0.4 },
    ])
    expect(text).toContain('ccrecall')
    expect(text).toContain('5')
    expect(text).toContain('0.400')
  })
})

describe('shipped cases', () => {
  it('every case declares expectations and at least one supporting memory, except the floor', () => {
    for (const c of CASES) {
      expect(c.expects.length).toBeGreaterThan(0)
      expect(c.corpus.length).toBeGreaterThan(1)  // distractors are required
      if (c.id !== 'no-answer-in-corpus') {
        expect(c.corpus.some(m => m.supporting)).toBe(true)
      }
    }
  })

  it('the floor case is unanswerable from its own corpus by every arm', async () => {
    // If this ever passes, the suite has stopped measuring the memory: either a
    // case leaked the answer into its corpus, or the scorer rewards saying
    // nothing. The first draft did the latter — the no-memory arm scored 1.00
    // for replying "I do not know" against expects ['not','know'].
    const floor = CASES.find(c => c.id === 'no-answer-in-corpus')!
    const result = await runCase(floor, { answer: echo })
    for (const arm of result.arms) expect(arm.score).toBe(0)
  })
})
