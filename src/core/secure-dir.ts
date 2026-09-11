// SPDX-License-Identifier: Apache-2.0
//
// #95: ~/.ccrecall holds the database — every memory, every session title — and
// telemetry whose rows carry `cwd`: the account name and every project name
// worked on. Four call sites create that directory; whichever ran first decided
// its mode, and three of them passed none. On a `umask 022` machine that is
// 0755, and under the `umask 002` that several distributions default to, 0775 —
// a directory another local user can write into.
//
// ⚠️ There is a second copy of this logic in hooks/lib/secure-dir.mjs. The hooks
// ship as standalone .mjs installed via npm and are never bundled through the
// TypeScript build, so they cannot import this file. The two are kept in step
// by tests/ccrecall-dir-permissions.test.ts, which imports both and asserts
// they agree — the same arrangement src/core/project-id.ts has with
// hooks/lib/project-id.mjs.
import { mkdirSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CCRECALL_DIR_MODE = 0o700
export const CCRECALL_FILE_MODE = 0o600

/** Resolved per call, never at module load: tests move $HOME, and a value
 *  frozen at import time would answer "is this ours?" about the real home
 *  directory no matter where the caller was pointed. */
function isOurs(dir: string): boolean {
  const root = path.join(os.homedir(), '.ccrecall')
  const resolved = path.resolve(dir)
  return resolved === root || resolved.startsWith(root + path.sep)
}

/** Create a ccRecall directory 0700, and repair one we already own. */
export function ensureCcrecallDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: CCRECALL_DIR_MODE })
  // mkdirSync leaves an existing directory's mode alone, so without this every
  // install predating the fix keeps whatever its first creator gave it. The
  // repair is limited to a path we know is ours because PR #94 did it to a
  // configurable one: with a relative CCRECALL_EXTRACT_LOG the parent is the
  // working directory, and a user's project directory went 0755 -> 0700 in
  // testing. That attempt was reverted twice. A creator may choose the mode of
  // a directory it makes; it may not re-mode a directory that was already
  // there and belongs to someone else.
  if (isOurs(dir)) {
    try {
      chmodSync(dir, CCRECALL_DIR_MODE)
    } catch {
      // Raced away, or owned by another user. Nothing safe left to do, and the
      // caller's real work must not fail over a mode.
    }
  }
}

/** Hold a ccRecall file at 0600, whoever chose its location. */
export function secureCcrecallFile(file: string): void {
  // Unconditional, unlike the directory above: a user-chosen *location* does
  // not make the file someone else's — ccRecall wrote it either way. This is
  // what the shell wrapper has done since #94, and it is what repairs the logs
  // that are already 0644 on existing installs, since `mode` on appendFileSync
  // only applies when the file is created.
  try {
    chmodSync(file, CCRECALL_FILE_MODE)
  } catch {
    // Not there yet, or not ours. Telemetry must never break a caller.
  }
}
