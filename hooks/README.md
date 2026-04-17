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
| `session-end.mjs` | `SessionEnd` | POST `/session/end` to harvest the just-ended session into a memory |

## Installation

Add to `~/.claude/settings.json` (or your project's `.claude/settings.json`):

```json
{
  "hooks": {
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

- **Non-blocking**: hooks complete quickly; errors go to stderr and the script exits 0
- **Skip on `resume`**: when `reason === 'resume'`, the session is continuing, so no harvest fires
- **Skip when missing `session_id`**: defensive; Claude Code always provides it in SessionEnd
- **5s timeout**: hook never hangs Claude Code even if the service is stuck
