// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import os from 'node:os'
import type { Stats } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Database } from './database.js'
import { runIndexer } from './indexer.js'
import { scrubErrorMessage } from './log-safe.js'

/**
 * Phase 4e: JSONL watch mode.
 *
 * Watches ~/.claude/projects for JSONL changes so fresh-session harvests don't
 * race the SessionEnd hook (the JSONL may not exist when hook fires; chokidar
 * add event triggers an incremental reindex so /session/end finds the row on
 * retry). Single-flight — at most one runIndexer inflight; events arriving
 * during a scan mark dirty, triggering one follow-up scan after completion.
 * Periodic full-resync backstop covers events chokidar might miss on some
 * platforms (APFS rename edge cases, NFS, etc).
 */

const DEFAULT_BASE_DIR = path.join(os.homedir(), '.claude', 'projects')
const DEFAULT_DEBOUNCE_MS = 2000
const DEFAULT_FULL_RESYNC_MS = 10 * 60 * 1000

export type RunIndexerFn = (db: Database) => Promise<void>

export interface JsonlWatcherOptions {
  baseDir?: string
  debounceMs?: number
  fullResyncMs?: number
  runIndexer?: RunIndexerFn
}

function isJsonlFileOrDir(p: string, stats?: Stats): boolean {
  // chokidar 5 ignored() returns true to skip. Keep dirs (need recursion) and
  // .jsonl files; drop everything else. stats is undefined during directory
  // enumeration of an entry we haven't stat'd yet — treat as "keep" and let
  // the recursive walk re-check with stats.
  if (!stats) return false
  if (stats.isDirectory()) return false
  return !p.endsWith('.jsonl')
}

export class JsonlWatcher {
  private readonly db: Database
  private readonly baseDir: string
  private readonly debounceMs: number
  private readonly fullResyncMs: number
  private readonly runIndexerFn: RunIndexerFn

  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private fullResyncTimer: NodeJS.Timeout | null = null
  private inflight = false
  private dirty = false

  constructor(db: Database, opts: JsonlWatcherOptions = {}) {
    this.db = db
    this.baseDir = opts.baseDir ?? DEFAULT_BASE_DIR
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.fullResyncMs = opts.fullResyncMs ?? DEFAULT_FULL_RESYNC_MS
    this.runIndexerFn = opts.runIndexer ?? runIndexer
  }

  isRunning(): boolean {
    return this.watcher !== null
  }

  async start(): Promise<void> {
    if (this.watcher) return

    const watcher = chokidar.watch(this.baseDir, {
      persistent: true,
      // runIndexer ran before watcher.start() — skip the add spam from the
      // initial tree walk.
      ignoreInitial: true,
      ignored: isJsonlFileOrDir,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    })

    const onEvent = (): void => { this.scheduleIncrementalScan() }
    watcher.on('add', onEvent)
    watcher.on('change', onEvent)
    watcher.on('unlink', onEvent)
    watcher.on('error', (err) => {
      console.warn('[watcher] chokidar error:', scrubErrorMessage(err))
    })

    // Await ready so callers (daemon bootstrap) can be sure ignoreInitial has
    // settled before advertising the service. Without this, a JSONL written
    // between scanProjects() and chokidar's ready event would be missed by
    // both paths until the backstop or a rescue fires.
    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve())
    })

    this.watcher = watcher

    this.fullResyncTimer = setInterval(() => {
      // Bypass scheduleIncrementalScan so steady JSONL churn cannot keep
      // pushing the debounce out and starve the backstop. runScan's single-
      // flight guard still prevents overlapping work.
      void this.runScan()
    }, this.fullResyncMs)
    this.fullResyncTimer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.fullResyncTimer) {
      clearInterval(this.fullResyncTimer)
      this.fullResyncTimer = null
    }
    if (this.watcher) {
      const w = this.watcher
      this.watcher = null
      await w.close()
    }
  }

  private scheduleIncrementalScan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.runScan()
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  private async runScan(): Promise<void> {
    if (this.inflight) {
      this.dirty = true
      return
    }
    this.inflight = true
    this.dirty = false
    try {
      await this.runIndexerFn(this.db)
    } catch (err) {
      console.warn('[watcher] incremental scan error:', scrubErrorMessage(err))
    } finally {
      this.inflight = false
      if (this.dirty) {
        // Events that arrived during the inflight scan bumped dirty; kick the
        // debounce again so the follow-up scan sees them.
        this.scheduleIncrementalScan()
      }
    }
  }

  /** Trigger a scan immediately, bypassing debounce. Intended for /session/end
   *  rescue and integration tests. */
  async runNow(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    await this.runScan()
  }
}
