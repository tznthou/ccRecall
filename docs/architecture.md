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
│  │ 10min backstop│ │ compression  │  │ injection  │      │
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

Independent 5-minute timer, independent single-flight. One job per tick:
`CompressionPipeline.runOnce({ batchSize: 50 })` — age memories, compress them
in stages (raw → summary → one-liner), and delete those that haven't been
accessed in 60 days. (Until v0.5.0 the tick also swept the journal table;
that pipeline is gone.)

It does *not* share the watcher's single-flight. Here's why: the watcher writes to the session-scoped tables (`sessions` / `sessions_fts` / `session_files` / `message_uuids` / topic tables); the coordinator writes to `memories`. Disjoint tables means they can't corrupt each other's state. What they *can* do is contend for the SQLite writer (WAL serializes one writer at a time), but that's a throughput concern, not a correctness one. Keeping the single-flights per-engine means each one's worst case is bounded by itself, not by the other.

`timer.unref()` — the coordinator's interval does not keep the process alive. The HTTP server is the authoritative keep-alive. This matters in a test harness: when the server closes, the compression timer won't trap the process.

---

## Engine 3: HTTP + the Session-End Confirm

`src/api/routes.ts`

Memories don't get created by the watcher. The watcher writes **session summaries** (into the `sessions` table); memories are written by the post-session extraction wrapper (Haiku → MCP `recall_save`) and by manual `recall_save` calls. What `/session/end` does is narrower and load-bearing: confirm the just-ended session is indexed, running a rescue reindex on a miss. That endpoint is driven by the SessionEnd hook `hooks/session-end.mjs`.

(History: from v0.3.0 to v0.4.x this endpoint also harvested a rule-scored candidate into a `session_journal` review queue. The queue recorded zero promotions in its entire history, and post-session extraction made it redundant — v0.5.0 removed the whole pipeline. The "Trust grade" section below keeps the epitaph.)

### Why session-end is hook-driven, not watcher-driven

A session's JSONL can grow forever if the user keeps resuming. The watcher sees file writes, not session lifecycle — only Claude Code knows when a session actually ends, and both consumers of that moment (the index confirm here, the extraction wrapper's `/session/last` query) need it exactly once; hence the hook.

The `reason: 'resume'` filter in `hooks/session-end.mjs:82` is the other half of that contract — a resumed session is *not* an end event, so we skip it.

### rescueReindex: intentional bypass

When the hook fires and the daemon hasn't seen the JSONL yet (fresh-session race: the hook fires before chokidar's `add` event settles), the endpoint calls `rescueReindex` before giving up. Crucially:

```ts
// src/index.ts:141
const server = createServer(db, {
  rescueReindex: () => runIndexer(db),   // NOT watcher.runNow()
  ...
})
```

`watcher.runNow()` would respect the watcher's single-flight — meaning if a scheduled scan is already in flight, the rescue gets silently dropped (just flips `dirty`). That's exactly what we *don't* want for a blocking confirm: the client is waiting on a 200, and the extraction wrapper is about to ask `/session/last` for this very session. Calling `runIndexer(db)` directly sidesteps the single-flight and gives the caller deterministic execution.

The tradeoff: two concurrent `runIndexer` runs can contend for the writer. In practice they don't corrupt — SQLite WAL serializes writes — and the window is narrow (rescue only runs on cache miss).

---

## Trust grade vs persistence gate (an epitaph)

Two write-path designs died here; the doc keeps their story because both graves explain the current shape.

**The persistence gate (pre-0.3.0).** A rule scorer in `summarizer.ts` decided whether a session's harvest got persisted at all (`score >= KNOWLEDGE_THRESHOLD`). A corpus audit on 39 known-good outcomes returned **0** over threshold — regex scoring systematically under-weighted real outcomes ([issue #25](https://github.com/tznthou/ccRecall/issues/25)).

**The trust two-tier (v0.3.0 → v0.4.x).** The structural fix moved the scorer off the gate: harvest always landed in a low-trust `session_journal` queue that recall never read, and a human promoted entries into `memories` via `ccmem promote`. Race-safe, well-tested, philosophically sound — and it recorded **zero promotions in its entire history**. Nobody reviews a queue. Meanwhile post-session extraction (v0.4.1) started writing reviewed, keyed, deduplicated memories directly, doing the curation the queue was waiting on a human for.

v0.5.0 drew the conclusion: the journal pipeline, the rule scorer, and the harvest branch were removed whole. Today there is exactly one automatic write path (extraction → `recall_save`) and one manual one (`recall_save` in-session), both landing in `memories`. The lesson worth keeping: a review queue whose reviewer never shows up is not a trust boundary, it's a dead-letter box.

---

## Trade-offs We Chose

| Choice | Alternative | Why |
|---|---|---|
| Event-driven + 10min backstop | Pure polling every N seconds | Polling wastes work when idle; pure events miss APFS/NFS edges. Backstop is safety net, not primary path. |
| Rule-based summarizer (zero LLM) | Call Claude for summaries | Every session would cost money. Rule-based covers the common shape; outliers fall into `discovery` confidence 0.7 and Claude can judge on recall. |
| Three per-engine single-flights | One global lock | A global lock means compression blocks indexing and vice versa. Per-engine isolates blast radius to its own job. |
| Hook-driven session-end signal | Watcher-driven detection | Only Claude Code knows when a session *really* ends. Watcher sees file writes, not session lifecycle. |
| Rescue bypasses single-flight | Rescue respects single-flight | Rescue is a blocking HTTP request. Getting dropped silently by the watcher's `dirty` flag would turn into a 404 to the hook. Deterministic execution wins. |
| One write path, LLM-curated (v0.5.0) | Rule-scored review queue (v0.3.0–v0.4.x) | The queue recorded zero promotions ever; extraction writes reviewed, keyed memories directly. A trust boundary nobody staffs is a dead-letter box — see the epitaph section above. |
| Dual 64-bit hash for replay dedup (v0.5.0) | 36-char TEXT uuid rows | The registry only ever answers "seen before?" — nothing reads the uuid back. Hashes cut 400k rows from 73.6MB to 17.3MB; a 4×10⁻⁹ collision merely skips one replayed message. |

---

## Known Limitations

These are deliberately **not** pinned to values in this doc body — they rot fast. Current state lives elsewhere:

- Open issues: [#11](https://github.com/tznthou/ccRecall/issues/11) (WAL/VACUUM physical compaction — partly addressed in 0.2.0 by moving VACUUM out of daemon startup), [#13](https://github.com/tznthou/ccRecall/issues/13) (FTS5 CJK edge cases)

Authoritative state is always `gh issue list` plus project notes, not this file.

---

## Where to Look Next

| Question | File:line |
|---|---|
| What does the bootstrap sequence look like? | `src/index.ts` (grep `startDaemon`) |
| How does the watcher decide when to scan? | `src/core/watcher.ts:73-109` |
| What does runIndexer actually do? | `src/core/indexer.ts:62-262` |
| How do memories get written after a session? | `scripts/post-session-extract.sh` + `scripts/extraction-prompt.md` |
| What does the summarizer produce? | `src/core/summarizer.ts` (grep `summarizeSession`) |
| Why is `reason: 'resume'` skipped? | `hooks/session-end.mjs:82` |
| How is compression scheduled? | `src/core/maintenance-coordinator.ts:51-57` |
| Where is the v24 knife-field migration defined? | `src/core/database.ts` (grep `version: 24`) |
| How does the dual-hash dedup registry work? | `src/core/database.ts` (grep `hash64`) |

Found something the doc gets wrong, or a trade-off not explained here? Open a [GitHub Issue](https://github.com/tznthou/ccRecall/issues) — the code is the truth, and this doc should track it.
