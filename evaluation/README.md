# Evaluation — does the memory actually help?

Every metric ccRecall ships measures the **retrieval** layer: did the right row
come back, did it reach the injection, was it surfaced more than once. None of
them answers the question [#71](https://github.com/tznthou/ccRecall/issues/71)
has been open on since May — *did having the memory produce a better answer?*

This runs the same question under three evidence conditions and compares them.

```bash
pnpm eval:demo     # offline, stub model, no API key, costs nothing
```

## The three arms

| Arm | Evidence | What it is for |
|---|---|---|
| `ccrecall` | the real retrieval path (FTS5 + BM25 + decayed confidence) | the thing under test |
| `lexical` | a deliberately dumb bag-of-words ranker, ~15 lines, no index | **the load-bearing comparison** |
| `none` | nothing | the floor |

`lexical` is the arm that matters. Beating `none` only shows that some context
beats no context — an almost unfalsifiable claim. Beating `lexical` is what
would justify the ranking machinery. This is not a rhetorical worry: #83 already
measured startup selection as statistically indistinguishable from "a random
other batch from the same project" (p ≈ 0.27).

## What the harness guarantees

- **Blinding.** The answering callback receives `{ question, evidence }` and
  nothing else — no arm name, no reference answer, no expected terms. The
  payload is built field by field rather than spread from the case, so adding a
  field to `EvalCase` cannot silently widen it. Asserted in
  `tests/evaluation.test.ts`.
- **Isolation.** Each case gets its own temporary database, created and deleted
  per run. It never opens `~/.ccrecall/ccrecall.db`; there is no code path that
  can. A cross-case leak test asserts that two cases sharing a `projectId` still
  cannot see each other's corpus.
- **A floor.** `no-answer-in-corpus` is unanswerable from its own corpus. If any
  arm scores on it, the suite has stopped measuring memory and started measuring
  the model's prior knowledge.

## What it cannot tell you

Read this before quoting a number from it.

- **The cases are authored**, by someone who knows how retrieval works. They
  cannot be drawn from the live corpus — that is personal, and this repository
  is public. This is the single largest limitation and no amount of care in the
  harness reduces it.
- **`pnpm eval:demo` is not a quality result.** Its "model" echoes its evidence,
  so the run is fully determined by retrieval. That is deliberate — it isolates
  the retrieval comparison from model behaviour and makes the wiring testable
  for free — but it says nothing about answer quality.
- **n is tiny.** Five cases. Always quote the n alongside any number from here.
  Nothing in this directory produces a statistically meaningful claim yet.
- **The default scorer is keyword coverage**, which is crude and cannot grade
  prose. Pass your own `score` for anything real. If you use a model as judge,
  give the judge the same blindness the answerer has.

## Current standing (2026-09-11, stub model, n = 5)

```
arm       n   mean score   supporting recall
ccrecall   5        0.400                40%
lexical    5        0.600                60%
none       5        0.000                 0%
```

**The dumb baseline is ahead.** Two cases explain it, and both are known
weaknesses rather than surprises:

- `paraphrase` — the question and the memory share no vocabulary. FTS5 matches
  characters, not meaning, so it returns nothing while substring overlap still
  finds the row.
- `cjk-query` — a Chinese question contains no spaces, so it is submitted as one
  long token and its trigrams have to appear contiguously in a memory. Probed
  2026-09-11: **the same question with a single space added does match.** Both
  arms score zero here.

Five authored cases cannot establish that lexical retrieval is genuinely better.
What they do establish is that the comparison discriminates — the arms separate,
the floor holds at zero, and the failures land where the architecture predicts
they would.

## Extending it

Add cases to `cases.ts`. A case earns its place by including **distractors** —
a corpus with one obviously-relevant memory makes every retrieval strategy look
identical. Prefer shapes where ccRecall might lose; cases picked to flatter the
ranking layer teach nothing.

To run against a real model, pass your own `answer` to `runSuite`. That is a
separate, paid, explicit act — nothing here does it for you.
