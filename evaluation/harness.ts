// SPDX-License-Identifier: Apache-2.0
/**
 * Three-arm comparison harness — answers "did the memory help?", which is the
 * question issue #71 has been open on since 2026-05.
 *
 * Every metric ccRecall has shipped so far measures the retrieval layer: did
 * the right row come back, did it get injected, was it surfaced more than once.
 * None of them says whether having the memory produced a better answer. This
 * runs the same question under three evidence conditions and compares:
 *
 *   ccrecall — the real retrieval path (FTS5 + BM25 + decayed confidence)
 *   lexical  — a deliberately dumb bag-of-words baseline
 *   none     — no memory at all
 *
 * `lexical` is the load-bearing arm. Beating `none` only proves that some
 * context beats no context; beating `lexical` is what would justify the
 * ranking machinery. #83 already found that startup selection is statistically
 * indistinguishable from "a random other batch from the same project", so this
 * comparison is not rhetorical.
 *
 * WHAT THIS CANNOT TELL YOU
 * - Nothing about real sessions. Cases are authored, the corpus is authored.
 * - Nothing about a model you did not run it against; `answer` is injected.
 * - Nothing statistical from a handful of cases. Report n, always.
 *
 * The answering callback is deliberately injected rather than built in, so the
 * whole harness runs offline against a scripted model. That is what makes the
 * wiring testable without spending anything — a scored run with a real model
 * is a separate, explicit act.
 */
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database.js'
import type { MemoryType } from '../src/core/types.js'

export const ARMS = ['ccrecall', 'lexical', 'none'] as const
export type Arm = (typeof ARMS)[number]

export interface EvalMemory {
  content: string
  type?: MemoryType
  key?: string
  /** Marks a memory as the one a correct answer depends on. Used only to report
   *  whether retrieval found it — never shown to the answering model. */
  supporting?: boolean
}

export interface EvalCase {
  id: string
  projectId: string
  question: string
  /** What a correct answer has to convey. Never reaches the answering model. */
  reference: string
  /** Terms the default scorer looks for. Never reaches the answering model. */
  expects: string[]
  corpus: EvalMemory[]
}

/** Exactly what the answering model is given. No arm name, no reference, no
 *  expectations — a model that could see which condition it was in could match
 *  the grader instead of the question. Keeping the type this narrow is what
 *  makes that structural rather than a convention someone has to remember. */
export interface AnswerRequest {
  question: string
  evidence: string[]
}

export type AnswerFn = (request: AnswerRequest) => Promise<string> | string
export type ScoreFn = (answer: string, expects: string[]) => number

export interface ArmResult {
  arm: Arm
  evidence: string[]
  /** Whether retrieval surfaced at least one memory flagged `supporting`.
   *  Reported separately from the score: retrieval finding it and the model
   *  using it are different failures with different fixes. */
  foundSupporting: boolean
  answer: string
  score: number
}

export interface CaseResult {
  caseId: string
  arms: ArmResult[]
}

const EVIDENCE_LIMIT = 5

/** Default scorer: share of expected terms present in the answer.
 *
 *  Crude on purpose. It is here so the harness can run end to end with no API
 *  key, and because a scorer nobody can read is a scorer nobody can challenge.
 *  Swap in a model-based judge via `score` when you want to grade prose — and
 *  when you do, give the judge the same blindness the answerer has. */
export function keywordScore(answer: string, expects: string[]): number {
  if (expects.length === 0) return 0
  const haystack = answer.toLowerCase()
  const hits = expects.filter(term => haystack.includes(term.toLowerCase())).length
  return hits / expects.length
}

/** The dumb baseline: rank by how many of the question's words a memory
 *  contains. No index, no ranking model, no decay — if the real retrieval path
 *  cannot beat this, the ranking layer is not earning its complexity. */
export function lexicalRetrieve(question: string, corpus: EvalMemory[], limit: number): string[] {
  const terms = [...new Set(
    question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
  )].filter(t => t.length >= 2)
  if (terms.length === 0) return []
  return corpus
    .map(m => ({
      content: m.content,
      hits: terms.filter(t => m.content.toLowerCase().includes(t)).length,
    }))
    .filter(x => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map(x => x.content)
}

/** Load one case's corpus into a database of its own.
 *
 *  A fresh directory per case, never a shared one and never the real store:
 *  cross-case contamination is the failure mode that makes a comparison look
 *  decisive when it is measuring leakage. The caller owns cleanup via the
 *  returned `dispose`. */
async function loadCorpus(evalCase: EvalCase): Promise<{ db: Database; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `ccrecall-eval-${evalCase.id}-`))
  const db = new Database(path.join(dir, 'eval.db'))
  for (const memory of evalCase.corpus) {
    db.saveMemory({
      sessionId: null,
      messageId: null,
      content: memory.content,
      type: memory.type ?? 'discovery',
      projectId: evalCase.projectId,
      key: memory.key ?? null,
    })
  }
  return {
    db,
    dispose: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function evidenceFor(arm: Arm, evalCase: EvalCase, db: Database): string[] {
  if (arm === 'none') return []
  if (arm === 'lexical') return lexicalRetrieve(evalCase.question, evalCase.corpus, EVIDENCE_LIMIT)
  return db
    .queryMemories(evalCase.question, EVIDENCE_LIMIT, evalCase.projectId)
    .map(m => m.content)
}

export interface RunOptions {
  answer: AnswerFn
  score?: ScoreFn
  /** Restrict the run to a subset of arms. Whole set by default. */
  arms?: readonly Arm[]
}

/** Run every arm of one case against its own isolated corpus. */
export async function runCase(evalCase: EvalCase, opts: RunOptions): Promise<CaseResult> {
  const score = opts.score ?? keywordScore
  const arms = opts.arms ?? ARMS
  const supporting = new Set(
    evalCase.corpus.filter(m => m.supporting).map(m => m.content),
  )
  const { db, dispose } = await loadCorpus(evalCase)
  try {
    const results: ArmResult[] = []
    for (const arm of arms) {
      const evidence = evidenceFor(arm, evalCase, db)
      // Constructed here, field by field, rather than spreading the case:
      // spreading would carry `reference` and `expects` into the payload the
      // moment someone adds a field, and the blinding would be gone silently.
      const answer = await opts.answer({ question: evalCase.question, evidence })
      results.push({
        arm,
        evidence,
        foundSupporting: evidence.some(e => supporting.has(e)),
        answer,
        score: score(answer, evalCase.expects),
      })
    }
    return { caseId: evalCase.id, arms: results }
  } finally {
    await dispose()
  }
}

export interface ArmSummary {
  arm: Arm
  n: number
  meanScore: number
  /** How often retrieval surfaced the memory the answer depends on. `none` is
   *  always 0 by construction — it is the floor, not a failure. */
  supportingRecall: number
}

export async function runSuite(cases: EvalCase[], opts: RunOptions): Promise<{
  results: CaseResult[]
  summary: ArmSummary[]
}> {
  const results: CaseResult[] = []
  for (const evalCase of cases) results.push(await runCase(evalCase, opts))

  const arms = opts.arms ?? ARMS
  const summary = arms.map((arm): ArmSummary => {
    const rows = results.flatMap(r => r.arms.filter(a => a.arm === arm))
    const n = rows.length
    return {
      arm,
      n,
      meanScore: n === 0 ? 0 : rows.reduce((s, r) => s + r.score, 0) / n,
      supportingRecall: n === 0 ? 0 : rows.filter(r => r.foundSupporting).length / n,
    }
  })
  return { results, summary }
}

export function formatSummary(summary: ArmSummary[]): string {
  const lines = [
    'arm       n   mean score   supporting recall',
    '-------------------------------------------',
  ]
  for (const s of summary) {
    lines.push(
      `${s.arm.padEnd(9)} ${String(s.n).padStart(2)}   ${s.meanScore.toFixed(3).padStart(10)}   ${(s.supportingRecall * 100).toFixed(0).padStart(15)}%`,
    )
  }
  return lines.join('\n')
}
