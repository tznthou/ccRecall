# ccRecall Claude Code Hooks

Hook scripts that let Claude Code's lifecycle events trigger ccRecall actions.

## Prerequisites

1. ccRecall installed globally — `npm install -g @tznthou/ccrecall` (or `pnpm add -g`, `yarn global add`).
2. ccRecall daemon running on `127.0.0.1:7749` (or your `CCRECALL_PORT`):

   ```bash
   ccmem install-daemon   # macOS — auto-start at login
   # or
   ccmem                  # foreground, any OS
   ```

If the daemon is not running, hooks log a warning to stderr and exit cleanly — they never block Claude Code.

## Available Hooks

| Script | Claude Code Event | Action |
|--------|------------------|--------|
| `session-start.mjs` | `SessionStart` | GET `/memory/query` with the project name, write matching memories to stdout (Claude prepends them to context) |
| `session-end.mjs` | `SessionEnd` | POST `/session/end` to harvest the just-ended session into a memory |

## Finding the Hook Scripts

When installed from npm, the hook files live under your global `node_modules`. Look up the absolute path once — you'll paste it into `settings.json` in the next step.

```bash
# npm
HOOKS_DIR="$(npm root -g)/@tznthou/ccrecall/hooks"

# pnpm
HOOKS_DIR="$(pnpm root -g)/@tznthou/ccrecall/hooks"

# yarn v1
HOOKS_DIR="$(yarn global dir)/node_modules/@tznthou/ccrecall/hooks"

echo "$HOOKS_DIR"
# Example: /usr/local/lib/node_modules/@tznthou/ccrecall/hooks
```

> Developing from a cloned repo? Skip the lookup and point directly at `<repo>/hooks/`.

## Installation

Add to `~/.claude/settings.json` (or a project-scoped `.claude/settings.json`). Replace `{HOOKS_DIR}` with the path you printed above:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node {HOOKS_DIR}/session-start.mjs"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node {HOOKS_DIR}/session-end.mjs"
          }
        ]
      }
    ]
  }
}
```

Restart any running Claude Code sessions — settings changes don't hot-reload.

## Environment Variables

- `CCRECALL_PORT` — override the HTTP port (default `7749`)

## Verifying the Hook

Manually trigger `session-end.mjs` from your terminal:

```bash
echo '{"session_id":"test-session","hook_event_name":"SessionEnd","reason":"other"}' \
  | node "$HOOKS_DIR/session-end.mjs"
```

With the daemon running, this POSTs to `/session/end`. Success is silent; failures go to stderr.

Live-tail the daemon log to watch real hook invocations land:

```bash
tail -f ~/Library/Logs/ccrecall/ccrecall.out.log   # macOS LaunchAgent
# or watch the terminal running `ccmem` in foreground
```

## Troubleshooting

**Q: Hooks seem to never trigger.**

1. Validate `settings.json` — `jq . ~/.claude/settings.json` (any parse error silently disables hooks).
2. Start a fresh Claude Code session — hook config doesn't apply to running sessions.
3. Confirm the daemon is up — `curl http://127.0.0.1:7749/health`.
4. Run the "Verifying" command above — this isolates whether the issue is the hook script, the daemon, or Claude Code's hook wiring.

**Q: `npm root -g` points somewhere unexpected.**

`nvm` / `fnm` / `volta` use per-version prefixes. After switching Node versions, `npm root -g` moves — the `$HOOKS_DIR` in `settings.json` needs to be re-computed and updated.

**Q: Hook logs an error but settings look right.**

Check the daemon side: `~/Library/Logs/ccrecall/ccrecall.err.log` (macOS) or the foreground terminal. Common culprits: port conflict (see `docs/launchd.md`), DB permission, or a corrupted `~/.ccrecall/ccrecall.db`.

## Design Notes

- **Non-blocking**: hooks exit quickly; errors go to stderr and the script exits 0 — never blocks Claude Code
- **Skip on `resume`**:
  - SessionEnd: `reason === 'resume'` means the session continues
  - SessionStart: `source === 'resume'` means the context is already loaded
- **SessionStart query strategy**: uses the last path segment of `cwd` as a keyword against FTS5 — simple, no-prompt-yet heuristic; Phase 3+ will add smarter selection
- **SessionStart stdout = context injection**: only memories are written to stdout; all errors and diagnostics go to stderr to avoid polluting Claude's context
- **Timeouts**: SessionEnd 5s, SessionStart 2s (tighter because it sits on the pre-prompt critical path)
