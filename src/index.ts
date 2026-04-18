#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from './api/server.js'
import { Database } from './core/database.js'
import { runIndexer } from './core/indexer.js'
import { MemoryService } from './core/memory-service.js'
import { MaintenanceCoordinator } from './core/maintenance-coordinator.js'
import { JsonlWatcher } from './core/watcher.js'
import { installDaemon, uninstallDaemon } from './cli/daemon.js'
import { installHooks, uninstallHooks } from './cli/hooks-installer.js'

/** Read the package.json version shipped next to this bundle. Works across
 *  layouts: src/index.ts (tsx) → ../package.json, dist/index.js → ../package.json,
 *  node_modules/@tznthou/ccrecall/dist/index.js → ../package.json. If the file
 *  is missing or unreadable (shouldn't happen in a published install), fall
 *  back to 'unknown' rather than crashing the daemon. */
function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const subcommand = process.argv[2]

if (subcommand === 'install-daemon' || subcommand === 'uninstall-daemon') {
  const dryRun = process.argv.includes('--dry-run')
  // Propagate the current daemon's runtime config into the plist so the
  // auto-started instance uses the same port/db as the user's interactive
  // session. Without this the LaunchAgent silently resets to defaults after
  // the next login, which looks like memory loss or a port mismatch.
  const envPort = process.env.CCRECALL_PORT
  const parsedPort = envPort ? parseInt(envPort, 10) : NaN
  // Cap at 65535 so a typo like CCRECALL_PORT=70000 doesn't get baked into
  // the plist and crash-loop launchd (ERR_SOCKET_BAD_PORT on every restart).
  const port = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : undefined
  const dbPath = process.env.CCRECALL_DB_PATH
  const action = subcommand === 'install-daemon'
    ? () => installDaemon({ dryRun, port, dbPath })
    : () => uninstallDaemon()
  action().then(() => process.exit(0)).catch((err: Error) => {
    console.error(`[ccmem ${subcommand}] ${err.message}`)
    process.exit(1)
  })
} else if (subcommand === 'install-hooks' || subcommand === 'uninstall-hooks') {
  const dryRun = process.argv.includes('--dry-run')
  const action = subcommand === 'install-hooks'
    ? () => installHooks({ dryRun })
    : () => uninstallHooks({ dryRun })
  action().then(() => process.exit(0)).catch((err: Error) => {
    console.error(`[ccmem ${subcommand}] ${err.message}`)
    process.exit(1)
  })
} else if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  printHelp()
  process.exit(0)
} else if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
  console.log(readPackageVersion())
  process.exit(0)
} else {
  startDaemon().catch((err: Error) => {
    console.error(`[ccmem] fatal: ${err.message}`)
    process.exit(1)
  })
}

function printHelp(): void {
  const port = process.env.CCRECALL_PORT ?? '7749'
  console.log(`ccRecall — AI memory service for Claude Code

Usage:
  ccmem                            Run the daemon (HTTP API on :${port})
  ccmem install-daemon             Install macOS LaunchAgent for auto-start
  ccmem install-daemon --dry-run   Print plist without installing
  ccmem uninstall-daemon           Remove LaunchAgent and stop auto-start
  ccmem install-hooks              Register SessionStart/SessionEnd hooks in ~/.claude/settings.json
  ccmem install-hooks --dry-run    Print merged settings.json without writing
  ccmem uninstall-hooks            Remove ccRecall hook entries from ~/.claude/settings.json
  ccmem --version                  Print the installed package version

Environment:
  CCRECALL_PORT                    HTTP port (default: 7749)
  CCRECALL_DB_PATH                 SQLite path (default: ~/.ccrecall/ccrecall.db)

See docs/launchd.md for manual install and troubleshooting.`)
}

async function startDaemon(): Promise<void> {
  const rawPort = parseInt(process.env.CCRECALL_PORT ?? '7749', 10)
  const PORT = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 7749
  const DB_PATH = process.env.CCRECALL_DB_PATH ?? path.join(os.homedir(), '.ccrecall', 'ccrecall.db')

  const db = new Database(DB_PATH)
  console.log(`Database initialized at ${DB_PATH}`)

  // Await the initial index so the watcher (which uses ignoreInitial=true)
  // doesn't start before scanProjects has observed the tree. A JSONL written
  // between these two phases would otherwise be invisible until the 10-minute
  // backstop or a /session/end rescue.
  console.log('Running indexer...')
  try {
    await runIndexer(db)
    console.log('Indexer complete.')
  } catch (err) {
    console.error('Indexer error:', err)
  }

  // Phase 4d: start background compression scheduler. unref'd so it never blocks
  // process exit — HTTP server keep-alive is authoritative.
  const memoryService = new MemoryService(db)
  const coordinator = new MaintenanceCoordinator(db, memoryService)
  coordinator.start()
  console.log('Maintenance coordinator started.')

  // Phase 4e: JSONL watch mode — incremental reindex when Claude Code writes new
  // session files. Complements the hook path; covers resumed sessions too.
  // start() resolves only after chokidar's `ready` event, so ignoreInitial
  // has settled before we advertise the service.
  const watcher = new JsonlWatcher(db)
  try {
    await watcher.start()
    console.log('JSONL watcher started.')
  } catch (err) {
    console.error('Watcher start error:', err)
  }

  // Rescue reindex uses runIndexer directly (not watcher.runNow) so /session/end
  // gets deterministic execution instead of being dropped by watcher's single-
  // flight guard when a scheduled scan is already inflight.
  const server = createServer(db, {
    rescueReindex: () => runIndexer(db),
    version: readPackageVersion(),
    dbPath: DB_PATH,
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
