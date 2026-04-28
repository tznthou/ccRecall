# Changelog

All notable changes to ccRecall are recorded here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) (anything under `1.0`
is pre-stable — breaking changes are documented but the minor number is used
more like an iteration counter than a strict SemVer major).

[中文版](CHANGELOG_ZH.md)

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

- **Harvest noise filter** (`isHarvestNoise()` in `src/core/harvester-filter.ts`). Hook auto-harvest now skips conversation-control noise before writing to the memories table: bare slash commands (`/clear`, `/model`, `/compact`, `/save-t`), pure-CJK progress query shells (`繼續我們的進度`, `確認我們現在的進度`, `這個專案進度如何?`), and speculative self-reflection openings (`我們剛是不是 …`). False-positive guards: short-text 30-char cap on slash and progress detection so audit queries carrying concrete technical detail still pass; reflection narrowed to the high-signal `^我們剛是不是` prefix so concrete inquiries like `我們剛剛 github 沒有發 tag ？` are kept.
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
