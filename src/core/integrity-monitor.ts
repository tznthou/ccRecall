// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Database } from './database.js'

/**
 * Periodic PRAGMA integrity_check runner. Surfaces SQLite index / FTS / B-tree
 * drift that write-path bugs can leave behind and which would otherwise stay
 * silent until the next REINDEX. Read-only; safe to run against the live WAL DB.
 *
 * Cache semantics: getLastRecord() returns the most recent tick's timestamp +
 * boolean. Drift details (full PRAGMA output) go to an alert file in alertDir,
 * NOT into the cache — /health is a liveness probe, not a forensic store.
 */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_ALERT_DIR = path.join(os.homedir(), '.ccrecall', 'integrity-alerts')

export interface IntegrityMonitorOptions {
  intervalMs?: number
  alertDir?: string
  /** Clock injection for deterministic tests. */
  clock?: () => Date
}

export interface IntegrityCheckRecord {
  at: string
  ok: boolean
}

export class IntegrityMonitor {
  private readonly db: Database
  private readonly intervalMs: number
  private readonly alertDir: string
  private readonly clock: () => Date
  private timer: NodeJS.Timeout | null = null
  private inflight = false
  private lastRecord: IntegrityCheckRecord | null = null

  constructor(db: Database, opts: IntegrityMonitorOptions = {}) {
    this.db = db
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.alertDir = opts.alertDir ?? DEFAULT_ALERT_DIR
    this.clock = opts.clock ?? (() => new Date())
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  getLastRecord(): IntegrityCheckRecord | null {
    return this.lastRecord
  }

  /** Start the periodic checker. Kicks off an immediate first tick (non-blocking)
   *  so the /health endpoint has a value to report as soon as the HTTP listener
   *  comes up. Timer is unref'd — coordinator.stop() is the clean shutdown path. */
  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run one integrity_check. Single-flight: if a prior tick has not finished,
   *  the new call returns null. The microtask yield before the synchronous
   *  pragma read is load-bearing — concurrent callers must observe inflight=true
   *  before the DB work begins. */
  async tick(): Promise<IntegrityCheckRecord | null> {
    if (this.inflight) return null
    this.inflight = true
    try {
      await Promise.resolve()
      const at = this.clock().toISOString()
      const lines = this.db.integrityCheck()
      const ok = lines.length === 1 && lines[0] === 'ok'
      const record: IntegrityCheckRecord = { at, ok }
      this.lastRecord = record
      if (!ok) {
        const alertPath = this.writeAlertFile(at, lines)
        console.error(
          `[integrity] CRITICAL: PRAGMA integrity_check surfaced ${lines.length} issue(s). ` +
          `Do NOT run REINDEX before capturing a snapshot. See ${alertPath ?? this.alertDir}`,
        )
      }
      return record
    } catch (err) {
      console.warn(
        '[integrity] tick error:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    } finally {
      this.inflight = false
    }
  }

  private writeAlertFile(at: string, lines: string[]): string | null {
    try {
      mkdirSync(this.alertDir, { recursive: true })
      const safeStamp = at.replace(/[:.]/g, '-')
      const file = path.join(this.alertDir, `integrity-check-${safeStamp}.log`)
      const body = [
        '# ccRecall PRAGMA integrity_check alert',
        `# at: ${at}`,
        '# Do NOT run REINDEX before capturing a snapshot:',
        '#   cp ~/.ccrecall/ccrecall.db ~/ccrecall-drift-snapshot.db',
        '',
        ...lines,
        '',
      ].join('\n')
      writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' })
      return file
    } catch (err) {
      console.error(
        '[integrity] alert file write failed:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    }
  }
}
