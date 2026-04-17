#!/usr/bin/env node
import path from 'node:path'
import os from 'node:os'
import { createServer } from './api/server.js'
import { Database } from './core/database.js'
import { runIndexer } from './core/indexer.js'
import { MemoryService } from './core/memory-service.js'
import { MaintenanceCoordinator } from './core/maintenance-coordinator.js'
import { JsonlWatcher } from './core/watcher.js'
import { installDaemon, uninstallDaemon } from './cli/daemon.js'

const subcommand = process.argv[2]

if (subcommand === 'install-daemon' || subcommand === 'uninstall-daemon') {
  const dryRun = process.argv.includes('--dry-run')
  const action = subcommand === 'install-daemon'
    ? () => installDaemon({ dryRun })
    : () => uninstallDaemon()
  action().then(() => process.exit(0)).catch((err: Error) => {
    console.error(`[ccrecall ${subcommand}] ${err.message}`)
    process.exit(1)
  })
} else if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  printHelp()
  process.exit(0)
} else {
  startDaemon()
}

function printHelp(): void {
  const port = process.env.CCRECALL_PORT ?? '7749'
  console.log(`ccRecall — AI memory service for Claude Code

Usage:
  ccrecall                            Run the daemon (HTTP API on :${port})
  ccrecall install-daemon             Install macOS LaunchAgent for auto-start
  ccrecall install-daemon --dry-run   Print plist without installing
  ccrecall uninstall-daemon           Remove LaunchAgent and stop auto-start

Environment:
  CCRECALL_PORT                       HTTP port (default: 7749)
  CCRECALL_DB_PATH                    SQLite path (default: ~/.ccrecall/ccrecall.db)

See docs/launchd.md for manual install and troubleshooting.`)
}

function startDaemon(): void {
  const PORT = parseInt(process.env.CCRECALL_PORT ?? '7749', 10)
  const DB_PATH = process.env.CCRECALL_DB_PATH ?? path.join(os.homedir(), '.ccrecall', 'ccrecall.db')

  const db = new Database(DB_PATH)
  console.log(`Database initialized at ${DB_PATH}`)

  console.log('Running indexer...')
  runIndexer(db).then(() => {
    console.log('Indexer complete.')
  }).catch((err) => {
    console.error('Indexer error:', err)
  })

  // Phase 4d: start background compression scheduler. unref'd so it never blocks
  // process exit — HTTP server keep-alive is authoritative.
  const memoryService = new MemoryService(db)
  const coordinator = new MaintenanceCoordinator(db, memoryService)
  coordinator.start()
  console.log('Maintenance coordinator started.')

  // Phase 4e: JSONL watch mode — incremental reindex when Claude Code writes new
  // session files. Complements the hook path; covers resumed sessions too.
  const watcher = new JsonlWatcher(db)
  watcher.start().then(() => {
    console.log('JSONL watcher started.')
  }).catch((err) => {
    console.error('Watcher start error:', err)
  })

  // Rescue reindex uses runIndexer directly (not watcher.runNow) so /session/end
  // gets deterministic execution instead of being dropped by watcher's single-
  // flight guard when a scheduled scan is already inflight.
  const server = createServer(db, {
    rescueReindex: () => runIndexer(db),
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`ccRecall listening on http://127.0.0.1:${PORT}`)
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\nReceived ${signal}, shutting down...`)
      coordinator.stop()
      watcher.stop().catch(() => { /* swallow shutdown errors */ })
      db.close()
      server.close(() => process.exit(0))
    })
  }
}
