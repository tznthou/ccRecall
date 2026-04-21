// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline/promises'
import { Database } from '../core/database.js'
import { runIndexer } from '../core/indexer.js'

export interface CleanupOptions {
  /** Actually delete. Without this, only report the orphan list. */
  yes: boolean
  /** Run `runIndexer` before scanning for orphans. Default false because
   *  reconcile is a write path (archives stale sessions, rewrites session
   *  rows, updates project stats, rewrites message_uuids) and will contend
   *  with a live daemon over the SQLite writer — so dry-run without this
   *  flag is a pure SELECT. Opt in with `--reconcile` after stopping the
   *  daemon when the DB is known-stale. */
  reconcile?: boolean
  /** Bypass interactive confirmation — for tests. Default false. */
  assumeConfirmed?: boolean
}

interface OrphanRow {
  id: number
  session_id: string
  preview: string | null
}

/** Find memories whose session_id points at a session row that no longer exists
 *  (typically: test-fixture leftovers, manual `DELETE FROM sessions`, partial
 *  index races). Run reconcile first so we do not delete memories whose session
 *  is about to come back via the normal indexer path. */
export async function cleanupOrphans(db: Database, opts: CleanupOptions): Promise<number> {
  if (opts.reconcile) {
    // reconcile writes regardless of `--yes`; warning must fire for dry-run
    // reconcile too, otherwise the user thinks they picked a safe path.
    console.log('Reconciling indexer before scanning (writes to sessions / message_uuids / project stats)...')
    console.log('⚠  Stop the ccRecall daemon first — concurrent writers will contend on the SQLite writer.')
    await runIndexer(db)
  }

  const orphans = db.rawAll<OrphanRow>(`
    SELECT m.id, m.session_id, substr(m.content, 1, 80) AS preview
    FROM memories m
    LEFT JOIN sessions s ON s.id = m.session_id
    WHERE m.session_id IS NOT NULL AND s.id IS NULL
    ORDER BY m.id
  `)

  if (orphans.length === 0) {
    console.log('No orphan memories found.')
    return 0
  }

  const noun = orphans.length === 1 ? 'memory' : 'memories'
  console.log(`Found ${orphans.length} orphan ${noun}:`)
  // session_id / preview come from JSONL content under ~/.claude/, which an
  // attacker could in principle plant with ANSI escapes (\x1b[2J, \r, …) to
  // spoof the terminal and hide rows before the confirm prompt. Strip
  // C0/DEL control bytes on the way out — cheap defence, local-only blast
  // radius but high AI-generated-code log-injection rate (88%).
  const sanitize = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, '?')
  for (const o of orphans) {
    const preview = sanitize((o.preview ?? '').replace(/\s+/g, ' ').trim())
    console.log(`  #${o.id} (session: ${sanitize(o.session_id)}) — ${preview}`)
  }

  if (!opts.yes) {
    console.log(`\nDry run — no deletion. Re-run with --yes to delete.`)
    return 0
  }

  if (!opts.assumeConfirmed) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nAbout to DELETE ${orphans.length} ${noun}. Type "yes" to confirm: `)
    rl.close()
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.')
      return 0
    }
  }

  const ids = orphans.map(o => Number(o.id)).filter(Number.isInteger)
  db.runTransaction(() => {
    db.rawExec(`DELETE FROM memories WHERE id IN (${ids.join(',')})`)
  })
  console.log(`Deleted ${orphans.length} ${noun}.`)
  return orphans.length
}

/** CLI entry point — opens DB at $CCRECALL_DB_PATH (or default), runs cleanup,
 *  and closes. Default dry-run is a pure SELECT that coexists with a live
 *  daemon. `--yes` and `--reconcile` both write; users are expected to stop
 *  the daemon before those paths. */
export async function runCleanupCli(args: string[]): Promise<number> {
  const isOrphans = args.includes('--orphans')
  if (!isOrphans) {
    console.error('Usage: ccmem cleanup --orphans [--yes] [--reconcile]')
    return 1
  }
  const yes = args.includes('--yes')
  const reconcile = args.includes('--reconcile')
  const dbPath = process.env.CCRECALL_DB_PATH ?? path.join(os.homedir(), '.ccrecall', 'ccrecall.db')
  const db = new Database(dbPath)
  try {
    await cleanupOrphans(db, { yes, reconcile })
    return 0
  } finally {
    db.close()
  }
}
