// SPDX-License-Identifier: Apache-2.0
//
// Guards the telemetry log write path in the post-session-extract wrapper.
//
// Background: extract.log.jsonl carries $PWD (added with #89) and therefore
// discloses the account name and every project name the user works on. A log
// first created under a permissive umask lands at 0644 — the dogfood machine's
// was exactly that, while recall-query.log.jsonl beside it was already 0600.
//
// This failure mode is silent: a log that drifts back to 0644 raises no error,
// writes no warning, and looks identical in every telemetry query. Nothing but
// a test that reads the mode can catch it, which is why these exist.
//
// The wrapper is sourced and its shipped functions are called directly rather
// than reimplemented here, matching extract-wrapper-marker.test.ts: one source
// of truth, so the test cannot drift away from what actually ships.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, chmod, readFile, readdir, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')

const IS_ROOT = process.getuid?.() === 0
const IS_DARWIN = process.platform === 'darwin'
const HAS_ZSH = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0

/**
 * A filename component past every filesystem's 255-byte limit, so creation
 * fails with ENAMETOOLONG regardless of who is running. That matters: the
 * obvious way to stage a failure is an unwritable parent directory, which
 * root ignores — and on a containerised runner root is the default user, so
 * the assertions this security fix rests on would silently skip while the
 * suite still reported green.
 */
const TOO_LONG = 'a'.repeat(300)

/**
 * Environment for a spawned shell, with every route back to the real machine
 * cut. HOME alone is not enough: a non-interactive `bash -c` still sources
 * $BASH_ENV, and zsh still sources $ZDOTDIR/.zshenv, both before the body
 * runs and both regardless of HOME — verified on this machine. They are unset
 * here today, so the hole is latent rather than open, but a test writing to
 * the real telemetry log has happened twice in this repo already.
 */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ZDOTDIR: home,
    CCRECALL_EXTRACT_LOG: path.join(home, 'extract.log.jsonl'),
  }
  delete env.BASH_ENV
  delete env.ENV
  return env
}

interface ShellResult {
  code: number
  stderr: string
  stdout?: string
}

/**
 * Run one of the wrapper's shipped functions in a real shell.
 *
 * `umask 022` is the point, not incidental setup: under a restrictive umask a
 * plain `>>` already yields 0600, so a run inheriting the CI runner's umask
 * could pass while the guard did nothing. An assertion that cannot fail is
 * not a test.
 *
 * zsh is invoked with -f so it skips startup files; bash -c reads none.
 */
function runShell(body: string, args: string[], home: string, shell = 'bash'): ShellResult {
  const flags = shell === 'zsh' ? ['-f', '-c'] : ['-c']
  const r = spawnSync(shell, [...flags, `umask 022\n. "$1"\n${body}`, 'ccrecall-test', WRAPPER, ...args], {
    encoding: 'utf8',
    env: cleanEnv(home),
  })
  return { code: r.status ?? -1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' }
}

/**
 * The wrapper's functions as the shell itself parses them, whitespace
 * collapsed so each command reads as the single unit the shell runs.
 *
 * Structural assertions used to scan the file as text, which meant
 * reimplementing shell lexing in TypeScript: whole-line comments, trailing
 * comments, `#` inside quotes, `#` after a metacharacter, backslash
 * continuations, backslashes inside comments. Four rounds of adversarial
 * review found four different ways that approximation disagreed with the
 * shell, each one a test that stayed green over a wrapper that was already
 * broken. `declare -f` ends the category: comments are gone because bash
 * discarded them, continuations are joined because bash joined them, and
 * what is left is bash's own reading of the code that actually ships.
 *
 * The collapse matters because `declare -f` breaks a subshell across lines —
 * `( umask 077;\n mkdir -p … )` — and the umask must be asserted together
 * with the command it protects, not merely somewhere in the same function.
 */
function parsedShell(home: string, fn = ''): string {
  const r = runShell(`declare -f ${fn}`.trimEnd(), [], home)
  if (r.code !== 0) throw new Error(`sourcing the wrapper failed: ${r.stderr}`)
  const out = (r.stdout ?? '').replace(/\s+/g, ' ')
  // An empty result would make every `not.toMatch` below pass vacuously.
  if (!out.trim()) throw new Error(`declare -f ${fn} returned nothing`)
  return out
}

/** Names of every function the wrapper defines, sorted. */
function definedFunctions(home: string): string[] {
  const r = runShell('declare -F | sed "s/^declare -f //"', [], home)
  if (r.code !== 0) throw new Error(`sourcing the wrapper failed: ${r.stderr}`)
  return (r.stdout ?? '').split('\n').filter(Boolean).sort()
}

/** `_ccrecall_secure_log <target>` */
const guard = (target: string, home: string, shell = 'bash'): ShellResult =>
  runShell('_ccrecall_secure_log "$2"', [target], home, shell)

/** Permission bits, read through Node so the assertion is identical on macOS and Linux. */
async function mode(p: string): Promise<string> {
  return ((await stat(p)).mode & 0o777).toString(8)
}


describe('extract wrapper: telemetry log permission guard', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-seclog-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates a new log 0600 under a permissive umask', async () => {
    const target = path.join(dir, 'extract.log.jsonl')
    expect(guard(target, dir).code).toBe(0)
    expect(await mode(target)).toBe('600')
  })

  it('creates missing parents 0700 rather than at the caller umask', async () => {
    // Only directories this call brings into existence. Under `umask 022` an
    // unguarded mkdir would yield 0755, which is what ~/.ccrecall gets today
    // — but that one is created upstream in TypeScript, not here, so this
    // only covers installs whose directory does not exist yet.
    const target = path.join(dir, 'nested', 'deeper', 'extract.log.jsonl')
    expect(guard(target, dir).code).toBe(0)
    expect(await mode(target)).toBe('600')
    expect(await mode(path.join(dir, 'nested'))).toBe('700')
    expect(await mode(path.join(dir, 'nested', 'deeper'))).toBe('700')
  })

  // The two tests below pin what the guard must NOT do to a directory it did
  // not create. Both behaviours were written, shipped into this branch, and
  // removed again after review showed each one broke something worse than it
  // fixed — so they are here to stop either coming back.

  it('leaves an existing directory\'s mode alone', async () => {
    // CCRECALL_EXTRACT_LOG is user-configurable, so this can be a directory
    // the user picked — a project root, or `.` for a relative setting. A
    // revision of this guard chmodded it, and a relative setting then turned
    // the user's own project directory from 0755 into 0700.
    const parent = path.join(dir, 'theirs')
    await mkdir(parent)
    await chmod(parent, 0o755)

    expect(guard(path.join(parent, 'extract.log.jsonl'), dir).code).toBe(0)
    expect(await mode(parent)).toBe('755')
  })

  it('still writes when the directory is group-writable', async () => {
    // The other discarded revision refused a group- or world-writable parent.
    // 0775 is what a `umask 002` machine produces — the RHEL/Fedora default
    // for user-private groups — so refusing meant dropping every telemetry
    // row on those machines forever, with no message: precisely the permanent
    // silent data loss that refusing was chosen to avoid.
    const parent = path.join(dir, 'shared')
    await mkdir(parent)
    await chmod(parent, 0o775)
    const target = path.join(parent, 'extract.log.jsonl')

    expect(guard(target, dir).code).toBe(0)
    expect(await mode(target)).toBe('600')
  })

  it('refuses a symlinked log instead of chmodding whatever it points at', async () => {
    // Without this the guard becomes the attack: it chmods the victim's file
    // to 0600 and the caller then appends the user's cwd into it.
    const victim = path.join(dir, 'victim.txt')
    await writeFile(victim, 'important\n', 'utf8')
    await chmod(victim, 0o644)
    await symlink(victim, path.join(dir, 'extract.log.jsonl'))

    const r = guard(path.join(dir, 'extract.log.jsonl'), dir)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe('')
    expect(await mode(victim)).toBe('644')
    expect(await readFile(victim, 'utf8')).toBe('important\n')
  })

  it('refuses a target that is not a regular file, without touching it', async () => {
    // chmod on a directory succeeds and leaves it 0600 — non-traversable —
    // and the append that follows then fails with the path on stderr. The
    // guard rejects before either happens, so the directory is left exactly
    // as it was.
    const target = path.join(dir, 'extract.log.jsonl')
    await mkdir(target)
    const before = await mode(target)

    const r = guard(target, dir)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe('')
    expect(await mode(target)).toBe(before)
  })

  it('repairs an existing 0644 log without discarding its rows', async () => {
    const target = path.join(dir, 'extract.log.jsonl')
    await writeFile(target, '{"ts":"2026-01-01T00:00:00Z","mode":"skip"}\n', 'utf8')
    await chmod(target, 0o644)

    expect(guard(target, dir).code).toBe(0)
    expect(await mode(target)).toBe('600')
    // Repair must not truncate: `>` instead of `>>` would silently erase the
    // history this log exists to accumulate.
    expect(await readFile(target, 'utf8')).toContain('2026-01-01T00:00:00Z')
  })

  // ── Each step of the guard fails for a different reason. All three are
  // exercised for real, because a step whose failure is only asserted
  // structurally is a step whose `|| return 1` can quietly stop working.

  it('fails closed and silent when the log cannot be created', () => {
    // The step the shipped 2>/dev/null change is about: without it the shell
    // names the full path on stderr — the account and project names the mode
    // exists to withhold.
    const r = guard(path.join(dir, TOO_LONG), dir)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe('')
  })

  it.skipIf(!HAS_ZSH)('fails closed and silent under zsh too', () => {
    // The wrapper ships to be sourced from a shell rc file and the dogfood
    // machine runs zsh, so bash-only coverage of the silence contract would
    // leave the shell that actually runs this untested. CI images do not all
    // carry zsh, hence the skip.
    const r = guard(path.join(dir, TOO_LONG), dir, 'zsh')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe('')
  })

  it.skipIf(IS_ROOT)('fails closed and silent when the parent cannot be created', async () => {
    const locked = path.join(dir, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)
    try {
      const r = guard(path.join(locked, 'nested', 'extract.log.jsonl'), dir)
      expect(r.code).not.toBe(0)
      expect(r.stderr).toBe('')
    } finally {
      // Restore write permission or afterEach's rm cannot remove the dir.
      await chmod(locked, 0o700)
    }
  })

  it.skipIf(!IS_DARWIN)('fails closed when an existing log cannot be chmodded', async () => {
    // The one step whose `|| return 1` is load-bearing: without it the guard
    // returns 0 and the caller appends to a 0644 log believing it private.
    // Staged with the BSD immutable flag, which needs no other user and no
    // path outside the temp dir. chflags is darwin-only; platform-gated tests
    // are established here (see cli-daemon.test.ts).
    const target = path.join(dir, 'extract.log.jsonl')
    await writeFile(target, '{}\n', 'utf8')
    await chmod(target, 0o644)
    spawnSync('chflags', ['uchg', target])
    try {
      const r = guard(target, dir)
      expect(r.code).not.toBe(0)
      expect(await mode(target)).toBe('644')
    } finally {
      // Without this the immutable flag survives and afterEach's rm fails.
      spawnSync('chflags', ['nouchg', target])
    }
  })
})

describe('extract wrapper: the log append helper', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-append-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const append = (target: string, home: string, shell = 'bash'): ShellResult =>
    runShell(`_ccrecall_log_append "$2" --arg a "x y" --arg b "/tmp/專 案" '{a:$a,b:$b}'`, [target], home, shell)

  it('writes one compact JSONL row to a log it just secured', async () => {
    const target = path.join(dir, 'extract.log.jsonl')
    expect(append(target, dir).code).toBe(0)
    expect(await mode(target)).toBe('600')
    // Values with spaces and CJK must survive the "$@" forwarding to jq.
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ a: 'x y', b: '/tmp/專 案' })
  })

  it('appends rather than truncating on a second call', async () => {
    const target = path.join(dir, 'extract.log.jsonl')
    append(target, dir)
    append(target, dir)
    expect((await readFile(target, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('writes nothing at all when the log cannot be secured', async () => {
    // The row is dropped rather than written to a file whose mode is unknown:
    // losing telemetry is cheaper than leaking paths.
    const target = path.join(dir, TOO_LONG)
    const r = append(target, dir)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe('')
    // Asserted on the parent, not the target: stat() of a 300-character name
    // rejects with ENAMETOOLONG whether or not the guard did anything, so an
    // assertion on the target itself could never fail.
    expect(await readdir(dir)).toEqual([])
  })

  it('stays silent when the target is not writable as a log', async () => {
    const target = path.join(dir, 'extract.log.jsonl')
    await mkdir(target)
    const r = append(target, dir)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe('')
  })

  it.skipIf(!HAS_ZSH)('stays silent under zsh on the same failure', async () => {
    const target = path.join(dir, 'extract.log.jsonl')
    await mkdir(target)
    const r = append(target, dir, 'zsh')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe('')
  })
})

describe('extract wrapper: a dropped row must not take the session with it', () => {
  // The call sites moved from `if _ccrecall_secure_log …; then jq …; fi` to a
  // bare `_ccrecall_log_append …`. An `if` condition is exempt from errexit;
  // a bare command is not. Without `|| :` a dropped telemetry row aborts
  // ccrecall-extract before it returns Claude's exit status — and in an
  // interactive shell with errexit set, closes the shell.
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-errexit-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Run a failing append under errexit and report whether execution continued. */
  function underErrexit(shell: 'bash' | 'zsh'): ShellResult {
    const setOpt = shell === 'zsh' ? 'setopt err_exit' : 'set -e'
    const flags = shell === 'zsh' ? ['-f', '-c'] : ['-c']
    const script = `${setOpt}\n. "$1"\n_ccrecall_log_append "$2" --arg a 1 '{a:$a}' || :\nprintf REACHED\n`
    const r = spawnSync(shell, [...flags, script, 'ccrecall-test', WRAPPER, path.join(dir, TOO_LONG)], {
      encoding: 'utf8',
      env: cleanEnv(dir),
    })
    // `printf REACHED` writes to stdout; the marker is asserted from the
    // stream it actually lands on. Both are returned so a failure here shows
    // what the shell complained about instead of only that REACHED is missing.
    return { code: r.status ?? -1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' }
  }

  it('keeps going under bash set -e when the row cannot be written', () => {
    const r = underErrexit('bash')
    expect(r.stdout).toBe('REACHED')
    expect(r.code).toBe(0)
  })

  it.skipIf(!HAS_ZSH)('keeps going under zsh err_exit when the row cannot be written', () => {
    const r = underErrexit('zsh')
    expect(r.stdout).toBe('REACHED')
    expect(r.code).toBe(0)
  })

  it('pairs every call site with a failure-tolerant suffix', () => {
    // The `|| :` lives at the call sites, so the behavioural pair above can
    // only prove the shape works — not that both sites actually carry it.
    // bash has already joined each multi-line call into one command here, so
    // there is no continuation to reassemble and no chance of reassembling
    // one the shell had cut short.
    const calls = parsedShell(dir).match(/_ccrecall_log_append "\$CCRECALL_EXTRACT_LOG".*?(?=;|$)/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c).toMatch(/\|\|\s*:\s*$/)
  })

  it('creates the log directory the same way on both paths through the wrapper', () => {
    // The extraction path creates this directory ~95 lines before the
    // telemetry append, and `mkdir -p` does not touch an existing one — so
    // an unguarded mkdir there leaves the same function producing 0700 when
    // a skip returns early and 0755 otherwise. Both must carry the umask.
    const fns = parsedShell(dir)
    // Counting rather than iterating: every mkdir must be a secured one, so
    // the two counts have to agree. Asserting only that secured ones exist
    // would let an unguarded third mkdir in beside them.
    const all = fns.match(/mkdir\s+-p/g) ?? []
    // Silenced because a failure prints the directory path, which is the
    // disclosure the mode exists to prevent; and non-fatal in its own way —
    // the guard propagates so the caller drops the row, while the extraction
    // path must not abort under errexit.
    // The inner group allows exactly one level of nesting so `$(dirname "$f")`
    // does not close the subshell early, while still refusing to run past the
    // subshell's own `)` — an unguarded mkdir must not be able to borrow the
    // `2>/dev/null || :` belonging to the next one.
    const secured = fns.match(
      /\(\s*umask\s+077;\s*mkdir\s+-p[^()]*(?:\([^()]*\)[^()]*)*\)\s*2>\s*\/dev\/null\s*\|\|\s*(?:return 1|:)/g,
    ) ?? []
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(secured).toHaveLength(all.length)
  })
})

describe('extract wrapper: the guard cannot be bypassed or removed', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-structure-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('defines exactly the three functions these assertions cover', () => {
    // `declare -f` sees functions and nothing else, so a fourth one is a
    // blind spot rather than a neutral addition. This fails until whoever
    // adds it decides whether the scans below need to cover it.
    expect(definedFunctions(dir)).toEqual([
      '_ccrecall_log_append',
      '_ccrecall_secure_log',
      'ccrecall-extract',
    ])
  })

  it('writes nothing at the moment it is sourced', async () => {
    // The other half of what `declare -f` cannot see: top-level code, which
    // runs on source. Today that is nine lines of variable assignment. An
    // append that ever drifted out of a function would land here instead,
    // with no guard in front of it and no structural scan looking.
    const r = runShell('true', [], dir)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(await readdir(dir)).toEqual([])
  })

  it('creates the file already private rather than repairing it afterwards', () => {
    // chmod alone would leave a window between creation and repair in which
    // the log is world-readable; `umask 077` closes it. A window that narrow
    // leaves nothing a later stat() could observe — both paths end at 600 —
    // so this is the one property asserted structurally. Every failure mode
    // above is exercised for real.
    //
    // Anchored to the creation itself: the guard also carries a `umask 077`
    // for its mkdir, and a function-wide match would let either one cover
    // for the other going missing.
    const fns = parsedShell(dir)
    const creations = fns.match(/:\s*>>\s*"\$f"/g) ?? []
    const secured = fns.match(/\(\s*umask\s+077;\s*:\s*>>\s*"\$f"\s*\)/g) ?? []
    expect(creations).toHaveLength(1)
    expect(secured).toHaveLength(creations.length)
  })

  it('routes every append to the log through the helper', () => {
    // Permissions belong to the file, not to the call site: one append that
    // skips the guard re-creates the log 0644 under a permissive umask and
    // every other writer inherits it. Rather than tracing shell control flow
    // to prove each write site is guarded — which needs a real parser, and a
    // line scan gets both `else` branches and nested `if` wrong — there is
    // exactly one write site, and this pins that.
    const fns = parsedShell(dir)

    // No caller may redirect into the log itself; that is the helper's job.
    expect(fns).not.toMatch(/>>\s*"\$CCRECALL_EXTRACT_LOG"/)

    // Exactly one row-writing redirect, and it is silenced. Asserted
    // structurally because the guard now rejects every target whose open
    // would fail, so the behavioural tests above can no longer reach this
    // line while failing — the remaining route to it is the target being
    // swapped after the guard returns.
    const writes = fns.match(/\{\s*jq\b[^}]*>>\s*"\$f"\s*\}\s*2>\s*\/dev\/null/g) ?? []
    expect(writes).toHaveLength(1)

    // Ordering, read from the helper alone so the call sites cannot supply
    // the guard reference on its behalf.
    const helper = parsedShell(dir, '_ccrecall_log_append')
    expect(helper.indexOf('_ccrecall_secure_log')).toBeLessThan(helper.indexOf('>> "$f"'))

    // Without this the checks above pass vacuously the day the helper is
    // renamed and every pattern here matches nothing at all.
    const callers = fns.match(/_ccrecall_log_append "\$CCRECALL_EXTRACT_LOG"/g) ?? []
    expect(callers.length).toBeGreaterThanOrEqual(2)
  })
})
