# ccRecall Claude Code Hooks

Hook scripts that let Claude Code's lifecycle events trigger ccRecall actions.

## Prerequisites

The ccRecall HTTP service must be running on `127.0.0.1:7749` (or the port set via `CCRECALL_PORT`). Start it with:

```bash
pnpm dev       # from the ccRecall repo
```

If the service is not running, hooks log a warning to stderr and exit cleanly — they never block Claude Code.

## Available Hooks

| Script | Claude Code Event | Action |
|--------|------------------|--------|
| `session-start.mjs` | `SessionStart` | GET `/memory/query` with the project name, write matching memories to stdout (Claude prepends them to context) |
| `session-end.mjs` | `SessionEnd` | POST `/session/end` to harvest the just-ended session into a memory |

## Installation

Add to `~/.claude/settings.json` (or your project's `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/tznthou/Documents/ccRecall/hooks/session-start.mjs"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/tznthou/Documents/ccRecall/hooks/session-end.mjs"
          }
        ]
      }
    ]
  }
}
```

Adjust the path to match your ccRecall clone location.

## Environment Variables

- `CCRECALL_PORT` — override the HTTP port (default `7749`)

## Verifying the Hook

Trigger manually:

```bash
echo '{"session_id":"test-session","hook_event_name":"SessionEnd","reason":"other"}' \
  | node /Users/tznthou/Documents/ccRecall/hooks/session-end.mjs
```

With ccRecall running, this POSTs to `/session/end`. The response (success or 404) is logged to stderr only on failure.

## Design Notes

- **Non-blocking**: hooks exit quickly; errors go to stderr and the script exits 0 — never blocks Claude Code
- **Skip on `resume`**:
  - SessionEnd: `reason === 'resume'` means the session continues
  - SessionStart: `source === 'resume'` means the context is already loaded
- **SessionStart query strategy**: uses the last path segment of `cwd` as a keyword against FTS5 — simple, no-prompt-yet heuristic; Phase 3+ will add smarter selection
- **SessionStart stdout = context injection**: only memories are written to stdout; all errors and diagnostics go to stderr to avoid polluting Claude's context
- **Timeouts**: SessionEnd 5s, SessionStart 2s (tighter because it sits on the pre-prompt critical path)
