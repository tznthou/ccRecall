# Changelog

All notable changes to ccRecall are recorded here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) (anything under `1.0`
is pre-stable — breaking changes are documented but the minor number is used
more like an iteration counter than a strict SemVer major).

[中文版](CHANGELOG_ZH.md)

---

## [0.6.0] — 2026-08-02

Memories were only ever offered at second zero. A session could run for hours
and turn to any subject without the store being consulted again, which is why
`recall_query` accounted for well under 1% of all memory surfacing. This
release adds a second trigger point, makes injected excerpts fetchable, and
makes a long-standing extraction failure visible.

### Added

- **Mid-conversation recall** — a new `UserPromptSubmit` hook
  (`hooks/user-prompt-submit.mjs`) backed by `GET /memory/prompt`. It extracts
  topics from the prompt and surfaces related memories mid-session.

  Deliberately restrained, because injected context accumulates in the
  conversation rather than being replaced
  ([claude-code#40216](https://github.com/anthropics/claude-code/issues/40216)) —
  every injection is permanent weight. It skips short prompts and slash
  commands with no network call, suppresses memories already surfaced in the
  session, stops after 8 memories per session, times out at 300ms, and fails
  open on any error. Measured at ~40ms end to end against a 742-memory store.
  Set `CCRECALL_PROMPT_RECALL=off` to disable it.

  Ranking is inverse document frequency over topics, scoped per project and
  normalised by each memory's own topic count — without that normalisation
  long memories outrank everything regardless of subject, which is the same
  length bias that skews startup selection.

- **Injected memories now carry their key.** Startup lines are ~150-character
  excerpts of memories averaging far more, and the cut usually lands before
  the conclusion. The key travels through the API and renders as a handle, so
  a truncated line can be read in full with `recall_query`. The footer now
  says the lines are excerpts instead of reporting only how many memories
  exist, which read as though the shown ones were whole.

- **Extraction silent-miss detection.** The extraction model sometimes prints
  `recall_save(...)` as text instead of invoking the tool: the run exits 0
  with empty stderr and writes nothing, indistinguishable in telemetry from a
  session with nothing worth saving. The wrapper now counts printed call
  syntax into a new `recallSaveTextCount` telemetry field (a count only — no
  captured content reaches the log) and warns at the terminal on a clean exit
  that produced them.

### Changed

- **`ccmem install-hooks` now registers three hooks**, adding
  `UserPromptSubmit` to `SessionStart` and `SessionEnd`. Re-running install on
  an existing setup will add it. Unlike the other two, this one runs on every
  prompt — see `hooks/README.md` for the restraint notes and the kill switch.

## [0.5.6] — 2026-07-26

### Changed

- **`/health` field `sessionCount` renamed to `mainSessionCount`** — the value
  has always counted main sessions only (subagent sessions are excluded), so
  the old name read like the full sessions-table count when it wasn't. Update
  the field name if you script against `/health`.

### Added

- **SessionEnd hook logs its harvest decision to stderr** — skips (resume /
  missing session_id) and harvest starts now log the hook `reason`, so the
  reason distribution can be aggregated when diagnosing harvest misses.
  Previously skips were silent, making misses undiagnosable.

## [0.5.5] — 2026-07-24

### Changed

- **Tier 0 startup injection now rotates** (#71 Phase B) — Tier 0 ordering was
  purely static, so the same three memories occupied the startup injection
  slots every session. An injection_log subquery is now the second sort key:
  confidence DESC, then least-recently-injected first (never injected = top
  priority), then created_at DESC.

### Added

- **`scripts/usefulness-report.sql`** — topic-overlap analysis (#71 S1) with a
  data quality gate, overlap distribution, per-source breakdown, and the
  top-10 most-injected memories.

## [0.5.4] — 2026-07-23

### Added

- **injection_log** (#71 Phase A) — migration v25 adds an `injection_log`
  table recording every memory `touch()` with its source (startup / query /
  recall_query / recall_context) and optional session_id, enabling usefulness
  attribution. The SessionStart hook now passes session_id to
  `/memory/startup`; sessionId is normalized server-side (empty string →
  null); INSERT OR IGNORE keeps logging FK-safe for nonexistent memory IDs.

## [0.5.3] — 2026-07-23

### Changed

- **Topic extraction now preserves CJK characters** — `normalizeTopicKey` uses
  `\p{Script=Han}` (Unicode property escape) instead of stripping all non-ASCII.
  Chinese terms like 砍刀場, 版本, 驗證 now appear as topic keys in the knowledge
  map. Content extraction splits on Chinese punctuation and common grammatical
  particles (的/了/是/在) for lightweight phrase segmentation without external
  dependencies. CJK stopwords (~32 entries) filter noise; pure-Han runs over 6
  characters are skipped (FTS5 trigram covers those). Production validation:
  772 CJK topics from 0, 1.09× total count increase.

### Fixed

- **`rebuildKnowledgeMap` dropped session-less memories** — the memory_topics
  branch used INNER JOIN on sessions, silently excluding all `recall_save`
  memories (14% of total). Changed to LEFT JOIN with
  `COALESCE(s.project_id, m.project_id)` fallback.
- **`getMemoriesByTopics` had the same INNER JOIN gap** — topic-based retrieval
  now matches the rebuild path, so session-less memories are both counted and
  retrievable. (PTA cross-source finding: Simplify + Security independently
  flagged this.)

### Upgrade guide

**Only relevant if your memories contain CJK text** (Chinese, Japanese kanji,
or Korean hanja). English-only users need no action — the upgrade is seamless.

The new CJK-aware extractor only affects memories written **after** upgrading.
To backfill CJK topics for existing memories, run once after `npm install -g`:

```sh
pnpm tsx scripts/backfill-memory-topics.ts
```

This script skips memories that already have topics, so it won't re-extract
existing CJK topics on its own. If you upgraded from ≤ 0.5.2 and want CJK
topics for older memories, use the one-liner below to add them (safe to run
multiple times — duplicates are ignored):

```sh
npx tsx -e "
  import {Database} from './src/core/database.js';
  import {extractTopicsFromContent} from './src/core/topic-extractor.js';
  const db = new Database(require('os').homedir()+'/.ccrecall/ccrecall.db');
  const mems = db.rawAll('SELECT id,content,project_id,session_id FROM memories');
  let n = 0;
  for (const m of mems) {
    const cjk = extractTopicsFromContent(m.content).filter(t => /\p{Script=Han}/u.test(t));
    if (!cjk.length) continue;
    const pid = m.project_id || '';
    if (!pid) continue;
    for (const t of cjk) {
      try { db.rawExec(\`INSERT OR IGNORE INTO memory_topics VALUES (\${m.id},'\${t}','\${pid}')\`); n++; } catch {}
    }
  }
  const projects = db.rawAll('SELECT id FROM projects');
  for (const p of projects) db.rebuildKnowledgeMap(p.id);
  console.log(n + ' CJK topic entries added');
  db.close();
"
```

## [0.5.2] — 2026-07-23

### Changed

- **Recall ranking blends FTS relevance and confidence multiplicatively** —
  `recall_query` previously sorted by effective confidence first, with FTS rank
  as a tiebreaker; a fresh but loosely matching memory could outrank an older
  exact match. The new formula `(-rank) * sqrt(EC)` weights both signals
  together, so a strong text match on a moderately decayed memory beats a weak
  match on a fresh one. Same API shape, better ordering.

- **Half-life grows logarithmically beyond 4 accesses** — access counts 1–4
  still produce 14–35 day half-lives (identical to v0.5.1). Beyond that,
  half-life follows `7 + 7 · (min(k,4) + 2.5 · ln(1 + max(0, k−4)))` instead
  of capping flat at 35 days. k=10 → ~69 d, k=50 → ~102 d, k=302 → ~135 d.
  Frequently accessed memories decay slower without becoming immortal.

- Age days clamped to `MAX(0, ...)` to handle future-dated timestamps from
  clock drift or manual edits.

## [0.5.0] — 2026-07-16

The knife-field release. A 2026-06-10 audit delivered the verdict this release
executes: the journal pipeline recorded **zero promotions in its entire
history** (177 pending entries = a dead-letter queue), 8 of 13 HTTP endpoints
had no callers, and 65% of the database fed a bookkeeping table. Everything
dead is now gone, in one breaking cut. What remains is the pipeline that
actually runs: post-session extraction → keyed memories → startup injection /
MCP recall.

### Removed (breaking)

- **The journal pipeline, whole** — `session_journal` table, the
  `/journal/promote`, `/journal/pending`, `/journal/reject` endpoints, the
  `ccmem promote` / `ccmem reject` CLI, the decay sweep, and the trust
  two-tier write path (v0.3.0). Auto-harvest into a review queue never earned
  a single promotion; post-session extraction (v0.4.1) writes reviewed,
  deduplicated memories directly and made the queue obsolete.
- **The rule scorer and outcome harvester** — `outcome-scorer.ts`,
  `outcome-extractor.ts`, the summarizer harvest branch, and
  `sessions.harvest_text`. These existed to feed the journal.
- **`session_checkpoints`** table and `POST /session/checkpoint` (no caller).
- **`GET /metacognition/check`** — the knowledge map lives on; MCP
  `recall_context` remains its query surface.
- **`GET /lint/warnings`** and `lint.ts` (no caller).
- **`POST /memory/save`** — MCP `recall_save` writes via the database
  directly; the HTTP mirror had no remaining caller.
- **`GET /memory/context`** — was a stub returning empty fields since day one.

### Changed (breaking)

- **`POST /session/end`** no longer harvests. It now does exactly one thing:
  confirm the just-ended session is indexed (running the rescue reindex on a
  miss — the #55 fix chain is untouched). Response no longer carries
  `journalSaved` / `dryRun`. The v0.4.x SessionEnd hook is fully compatible.
- **`GET /health`** no longer reports `journalPendingCount`.
- **`message_uuids` rebuilt as dual 64-bit hashes** (migration v24). The
  replay-dedup registry stored 400k UUIDs as 36-char TEXT across three
  b-trees — 73.6MB, 65% of the whole database. Each uuid/session id is now
  the first 8 bytes of its SHA-256 as a signed integer; `uuid_hash` doubles
  as the rowid, so the primary key costs nothing. Same table: 17.3MB.
  Collision odds at 400k rows ≈ 4×10⁻⁹, and the worst case is one replayed
  message being skipped — an acceptable trade for a 56MB saving.

### Upgrade guide

Migration v24 runs automatically on first start (single transaction; a
failure rolls back to v23 untouched). Verified against a production snapshot:
~1s for 400k rows, zero loss. Two manual steps:

1. **Before upgrading**, snapshot your DB (one-liner insurance):
   `cp ~/.ccrecall/ccrecall.db ~/.ccrecall/ccrecall.db.bak-v0.4.8`
2. **After upgrading**, reclaim the freed space manually:
   `sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'`
   (114MB → 42MB measured). ccRecall never auto-VACUUMs — on a large DB it
   can freeze the daemon for minutes (the v20 lesson). Skipping this is
   harmless: SQLite reuses the freed pages; the file just stays big.

To downgrade, reinstall `@tznthou/ccrecall@0.4.8` and restore the backup —
the v24 schema is not readable by older code.

## [0.4.8] — 2026-07-16

### Fixed

- **Post-session extraction silently skipped ~1 in 5 sessions (`no-session-id`)** —
  the extraction wrapper piped `/session/last`'s JSON response through `echo`,
  and zsh's `echo` expands escape sequences by default: any session title
  containing a JSON-escaped `\n` (a multi-line first prompt — 21.5% of all
  indexed sessions) turned into invalid JSON before reaching `jq`. The parse
  error was swallowed by `2>/dev/null`, `session_id` stayed empty, and
  extraction was skipped. A one-week probe closed the case: all 39 daemon
  responses were HTTP 200 with correct payloads, so the mangling was entirely
  client-side — this also retires the earlier "daemon 404" theory. The wrapper
  now pipes through `printf '%s'`, which is byte-exact. Note the wrapper lives
  in `scripts/` (sourced from your shell rc, not part of the npm package):
  pull and restart your shell to pick it up. (#63)
- **`/session/last` could return a subagent instead of the just-closed
  session** — a subagent's `sessions` row can briefly exist while its
  `subagent_sessions` registry row is absent (observed live 2026-07-13), so
  the `NOT IN` exclusion failed and the endpoint returned `<parent>/agent-…`.
  The wrapper's UUID check rejects that shape, producing the same silent
  skip. `getLastSession` now filters on id shape directly — composite ids are
  never main sessions — so correctness no longer depends on registry timing.
  Archived rows (JSONL gone from disk) are excluded too. (#63)

### Documentation

- Architecture diagram corrected: the MCP server opens SQLite directly via
  WAL — it never sat behind the HTTP API. Arrows now follow call direction,
  and the watcher + extraction wrapper join the picture. A session-lifecycle
  sequence diagram is new, covering both timing-sensitive ends (startup
  injection, post-session extraction) including the `notBefore` gate and the
  subagent filter. (#63)

## [0.4.7] — 2026-07-05

### Fixed

- **Compression collapsed sibling memories into identical duplicates** — when
  compressing a session-backed memory, the pipeline rewrites its content from
  the owning session's `summary_text` (L1) or `intent_text` (L2). That summary
  describes the *whole session*, so when one session had produced several
  memories — the common case since post-session extraction (86% of
  memory-bearing sessions hold more than one) — every sibling was rewritten to
  the same session-wide string. Distinct distilled facts collapsed into
  byte-identical copies, and since compression updates in place, the originals
  were unrecoverable from the database (23 rows across 7 sessions confirmed in
  production). The pipeline now only adopts the session summary when the memory
  is the session's *only* memory; siblings fall back to truncating their own
  content, which keeps them distinct. Memories whose source transcript still
  exists can be rebuilt by re-running extraction on that session.

## [0.4.6] — 2026-07-04

### Fixed

- **Post-session extraction skipped — or extracted the wrong session — right
  after session close** — the wrapper queries `/session/last` within seconds of
  close, racing the indexer. The race has two faces: with no other session
  indexed, the endpoint 404s and extraction is skipped (`no-session-id` skips
  reached 24% of runs in the week before the fix); with an older session
  present, the endpoint returned *that* one — its memories were extracted
  again while the fresh session was silently missed (six duplicate extractions
  found in telemetry). `/session/last` now runs the same rescue-reindex-and-
  retry that `/session/end` already had, and the wrapper passes
  `notBefore=<its launch time>` so a session that ended before launch counts
  as a miss instead of being returned. `endedAt` (not `startedAt`) anchors the
  staleness check, so resumed sessions — old start, fresh messages — pass.
  Concurrent rescues from both endpoints coalesce onto one indexer run instead
  of stacking full scans.

### Security

- **Far-future `notBefore` values are clamped** — a spoofed timestamp like
  `9999-01-01` would mark every session permanently stale and force a full
  reindex per request (a local DoS amplifier: coalescing merges concurrent
  runs, not sequential ones). Values beyond a 60-second clock-skew allowance
  are ignored; the wrapper only ever sends its launch time.

## [0.4.5] — 2026-06-27

### Fixed

- **Post-session extraction printed Haiku's stray output to the terminal** —
  Haiku is prompted to emit no text (only `recall_save` tool calls carry the
  result), but small models occasionally print a stray summary that can drift to
  an unrelated language — a Korean report was observed. The wrapper had been
  streaming Haiku's stdout to the terminal via `exec 3>&1` fd juggling; it now
  discards stdout entirely (`2>&1 1>/dev/null`) and shows only its own status
  lines. No memories were ever corrupted — the stray output never reached the
  database.

### Security

- **Stdout is no longer logged, and the stderr scrub was broadened.** An interim
  version of the fix above captured stdout into the telemetry log; review found
  that if the model echoed transcript content, session secrets could be retained
  there past the `sk-ant-`-only scrub, so stdout is now discarded rather than
  logged. The stderr scrub was also widened from `sk-ant-` to also cover common
  OpenAI (`sk-proj-`), GitHub (`ghp_` / `github_pat_`), and AWS (`AKIA`) token
  prefixes.

## [0.4.4] — 2026-06-20

### Fixed

- **Post-session extraction false-aborted with "Exceeded USD budget (0.1)"** —
  `--max-budget-usd` gates on API-equivalent cost, but with no `ANTHROPIC_API_KEY`
  set, `claude -p` runs on the Pro/Max subscription quota and never actually
  charges, so the flag killed runs that had already written their memories. The
  cap now applies only under API-key billing (default `0.50`, overridable via
  `CCRECALL_EXTRACT_MAX_BUDGET_USD`). The `claude -c` continue fallback — which
  reloaded the full session and burned quota for frequently-zero output — is
  replaced by a skip with a logged `reason`.

- **`extraction-prompt.md` was never read under zsh** — `CCRECALL_SCRIPT_DIR`
  resolved via `BASH_SOURCE[0]`, which is empty under zsh, so it fell back to
  `$PWD` and the prompt file was silently never found (the inline fallback prompt
  was used instead). Now resolved via zsh's `%x` prompt expansion when running
  under zsh.

### Security

- Redact `sk-ant-*` API keys from captured extraction stderr before it reaches
  the telemetry log.
- Mark the session transcript as untrusted data in the extraction prompt, to
  blunt prompt injection that could drive runaway `recall_save` calls.

### Changed

- Extraction stderr is now captured into the telemetry log (as valid JSONL)
  instead of discarded via `2>/dev/null`.
- Each saved memory now carries its origin session ID for traceability.

## [0.4.3] — 2026-06-17

### Fixed

- **Integrity monitor false-positive "malformed FTS5" alerts** — the periodic
  `PRAGMA integrity_check` ran on the daemon's long-lived connection, which could
  report a transient "malformed inverted index for FTS5 table" on healthy
  on-disk data (an external-content FTS5 quirk under a long-held connection). The
  check now runs on a fresh read-only connection each tick, eliminating the false
  alarms. On-disk data was verified healthy throughout.

## [0.4.2] — 2026-06-06

### Fixed

- **Post-session extraction "Prompt is too long" on long sessions** — replaced
  `claude -c` (loads full conversation history) with JSONL text-only extraction.
  Only human and assistant text messages are extracted (~98% smaller than raw
  JSONL), eliminating context overflow for sessions of any length. Includes
  UUID validation on session IDs, lenient JSONL parsing (`fromjson?`), and
  UTF-8 safe truncation.

- **Extraction agent producing conversational output** — strengthened the
  extraction prompt to declare non-interactive pipeline mode. The agent now
  only calls `recall_save` without producing summaries, questions, or
  next-step suggestions that no human would read.

## [0.4.1] — 2026-06-05

### Added

- **Key-based upsert for `recall_save`** — new optional `key` parameter (stable
  hyphenated slug). Saving with the same `(projectId, key)` updates the existing
  memory instead of creating a duplicate. Upsert resets access count and
  compression metadata so updated content re-enters the recall pool fresh.
  Migration v23 adds the `key` column with a partial unique index.

- **Auto topic extraction on `recall_save`** — every saved memory now
  automatically gets `memory_topics` entries extracted from its content.
  Prerequisite for Phase 3 cross-project topic-intersecting retrieval.

- **`GET /session/last?cwd=...` endpoint** — returns the most recent session's
  metadata (sessionId, projectId, title, timestamps) for a given project path.
  Used by the post-session extraction wrapper to resolve session context.

- **Post-session memory extraction pipeline** — structured Haiku extraction
  prompt (`scripts/extraction-prompt.md`) with triage/extract rules, scope
  determination, key slug generation, and sanitization directives. Shell
  wrapper template (`scripts/post-session-extract.sh`) with daemon health check,
  `/session/last` API call, and jq-based telemetry logging.

- **`getLastSession(projectId)` database method** — `LIMIT 1` variant of
  `getSessions` to avoid materializing the full session list.

- **Cross-project memory visibility (Tier 0)** — `getStartupMemories` now
  surfaces memories from other projects via topic intersection. If Project B's
  `knowledge_map` shares topics with a memory in Project A, that memory appears
  in Project B's startup injection (max 3 rows, confidence ≥ 0.8 gate).
  Global memories (`project_id = NULL`) also surface when topics match.

- **`backfillMemoryTopics()` + `cleanOrphanedMemoryTopics()`** — database
  methods for one-off migration of existing memories. Backfill extracts topics
  from content; orphan cleanup removes `memory_topics` rows referencing deleted
  memories. One-off script: `scripts/backfill-memory-topics.ts`.

### Changed

- `recall_query` tool description updated from "project-scoped long-term
  memory store" to "user-scoped memory store with project-aware ranking" —
  reflects the new cross-project visibility.

- `recall_save` tool description updated for cross-project guidance: "Omit
  projectId for knowledge reusable across all projects" and key slug
  documentation.

- `Memory` interface and all SELECT queries now include the `key` field.

- `getStartupMemories` Tier 1 now passes a reduced LIMIT (subtracting Tier 0
  consumed slots) for consistency with Tier 2.

## [0.4.0] — 2026-06-03

### Changed

- **SessionStart default strategy switched from `legacy` to `startup-v1`.**
  The legacy strategy matched memories by project-name keyword via FTS, causing
  an echo chamber where the same 4-5 keyword-matching memories surfaced every
  session. `startup-v1` prioritizes cold (never-accessed) memories first, then
  fills with recent/high-confidence ones — breaking the echo chamber and surfacing
  previously buried knowledge. The new formatter shows a pointer hint
  ("N memories available — use recall_query to search more") instead of the old
  "matched via project keyword" footer. Legacy remains available via
  `CCRECALL_SESSION_START_STRATEGY=legacy`.

- **`recall_save` tool description repositioned as the primary write path.**
  Description now includes concrete "WHEN TO SAVE" scenarios, self-contained
  memory writing guidance (include WHY, use concrete details, avoid pronouns),
  and a cold-start hint (empty recall_query results suggest saving findings).

- **`recall_query` tool description adds a sufficiency hint.**
  When results are sparse, the response now suggests trying different keywords
  or more specific terms.

### Fixed

- **Global memories (project_id=NULL) now included in scoped startup queries.**
  (Included from [0.3.4] PR #44 — first deployment in this release.)

## [0.3.4] — 2026-05-24

### Fixed

- **`recall_query` searched across all projects instead of the current one.**
  The MCP `recall_query` tool called `db.queryMemories(query, limit)` without a
  `projectId`, hitting the no-filter branch — a query in project A could surface
  project B's memories. `recall_query` predated the `project_id` mechanism
  (phase-4b) and was missed when query handlers were wired for scoping
  (phase-4c); `recall_context`, `recall_save`, and the HTTP `/memory/query`
  route all already scoped correctly. Cross-project visibility was an explicit
  early-development non-goal. Fix: `recall_query` now takes a required
  `projectId` (mirroring `recall_context`), threaded into `db.queryMemories` and
  `appendRecallTelemetry` (the telemetry `projectId` was previously hardcoded
  `null`, which also broke per-project grouping). Cross-project isolation test
  added in `tests/mcp.test.ts`.

### Notes

- Cross-project "accidental hits" disappear with this fix, so cold-rate figures
  in the 6/04 hit-rate window may rise. The prior baseline was inflated by the
  bug — post-fix numbers reflect true project-scoped recall and should be read
  that way.
- `projectId` is client-supplied (derived from cwd), same as the other MCP
  tools. Whether to move to server-side project binding is tracked in #41 for
  if/when the threat model expands beyond local single-machine use.

---

## [0.3.3] — 2026-05-22

### Fixed

- **`recall_query` MCP path missed telemetry instrumentation.** v0.3.2 added
  `appendRecallTelemetry` to the HTTP `GET /memory/query` route but not to the
  MCP `recall_query` tool handler (`src/mcp/tools.ts`). Since most clients
  (Claude Code, Claude Desktop) reach the daemon over MCP rather than direct
  HTTP, the telemetry log (`~/.ccrecall/recall-query.log.jsonl`) only captured
  ship smoke-test traffic — actual user calls were silently dropped. Fix:
  `recallQueryHandler` now calls `appendRecallTelemetry` with
  `hitCount = emittedIds.length` (post-budget, matching HTTP semantics) and
  `projectId = null` (the MCP schema does not carry a project parameter).
  Regression coverage added in `tests/mcp.test.ts` using
  `CCRECALL_RECALL_TELEMETRY_PATH` to isolate the test log.

### Notes

- Anyone observing the v0.3.2 7-day hit-rate window should treat the original
  5/28 deadline as void and restart from v0.3.3 ship date (new target: 6/04).
  Samples gathered during the bug window only reflect HTTP-direct traffic and
  cannot be extrapolated to the population — cold-rate estimates from that
  window are not reliable evidence for v0.4.0 batch decisions.

---

## [0.3.2] — 2026-05-21

### Added

- **`recall_query` telemetry for hit-rate analysis.** Every `GET /memory/query`
  call now appends one JSONL row to `~/.ccrecall/recall-query.log.jsonl`:
  truncated query (80 chars), original `queryLen`, `hitCount`, `projectId`,
  `limit`, `maxTokens`. Append failures are swallowed — telemetry must never
  affect endpoint response. Two opt-out knobs:
  `CCRECALL_RECALL_TELEMETRY_OFF=1` disables writes; `CCRECALL_RECALL_TELEMETRY_PATH`
  redirects the log (used by the test suite to keep host telemetry clean).

- **`scripts/recall-hit-rate-report.ts` analysis tool.** Reads the telemetry log
  and cross-references the `memories` table to split zero-hit queries into two
  buckets — *literal mismatch* (keyword appears in some memory body but FTS5
  missed it) vs *truly absent* (keyword nowhere in any memory). Output (markdown
  or `--json`): totals, hit rate, zero-hit breakdown, per-project counts,
  query-length percentiles, and up to 10 samples per category. Designed as the
  L0 quick-fix that feeds the v0.4.0 batch ordering: 1 day of instrumentation +
  7 days of observation → evidence-driven decision between `#28` surfacing UX,
  `#15` tag first-class + Topic CJK, and `#29` scorer epistemic.

### Why

The cold-rate signal (96/116 memories never recalled, 4 batches of major events
that landed in auto memory instead of ccRecall DB) needs an evidence base before
the v0.4.0 batch can pick a direction. This release is pure instrumentation —
no scoring, schema, or recall behaviour changes — so the 7-day observation
period stays clean.

### Notes

- Privacy: query string is truncated to 80 chars before logging. `queryLen`
  preserves the original length so we can still characterise long-query
  distribution. Hashing was considered and rejected because hashing would
  prevent the substring cross-reference that splits literal-mismatch from
  truly-absent.
- Performance: `appendFileSync` runs on the response path; E2E tests assert the
  total round-trip stays under 100ms even with telemetry on.
- This release does NOT flip `CCRECALL_SESSION_START_STRATEGY` default — that
  ships with v0.4.0 once the metric evidence is in.

---

## [0.3.1] — 2026-05-13

### Fixed

- **SessionStart keyword echo chamber.** `hooks/session-start.mjs` used to
  fire `GET /memory/query` with `projectNameFromCwd(cwd)` as the sole FTS5
  keyword, so only memories whose content literally contained the project
  name could surface. Manual atomic-knowledge entries stayed cold while
  prompt-fragment rows quoting the project name were injected every session
  start, inflating `access_count` on noise. A live-DB audit confirmed the
  inverted signal: 4 of 4 post-trust-split manual `recall_save` rows were
  100% cold, while 9 prompt-fragment rows (7.6% of the corpus) produced
  45% of all access events. The fix is an opt-in
  `CCRECALL_SESSION_START_STRATEGY=startup-v1`, which routes the hook
  through a new `GET /memory/startup` endpoint backed by 3-tier selection
  (cold project-scoped → recent-confidence fill → FTS fallback). Default
  remains `legacy` so the v0.3.0 observation period is undisturbed.

- **No token budget on the hook injection path.** `GET /memory/query` and
  the SessionStart hook previously had no token cap, so a single long
  memory row could silently consume thousands of context tokens. Both
  paths now accept an optional `maxTokens` (default 300 on
  `/memory/startup`), apply CJK-aware per-row truncation via the new
  `applyRowBudget` helper, and `memoryService.touch` runs only on
  budget-emitted rows so dropped rows do not poison `access_count`.

### Added

- **`GET /memory/startup?project=&limit=&maxTokens=&q=<fallback>`** —
  SessionStart-tier retrieval. Project param required. Returns
  `{ memories, emittedIds, candidateCount, totalTokenEstimate,
  droppedCount, truncated, project, limit }`.
- **`Database.getStartupMemories(projectId, limit, fallbackKeyword?)`** —
  3-tier selection helper, public for callers that want the selection
  logic without HTTP overhead.
- **`applyRowBudget(rows, maxTokens, perRowCharCap)`** in
  `src/core/token-budget.ts` — generic CJK-aware row budget helper.
  Reused by `/memory/query` and `/memory/startup`.
- **`CCRECALL_SESSION_START_STRATEGY` env var** — `legacy` (default) |
  `startup-v1` | `off`. Controls which retrieval path the SessionStart
  hook uses.
- **Opt-in JSONL telemetry** at `~/.ccrecall/startup-recall.log.jsonl`
  while `startup-v1` is active (disable with `CCRECALL_TELEMETRY=off`).
  Records `{ ts, projectId, emittedIds, droppedCount }` per session
  start — enough for a 7-day dogfood gate to measure whether
  atomic-knowledge surfacing actually improved.

### Migration

No schema migration. Existing `~/.claude/settings.json` hooks continue
to work unchanged; the new strategy is opt-in via env var only.

---

## [0.3.0] — 2026-05-06

### ⚠️ Breaking — harvest write path

Hook auto-harvester (`POST /session/end`) now writes to a new
`session_journal` table instead of `memories`. Manual `recall_save` is
unchanged — it still writes directly to `memories`. This is the
architectural fix for issue #21 (and the underlying root cause of
issue #25's 0/39 hit rate): the rule scorer was on the persistence
gate, not on a trust grade. Adding more regex patterns would have only
delayed the next failure mode. Splitting low-trust harvest from
high-trust memories lets the harvester record candidates broadly while
recall results stay clean.

`recall_query` / `recall_context` / `recall_query` results are not
affected by journal entries — by design they only read `memories`.

**Response field rename**: `POST /session/end` returns `journalSaved`
(was `memoriesSaved`). Hooks ignore the response body, so installed
hooks continue to work without reinstall.

### Added

- **Schema v22**: `session_journal` table with `(session_id, message_id,
  content, content_hash, score, reasons_json, status, expires_at,
  promoted_memory_id, project_id, created_at)`. `idx_journal_status`
  and `idx_journal_hash UNIQUE` for sweep + idempotency.
- **`ccmem promote <id>`** — manual promotion to memories. Atomic:
  saveMemory → saveMemoryTopics → rebuildKnowledgeMap →
  promoteJournalEntry. Optional `--type` (default `discovery`) and
  `--confidence` (default `0.7`) flags. Returns 409 if already
  promoted, 404 if not found.
- **`ccmem reject <id>`** — soft-delete with 7-day TTL via `expires_at`.
  Decay sweep cleans up after expiry.
- **`/health` endpoint** gains `journalPendingCount`. Surfacing the
  pending queue is how users discover candidates worth promoting —
  manual-only on purpose; auto-promote would re-introduce the failure
  mode we just removed.
- **Decay sweep** in the existing `MaintenanceCoordinator` tick:
  rejected past `expires_at` and pending older than 30 days are
  deleted. Promoted entries kept as audit trail. Memories table never
  touched (manual saves exempt by table boundary).

### Changed

- `summarizer.ts` removed the `score >= KNOWLEDGE_THRESHOLD` (≥ 2)
  persistence gate. Hard floor preserved: `noise` / `process-report`
  reasons still short-circuit (these are not knowledge regardless of
  where they land).
- `buildMemoryFromSession` renamed to `buildJournalCandidate`, returns
  `JournalEntryInput` with re-scored `score` + `reasonsJson` metadata.
  Score is recomputed at journal-write time (cheap regex on <2KB text)
  so we don't need a v23 migration for `harvest_score` columns.

### Migration

- v22 migration runs automatically on daemon startup. Pre-check throws
  if `memories` table is missing (would dangle FK), recommending
  restore from pre-v22 backup.
- **Backup recommended before upgrading**:
  `cp ~/.ccrecall/ccrecall.db ~/.ccrecall/ccrecall.db.pre-v22.bak`
- Existing memories rows stay queryable as before. The 17 historical
  `type='query'` rows from v0.2.x harvest are not migrated to journal —
  they're frozen in place; new harvest writes go to journal from now.

### Tests

- +22 tests across 5 commits (schema target / journal DAO / trust
  boundary / promote+reject endpoints / sweep TTL / health field)
- 535 → 557 tests passing.

### First-run observation period

Plan-critic acceptance criteria:

| Day | Indicator | Threshold | Failure reading |
|-----|-----------|-----------|-----------------|
| 14  | journal write count | ≥ 50 | gate-removal didn't unblock — issue is upstream of `pickLastSubstantialAssistant` |
| 30  | manual promote count | ≥ 3  | surfacing is insufficient — escalate to issue #21 P2 (promotion UX) |

Tracking: [issue #21](https://github.com/tznthou/ccRecall/issues/21).

### Upgrade checklist

- `pnpm install -g @tznthou/ccrecall@0.3.0` (or your usual install path).
- Optional: backup DB before restart (see Migration section).
- `launchctl kickstart -k gui/$UID/com.tznthou.ccrecall` to restart the
  daemon. v22 migration runs on first connection.
- `curl http://127.0.0.1:7749/health` — verify `version: "0.3.0"` and
  the new `journalPendingCount` field.

---

## [0.2.7] — 2026-05-06

### Fixed

- **`extractOutcome` skips session wrap-up reports** (PR #24). Dogfood corpus audit (39 v=2 committed/tested sessions) found 100% sub-threshold scoring because `pickLastSubstantialAssistant` captured session-completion summary reports (process meta) instead of real implementation outcomes. The walk-back loop now skips process-report candidates and falls back to earlier substantial assistant text. `scoreKnowledgeBearing` also short-circuits process-report → score 0 (defense in depth).

### Added

- `isProcessReport(text)` exported from `src/core/outcome-scorer.ts` and consumed by `outcome-extractor.ts`. `PROCESS_REPORT_RES` is anchored at `^` so long mid-text mentions do not misfire. Patterns cover CJK and English session-completion markers, slash-command form, and colon-separated headings, with optional markdown heading prefix and emoji (`💾🟢✅`).
- `PROCESS_REPORT_MAX_LEN = 5000` length gate in `isProcessReport` to prevent regex linear-scan on megabyte-scale assistant text (security: ReDoS prevention).

### ⚠️ Known limitation — prerequisite fix, not sufficient

This fix unblocks the harvester's view of real outcomes (wrap-up reports no longer hide them) but **does not on its own raise the hit rate above zero**. The audit shows real implementation outcomes now reach the scorer, but they stay sub-threshold due to category coverage gaps in the 5-category rule scorer:

- Chinese commit confirmation (`Commit 6de0666 落地`) — score 0
- `## 修復總結 / 完工總結` tables — score 1 (occasionally hits decision-language)
- Phase milestones (`## Phase 1 完成 ✅ | Step | Commit |`) — score 0

Tracking: [issue #25](https://github.com/tznthou/ccRecall/issues/25). Same protocol as #23 — extend anchors deliberately when 3+ corroborating reports converge on a category gap.

### Tests

- +11 new unit tests (8 process-report scorer cases + 2 extractor fallback cases + 1 oversized input length-gate test).
- Test count: 524 → 535.

### Quality pipeline

- ✅ Codex Review: 1 Medium (slash/colon regex gap) + 1 Low (`流程` alternation too broad) → both fixed.
- ⏭️ Simplify: 4 candidates considered, all ruled out (no genuine simplification).
- ✅ Security: 1 Medium (ReDoS length gate) fixed; 3 Low declined per gogo override.
- ✅ Final Verify: build / typecheck / lint / 535 tests all green.

### Upgrade checklist

- `pnpm install -g @tznthou/ccrecall@0.2.7` (or your usual install path).
- `launchctl kickstart -k gui/$UID/com.tznthou.ccrecall` to restart the daemon.
- `curl http://127.0.0.1:7749/health` to verify `version: "0.2.7"`.
- No schema migration in this release. No DB backup needed.

---

## [0.2.6] — 2026-04-30

### Changed

- **Harvester source-of-truth switched from "first user prompt" to "outcome cluster"** (closes #18). The pre-0.2.6 harvester captured the first user prompt and labeled it `type='query'` — a live audit (n=104) showed 94% noise and **zero genuine knowledge entries from the auto-harvester**; all 4 high-quality entries came from manual `recall_save`. The new pipeline picks the last substantial assistant message from a session and gates harvest on a 5-category rule-based scorer (decision-language / impl-facts / constraints / cause-effect / validation), threshold ≥ 2.

### Added

- `src/core/outcome-extractor.ts` — picks the last substantial assistant text. `isSubstantial()` has three branches: length ≥ 200 chars, markdown structure (header / fenced code / bullet / checkbox), or scorer threshold reached.
- `src/core/outcome-scorer.ts` — 5-category regex scorer with internal noise short-circuit (drops bare ack tokens like `done` / `完成` / `ok` before they accumulate weak signals).
- Schema migration **v21**: adds `harvest_text TEXT` column to the `sessions` table. Idempotent ALTER TABLE, forward-only — existing sessions keep `harvest_text = NULL` by design.
- `MAX_HARVEST_LEN = 2000` truncation cap on harvested text before persistence (aligned with the read-side `<300 tokens per memory` injection budget).

### ⚠️ Known limitation — English coverage

The scorer's pattern set was corpus-validated against **Mandarin Chinese sessions only** (the maintainer's own dogfooded ccRecall DB):

- Group A: 91 noise sub-threshold (90/91 = 98.9%)
- Group B: 50 outcome sessions (49/50 sub-threshold = 98%)

Each of the 5 categories ships with 1–3 anchor patterns per language as plan-time scaffolding. **English-language sessions are likely to clear the threshold less often than the plan-target 60–80% skip rate suggests** — the harvester will write fewer new memories than expected for English-only adopters until pattern coverage expands.

Tracking: [issue #23](https://github.com/tznthou/ccRecall/issues/23). Contribute a redacted excerpt of an English session that should have harvested but didn't, and we'll extend anchors deliberately when 3+ corroborating reports converge on a category gap.

### Migration notes

- Migration v21 is **forward-only**. Sessions indexed before v0.2.6 keep `harvest_text = NULL` and stay outside the new harvest pipeline. The indexer fires only when `mtime` changes (`indexer.ts:95`), and the SUMMARY_VERSION bump 1→2 deliberately does not trigger a full reindex of historical sessions.
- Existing memories from pre-v0.2.6 versions are **preserved**. A separate cleanup release will purge `[intent]`-prefixed legacy noise (matching `access_count = 0 AND type = 'query' AND content LIKE '[intent]%'`) with a backup table and 7-day observation window.
- Strict no-fallback contract in `buildMemoryFromSession`: when `harvestText` is `NULL`, `intentText` / `summaryText` / `outcomeStatus` are all ignored. Returns `null` so `/session/end` reports `reason: 'session has no summary'`.

### Tests

- 34 new unit tests covering extractor (10) + scorer (20) + 4 in `tests/session-end.test.ts` for the no-fallback contract.
- Test count: 528 → 524 (–4 net; +34 new, –6 dead `collectToolEvidence` evidence tests deleted during simplify, plus other consolidations).
- No assertion softening — `session-end.test.ts` fixture rewrites are documented as needs change driven by issue #18 (outcome cluster replaces intent+summary), not silent test softening.

### Quality pipeline

- **Codex review** (1 of 2 fixed): M1 `isSubstantial()` scorer fallback added so short plain-text outcomes (< 200 chars, no markdown) like `Root cause: x.ts:42. 495/495 tests pass.` are not silently dropped before scoring. M2 (folding `hasCommitInvoked`/`filesTouched` into `harvestText`) declined — minimal `{lastAssistantText}` payload was a deliberate plan-critic round-2 design to avoid structural noise polluting FTS5 ranking.
- **Simplify** (4 of 7 applied): drop unused `collectToolEvidence` + evidence tests (verified zero downstream consumers via grep); align structural regex to the project's `ReadonlyArray<RegExp>` idiom; align `IMPL_FACTS` extension list and add trailing `\b`; trim stale comment that referenced no-longer-existing `isHarvestNoise` overlap. 3 declined: `harvester-filter.ts` orphaning is out-of-scope, remaining JSON.parse consolidation is pre-existing.
- **Security review** (Critical:0 High:0 Medium:2 Low:2): both Mediums solved at one change point — A10 unbounded `harvest_text` write to DB and A09 dry-run `candidate.content` exposure — by the `MAX_HARVEST_LEN = 2000` cap. Two Lows reported but not fixed per gogo policy.
- **Final verify**: build / typecheck / lint / 524 tests all green.

### Upgrade checklist

```bash
# 1. Back up the DB before migration v21 (recommended — Code Protection Protocol)
cp ~/.ccrecall/ccrecall.db ~/.ccrecall/ccrecall.db.pre-issue18.$(date +%Y%m%d).bak

# 2. Install 0.2.6
npm i -g @tznthou/ccrecall@0.2.6

# 3. Restart daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 4. Verify version + integrity
curl -s http://127.0.0.1:7749/health | jq .
# Expect: version="0.2.6", lastIntegrityCheckOk=true
# (sessions table now has harvest_text column; existing rows are NULL by design)

# 5. After 7 days of clean operation, remove the backup
rm ~/.ccrecall/ccrecall.db.pre-issue18.*.bak
```

Closes [#18](https://github.com/tznthou/ccRecall/issues/18). Tracking limitation: [#23](https://github.com/tznthou/ccRecall/issues/23).

---

## [0.2.5] — 2026-04-29

### Fixed

- **WAL file growth on long-uptime daemons** (issue #11). `runIndexer` now ends with `PRAGMA wal_checkpoint(TRUNCATE)`, the only checkpoint mode that actually resets the WAL file to 0 bytes on disk. Previously the WAL drifted up to ~1:1 with the main DB between SQLite's passive auto-checkpoints — observed at 624 MB after 8 hours of uptime (issue #11 evidence). PASSIVE/FULL modes were ruled out: they mark frames for reuse but never shrink the on-disk file, so disk-watching operators would still see the growth.

### Motivation

When ccRecall ran 22.9 hours uptime against a real workload, the WAL sidecar reached 6.8 MB — small in absolute terms but unbounded in principle, and the original 8.4-hour / 624 MB observation in issue #11 proved the upper bound was effectively the main DB size. We considered three approaches and picked one:

| Option | Disk shrink | Blocks readers | Verdict |
|--------|-------------|---------------|---------|
| Tune `wal_autocheckpoint` smaller | No (passive) | No | Doesn't solve disk visibility |
| Background timer | Yes | Brief stall | Adds timer lifecycle + race surface |
| **End-of-batch TRUNCATE** | **Yes** | **Brief, safe at batch end** | Chosen |

Indexer batch end has no concurrent indexer write and HTTP query reads are millisecond-scale, so the brief reader stall is acceptable. If a long-running reader holds a snapshot past `busy_timeout`, SQLite returns `busy=1` and the next batch retries — `console.warn` surfaces this so operators know.

### Why not SIGTERM-only checkpoint

The original quick-fix sketch was "add `wal_checkpoint(TRUNCATE)` to the SIGTERM handler." A standalone reproduction confirmed `db.close()` already triggers SQLite's last-connection truncate (200-session WAL: 4.1 MB → 0 bytes on close), so a SIGTERM hook would have been redundant and would not have addressed the *during-uptime* growth that issue #11 actually documents.

### Tests

- 3 new test cases in `tests/wal-checkpoint.test.ts` covering the method itself (200-session write → TRUNCATE → 0 bytes), idempotency on a clean WAL, and end-to-end indexer integration (50-session batch → WAL = 0 after `runIndexer`).
- Test count: 492 → 495.

### Quality pipeline

- Codex review (1 Medium fixed): `busy=1` was silently swallowed; now logs `[indexer] WAL checkpoint busy — readers held snapshot; deferred to next batch`.
- Simplifier (2 fixes): unreachable nullish fallback dropped (`PRAGMA wal_checkpoint` contract guarantees one row); redundant comment block tightened.
- Security review: C:0 H:0 M:0 L:2 — both Low (log-message diagnostic precision); not fixed per gogo policy.
- Final verify: build / typecheck / lint / 495 tests all green.

### Upgrade checklist

```bash
# 1. Install 0.2.5
npm i -g @tznthou/ccrecall@0.2.5

# 2. Restart daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. Verify
curl -s http://127.0.0.1:7749/health | jq .version
# Expect: "0.2.5"

# 4. Inspect WAL after the next indexer batch fires
ls -lah ~/.ccrecall/ccrecall.db-wal
# Expect: typically 0 bytes (or near-0 if a reader was active during checkpoint)
```

Closes [#11](https://github.com/tznthou/ccRecall/issues/11).

---

## [0.2.4] — 2026-04-28

### Added

- **English progress / control noise patterns** in `isProgressShell()`. The 0.2.3 noise filter caught language-neutral slash commands but only CJK progress shells and CJK speculative reflection — English-language adopters would re-introduce ~25-30% of the noise the CJK filter had just removed. The new `ENGLISH_PROGRESS_RES` list covers `status?` / `any progress?` / `what's next` / `where are we` / `are we done yet?` / `continue` / `keep going` / `proceed` / `done?` / `all good?` and the case-insensitive variants. All entries are `^...$`-anchored so concrete inquiries carrying topic detail (e.g. `what's next on the roadmap`, `continue with the auth refactor`) are still kept. Closes #17.

### Motivation

0.2.3 was shipped on a CJK-only audit corpus (n=89). The filter design was tested against the live data we had, but the filter itself encoded a dataset bias: progress and reflection patterns were CJK-specific, leaving English-language usage entirely unfiltered. Slash commands were already language-neutral, but `status?` / `continue` / `where are we` are exactly the same kind of conversation-control shell — short, recurring, zero knowledge value.

### Out of scope

- **English reflection patterns deliberately not added.** `did we just X` and `didn't we just Y` are too ambiguous between pure speculation (correct to filter) and concrete inquiry like `did we just commit the migration?` (wrong to filter). Same trap that forced dropping `^我們剛剛` in 0.2.3 — there's no high-signal English subset to anchor on, so the safer behavior is to keep all English reflections.
- Other CJK languages (Japanese 進捗, Korean 진행) — wait for real adopters before extending vocab.

### Tests

- 5 new test cases in `tests/harvester-filter.test.ts` covering the English shell flag-positives, case-insensitivity, false-positive guards (concrete topic suffixes), and the deliberate non-coverage of English reflection.
- Test count: 487 → 492.

### Upgrade checklist

```bash
# 1. Install 0.2.4
npm i -g @tznthou/ccrecall@0.2.4

# 2. Restart daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. Verify
curl -s http://127.0.0.1:7749/health | jq .version
# Expect: "0.2.4"
```

---

## [0.2.3] — 2026-04-28

### Added

- **Harvest noise filter** (`isHarvestNoise()` in `src/core/harvester-filter.ts`). Hook auto-harvest now skips conversation-control noise before writing to the memories table: bare slash commands (`/clear`, `/model`, `/compact`), pure-CJK progress query shells (`繼續我們的進度`, `確認我們現在的進度`, `這個專案進度如何?`), and speculative self-reflection openings (`我們剛是不是 …`). False-positive guards: short-text 30-char cap on slash and progress detection so audit queries carrying concrete technical detail still pass; reflection narrowed to the high-signal `^我們剛是不是` prefix so concrete inquiries like `我們剛剛 github 沒有發 tag ？` are kept.
- **`'query'` MemoryType** added to the union, MCP `MEMORY_TYPES` enum, and HTTP `VALID_MEMORY_TYPES` set. Hook-harvested memories now always carry `type='query'` regardless of session outcome — the prompt itself is a query, not a decision or discovery, even when the underlying session ended in a commit. `decision` / `discovery` / `feedback` / `preference` / `pattern` are reserved for explicit `recall_save` writes.

### Changed

- **`buildMemoryFromSession()` no longer uses outcome to infer memory type**. Outcome (`committed` / `tested` / `null`) still drives `confidence` (0.9 / 0.8 / 0.7 — the certainty signal is genuine), but conflating outcome with knowledge category was forcing every committed work session into `decision` even when the prompt was just a progress query.

### Removed

- `inferMemoryType()` (sole caller deleted, no public API).

### Motivation

A live-DB audit showed 84% of hook-harvested memories were never recalled. Tracing the bottom-quartile entries surfaced the actual cost: bare `/clear` / `/model` invocations, repeated 「確認進度」 shells, and conversational reflection were all being written as if they were `discovery`- or `decision`-grade memories. The topic system (1,767 memory↔topic links across 89 memories — average 19.9 topics each) was further inflating top-topic hit rates above 80% because the noise wrote to the same generic English `topic_keys` (`docs`, `bug-fix`, `testing`) the rest of the corpus shared. A dry-run of the new filter against the live 89 entries flagged 23 (25.8%) as noise — almost exactly the bottom-quartile recall cohort. Reclassifying the rest as `query` separates "user asked X at time T" from "we learned Y" so a future filter pass on `recall_query` can opt out of returning queries-as-memories. No backfill of existing entries — historical records keep their original type to preserve audit history.

### Tests

- 12 new cases in `tests/harvester-filter.test.ts` (slash / progress / reflection / fallback / false-positive guards) + 2 integration cases in `tests/session-end.test.ts` covering noise skip and audit-query preservation.
- Test count: 475 → 487.

### Upgrade checklist

```bash
# 1. Install 0.2.3
npm i -g @tznthou/ccrecall@0.2.3

# 2. Restart daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. Verify
curl -s http://127.0.0.1:7749/health | jq .version
# Expect: "0.2.3"
```

---

## [0.2.2] — 2026-04-27

### Fixed

- **CJK case 5: LIKE fallback now uses AND across short tokens**. The short-token fallback (any whitespace-split token under 3 characters, gating the LIKE path because the trigram tokenizer cannot index <3-char tokens) was wrapping the entire raw query in `%...%`. That collapsed AND semantics into substring match: `queryMemories('UI 記憶')` only hit documents where `UI` was immediately followed by ` 記憶` as a contiguous substring. Mixed Latin + CJK queries (the most common shape — `UI 記憶`, `DB 查詢`, `API 路由`, `CI 流程`) silently dropped any document where the tokens were separated. The fallback now splits on whitespace and ANDs each token's LIKE clause; `searchSessionsFallback` keeps the per-column OR within each token. Pure single-token short queries (bare `記憶`, `UI`) reduce to the prior single-LIKE behavior with no observable change.

### Security

- **Cap LIKE fallback token count at 20** to bound SQL prepare cost. Without the cap, a caller could pass `'a b c d e ...'` with 10 000 tokens and either stall the synchronous `prepare()` pass or hit `SQLITE_MAX_VARIABLE_NUMBER` (each token contributes 1 bind param in `queryMemoriesFallback`, 5 in `searchSessionsFallback`). 20 covers any realistic search query. Maps to OWASP A10 (mishandling exceptional conditions, unbounded resource consumption) and AI-vuln #5 (missing input validation).

### Motivation

All five deferred CJK edge cases tracked in #13 were reproduced locally. Case 5 was the highest-impact false-negative for end users — recall returned 0 hits with no signal that anything was wrong — and the only one fixable without an ingest re-index. Cases 1 / 2 / 4 (full-width punctuation, NFC↔NFD divergence, halfwidth ↔ fullwidth katakana) need NFKC normalization at both ingest and query boundaries and stay deferred until the storage governance work converges. Case 3 (snippet boundary under the trigram tokenizer) is UX-only and stays deferred.

### Tests

- 9 new tests across `tests/memories.test.ts` (7) and `tests/database.test.ts` (2): single-token unchanged behavior, mixed Latin+CJK AND, token order independence, whitespace normalization, wildcard escape, and the DoS token-cap guard.
- Test count: 463 → 472.

### Upgrade checklist

```bash
# 1. Install 0.2.2
npm i -g @tznthou/ccrecall@0.2.2

# 2. Restart daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. Verify
curl -s http://127.0.0.1:7749/health | jq .version
# Expect: "0.2.2"
```

---

## [0.2.1] — 2026-04-25

### Added

- **Runtime `PRAGMA integrity_check` monitor** — periodic SQLite health probe that runs once on daemon startup and every six hours thereafter. Surfaces index, FTS, and B-tree drift that silent write-path bugs would otherwise leave dormant until the next manual REINDEX. Read-only pragma, safe against the live WAL database with no reader/writer contention. The `setInterval` timer is `unref`'d so the monitor never holds the event loop alive; `coordinator.stop()` is the clean shutdown path.
- **`/health` now reports `lastIntegrityCheckAt` and `lastIntegrityCheckOk`** — gives liveness probes the most recent tick's ISO timestamp and pass/fail boolean. The full drift output (multi-line `PRAGMA integrity_check` result) is written to `~/.ccrecall/integrity-alerts/integrity-check-<timestamp>.log` rather than kept in the cache — `/health` stays a lightweight liveness signal, not a forensic store.
- **Single-flight scheduling** — if the 6-hour interval fires while a prior tick is still running, the new call is dropped instead of racing the in-flight pragma.

### Motivation

On 2026-04-24 an ad-hoc `PRAGMA integrity_check` surfaced a silent index drift (row 48 missing from `idx_memories_access`) that had survived a full `VACUUM`; only a manual `REINDEX` caught it. This release is the detection layer — it does not prevent drift from happening, but it caps silent-drift duration at six hours. When drift is detected, the alert log explicitly instructs snapshotting the DB (`cp ~/.ccrecall/ccrecall.db ~/ccrecall-drift-snapshot.db`) **before** running any repair, so the forensic state is preserved for analysis.

### Docs

- Architecture / CLAUDE.md notes now document the integrity monitor's place in the governance surface (detection layer; Tier 0/1 root-cause work still ahead).
- Memory types documentation clarified to distinguish liveness data (`/health` cache) from forensic records (alert files on disk).

### Tests

- `tests/integrity-monitor.test.ts` (145 lines) covers start/stop lifecycle, single-flight guard, timer cadence with injected clock, `/health` surface, alert file layout, and the read-only guarantee against a live WAL database.
- Test count: 451 → 463.

### Upgrade checklist

```bash
# 1. Install 0.2.1
npm i -g @tznthou/ccrecall@0.2.1

# 2. Restart daemon so it picks up the new build
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. Verify the monitor is live
curl -s http://127.0.0.1:7749/health | jq '{lastIntegrityCheckAt, lastIntegrityCheckOk}'
# Expect: recent ISO timestamp + "lastIntegrityCheckOk": true
```

If `lastIntegrityCheckOk` ever reports `false`, inspect `~/.ccrecall/integrity-alerts/` for the full forensic output before running any repair.

---

## [0.2.0] — 2026-04-21

### Breaking

- **Dropped the four legacy message tables** — `messages`, `message_content`, `message_archive`, and `messages_fts` (plus their FTS5 triggers and indexes) are removed. These were inherited when ccRecall forked core modules from ccRewind; an internal audit confirmed zero functional loss from dropping them. Memory recall, session summaries, FTS on memories and sessions, and harvest all continue to work unchanged — all of those paths query `memories_fts` / `sessions_fts` / `sessions.summary_text`, never the messages tables.
- **Removed public `Database` methods**: `getMessages`, `getMessageContext`, `search`, `getSessionTokenStats`, plus the associated types `Message`, `MessageContext`, `SearchPage`, `SearchResult`, `SearchScope`, `SessionTokenStats`. None had a production caller (verified via grep of the entire repo + all hooks / MCP tools / HTTP routes); they were dead code kept alive only by tests that exercised their own removal.
- **Schema bumped to v20.**

### User impact

**Zero functional impact** — recall behaves identically. What changes is the on-disk DB: a healthy ccRecall install that accumulated ~700 MB over two weeks under the old schema will collapse to single-digit MB once the user reclaims space with `sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'`. Projected year-over-year storage drops from ~95 GB/year to a few GB over a decade.

### Migration

- **Automatic on daemon start.** v19 → v20 runs in a single SQLite transaction:
  1. Pre-flight `copyFileSync(dbPath, dbPath + '.pre-v20.bak')` — captures a snapshot so non-SQL failures (disk full, segfault, corrupted WAL) can't orphan data. SQL-level errors are already covered by transaction auto-rollback.
  2. Creates `message_uuids (uuid PK, session_id REFERENCES sessions ON DELETE CASCADE)` + `idx_message_uuids_session`.
  3. Backfills from `messages`, ordered by session age (older sessions own a shared uuid on replay — matches the pre-existing dedup semantics).
  4. Verifies `COUNT(DISTINCT uuid) FROM messages` equals `COUNT(*) FROM message_uuids`. Mismatch throws with a clear message; transaction rolls back, DB stays at v19, backup file is on disk.
  5. Drops the four tables + their triggers in dependency order.
- **Auto-`VACUUM` after migration removed.** On mature ~700 MB DBs it froze daemon startup for multiple minutes. VACUUM is now user-driven: `sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'` (stop the daemon first — `ccmem uninstall-daemon` or `launchctl stop com.tznthou.ccrecall`).
- **`PRAGMA busy_timeout = 5000`** added to the Database constructor so concurrent reads (e.g. a stray `sqlite3` CLI) don't crash the daemon with SQLITE_BUSY.

### Added

- **`ccmem cleanup --orphans`** CLI — lists memories whose `session_id` points at a session row that no longer exists (test fixtures, manual `DELETE FROM sessions`, partial-index race). Default is a **read-only dry run** — pure SELECT, safe alongside a live daemon. `--yes` deletes after stdin confirmation in a single transaction. `--reconcile` opt-in runs a full indexer pass first (useful when the DB is known-stale); this is a write path, so stop the daemon first to avoid SQLite writer contention. Manual memories (`session_id IS NULL`) are left alone.
- **`message_uuids` lookup table** — the only piece that survives from the messages infrastructure. `indexSession()` writes `{uuid, session_id}` here; `getExistingUuids()` reads from here for resumed-session replay dedup. Tiny table: one row per message with a uuid, no content, session_id FK cascades on delete.

### Removed

- Search-related private helpers that had no remaining callers after `search()` went: `fts5QuoteIfNeeded`, `likePattern`, `hasShortToken`, `VALID_OUTCOMES`, `parseOutcomeStatus` — **kept**, because `searchSessions()` reuses them.
- `deleteSubagentSession()` stopped issuing `DELETE FROM messages` explicitly — FK cascade from `sessions` now handles `message_uuids` and `session_files`.

### Tests

- Deleted `tests/fts5-cjk.test.ts` (targeted `db.search()`, which no longer exists).
- Deleted `tests/migration-v19.test.ts` — its assertions test schema state that v20 immediately discards. Coverage folded into the new `tests/migration-v20.test.ts`, which runs:
  - Fresh-DB state (v20 tables present, 4 legacy tables absent, `schema_version` row = 20, FK CASCADE from sessions → message_uuids).
  - v19 → v20 upgrade happy path (rewinds a fresh DB to simulate v19, seeds messages, reopens, verifies backup file + backfilled `message_uuids` + dropped tables).
  - Ordered-backfill semantics (older session owns a shared uuid).
  - Negative-path abort (backfill count mismatch throws, transaction rolls back, backup intact).
- Rewrote `indexSession` / `archiveStaleSessionsExcept` asserts in `tests/database.test.ts` / `tests/indexer.test.ts` to check `message_uuids` + `session.messageCount` instead of message content.
- Test count: 477 → 451 (removed 31 asserts for removed code; added 11 new tests for v20 migration + cleanup CLI).

### Upgrade checklist

```bash
# 1. Stop the daemon
ccmem uninstall-daemon   # or launchctl stop com.tznthou.ccrecall

# 2. Install 0.2.0
npm i -g @tznthou/ccrecall@0.2.0

# 3. Start — migration runs on first boot, backup lands next to the DB
ccmem install-daemon
tail -f ~/.ccrecall/daemon.log   # watch for "Pre-v20 backup created at ..."

# 4. Reclaim disk (optional but recommended)
launchctl stop com.tznthou.ccrecall
sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'
launchctl start com.tznthou.ccrecall

# 5. Once happy, remove the backup
rm ~/.ccrecall/ccrecall.db.pre-v20.bak
```

---

## [0.1.7] — 2026-04-20

### Added

- **Token budget on `recall_query` / `recall_context`** ([#12](https://github.com/tznthou/ccRecall/issues/12)) — public docs advertised `<300 tokens` per recall call but the code returned the full `m.content` of every match with no cap. A single long-form memory could silently inflate a recall call to 1500+ tokens.
  - New `src/core/token-budget.ts` — CJK-aware token estimator (~1 token per CJK char, ~0.3 per Latin char) + code-point-safe `truncateToChars`.
  - Per-row char cap (default 150 chars, ellipsis suffix) so a single long memory can't monopolize output.
  - Total-output budget (default 300 tokens) with visible trailer `(... +N more memories truncated)` — truncation is never silent.
  - Optional `maxTokens` field on both MCP tool schemas (positive, ≤ 2000); defaults honor the documented contract, callers with budget headroom can opt in.
  - `docs/tutorial.md` + `docs/tutorial_zh.md` updated to describe the target as `~300 tokens by default (configurable via maxTokens)` rather than a hard cap.

### Fixed

- **`touch()` bumped `access_count` on budget-dropped memories** — after token-budget truncation, `recall_query` / `recall_context` used to mark every DB row returned by the query as "surfaced", even rows that didn't make it into the final output. That skewed the decay / compression pipeline toward memories the caller never actually saw. `formatMemories` and `formatContextResult` now return `{ text, emittedIds }` and handlers touch only `emittedIds`. Caught by adversarial Codex review during the release pipeline.
- **Token budget leaked past `maxTokens`** — the initial budget accountant only counted memory rows. Trailers, blank lines, and the dynamic markdown headers in `formatContextResult` (`# Relevant memories`, `## Topic: …`, `## FTS fallback`) were not counted, so a realistic call could still cross the advertised cap. Replaced the fixed `HEADER_OVERHEAD_TOKENS = 60` estimate with per-header `approximateTokens()` and reserved `TRAILER_RESERVE_TOKENS = 20` upfront.

### Notes

- Issue #12 kept the `maxTokens` override as a soft target rather than a hard server-side cap. A Codex finding argued the MCP schema field lets model-controlled callers bypass the ceiling; the project's documented design trades that for explicit opt-in flexibility (the schema description spells out the default honors `<300`). A hard cap is a separate design call, not a bug fix.
- Total: 22 new tests (18 `token-budget.test.ts` + 4 MCP integration cases), 477 passing overall.

---

## [0.1.6] — 2026-04-19

### Fixed

- **FTS5 search returned 0 results for CJK queries** ([#10](https://github.com/tznthou/ccRecall/issues/10)) — the `unicode61` tokenizer splits Han/Hiragana/Katakana/Hangul on every character, which means queries shorter than the FTS5 minimum match length (typically 3) found nothing. Users hitting `recall_query` with Chinese/Japanese/Korean terms got silent zero-row responses.
  - Replaced `unicode61` with `trigram` tokenizer across all three FTS5 tables (`memories_fts`, `sessions_fts`, `messages_fts`).
  - Added LIKE fallback for any query containing a token shorter than 3 characters — this also fixes 2-char Latin acronyms (`UI`, `DB`, `CI`, `PR`) that had the same problem.
  - Migration **v19** rebuilds all three FTS tables in a single transaction (`DROP + CREATE + INSERT SELECT`). Benchmark: ~1 second on a 587 MB / 109K-message DB (30× faster than the 30 s budget the plan allowed for).

### Changed

- **`queryMemories` ORDER BY swap** — `EFFECTIVE_CONFIDENCE DESC` is now the primary sort, with `rank` as tiebreaker. The trigram tokenizer makes BM25 scoring unstable on short content; decay semantics (memories have lifetimes) are the intended ordering anyway.

### Internal

- Codex adversarial review caught a blind spot in the original plan: the fallback gate was written for CJK only, but trigram misses any token < 3 chars regardless of script. Widened `containsCJK()` → `hasShortToken()` and dropped the unused CJK utility.
- 455 tests (433 baseline + 22 new: 15 FTS5 CJK regression + 7 migration v19 schema/backfill).

---

## [0.1.5] — 2026-04-18

### Changed

- **MCP tool descriptions now defer to Claude Code's auto memory** ([#9](https://github.com/tznthou/ccRecall/issues/9)) — before this release, every tool's description said some variant of "use when user references past work", which overlapped exactly with auto memory's scope. Claude ended up defaulting to whichever system had concrete instructions (auto memory via CLAUDE.md), leaving `recall_query` / `recall_save` idle.
  - `recall_query`: "USE ONLY AFTER checking auto memory first"
  - `recall_context`: same deference + explicit topic-vs-FTS guidance
  - `recall_save`: "RARELY USED MANUALLY — SessionEnd hook auto-harvests each session"
  - README (both versions) gained a `## ccRecall vs auto memory` section with a division-of-labor table.

### Security

- **`install-hooks` tmp file now created with mode 0o600 [M01]** — `writeFileSync` was relying on the default `0o666 & ~umask`, leaving the tmp `settings.json` briefly world-readable between write and atomic rename. Caught by the release-pipeline security pass.

### Docs

- `docs/research/ai-long-term-memory-design.md` — private tool references (internal skills / handover docs) rewritten into functional descriptions. Publicly installable tools (`Serena MCP` etc.) kept named.

---

## [0.1.4] — 2026-04-18

### Fixed

- **`ccmem --version` / `-v` / `version`** ([#7](https://github.com/tznthou/ccRecall/issues/7)) — previously fell through to `startDaemon()`, which crashed with `EADDRINUSE` when a LaunchAgent was already running, or hung on indexing on a fresh machine. Now prints the version and exits.
- **`install-hooks` backup filename format** ([#8](https://github.com/tznthou/ccRecall/issues/8)) — changed from epoch milliseconds (`settings.json.bak-1776509587711`) to ISO-8601-ish (`settings.json.bak-2026-04-18T18-50-00-123`) — sortable, Windows-safe, millisecond-precise.
  - First cut of this fix dropped sub-second precision. Automated Codex review caught it: two `install-hooks` runs in the same second would overwrite the same backup, silently destroying the only copy of the user's original `settings.json`. Fixed in the same release, regression test locks the format.

### Docs

- `docs/research/` now public — three research notes (`ccrecall-for-kids`, `ai-long-term-memory-design`, `ccrewind-memory-service-architecture`) moved out of private `.claude/`. The tutorial's "Going Deeper" links finally resolve on GitHub.
- New `docs/launchd_zh.md` mirrors the English LaunchAgent guide.
- README ccRewind URL typo fixed (`github.com/user` → `github.com/tznthou`).

---

## [0.1.3] — 2026-04-18

### Fixed

- **`package.json` engines syntax** ([#1](https://github.com/tznthou/ccRecall/issues/1)) — was comma-separated; npm emitted EBADENGINE on every install. Now whitespace-separated per spec.
- **`/health` reports the actual package version** ([#2](https://github.com/tznthou/ccRecall/issues/2)) — previously hardcoded to `0.1.0`.
- **`/health` reports the active SQLite path** ([#3](https://github.com/tznthou/ccRecall/issues/3)) — previously an empty string.
- **`ccmem install-daemon` verifies startup** ([#4](https://github.com/tznthou/ccRecall/issues/4)) — polls launchctl for the PID and runs a one-shot `/health` probe, printing one of three states (running / crashed / indexing). Replaces the previous "verify manually with launchctl list" hand-off.

### Added

- **`ccmem install-hooks` / `ccmem uninstall-hooks`** ([#5](https://github.com/tznthou/ccRecall/issues/5)) — auto-configures Claude Code's SessionStart / SessionEnd hooks in `~/.claude/settings.json`, replacing the manual "compute `npm root -g`, hand-edit JSON" dance.
- **Tutorial "How It Runs in the Background" section** ([#6](https://github.com/tznthou/ccRecall/issues/6)) — explains daemon / watcher / 10-minute backstop / hooks so users stop asking "do I have to rescan periodically?".

### Internal

- First release through a fully working `tag push → OIDC → npm publish` pipeline.
  - `publish.yml` pinned to Node 24 — Node 22 / npm 10 silently fails the current Trusted Publishing handshake and npm returns a misleading `404 Not Found`.
  - `package.json` now declares `repository.url` matching the GitHub repo exactly — npm validates the signed provenance bundle against this field, mismatch returns `422 Unprocessable Entity`.
- 37 new tests (28 for `install-hooks`, 6 for daemon verify, 3 for `/health`). Total 433 passing across 27 files.

---

## [0.1.1] — 2026-04-18

**First public release.**

### Fixed

- **Fresh-clone test run now green** — `pnpm.onlyBuiltDependencies` auto-builds `better-sqlite3` + `esbuild`. Before this, pnpm v10 skipped the native binding build and 247 tests failed. First release where `git clone && pnpm install && pnpm test` goes 396/396 green.

### Changed

- **Contributor Covenant v2.1 vendored in full** — replaces the short-form stub so the Code of Conduct is self-contained and offline-readable.

### Status

Phase 1–4 complete: parser, data layer, MCP tools, metacognition (knowledge map), forgetting-curve compression, JSONL watcher, macOS LaunchAgent daemon. Cross-session recall verified against a live Claude Code session.

---

## [0.1.0]

Internal baseline — not published to npm.

Phases 1–4 implementation complete: 396 tests passing, Apache-2.0 licensed, repo made public on 2026-04-18.
