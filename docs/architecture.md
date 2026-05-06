# Architecture — Why the Daemon Looks the Way It Does

> [中文](architecture_zh.md)

This isn't a tutorial. If you want to install ccRecall and use it, read [tutorial.md](tutorial.md). If you're wondering *why* the daemon runs three timers instead of one, why `awaitWriteFinish` is set to 500ms, or why `/session/end` bypasses the watcher it could have reused — you're in the right place.

The source code is the ground truth. Paths like `src/core/watcher.ts:73` point you there. Everything below is the reasoning that didn't fit into code comments.

---

## Three Engines in One Process

When `ccmem` starts, it doesn't spin up one loop — it orchestrates three:

```
┌──────────────────────────────────────────────────────────┐
│  Single process (port 7749)                              │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐      │
│  │ JsonlWatcher │  │ Maintenance  │  │ HTTP/MCP   │      │
│  │ (event-driven)│ │ Coordinator  │  │ Server     │      │
│  │              │  │ (5 min tick) │  │ (on-demand)│      │
│  │ 2s debounce  │  │              │  │            │      │
│  │ 10min backstop│ │ compression  │  │ harvest    │      │
│  │ single-flight│  │ single-flight│  │ rescue     │      │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘      │
│         │                 │                │              │
│         └──── SQLite (WAL mode) ←──────────┘              │
└──────────────────────────────────────────────────────────┘
```

Each engine has a distinct responsibility, and the `single-flight` guards aren't cosmetic — they exist because contention between them is inevitable under real workloads.

---

## Bootstrap: Why We Await the Initial Index

`src/index.ts:100-148`

The order matters:

1. Open SQLite
2. **Await** a full `runIndexer(db)`
3. Start `MaintenanceCoordinator`
4. Start `JsonlWatcher` (await its `ready` event)
5. Listen on HTTP

Between step 2 and step 4 there's a race. If you start chokidar with `ignoreInitial: true` *before* your own tree walk finishes, a JSONL written in that window is invisible to both paths. Chokidar skips it (the file was already there when chokidar opened), and the indexer has already moved past that directory. The file stays unseen until the 10-minute backstop fires, or a `/session/end` rescue is triggered for that session.

Awaiting the initial indexer keeps the `ignoreInitial` contract clean: "we already own everything on disk as of now; chokidar, only tell us about changes *after* this moment."

---

## Engine 1: JsonlWatcher

`src/core/watcher.ts`

### The Debounce

Claude Code writes JSONL in streaming bursts — each tool call can fire several `change` events on the same file within milliseconds. Without a debounce, every event triggers `runIndexer`, which does a full tree scan plus N file parses. The debounce collapses a burst into a single scan 2 seconds after the last event settles.

### The Backstop

Debounces can be starved. If a session is very chatty — a tool call every 1.5 seconds for an hour — each event pushes the debounce forward and a scan never fires. That's why the backstop bypasses the debounce entirely:

```ts
setInterval(() => { void this.runScan() }, this.fullResyncMs)   // 10 min
```

This isn't a backup for chokidar correctness. Chokidar is mostly reliable, but filesystems have edges — APFS rename races, NFS event loss, symlinks crossing mount points. The backstop is insurance, not redundancy.

### awaitWriteFinish: 500ms

Claude Code keeps a single file handle open across a whole session. A `change` event can fire mid-line — if you `parseSession` while `{"type":"assistant"...` is half-flushed, you get a parse error and drop a valid message. `awaitWriteFinish.stabilityThreshold: 500` means: wait until 500ms pass with no new bytes before considering the file "changed." Long enough to catch mid-write; short enough that it doesn't feel sluggish.

### single-flight

If a scan is running and another event fires, we don't queue it — we set a `dirty` flag and let the current scan finish. Only then do we schedule one follow-up. The queue alternative has a pathological case: scan N, event during N, queue N+1, event during N+1, queue N+2... Under sustained write pressure the work is unbounded.

---

## Engine 2: MaintenanceCoordinator

`src/core/maintenance-coordinator.ts`

Independent 5-minute timer, independent single-flight. Two sweeps per tick (since v0.3.0):

1. `CompressionPipeline.runOnce({ batchSize: 50 })` — age memories, compress them in stages (raw → summary → one-liner), and delete those that haven't been accessed in 60 days.
2. `sweepJournal()` — delete journal entries that are `rejected` past their 7-day `expires_at`, plus `pending` entries older than 30 days. Promoted entries are kept indefinitely as an audit trail (the promotion already wrote a corresponding row into `memories`).

Both sweeps share the coordinator's single-flight; the watcher's single-flight is separate.

It does *not* share the watcher's single-flight. Here's why: the watcher writes to the session-scoped tables (`sessions` / `sessions_fts` / `session_files` / `message_uuids` / topic tables); the coordinator writes to `memories`. Disjoint tables means they can't corrupt each other's state. What they *can* do is contend for the SQLite writer (WAL serializes one writer at a time), but that's a throughput concern, not a correctness one. Keeping the single-flights per-engine means each one's worst case is bounded by itself, not by the other.

`timer.unref()` — the coordinator's interval does not keep the process alive. The HTTP server is the authoritative keep-alive. This matters in a test harness: when the server closes, the compression timer won't trap the process.

---

## Engine 3: HTTP + the Harvest Endpoint

`src/api/routes.ts`

Memories don't get created by the watcher. The watcher writes **session summaries** (into the `sessions` table); harvesting a summary into a journal candidate happens only when `/session/end` is called. That endpoint is driven by the SessionEnd hook `hooks/session-end.mjs`.

Since v0.3.0 the harvest target is `session_journal`, **not** `memories`. The hook produces a low-trust candidate; turning it into a high-trust memory takes an explicit `POST /journal/promote` (typically via `ccmem promote <id>`). Manual `POST /memory/save` and the MCP `recall_save` tool still write directly to `memories` — they bypass journal entirely. Reasoning lives in the "Trust grade vs persistence gate" section below.

### Why harvest is hook-driven, not watcher-driven

A session's JSONL can grow forever if the user keeps resuming. You don't want to harvest on every file change — you'd produce thousands of duplicate, half-finished memories. You want to harvest exactly once, when the session actually ends. Only Claude Code knows that; hence the hook.

The `reason: 'resume'` filter in `hooks/session-end.mjs:82` is the other half of that contract — a resumed session is *not* an end event, so we skip it. (We suspect this filter is a little too wide in practice — see the harvest-rate gap in the known-limitations section below.)

### rescueReindex: intentional bypass

When the hook fires and the daemon hasn't seen the JSONL yet (fresh-session race: the hook fires before chokidar's `add` event settles), the endpoint calls `rescueReindex` before giving up. Crucially:

```ts
// src/index.ts:141
const server = createServer(db, {
  rescueReindex: () => runIndexer(db),   // NOT watcher.runNow()
  ...
})
```

`watcher.runNow()` would respect the watcher's single-flight — meaning if a scheduled scan is already in flight, the rescue gets silently dropped (just flips `dirty`). That's exactly what we *don't* want for a blocking harvest: the client is waiting on a 200. Calling `runIndexer(db)` directly sidesteps the single-flight and gives the caller deterministic execution.

The tradeoff: two concurrent `runIndexer` runs can contend for the writer. In practice they don't corrupt — SQLite WAL serializes writes — and the window is narrow (rescue only runs on cache miss).

### Promote and reject paths

`POST /journal/promote` runs four steps inside one BEGIN/COMMIT: `saveMemory` → `saveMemoryTopics` → `rebuildKnowledgeMap` → `promoteJournalEntry` (which sets the journal row's `status = 'promoted'` and links `promoted_memory_id`). If any step throws, the transaction rolls back and the journal row stays `pending`. `promoteJournalEntry()` returning `false` (concurrent promote race) re-throws inside the transaction so an already-written memory row does not leak — race-safe by construction, not by `SELECT … FOR UPDATE` gymnastics.

`POST /journal/reject` is simpler: it sets `status = 'rejected'` and `expires_at = now + 7 days`. The decay sweep in Engine 2 reaps it later. The soft-delete + TTL choice (rather than immediate `DELETE`) means an accidental reject can be undone within a week — `UPDATE session_journal SET status = 'pending', expires_at = NULL WHERE id = ?` is enough.

---

## Trust grade vs persistence gate (the 0.3.0 redesign)

Pre-0.3.0, the rule scorer in `summarizer.ts` decided whether the harvest got persisted at all (`score >= KNOWLEDGE_THRESHOLD`). A corpus audit on 39 known-good outcomes returned **0** over threshold — the scorer was systematically under-weighting real outcomes (the failure scenarios are catalogued in [issue #25](https://github.com/tznthou/ccRecall/issues/25)). Adding more regex patterns would have only delayed the next failure mode.

The structural fix was to move the scorer off the persistence gate. Harvest now *always* lands somewhere; the scorer informs trust grade and promotion priority instead of yes/no. Two tables, two trust levels:

| Table | Write path | Trust | Read path |
|---|---|---|---|
| `session_journal` | SessionEnd hook (auto) | Low — needs review | `/journal/pending`, `/health.journalPendingCount` |
| `memories` | `recall_save` (manual) **or** `ccmem promote` | High — explicit human OK | `recall_query`, `recall_context`, `/memory/query` |

The hard floor is preserved. The scorer's `noise` and `process-report` reasons still short-circuit (these aren't knowledge regardless of where they land), so Claude Code's session-completion summaries do not pollute the journal either.

What this design buys us: harvester records broadly without polluting recall results; the user (or future tooling) can replay the trust decision later as patterns evolve, without re-running the harvester or losing data. What it costs: someone has to do the promotion. Manual-only on purpose — auto-promote at a threshold *is* the persistence gate we just removed, and would re-introduce the same failure mode. Surfacing pending count via `/health` and the full list via `/journal/pending` is the discovery mechanism.

---

## Trade-offs We Chose

| Choice | Alternative | Why |
|---|---|---|
| Event-driven + 10min backstop | Pure polling every N seconds | Polling wastes work when idle; pure events miss APFS/NFS edges. Backstop is safety net, not primary path. |
| Rule-based summarizer (zero LLM) | Call Claude for summaries | Every session would cost money. Rule-based covers the common shape; outliers fall into `discovery` confidence 0.7 and Claude can judge on recall. |
| Three per-engine single-flights | One global lock | A global lock means compression blocks indexing and vice versa. Per-engine isolates blast radius to its own job. |
| Hook-driven harvest | Watcher-driven harvest | Only Claude Code knows when a session *really* ends. Watcher sees file writes, not session lifecycle. |
| Rescue bypasses single-flight | Rescue respects single-flight | Rescue is a blocking HTTP request. Getting dropped silently by the watcher's `dirty` flag would turn into a 404 to the hook. Deterministic execution wins. |
| Two trust tiers (`session_journal` + `memories`) | Single table with a `trust` column | Disjoint tables make `recall_query` cheap and unambiguous — it never needs a `WHERE trust = 'high'` filter. Hook writes can never accidentally pollute recall, even if a future bug forgets the column. The cost — one extra table — is paid once at migration; the recall savings are amortized forever. |
| Manual-only promotion | Auto-promote at score threshold | Auto-promote at a score threshold *is* the persistence gate we just removed. Threshold-driven persistence is what produced the 0/39 audit hit rate. Manual promotion (with `/health` surfacing) keeps the human in the loop precisely where we know the rule scorer can't be trusted alone. |

---

## Known Limitations

These are deliberately **not** pinned to values in this doc body — they rot fast. Current state lives elsewhere:

- Open issues: [#11](https://github.com/tznthou/ccRecall/issues/11) (WAL/VACUUM physical compaction — partly addressed in 0.2.0 by moving VACUUM out of daemon startup), [#13](https://github.com/tznthou/ccRecall/issues/13) (FTS5 CJK edge cases)
- Harvest-rate gap: we observe a non-trivial fraction of sessions skipped despite having summaries. The prime suspect is the `reason: 'resume'` filter being over-eager; logging the `reason` distribution is on the quick-fix list.

Authoritative state is always `gh issue list` plus project notes, not this file.

---

## Where to Look Next

| Question | File:line |
|---|---|
| What does the bootstrap sequence look like? | `src/index.ts:100-148` |
| How does the watcher decide when to scan? | `src/core/watcher.ts:73-109` |
| What does runIndexer actually do? | `src/core/indexer.ts:62-262` |
| How does harvest build a memory from a session? | `src/api/routes.ts:85-99` + `:285-375` |
| What does the summarizer produce? | `src/core/summarizer.ts:420-480` |
| Why is `reason: 'resume'` skipped? | `hooks/session-end.mjs:82` |
| How is compression scheduled? | `src/core/maintenance-coordinator.ts:51-57` |
| Where is the v22 schema migration defined? | `src/core/database.ts` (grep `journalCreateSql`) |
| How does `POST /journal/promote` stay atomic? | `src/api/routes.ts` (grep `promoteJournal`) |
| Where does the journal decay sweep run? | `src/core/maintenance-coordinator.ts` (grep `sweepJournal`) |
| Where is the `ccmem promote` / `reject` CLI? | `src/cli/journal.ts` |

Found something the doc gets wrong, or a trade-off not explained here? Open a [GitHub Issue](https://github.com/tznthou/ccRecall/issues) — the code is the truth, and this doc should track it.
