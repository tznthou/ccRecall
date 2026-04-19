# Changelog

All notable changes to ccRecall are recorded here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) (anything under `1.0`
is pre-stable — breaking changes are documented but the minor number is used
more like an iteration counter than a strict SemVer major).

[中文版](CHANGELOG_ZH.md)

---

## [Unreleased]

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
