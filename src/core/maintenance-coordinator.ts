import type { Database } from './database.js'
import type { MemoryService } from './memory-service.js'
import { CompressionPipeline, type CompressionStats } from './compression.js'

/**
 * Phase 4d: background maintenance orchestrator.
 *
 * Runs the compression pipeline on a timer so memories age and compress without
 * blocking MCP queries. Uses a single-flight guard — if a previous tick has
 * not finished (slow I/O, long batch, or nested manual call during a scheduled
 * fire), the new tick is dropped rather than queued. That keeps WAL writer
 * contention bounded even when intervalMs is tuned aggressively short.
 *
 * Intentionally does not run lint: lint is on-demand (see src/core/lint.ts) and
 * adding it here would double-scan memories without surfacing warnings anywhere.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_BATCH_SIZE = 50

export interface MaintenanceOptions {
  /** Interval between scheduled ticks. Default 5 min. */
  intervalMs?: number
  /** Memories scanned per tick. Default 50. */
  batchSize?: number
}

export class MaintenanceCoordinator {
  private readonly compression: CompressionPipeline
  private readonly intervalMs: number
  private readonly batchSize: number
  private timer: NodeJS.Timeout | null = null
  private inflight = false

  constructor(
    db: Database,
    svc: MemoryService,
    opts: MaintenanceOptions = {},
  ) {
    this.compression = new CompressionPipeline(db, svc)
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    // Prevent the timer from keeping the process alive — the daemon's HTTP/MCP
    // servers are the authoritative keep-alive sources.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run one compression pass. Returns null if a prior tick is still in flight
   *  (single-flight drop). The await before the synchronous runOnce() is load-
   *  bearing: it yields the microtask queue so concurrent callers observe the
   *  inflight flag before this body starts its DB work. */
  async tick(): Promise<CompressionStats | null> {
    if (this.inflight) return null
    this.inflight = true
    try {
      await Promise.resolve()
      return this.compression.runOnce({ batchSize: this.batchSize })
    } catch (err) {
      console.warn('[maintenance] tick error:', (err as Error).message)
      return null
    } finally {
      this.inflight = false
    }
  }
}
