# Contributing to ccRecall

Thanks for considering a contribution. ccRecall is a small, focused project —
a local HTTP memory service for Claude Code — and the bar is "does it make the
recall loop better without bloating the surface area?"

## Before you start

- Open an issue first for any change bigger than a bug fix or a small doc tweak.
  Architecture is deliberately lean and I'd rather discuss scope upfront than
  ask you to undo work.
- ccRecall is **read-only** against `~/.claude/`. PRs that write, modify, or
  delete anything under that tree will be rejected.
- ccRecall is **localhost only**. Network-exposing features (remote ingest,
  cloud sync, auth layers) are out of scope — if you need that, fork.

## Development setup

```bash
git clone https://github.com/tznthou/ccRecall.git
cd ccRecall
pnpm install
pnpm build          # first build creates dist/ and chmods the bin files
pnpm vitest run     # should print `Tests XXX passed`
```

Node: `>=20.0.0,<23.0.0` (see `package.json` engines).

### Scripts

- `pnpm dev` — `tsx watch` on the HTTP daemon
- `pnpm mcp` — `tsx` on the MCP stdio server (for Claude Code integration)
- `pnpm build` — `tsc` + chmod the bin files
- `pnpm test` / `pnpm vitest run` — full test suite
- `pnpm lint` — ESLint `--fix`
- `pnpm typecheck` — `tsc --noEmit`

## Commit convention

Conventional commits in **English**:

- `feat: ...` new feature
- `fix: ...` bug fix
- `docs: ...` documentation
- `refactor: ...` restructure without behaviour change
- `chore: ...` deps, build config, etc.
- `test: ...` test-only changes

Scope is optional: `feat(watcher): ...`. Keep the subject under ~70 chars and
use the body for the "why".

## Pull request checklist

Before opening a PR:

- [ ] `pnpm build && pnpm vitest run` is green
- [ ] `pnpm lint` has no warnings
- [ ] `pnpm typecheck` is clean
- [ ] New behaviour has tests (red-first if you're TDD-inclined)
- [ ] Tests use `mkdtemp` — never touch the real `~/.claude/` or `~/.ccrecall/`
- [ ] New log output goes through `scrubErrorMessage()` if it echoes error
      messages (log-injection defence, see `src/core/log-safe.ts`)
- [ ] SPDX header on new `.ts` files: `// SPDX-License-Identifier: Apache-2.0`
- [ ] One logical change per PR — split unrelated fixes

## Testing integrity

- Failing tests mean code is broken, not that the assertion is wrong. Fix
  the code first; only touch the assertion if the test itself was miswritten,
  and explain why in the PR description.
- Don't write tests that pass regardless of implementation. If flipping the
  logic wouldn't fail the test, it isn't a test.

## Adversarial review

Pipeline uses `/gogo` (codex review → simplify → security lint → verify).
External contributors don't need to run it — I'll run it on merge candidates.
But if you want pre-flight signal, opening a draft PR and pinging me is the
fastest path.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
Participation implies agreement.

## License

By submitting a contribution, you agree it will be licensed under Apache-2.0
(the project's license). No CLA.
