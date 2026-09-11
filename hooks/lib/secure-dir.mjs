// SPDX-License-Identifier: Apache-2.0
//
// #95: mode for the directory and files under ~/.ccrecall.
//
// ⚠️ Deliberately a second copy of src/core/secure-dir.ts. The hooks ship as
// standalone .mjs installed via npm and are never bundled through the
// TypeScript build, so importing the compiled module is not an option — the
// same reason hooks/lib/project-id.mjs exists beside src/core/project-id.ts.
// tests/ccrecall-dir-permissions.test.ts imports both and asserts they agree,
// which is what keeps them from drifting apart.
import { mkdirSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CCRECALL_DIR_MODE = 0o700
export const CCRECALL_FILE_MODE = 0o600

/** Resolved per call, never at module load: tests move $HOME, and a frozen
 *  value would answer about the real home directory instead. */
function isOurs(dir) {
  const root = path.join(os.homedir(), '.ccrecall')
  const resolved = path.resolve(dir)
  return resolved === root || resolved.startsWith(root + path.sep)
}

/** Create a ccRecall directory 0700, and repair one we already own. */
export function ensureCcrecallDir(dir) {
  mkdirSync(dir, { recursive: true, mode: CCRECALL_DIR_MODE })
  // Existing directories keep their mode through mkdirSync, so the repair is
  // what reaches installs that predate this. Limited to paths we own: PR #94
  // re-moded a user's project directory by doing this to a configurable path
  // and was reverted twice.
  if (isOurs(dir)) {
    try {
      chmodSync(dir, CCRECALL_DIR_MODE)
    } catch {
      // Raced away or owned by another user; a mode must never fail the hook.
    }
  }
}

/** Hold a ccRecall file at 0600, whoever chose its location. */
export function secureCcrecallFile(file) {
  // Unconditional: a user-chosen location does not make the file someone
  // else's. Also the only thing that repairs a log already at 0644, since the
  // `mode` option applies solely when a file is created.
  try {
    chmodSync(file, CCRECALL_FILE_MODE)
  } catch {
    // Not there yet, or not ours.
  }
}
