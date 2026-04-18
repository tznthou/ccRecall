# Using ccRecall — From Zero to Cross-Session Memory

> [中文](tutorial_zh.md)

## What Is This

You have a genius friend named Claude who codes, debugs, and refactors better than most humans — but he has goldfish memory. Every time you close the session, everything resets. The bug you solved together yesterday? Strangers again tomorrow. The architecture you spent 20 minutes explaining? You'll explain it again next week.

ccRecall is Claude's memory implant. It reads the JSONL conversation logs Claude Code writes to `~/.claude/projects/`, quietly extracts the key moments into SQLite, and slips a note to Claude on the next session: "Last time you decided on approach A and fixed bug B." Zero API cost. Runs entirely locally.

If you want the deep mechanics, jump to "Going Deeper" at the end.

---

## Before You Start

This tutorial assumes you have:

- **Claude Code CLI** installed ([official guide](https://docs.anthropic.com/claude-code) if not)
- **macOS** for auto-start (Linux / Windows for the daemon itself is cross-platform; auto-start is Phase 5)
- **Node.js 20–22** (`node --version` to check)
- Basic terminal comfort

You don't need to know SQLite, FTS5, or MCP internals — they'll come up as needed.

---

## Three Steps to Get Running

### Step 1: Install

```bash
npm install -g @tznthou/ccrecall
```

> Prefer **pnpm**? First-time global installs need a one-off `pnpm setup` — it creates the global bin directory and wires `PNPM_HOME` into your shell config. Open a new terminal, then `pnpm add -g @tznthou/ccrecall`. Yarn v1 is similar: confirm `yarn global bin` is on your `PATH` before running `yarn global add`.

You'll get two CLI commands:

- `ccmem` — runs the daemon (the core service)
- `ccmem-mcp` — the MCP server Claude Code calls

> Why is the CLI named `ccmem`? Because `ccrecall` on npm is already taken by [spences10/ccrecall](https://github.com/spences10/ccrecall), an unrelated analytics-focused tool. The project is still called ccRecall; only the binary name sidesteps the conflict.

### Step 2: Run the Daemon at Login (macOS)

```bash
ccmem install-daemon
```

This:
1. Writes a LaunchAgent plist to `~/Library/LaunchAgents/com.tznthou.ccrecall.plist`
2. Creates the log directory `~/Library/Logs/ccrecall/`
3. Starts the daemon immediately and at every login

**Linux / Windows / just-trying-it-out** folks can run it in the foreground instead:

```bash
ccmem    # stays in foreground; Ctrl+C to quit
```

### Step 3: Wire It to Claude Code (MCP)

```bash
claude mcp add ccrecall --scope user -- ccmem-mcp
```

This registers ccRecall's MCP server (`ccmem-mcp`) with Claude Code. `--scope user` means it's available in every project.

---

## Verify It's Working

### Is the daemon alive?

```bash
curl http://127.0.0.1:7749/health
```

`{"status":"ok"}` means yes. `7749` is the default port; override with `CCRECALL_PORT` in the plist if you need to.

### Is MCP connected?

Start a fresh Claude Code session and ask something like:

> "Have we talked about xxx before?"

Claude should proactively invoke `mcp__ccrecall__recall_query` to search your past conversations. Seeing "looking up memories" in the tool calls means the connection is live.

### Why your first query might come up empty

On first boot, the daemon kicks off `runIndexer` to walk every historical JSONL under `~/.claude/projects/` and build the index. The file watcher only arms itself after that pass completes. Empty results during this window aren't a bug — they're the index still warming up. A dozen sessions take a few seconds; hundreds can take a minute or two.

Tail the log if you want to watch the progress:

```bash
tail -f ~/Library/Logs/ccrecall/ccrecall.out.log
# "Indexer complete." means you're good to go
```

---

## Three Everyday Scenarios

### Scenario 1: Recalling "That Bug We Fixed"

Last week you debugged a nasty race condition with Claude. You don't remember the details. New session:

```
You: Didn't we fix a race condition in the watcher? Can't remember how — look it up.
Claude: (invokes recall_query('race condition watcher'))
Claude: Found it — you used async/await to force scanProjects to complete
        before watcher.start(), sidestepping chokidar's ignoreInitial=true
        race. Commit ee64c6b.
```

ccRecall silently injected that memory into Claude's context as a <300-token note, and he picked up where you left off.

### Scenario 2: Actively Saving "This Is Important"

Not every decision gets auto-harvested. When you hit a key trade-off you want Claude to remember next time:

```
You: Remember we chose Trusted Publishing over NPM_TOKEN — zero token
     maintenance via OIDC.
Claude: (invokes recall_save with type=decision)
Claude: Saved. I'll recall this next time npm publishing comes up.
```

You can also hit the daemon directly from the terminal:

```bash
curl -X POST http://127.0.0.1:7749/memory/save \
  -H 'Content-Type: application/json' \
  -d '{"content":"Chose Trusted Publishing","type":"decision","confidence":0.9}'
```

### Scenario 3: Metacognition — "What Have We Been Working On?"

Some days you want to know what this project's conversations have actually been about lately:

```
You: What topics have we been discussing most on ccRecall this month?
Claude: (invokes recall_context('ccRecall') with knowledge_map)
Claude: Three main clusters:
         1. npm publishing + Trusted Publishing (last 2 weeks)
         2. pnpm packaging + CI workflow (3 weeks ago)
         3. Phase 4 forgetting curve (a month ago)
```

That's ccRecall's metacognition layer — not just individual memories, but topic clusters showing what you and the AI have actually been exploring together.

---

## Going Further

### Hooks: auto-trigger ccRecall via Claude Code lifecycle

MCP is "Claude asks on demand." Hooks fire automatically at session start and end — SessionStart injects relevant memories into the context before the first prompt; SessionEnd harvests the session just ended into a memory.

Setup: [`hooks/README.md`](../hooks/README.md). After wiring it up, sanity-check it works:

```bash
# Grab HOOKS_DIR (see hooks/README.md for pnpm / yarn variants)
HOOKS_DIR="$(npm root -g)/@tznthou/ccrecall/hooks"

# Fire session-end by hand
echo '{"session_id":"test","hook_event_name":"SessionEnd","reason":"other"}' \
  | node "$HOOKS_DIR/session-end.mjs"

# Did a memory land?
sqlite3 ~/.ccrecall/ccrecall.db "SELECT COUNT(*) FROM memories"
```

If the daemon log shows a `/session/end` hit and the memory count ticks up, the hook is wired end to end.

### macOS auto-start (daemon itself)

Step 2 covered the basic flow. For manual plist authoring, uninstall, or port-conflict workarounds, see [`docs/launchd.md`](./launchd.md).

---

## Troubleshooting

**Q: After install, `ccmem --help` says command not found.**
A: Your npm global bin isn't on PATH. Run `npm config get prefix` to see where it lives, then add `<prefix>/bin` to PATH.

**Q: Daemon won't start, log shows EADDRINUSE.**
A: Port 7749 is taken by something else. Override it:
```bash
export CCRECALL_PORT=17749
ccmem install-daemon    # reinstall plist with the new port
```

**Q: Claude never calls recall_query.**
A: Check `claude mcp list` shows `ccrecall`. If not, re-run `claude mcp add`. Claude doesn't always decide to call it on its own — name the tool explicitly and it will:
- To look up: "use recall_query to search for xxx"
- To save: "use recall_save to remember xxx"

**Q: Are my conversations uploaded anywhere?**
A: No. ccRecall runs fully locally; the SQLite DB lives at `~/.ccrecall/` and nothing leaves your machine. The summarizer is rule-based — no LLM calls.

**Q: Does it modify `~/.claude/`?**
A: No. ccRecall is strictly read-only against `~/.claude/`. It only writes to its own `~/.ccrecall/` and `~/Library/Logs/ccrecall/`.

---

## Uninstalling

```bash
# 1. Stop and unregister the LaunchAgent
ccmem uninstall-daemon

# 2. Unregister the MCP server from Claude Code
claude mcp remove ccrecall -s user

# 3. Remove the npm package
npm uninstall -g @tznthou/ccrecall

# 4. (Optional) Wipe the data and logs
rm -rf ~/.ccrecall ~/Library/Logs/ccrecall

# 5. (Optional) Clean up hook entries
# Edit ~/.claude/settings.json and drop the SessionStart / SessionEnd entries you added.
```

The first three steps take ccRecall fully offline. Skip steps 4–5 if you want to keep the memory DB around in case you reinstall later.

---

## Going Deeper

- **How it works (10-year-old version)**: [`.claude/pi-research/ccrecall-for-kids.md`](../.claude/pi-research/ccrecall-for-kids.md) — the five-step pipeline explained via a goldfish-friend metaphor
- **AI long-term memory design**: [`.claude/pi-research/ai-long-term-memory-design.md`](../.claude/pi-research/ai-long-term-memory-design.md) — forgetting curve, compression pipeline
- **Architectural lineage**: [`.claude/pi-research/ccrewind-memory-service-architecture.md`](../.claude/pi-research/ccrewind-memory-service-architecture.md) — modules extracted from ccRewind

Found a bug or have a question? Open a [GitHub Issue](https://github.com/tznthou/ccRecall/issues).
