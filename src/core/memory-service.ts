import type { Database } from './database.js'

/**
 * Phase 4b: thin abstraction on top of Database for memory lifecycle operations
 * (touch / delete / update-content). Centralises policy so HTTP routes, MCP
 * tools, hooks and background maintenance all share the same semantics.
 *
 * Deliberately narrow for now. Compression scheduling, decay tuning and lint
 * orchestration land in Phase 4c–4e and will be added here rather than in the
 * callers.
 */
export class MemoryService {
  constructor(private readonly db: Database) {}

  /**
   * Increment access_count and stamp last_accessed for each id. Dedupes
   * automatically so the same memory surfaced in multiple topic clusters is
   * only counted once per request.
   *
   * Fire-and-forget: swallows errors and logs to stderr so query latency is
   * never affected by touch failures.
   */
  touch(ids: number[]): void {
    const unique = Array.from(new Set(ids))
    if (unique.length === 0) return
    try {
      this.db.touchMemory(unique)
    } catch (err) {
      console.warn('[memory-service] touch failed:', (err as Error).message)
    }
  }

  /** Delete a memory by id. Returns true if a row was deleted. */
  delete(id: number): boolean {
    return this.db.deleteMemory(id)
  }

  /**
   * Rewrite memory.content and stamp compression metadata atomically. Used by
   * the compression pipeline in Phase 4d.
   */
  updateContent(id: number, content: string, level: number): boolean {
    return this.db.updateMemoryContent(id, content, level, new Date().toISOString())
  }
}
