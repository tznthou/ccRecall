// SPDX-License-Identifier: Apache-2.0
/**
 * Authored evaluation cases.
 *
 * THE BIG LIMITATION, STATED FIRST: these are written by hand, by someone who
 * knows how the retrieval path works. That is a bias no amount of care removes.
 * They cannot be drawn from the live corpus either — it is personal, and this
 * repository is public.
 *
 * Two things keep them from being pure self-congratulation:
 *
 * 1. `no-answer-in-corpus` exists so the suite has a floor. If every arm scores
 *    well on it, the metric is measuring the model's priors, not the memory.
 * 2. Several cases are shaped so the real retrieval path may well LOSE to the
 *    dumb baseline — paraphrase, short CJK queries, a crowded field of
 *    near-duplicates. Those are the shapes ccRecall is known to be weak at
 *    (FTS5 matches characters, not meaning). Cases chosen to flatter the
 *    ranking layer would tell us nothing we do not already believe.
 *
 * Distractors are not filler. A corpus of one obviously-relevant memory makes
 * every retrieval strategy look identical.
 */
import type { EvalCase } from './harness.js'

export const CASES: EvalCase[] = [
  {
    id: 'literal-match',
    projectId: '-eval-alpha',
    question: 'why does the WAL file keep growing to hundreds of megabytes',
    reference: 'A TRUNCATE checkpoint at batch boundaries is what resets the WAL file; PASSIVE and FULL leave it at peak size.',
    expects: ['truncate', 'checkpoint'],
    corpus: [
      {
        content: 'SQLite WAL grows without bound under a long-lived writer because PASSIVE and FULL checkpoints leave the file at its peak size for frame reuse. Only a TRUNCATE checkpoint resets it to zero, so run one at write-batch boundaries.',
        supporting: true,
        key: 'wal-truncate-checkpoint',
      },
      { content: 'WAL mode allows one writer and many readers concurrently, which is why the daemon and the MCP server can share one database file.' },
      { content: 'The busy_timeout pragma is set to 5000ms so a reader holding a snapshot does not fail a write immediately.' },
      { content: 'Journal mode is set once at connection open; changing it later on a live database requires an exclusive lock.' },
    ],
  },
  {
    id: 'paraphrase',
    projectId: '-eval-beta',
    // The memory says "trigram tokenizer" and "three characters"; the question
    // says neither. Character-level matching has nothing to grab here — this is
    // the shape where the dumb baseline is expected to do just as well.
    question: 'searching for a two-letter abbreviation returns nothing at all, what is going on',
    reference: 'The trigram tokenizer cannot index anything shorter than three characters, so short queries fall back to a substring scan.',
    expects: ['trigram', 'three'],
    corpus: [
      {
        content: 'The trigram tokenizer cannot index a token shorter than three characters in any language, so those queries return zero rows and fall back to a per-token LIKE scan that ANDs the terms.',
        supporting: true,
        key: 'trigram-three-char-floor',
      },
      { content: 'Full-text search across conversation history returns in under 100ms, fast enough to run inside a hook.' },
      { content: 'Stopwords were expanded from 21 to 223 entries because English function words dominated the topic index.' },
      { content: 'Queries should be phrased with more terms rather than fewer: terms are OR-joined, so extra terms widen recall.' },
    ],
  },
  {
    id: 'crowded-field',
    projectId: '-eval-gamma',
    // Five memories all mention timeouts. Only one answers the question. This
    // is where ranking is supposed to earn its keep.
    question: 'what timeout does the hook that runs on every prompt use',
    reference: 'The UserPromptSubmit hook uses a 300ms timeout because it blocks every prompt.',
    expects: ['300'],
    corpus: [
      {
        content: 'The hook that fires on every prompt uses a 300ms timeout, tighter than the others, because it sits on the blocking path to a response and a hung daemon must stay imperceptible.',
        supporting: true,
        key: 'prompt-hook-timeout',
      },
      { content: 'The session-start hook uses a 2000ms timeout, which is generous because it runs once per session.' },
      { content: 'The session-end hook allows 5000ms since nothing is waiting on its result.' },
      { content: 'The busy_timeout pragma on the database connection is 5000ms.' },
      { content: 'A capture lease expires after 125000ms, after which another worker may claim the same batch.' },
    ],
  },
  {
    id: 'cjk-query',
    projectId: '-eval-delta',
    // Deliberately uses the corpus's own wording (裁切, not 截斷) so this case
    // measures one thing: a Chinese question with no spaces in it. The tokenizer
    // indexes 3-character runs, and a spaceless question is submitted as a single
    // long token, so its trigrams (記憶注/憶注入/…) have to appear contiguously in
    // a memory to match. Probed 2026-09-11: the same question with one space
    // added ("記憶 注入") does match. That is the failure this case pins.
    question: '注入的內容為什麼會被裁切',
    reference: '每行注入的內容被裁切到 149 個字元，結論常落在切點之後。',
    expects: ['149'],
    corpus: [
      {
        content: '注入到 context 的每一行都會被裁切到 149 個字元，而記憶的結論通常寫在最後，所以送到讀者眼前的往往只有現象描述、沒有處方。',
        supporting: true,
        key: 'injection-truncation-149',
      },
      { content: '注入的總預算是 300 tokens，CJK 以每字一個 token 估算，其餘字元以 0.3 估算。' },
      { content: '記憶會隨時間壓縮：原文先變成摘要，再變成一行結論，最後刪除。' },
      { content: '知識圖譜聚合 session 與記憶的主題提及次數，用來推導知識深度。' },
    ],
  },
  {
    id: 'no-answer-in-corpus',
    projectId: '-eval-epsilon',
    // The floor. Nothing here answers the question. Any arm scoring well is
    // scoring on the model's own knowledge, which is exactly what this suite
    // must not mistake for the memory having helped.
    //
    // `expects` names a fact that does not exist in the corpus, rather than
    // words like "not"/"know". The first draft did the latter and the no-memory
    // arm scored 1.00 on it for answering "I do not know" — a floor case that
    // rewards saying nothing inflates exactly the baseline it exists to hold
    // down.
    question: 'which port does the coordinator bind to when the configured one is already taken',
    reference: 'Nothing in this corpus answers that; there is no documented fallback port.',
    expects: ['7750', 'fallback port'],
    corpus: [
      { content: 'The daemon listens on 127.0.0.1 only, never on a public interface.' },
      { content: 'A port outside 1..65535 in the environment falls back to the default rather than crash-looping the launch agent.' },
      { content: 'The maintenance coordinator runs a compression pass every five minutes on an unref\'d timer.' },
      { content: 'The integrity monitor runs PRAGMA integrity_check every six hours and writes drift to an alert directory.' },
    ],
  },
]
