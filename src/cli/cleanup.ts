// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline/promises'
import { Database } from '../core/database.js'
import { runIndexer } from '../core/indexer.js'

export interface CleanupOptions {
  /** Actually delete. Without this, only report the orphan list. */
  yes: boolean
  /** Skip the pre-flight `runIndexer` reconciliation pass. Default false —
   *  reconcile first so that a stale DB (e.g. Claude Code just restarted) is
   *  not mis-classified as full of orphans. Exposed for tests; not wired to
   *  a CLI flag. */
  skipReconcile?: boolean
  /** Abort interactive confirmation — for tests. Default false. */
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
  if (!opts.skipReconcile) {
    console.log('Reconciling indexer before scanning for orphans...')
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
  for (const o of orphans) {
    const preview = (o.preview ?? '').replace(/\s+/g, ' ').trim()
    console.log(`  #${o.id} (session: ${o.session_id}) — ${preview}`)
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
 *  and closes. The daemon must be stopped or the SQLite busy_timeout will kick
 *  in; we do not enforce stop-first because `ccmem cleanup` is usually run
 *  alongside a live daemon for a quick read-only diagnostic (dry-run path). */
export async function runCleanupCli(args: string[]): Promise<number> {
  const isOrphans = args.includes('--orphans')
  if (!isOrphans) {
    console.error('Usage: ccmem cleanup --orphans [--yes]')
    return 1
  }
  const yes = args.includes('--yes')
  const dbPath = process.env.CCRECALL_DB_PATH ?? path.join(os.homedir(), '.ccrecall', 'ccrecall.db')
  const db = new Database(dbPath)
  try {
    await cleanupOrphans(db, { yes })
    return 0
  } finally {
    db.close()
  }
}
