# Security Policy

## Threat model

ccRecall is a **local-only** memory service for Claude Code. The threat model
assumes:

- **Trust boundary**: the machine the daemon runs on. Other users on the same
  machine, or remote attackers with a foothold on the loopback interface, are
  out of scope — they already own more than this daemon can protect.
- **Network surface**: HTTP server binds to `127.0.0.1` only. Mutating and
  introspection endpoints require a loopback `Origin` header. No authentication
  beyond loopback gating — the assumption is that if something non-local can
  reach `127.0.0.1:7749`, the host is already compromised.
- **Filesystem**: ccRecall is **strictly read-only** against `~/.claude/`. It
  writes only to its own SQLite DB (`~/.ccrecall/ccrecall.db` by default) and
  the LaunchAgent plist under `~/Library/LaunchAgents/` (macOS).
- **External network**: none. ccRecall does not phone home, fetch updates, or
  make any outbound request at runtime.
- **Dependencies**: `better-sqlite3`, `chokidar`, `@modelcontextprotocol/sdk`,
  `zod`. See `package.json` for exact versions; `pnpm-lock.yaml` is authoritative.

### What ccRecall defends against

- Log injection — user-supplied content (session summaries, JSONL parse errors)
  is scrubbed before reaching `console.warn`/`console.error` (`scrubErrorMessage`
  helper, `src/core/log-safe.ts`).
- FTS5 query injection — user-supplied recall queries are quoted per-token
  before hitting the SQLite full-text index.
- NaN/infinity ranking hijack — effective-confidence SQL returns NULL instead
  of NaN so malformed decay inputs can't sort to the top of results.
- LaunchAgent clobbering — the installer refuses to touch a plist that isn't
  already ccRecall-managed (Label check + symlink rejection).
- Request-body DoS — 1 MB cap on HTTP body reads.

### What ccRecall does **not** defend against

- Local privilege escalation: if a local attacker can write to
  `~/.claude/projects/`, they can craft JSONL that indexes into memories.
  ccRecall treats the Claude Code working directory as trusted input.
- Multi-user machines: if another user on the same machine can reach
  `127.0.0.1:7749`, they can read recall data. Use a user-scoped firewall
  or run each user's daemon under a distinct port if this matters.
- Time-of-check / time-of-use races on the LaunchAgent installer: there is a
  microsecond-level window between `lstat` and `writeFile`. If an attacker
  can already write to `~/Library/LaunchAgents/`, they have other easier
  paths.

## Reporting a vulnerability

**Do not open a public GitHub issue.**

Report privately to `tznthou@gmail.com` with:

1. A description of the issue and what attacker capability is needed.
2. Reproducible steps or a proof-of-concept.
3. Your assessment of severity (Critical / High / Medium / Low).

I will acknowledge within 7 days and aim to land a fix within 30 days for
Critical/High issues. I can't offer a bug bounty — this is a hobby-scale
project — but I will credit reporters in the changelog unless you prefer
anonymity.

## Scope

In scope:

- `src/` production code
- `hooks/` Claude Code hooks
- `docs/` (for instructions that, if followed, would expose users)
- `package.json` dependency choices

Out of scope:

- Tests under `tests/` (not shipped to users)
- CI configuration
- Documentation typos or style issues — use regular issues/PRs
- Vulnerabilities in third-party dependencies (report upstream; I will update
  the pin once a fix is available)
