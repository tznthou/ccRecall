# Changelog

All notable changes to ccRecall are recorded here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) (anything under `1.0`
is pre-stable — breaking changes are documented but the minor number is used
more like an iteration counter than a strict SemVer major).

[中文版](CHANGELOG_ZH.md)

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

- **`ccmem cleanup --orphans`** CLI — lists memories whose `session_id` points at a session row that no longer exists (test fixtures, manual `DELETE FROM sessions`, partial-index race). Default is dry-run; `--yes` runs an indexer reconcile first (so stale DB state is not mis-classified) and deletes after stdin confirmation inside a single transaction. Manual memories (`session_id IS NULL`) are left alone.
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
