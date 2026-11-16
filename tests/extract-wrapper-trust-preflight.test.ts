// SPDX-License-Identifier: Apache-2.0
//
// Guards the wrapper's "workspace is not trusted" warning.
//
// The old check looked up only the exact $PWD key in ~/.claude.json. Claude
// Code's trust also covers subdirectories, so a directory under a trusted
// parent never gets its own trust prompt and its own entry stays false for
// good: the warning then fired on every run and told the user to do something
// that could not make it go away. It also fired in directories with no
// .claude/settings.json, where an untrusted workspace loses nothing.
//
// These tests run ccrecall-extract itself, sourced into bash and zsh, and read
// what it printed before launching the session. HOME is a temp dir holding a
// fake ~/.claude.json, `claude` is a stub, and CCRECALL_SKIP_EXTRACT=1 stops
// the wrapper right after the session, so nothing reaches a daemon or the real
// ~/.claude.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, chmod, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')
const WARNING = 'this workspace is not trusted'

const HAS_ZSH = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])]

describe('extract wrapper: trust pre-flight warning', () => {
  let home: string
  let stubBin: string
  /** The workspace the wrapper runs in: <home>/work/parent/child. */
  let parent: string
  let child: string

  beforeEach(async () => {
    // realpath: on macOS os.tmpdir() sits behind the /var -> /private/var
    // symlink, and the wrapper sees the resolved $PWD.
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ccrecall-trust-')))
    stubBin = path.join(home, 'bin')
    await mkdir(stubBin)
    const stub = path.join(stubBin, 'claude')
    await writeFile(stub, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(stub, 0o755)
    parent = path.join(home, 'work', 'parent')
    child = path.join(parent, 'child')
    await mkdir(child, { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function withSettings(dir: string): Promise<void> {
    await mkdir(path.join(dir, '.claude'), { recursive: true })
    await writeFile(path.join(dir, '.claude', 'settings.json'), '{}\n', 'utf8')
  }

  async function trust(entries: Record<string, boolean>): Promise<void> {
    const projects = Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, { hasTrustDialogAccepted: v }]),
    )
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ projects }), 'utf8')
  }

  function env(): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ZDOTDIR: home,
      PATH: `${stubBin}:${process.env.PATH}`,
      CCRECALL_SKIP_EXTRACT: '1',
      CCRECALL_EXTRACT_LOG: path.join(home, 'extract.log.jsonl'),
    }
    delete e.CCRECALL_PERMISSION_MODE
    delete e.BASH_ENV
    delete e.ENV
    delete e.NODE_OPTIONS
    for (const k of Object.keys(e)) if (k.startsWith('BASH_FUNC_')) delete e[k]
    return e
  }

  /** stdout+stderr of `ccrecall-extract` run in `cwd`. Timeout: spawnSync blocks vitest's timers. */
  function run(shell: string, cwd: string): string {
    const flags = shell === 'zsh' ? ['-f', '-c'] : ['-c']
    const r = spawnSync(shell, [...flags, `source "${WRAPPER}" && ccrecall-extract`], {
      encoding: 'utf8',
      env: env(),
      cwd,
      input: '',
      timeout: 30_000,
    })
    expect(r.status, `wrapper failed: ${r.stderr}`).toBe(0)
    return `${r.stdout}${r.stderr}`
  }

  describe.each(SHELLS)('sourced into %s', (shell) => {
    it('warns when the workspace has settings and nothing up the tree is trusted', async () => {
      // The positive case: without it every "does not warn" below could pass
      // because the check never runs at all.
      await withSettings(child)
      await trust({ [child]: false, [parent]: false })
      expect(run(shell, child)).toContain(WARNING)
    })

    it('warns when the workspace has no entry of its own and no trusted parent', async () => {
      await withSettings(child)
      await trust({ [parent]: false })
      expect(run(shell, child)).toContain(WARNING)
    })

    it('does not warn when the workspace itself is trusted', async () => {
      await withSettings(child)
      await trust({ [child]: true })
      expect(run(shell, child)).not.toContain(WARNING)
    })

    it('does not warn when a parent is trusted, even though its own entry says false', async () => {
      // The 2026-11-15 case: ~/Documents trusted, ~/Documents/zero stuck at false.
      await withSettings(child)
      await trust({ [parent]: true, [child]: false })
      expect(run(shell, child)).not.toContain(WARNING)
    })

    it('does not warn when a parent further up is trusted', async () => {
      await withSettings(child)
      await trust({ [home]: true, [parent]: false, [child]: false })
      expect(run(shell, child)).not.toContain(WARNING)
    })

    it('does not treat a sibling with a shared prefix as a parent', async () => {
      // "/x/parent-other" must not count as an ancestor of "/x/parent/child".
      await withSettings(child)
      await trust({ [`${parent}-other`]: true, [child]: false })
      expect(run(shell, child)).toContain(WARNING)
    })

    it('does not warn when the workspace has no .claude/settings.json', async () => {
      await trust({ [child]: false, [parent]: false })
      expect(run(shell, child)).not.toContain(WARNING)
    })

    it('does not warn when ~/.claude.json is missing or unreadable', async () => {
      await withSettings(child)
      expect(run(shell, child)).not.toContain(WARNING)
      await writeFile(path.join(home, '.claude.json'), '{not json', 'utf8')
      expect(run(shell, child)).not.toContain(WARNING)
    })
  })
})
