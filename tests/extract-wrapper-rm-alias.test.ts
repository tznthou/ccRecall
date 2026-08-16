// SPDX-License-Identifier: Apache-2.0
//
// Guards the stdout-capture deletion in the post-session-extract wrapper
// against interactive-shell alias interception (#99).
//
// Background: the wrapper is sourced into the user's interactive shell from
// .zshrc, so every bare command in it runs under the user's aliases. A
// trash-style `alias rm` that rejects `--` (the end-of-options marker) made
// all three deletion sites fail with exit 1 from #66 (2026-07-18) until #99 —
// silently, because `2>/dev/null` swallows the only error, nothing checks the
// return value, and the 60-minute `find -delete` sweep (a find builtin,
// immune to aliases) kept captures from ever piling up.
//
// A conventional harness cannot catch a regression here: aliases exist only
// in interactive shells that read .zshrc, and CI's non-interactive shells get
// the literal `rm` and pass. So these tests rebuild the hostile environment
// deliberately — a real `zsh -i` whose isolated ZDOTDIR/.zshrc defines an rm
// alias that NEVER deletes — and assert on the files themselves. Under that
// alias, "the capture is gone" can only mean the wrapper bypassed it.
//
// The two expansion paths need separate proof (verified against the shell,
// not reasoned about):
//   - main path: the alias expands at PARSE time, when the line is sourced —
//     reproduced by sourcing the live line into an interactive shell, and
//     visible statically via `declare -f`;
//   - trap paths: the single-quoted trap body survives sourcing unexpanded
//     and the alias expands when the trap FIRES — only a real INT/TERM can
//     exercise that path.
// Every line under test is extracted from the wrapper source rather than
// duplicated here, so the test cannot drift from what ships (same policy as
// extract-wrapper-marker.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')

const HAS_ZSH = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

/** The main-path deletion line, exactly as shipped. */
function extractMainRmLine(src: string): string {
  const m = src.match(/^\s*((?:command )?rm -f -- "\$stdout_tmp" 2>\/dev\/null)\s*$/m)
  if (!m) throw new Error('main-path rm line not found in wrapper')
  return m[1]
}

/** A full trap line (INT exits 130, TERM 143), exactly as shipped. */
function extractTrapLine(src: string, sig: 'INT' | 'TERM'): string {
  const exit = sig === 'INT' ? 130 : 143
  const re = new RegExp(
    `^\\s*(trap '(?:command )?rm -f -- "\\$stdout_tmp" 2>/dev/null; exit ${exit}' ${sig})\\s*$`,
    'm',
  )
  const m = src.match(re)
  if (!m) throw new Error(`${sig} trap line not found in wrapper`)
  return m[1]
}

describe.skipIf(!HAS_ZSH)('extract wrapper: deletion survives a hostile rm alias (#99)', () => {
  let home: string
  let bin: string
  let src: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-rm-alias-'))
    bin = path.join(home, 'bin')
    await mkdir(bin)
    // Trash-style stand-in for the real-world wrapper that broke the deletion:
    // rejects `--` with exit 1 and — deliberately stricter than the original —
    // never deletes anything, so a missing file is unambiguous proof the
    // wrapper reached the real rm.
    const hostile = path.join(bin, 'hostile-rm')
    await writeFile(
      hostile,
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "--" ] && exit 1; done\nexit 0\n',
      'utf8',
    )
    await chmod(hostile, 0o755)
    // The alias lives in the isolated ZDOTDIR's .zshrc, exactly where the real
    // one does. PATH still resolves `rm` to the genuine binary — the hazard is
    // the alias, and only an interactive shell reads this file.
    await writeFile(path.join(home, '.zshrc'), "alias rm='hostile-rm'\n", 'utf8')
    src = await readFile(WRAPPER, 'utf8')
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /**
   * Run a script in an interactive zsh with the hostile alias in scope.
   * HOME/ZDOTDIR point at the isolated directory and BASH_ENV/ENV are cut,
   * per the telemetry-writing test-isolation rule; `input: ''` keeps -i from
   * waiting on a terminal.
   */
  function runInteractiveZsh(script: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ZDOTDIR: home,
      PATH: `${bin}:${process.env.PATH}`,
      CCRECALL_EXTRACT_LOG: path.join(home, 'extract.log.jsonl'),
      ...extraEnv,
    }
    delete env.BASH_ENV
    delete env.ENV
    return spawnSync('zsh', ['-i', '-c', script], { encoding: 'utf8', env, input: '' })
  }

  it('harness: the hostile alias is in scope in the spawned shell', () => {
    // Every other assertion rests on `zsh -i -c` reading the isolated .zshrc.
    // If this fails, the environment is not hostile and green means nothing.
    const r = runInteractiveZsh('type rm')
    expect(r.stdout).toContain('hostile-rm')
  })

  it('main path: sourcing under the alias leaves the function calling command rm (parse-time)', () => {
    // The bug's mechanism: aliases expand while the function body is parsed,
    // baking the wrapper's alias target into the sourced function. declare -f
    // shows what the shell actually stored — no regex approximation of shell
    // semantics, the shell is the parser.
    const r = runInteractiveZsh(`source "${WRAPPER}" && declare -f ccrecall-extract`)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/command rm -f -- "\$stdout_tmp"/)
    expect(r.stdout).not.toContain('hostile-rm')
  })

  it('main path: the shipped deletion line removes the capture under the alias', async () => {
    const capture = path.join(home, 'extract-stdout.test')
    await writeFile(capture, 'raw model stdout\n', 'utf8')
    const snippet = path.join(home, 'main-path.zsh')
    await writeFile(snippet, extractMainRmLine(src) + '\n', 'utf8')
    // Sourcing the snippet re-creates the shipped parse context: the line is
    // read into an interactive shell with the alias in scope, exactly like
    // the wrapper itself from .zshrc.
    runInteractiveZsh(`source "${snippet}"`, { stdout_tmp: capture })
    expect(await exists(capture)).toBe(false)
  })

  for (const [sig, code] of [
    ['INT', 130],
    ['TERM', 143],
  ] as const) {
    it(`trap path: a real ${sig} deletes the capture and exits ${code} (fire-time)`, async () => {
      // The trap body is single-quoted, so it survives sourcing unexpanded;
      // the alias expands when the trap fires. Only delivering the signal
      // exercises that — declare -f cannot see this path.
      const capture = path.join(home, `extract-stdout.${sig.toLowerCase()}`)
      await writeFile(capture, 'raw model stdout\n', 'utf8')
      const snippet = path.join(home, `trap-${sig.toLowerCase()}.zsh`)
      await writeFile(snippet, `${extractTrapLine(src, sig)}\nkill -s ${sig} $$\n`, 'utf8')
      const r = runInteractiveZsh(`source "${snippet}"`, { stdout_tmp: capture })
      expect(r.status).toBe(code)
      expect(await exists(capture)).toBe(false)
    })
  }
})
