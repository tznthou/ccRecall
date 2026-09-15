// SPDX-License-Identifier: Apache-2.0
//
// Guards the channel the extraction prompt travels on (#120).
//
// Background: the wrapper used to pass the whole transcript to `claude -p` as a
// single argv parameter, and a single argv parameter has a ceiling. On Linux it
// is the kernel's MAX_ARG_STRLEN (32 pages = 131,072 bytes at a 4kB page size),
// which fails execve with E2BIG for every user on that platform. On macOS there
// is none by default, but a terminal that installs its own `claude` shim can add
// one — cmux caps a single argument at 122,880 bytes and returns 2 before Claude
// Code starts. Either way the run ends in 0 seconds and the session's memories
// are never extracted. Not a partial loss: zero memories, every time, for
// exactly the long sessions most worth extracting from.
//
// Nothing surfaced it. `head -c 200000` let the wrapper believe it was within
// budget while the real ceiling sat 85KB lower, and the only trace of the reason
// was the stderr field of a JSONL row nobody reads. So a static assertion that
// the source "contains a pipe" would guard the wrong thing — what has to hold is
// behavioural: the prompt arrives at claude, and it does not arrive as argv.
//
// These tests therefore run the real `ccrecall-extract` end to end against a stub
// `claude` that reproduces the shim's cap, a stub daemon, and a fixture
// transcript, and assert on what the stub actually received. Every subprocess
// gets its environment from one builder (`isolatedEnv`) that points HOME, PATH,
// the telemetry log and the daemon port into a temp dir and cuts the shell
// startup-file variables — so no test here reads or writes the real ~/.claude,
// ~/.ccrecall or :7749. It is one builder rather than per-call literals because
// the first version of this file hand-rolled the env at each call site and the
// second call silently kept the real HOME and BASH_ENV.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const PROJECT_ID = '-tmp-ccrecall-stdin-fixture'
// Carried inside the transcript body, so finding it proves the transcript
// itself travelled — not merely that some prompt-shaped string did.
const SENTINEL = 'CCRECALL-STDIN-SENTINEL-9f3a'
const MESSAGE_COUNT = 40

/**
 * Stub `claude`, first on PATH for both wrapper phases.
 *
 * Reproduces the one behaviour that matters: a per-argument byte cap enforced
 * before the real binary would start. That stands in for both real ceilings —
 * cmux-claude-wrapper's shim and the Linux kernel's MAX_ARG_STRLEN — and makes
 * the cap a parameter, so the test does not depend on which platform CI runs
 * on. Phase 1 (no -p) is the interactive session and just succeeds; phase 2
 * (-p) records the argv and stdin it was handed so the test can assert on both.
 */
const STUB_CLAUDE = `#!/bin/bash
# Phase 1 (no -p) is the interactive session: succeed and record nothing. This
# check comes FIRST so a diagnostic injected below cannot also be emitted during
# phase 1, where it would satisfy an assertion meant to be about extraction.
case " $* " in
  *" -p "*) ;;
  *) exit 0 ;;
esac
# Optional: emit a diagnostic and fail, to exercise what reaches the terminal.
# Always two lines — a one-line diagnostic cannot tell "takes the first line"
# apart from "prints whatever it was handed".
if [ -n "\${STUB_CLAUDE_STDERR_BYTES:-}" ]; then
  awk -v n="\${STUB_CLAUDE_STDERR_BYTES}" -v p="\${STUB_CLAUDE_STDERR_PREFIX:-}" \\
    'BEGIN { s = p; while (length(s) < n) s = s "E"; print substr(s, 1, n);
             print "SECOND-LINE-MUST-NOT-REACH-TERMINAL" }' >&2
  exit 3
fi
limit="\${STUB_CLAUDE_ARG_LIMIT:-122880}"
for a in "$@"; do
  n=$(printf '%s' "$a" | wc -c | tr -d ' ')
  if [ "$n" -gt "$limit" ]; then
    printf 'cmux: argument too large (maximum %s bytes)\\n' "$limit" >&2
    exit 2
  fi
done
# NUL-separated, because an argument may itself contain newlines: a
# newline-separated record cannot tell one huge multiline argument apart from
# many small ones, which is exactly what the size assertion needs to know.
printf '%s\\0' "$@" > "\${STUB_CLAUDE_OUT}/argv.nul"
cat > "\${STUB_CLAUDE_OUT}/stdin.txt"
exit 0
`

/**
 * Stub ccRecall daemon, run as its OWN process.
 *
 * It cannot live in this process: `spawnSync` blocks the event loop for as long
 * as the wrapper runs, so a server sharing this loop would never answer the
 * wrapper's `curl` — and that curl carries no --max-time, so the two would wait
 * on each other forever. The test would hang rather than fail.
 */
const STUB_DAEMON = `
const http = require('http')
const s = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  if (p === '/health') { res.writeHead(200); res.end('ok'); return }
  if (p === '/session/last') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sessionId: ${JSON.stringify(SESSION_ID)}, projectId: ${JSON.stringify(PROJECT_ID)} }))
    return
  }
  res.writeHead(404); res.end()
})
s.listen(0, '127.0.0.1', () => process.stdout.write(s.address().port + '\\n'))
`

const FILLER = 'x'.repeat(400)
const msgUuid = (i: number) => `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`
/** The `.type` the JSONL carries. */
const msgType = (i: number) => (i % 2 === 0 ? 'user' : 'assistant')
/** The label the wrapper's filter emits for it — `user` becomes `human`. */
const msgLabel = (i: number) => (i % 2 === 0 ? 'human' : 'assistant')
const msgText = (i: number) => `${SENTINEL} message ${i} ${FILLER}`

/** A transcript large enough to blow past a small cap, in the shape jq parses. */
function fixtureTranscript(messageCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < messageCount; i++) {
    lines.push(
      JSON.stringify({
        type: msgType(i),
        uuid: msgUuid(i),
        message: { content: [{ type: 'text', text: msgText(i) }] },
      }),
    )
  }
  return lines.join('\n') + '\n'
}

/**
 * What the wrapper's jq filter should turn that fixture into, in full.
 *
 * Derived from the same message data as the fixture, so the two cannot drift;
 * the shape (`--- role [uuid] ---` then the text) mirrors the filter in
 * post-session-extract.sh, and a change to that filter is meant to fail here.
 */
function expectedTranscript(messageCount: number): string {
  const blocks: string[] = []
  for (let i = 0; i < messageCount; i++) {
    blocks.push(`--- ${msgLabel(i)} [${msgUuid(i)}] ---\n${msgText(i)}`)
  }
  return blocks.join('\n')
}

describe('extract wrapper: the prompt travels over stdin, not argv (#120)', () => {
  let daemon: ChildProcess
  let daemonHome: string
  let port: number
  let home: string
  let stubBin: string
  let stubOut: string
  let logPath: string

  beforeAll(async () => {
    // The daemon gets a sanitized environment too: it is a Node process, and an
    // inherited NODE_OPTIONS=--require=… would run a module inside it before the
    // stub server ever listens. Its temp dir is its own, created before `home`.
    daemonHome = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-stdin-daemon-'))
    const daemonEnv: NodeJS.ProcessEnv = { ...process.env, HOME: daemonHome }
    delete daemonEnv.NODE_OPTIONS
    delete daemonEnv.BASH_ENV
    delete daemonEnv.ENV
    for (const k of Object.keys(daemonEnv)) if (k.startsWith('BASH_FUNC_')) delete daemonEnv[k]
    daemon = spawn(process.execPath, ['-e', STUB_DAEMON], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: daemonEnv,
    })
    port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stub daemon did not report a port')), 10_000)
      daemon.stdout!.once('data', (b: Buffer) => {
        clearTimeout(t)
        resolve(Number(b.toString().trim()))
      })
      daemon.once('error', reject)
    })
  })

  afterAll(async () => {
    daemon.kill()
    // Await the exit rather than assuming kill() is synchronous, so the process
    // cannot outlive the suite holding its port.
    await new Promise<void>((resolve) => {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return resolve()
      daemon.once('exit', () => resolve())
      setTimeout(resolve, 5_000).unref?.()
    })
    await rm(daemonHome, { recursive: true, force: true })
  })

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-stdin-'))
    stubBin = path.join(home, 'bin')
    stubOut = path.join(home, 'stub-out')
    logPath = path.join(home, 'extract.log.jsonl')
    await mkdir(stubBin)
    await mkdir(stubOut)

    const stub = path.join(stubBin, 'claude')
    await writeFile(stub, STUB_CLAUDE, 'utf8')
    await chmod(stub, 0o755)

    // The transcript lives where the wrapper looks for it, under the temp HOME.
    const projectDir = path.join(home, '.claude', 'projects', PROJECT_ID)
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${SESSION_ID}.jsonl`),
      fixtureTranscript(MESSAGE_COUNT),
      'utf8',
    )
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /**
   * The one environment every subprocess in this file runs under.
   *
   * Hand-rolling this per call site is how the direct probe below ended up
   * keeping the real HOME and BASH_ENV while claiming isolation — bash would
   * then read the running user's startup files before reaching the stub.
   */
  function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${stubBin}:${process.env.PATH}`,
      CCRECALL_PORT: String(port),
      CCRECALL_EXTRACT_LOG: logPath,
      STUB_CLAUDE_OUT: stubOut,
      ...extra,
    }
    // Per the telemetry-writing isolation rule: a startup file of the running
    // user's must not reach the spawned shell. ANTHROPIC_API_KEY would add
    // --max-budget-usd and make the argv assertions depend on the environment.
    delete env.BASH_ENV
    delete env.ENV
    delete env.ANTHROPIC_API_KEY
    // Two ways inherited state runs code before the stub does, neither covered
    // by the two deletions above: bash imports exported shell FUNCTIONS from
    // the environment, so an inherited BASH_FUNC_claude%% would win over the
    // stub despite it being first on PATH; and NODE_OPTIONS=--require=… preloads
    // a module into the stub daemon.
    delete env.NODE_OPTIONS
    for (const k of Object.keys(env)) if (k.startsWith('BASH_FUNC_')) delete env[k]
    return env
  }

  /**
   * Run the shipped wrapper with everything pointed at the temp environment.
   *
   * `prelude` runs before the wrapper is sourced, so a test can reproduce the
   * caller's shell as it really is — `set -o errexit`, `noclobber`, a `printf`
   * override. The wrapper is sourced into whatever shell the user has.
   *
   * The timeout is not optional: spawnSync blocks this thread, so Vitest cannot
   * run its own timeout or cleanup hooks while it waits. A hung child without
   * this hangs the whole runner with no output at all (observed, 2026-09-16).
   */
  function runExtract(argLimit: number, extra: NodeJS.ProcessEnv = {}, prelude = '') {
    return spawnSync(
      'bash',
      ['-c', `${prelude}\nsource "${WRAPPER}" && ccrecall-extract`],
      {
        encoding: 'utf8',
        env: isolatedEnv({ STUB_CLAUDE_ARG_LIMIT: String(argLimit), ...extra }),
        cwd: home,
        input: '',
        timeout: 60_000,
      },
    )
  }

  /** The argv the stub received, split on the NUL it recorded them with. */
  async function argvArguments(): Promise<string[]> {
    const raw = await readFile(path.join(stubOut, 'argv.nul'), 'utf8')
    return raw.split(' ').slice(0, -1)
  }

  async function telemetryRows(): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(logPath, 'utf8').catch(() => '')
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('harness: the stub enforces its cap and the wrapper reaches extraction', async () => {
    // Everything below rests on the stub being the claude that runs and on the
    // wrapper getting as far as phase 2. If this fails, green means nothing.
    const r = runExtract(4096)
    expect(r.stdout).toContain('extracting memories from session')
    expect(r.stdout).not.toContain('no text transcript')
    const direct = spawnSync('bash', ['-c', `claude -p "$(printf 'y%.0s' {1..5000})"`], {
      encoding: 'utf8',
      env: isolatedEnv({ STUB_CLAUDE_ARG_LIMIT: '4096' }),
      cwd: home,
      input: '',
      timeout: 60_000,
    })
    expect(direct.status).toBe(2)
    expect(direct.stderr).toContain('argument too large')
  })

  it('survives a per-argument cap far below the transcript size', async () => {
    // The #120 regression itself. Under argv this exits 2 in 0 seconds with
    // zero memories extracted; over stdin the cap is never consulted.
    const r = runExtract(4096)
    expect(r.stdout).not.toContain('argument too large')
    expect(r.stdout).toContain('extraction complete')

    const rows = await telemetryRows()
    const run = rows.find((x) => x.mode === 'jsonl')
    expect(run, 'wrapper wrote no extraction row').toBeDefined()
    expect(run!.exitCode).toBe(0)
    expect(String(run!.stderr ?? '')).not.toContain('argument too large')
  })

  it('delivers the whole transcript on stdin', async () => {
    // A cap high enough that argv would also have gone through: this isolates
    // "the prompt arrives over stdin" from "the cap was dodged".
    runExtract(10_000_000)
    const stdin = await readFile(path.join(stubOut, 'stdin.txt'), 'utf8')
    expect(stdin).toContain('Session transcript to analyze')
    expect(stdin).toContain(`Origin session ID: ${SESSION_ID}`)
    // Every message, in order, with its body intact — compared against the whole
    // expected transformation rather than sampled. Spot-checking identifiers
    // stays green for an implementation that drops every other message,
    // truncates bodies, or reorders them.
    expect(stdin).toContain(expectedTranscript(MESSAGE_COUNT))
    // The extraction instructions ride along behind the transcript.
    expect(stdin).toContain('recall_save')
  })

  it('passes no transcript on argv at all', async () => {
    // The failure this test exists for is a half-fix: piping the prompt in
    // while leaving the argv parameter in place keeps the shim's cap live and
    // the bug with it.
    runExtract(10_000_000)
    const args = await argvArguments()
    const joined = args.join(' ')
    expect(joined).not.toContain(SENTINEL)
    expect(joined).not.toContain('Session transcript to analyze')
    // Flags still travel on argv — this is not an assertion that argv is empty.
    expect(args).toContain('-p')
    expect(args).toContain('--model')
    // Measured per ARGUMENT, not per line: the ceiling this whole change exists
    // to stay under is a per-argument one, and an argument may contain newlines.
    const longest = Math.max(...args.map((a) => Buffer.byteLength(a, 'utf8')))
    expect(longest).toBeLessThan(4096)
  })

  it('surfaces the first line of stderr when extraction fails', async () => {
    // The secondary defect in #120: `exited with code 2` with the reason only
    // in the JSONL. Reproduced by capping below the *flags*, which no fix to
    // the prompt channel can avoid, so this stays a live failure path.
    const r = runExtract(4)
    expect(r.stdout).toContain('exited with code 2')
    expect(r.stdout).toContain('argument too large')
  })

  /** The wrapper's failure line, which carries the diagnostic excerpt. */
  function failureLine(stdout: string, code: number): string {
    const line = stdout.split('\n').find((l) => l.includes(`exited with code ${code}`))
    expect(line, `no "exited with code ${code}" line in wrapper output`).toBeDefined()
    return line!
  }

  it('bounds how much of stderr reaches the terminal, to exactly the cap', async () => {
    // Surfacing the reason (above) opened a SECOND sink for claude's stderr:
    // the telemetry log is 0600, terminal scrollback is not, and the scrubber
    // ahead of it is a best-effort denylist of known credential prefixes. So
    // the terminal copy is capped — enough for a real diagnostic
    // ("cmux: argument too large (maximum 122880 bytes)" is 44 characters),
    // far short of dumping whatever a failing MCP server happened to print.
    const r = runExtract(10_000_000, { STUB_CLAUDE_STDERR_BYTES: '5000' })
    const line = failureLine(r.stdout, 3)
    // Exactly 200 diagnostic characters, not merely "shorter than something":
    // a bound that a line carrying NO excerpt at all would also satisfy is not
    // a test of the cap.
    const excerpt = line.slice(line.indexOf('— E'))
    expect(excerpt.replace(/^— /, '').replace(/\.$/, '')).toHaveLength(200)
    // Only the first line: the second must not follow it to the terminal.
    expect(r.stdout).not.toContain('SECOND-LINE-MUST-NOT-REACH-TERMINAL')
    // The log keeps more than the terminal does — but it has its own cap of
    // 2000 bytes (post-session-extract.sh applies `head -c 2000` to the
    // scrubbed capture), so this asserts that documented bound, not "the full
    // 5000 bytes". Claiming the latter is how this assertion first passed while
    // describing something the code never did.
    const rows = await telemetryRows()
    const run = rows.find((x) => x.mode === 'jsonl')
    expect(String(run!.stderr ?? '')).toHaveLength(2000)
  })

  it('prints the first line of a multi-line diagnostic, not an arbitrary one', async () => {
    // Distinct first and second lines: with a single-line diagnostic, removing
    // first-line selection entirely would keep the test green.
    const r = runExtract(10_000_000, {
      STUB_CLAUDE_STDERR_BYTES: '20',
      STUB_CLAUDE_STDERR_PREFIX: 'FIRST-LINE-',
    })
    const line = failureLine(r.stdout, 3)
    expect(line).toContain('FIRST-LINE-')
    expect(line).not.toContain('SECOND-LINE-MUST-NOT-REACH-TERMINAL')
  })

  it('never lets a diagnostic write control characters to the terminal', async () => {
    // %s stops format-string interpretation but not control bytes. An escape
    // sequence in claude's stderr — or in an MCP server's — can overwrite the
    // failure notice, clear the screen, or drive OSC handlers; and truncating
    // at a fixed length can sever a sequence midway, leaving the terminal in
    // whatever state the fragment put it in.
    // Built from char codes: keeping the literals out of this file means the
    // source stays readable in an editor and carries no bytes that a diff, a
    // pager or a terminal would act on by itself.
    const ESC = String.fromCharCode(0x1b)
    const BEL = String.fromCharCode(0x07)
    const CR = String.fromCharCode(0x0d)
    const r = runExtract(10_000_000, {
      STUB_CLAUDE_STDERR_BYTES: '60',
      // Clear-screen, an OSC title-set, and a carriage return to overwrite.
      STUB_CLAUDE_STDERR_PREFIX: `BEFORE${ESC}[2J${ESC}]0;pwned${BEL}${CR}AFTER`,
    })
    const line = failureLine(r.stdout, 3)
    const control = [...line]
      .map((c) => c.charCodeAt(0))
      .filter((code) => code < 0x20 || code === 0x7f)
    expect(control, 'control characters reached the terminal').toEqual([])
    // The readable part still survives — sanitising must not blank the reason.
    expect(line).toContain('BEFORE')
  })

  it('still reports the failure when the caller shell has errexit set', async () => {
    // The wrapper is sourced into the user's shell, so it inherits their
    // options. Under errexit a failing command substitution aborts the shell
    // before `extract_exit=$?`, so the notice this fix added — and the
    // telemetry row — never happen at all.
    const r = runExtract(4, {}, 'set -o errexit')
    expect(r.stdout).toContain('exited with code 2')
    expect(r.stdout).toContain('argument too large')
    const rows = await telemetryRows()
    expect(rows.find((x) => x.mode === 'jsonl'), 'no telemetry row written').toBeDefined()
  })

  it('runs to completion when the caller shell has noclobber set', async () => {
    // `1>"$stdout_tmp"` targets a file mktemp already created, so under
    // noclobber the redirection fails and claude never execs.
    const r = runExtract(10_000_000, {}, 'set -o noclobber')
    expect(r.stdout).toContain('extraction complete')
    const stdin = await readFile(path.join(stubOut, 'stdin.txt'), 'utf8')
    expect(stdin).toContain(SENTINEL)
  })

  it('delivers the real prompt even when the caller has overridden printf', async () => {
    // Same hazard as the rm alias in #99, one command over: the wrapper is
    // sourced into an interactive shell, and a shell function beats a builtin.
    // A hijacked printf silently substitutes the prompt — extraction then
    // succeeds while saving memories drawn from nothing.
    const prelude = [
      'printf() {',
      '  if [[ "$*" == *"Session transcript to analyze"* ]]; then',
      '    builtin printf "HIJACKED-PROMPT"',
      '  else',
      '    builtin printf "$@"',
      '  fi',
      '}',
    ].join('\n')
    runExtract(10_000_000, {}, prelude)
    const stdin = await readFile(path.join(stubOut, 'stdin.txt'), 'utf8')
    expect(stdin).not.toContain('HIJACKED-PROMPT')
    expect(stdin).toContain(SENTINEL)
  })
})
