// SPDX-License-Identifier: Apache-2.0
import http from 'node:http'
import { URL } from 'node:url'
import { sendJson, parseJsonBody } from './server.js'
import type { Database } from '../core/database.js'
import { MemoryService } from '../core/memory-service.js'
import { scrubErrorMessage } from '../core/log-safe.js'
import { applyRowBudget, DEFAULT_MAX_TOKENS, DEFAULT_PER_ROW_CHAR_CAP } from '../core/token-budget.js'
import { appendRecallTelemetry } from '../core/recall-telemetry.js'
import type { HealthResult, Memory } from '../core/types.js'
import type { IntegrityCheckRecord } from '../core/integrity-monitor.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return LOOPBACK_HOSTS.has(host)
  } catch {
    return false
  }
}

function memorySource(m: Memory): string {
  if (m.sessionId && m.messageId) return `${m.sessionId}:msg:${m.messageId}`
  if (m.sessionId) return `${m.sessionId}:session`
  return `memory:${m.id}`
}

type SessionEndBody = {
  sessionId?: unknown
}

function validateSessionEndBody(
  raw: unknown,
): { sessionId: string } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be JSON object' }
  const b = raw as SessionEndBody
  if (typeof b.sessionId !== 'string' || b.sessionId.trim() === '') {
    return { error: 'sessionId must be non-empty string' }
  }
  return { sessionId: b.sessionId }
}

const startTime = Date.now()

/** Coalesces concurrent rescue calls onto one underlying run. The SessionEnd
 *  hook (/session/end) and the extraction wrapper (/session/last) both fire
 *  within the same session close — without this each miss stacks its own full
 *  reindex. Unlike the watcher's single-flight guard this never DROPS a call:
 *  joiners share the in-flight run's completion. A failed run clears the slot
 *  so the next call retries. */
export function coalesceRescue(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  return () => {
    inFlight ??= run().finally(() => { inFlight = null })
    return inFlight
  }
}

export interface RequestHandlerOptions {
  /** Called when /session/end or /session/last sees a missing/stale session —
   *  typically `coalesceRescue(() => runIndexer(db))` — so a fresh-session
   *  caller can retry after a forced reindex. */
  rescueReindex?: () => Promise<void>
  /** Reported in /health; closure-captured so daemons installed from different
   *  package versions don't lie about which one is actually running. Defaults
   *  to 'unknown' only because tests use createServer(db) without options. */
  version?: string
  /** SQLite path reported in /health so operators can confirm the daemon is
   *  writing where they expect. Empty string falls back to the current TODO
   *  behaviour, which matches pre-0.1.3 clients that ignored the field. */
  dbPath?: string
  /** Cached PRAGMA integrity_check result for /health. Structural type so
   *  tests can inject a stub without depending on the real class. Omit to
   *  report null/null (tests or daemons without the monitor attached). */
  integrityMonitor?: { getLastRecord(): IntegrityCheckRecord | null }
}

export function createRequestHandler(
  db: Database,
  opts: RequestHandlerOptions = {},
) {
  const memoryService = new MemoryService(db)
  return async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    // GET /health
    if (req.method === 'GET' && path === '/health') {
      const integrity = opts.integrityMonitor?.getLastRecord() ?? null
      const result: HealthResult = {
        status: 'ok',
        version: opts.version ?? 'unknown',
        dbPath: opts.dbPath ?? '',
        mainSessionCount: db.getMainSessionCount(),
        memoryCount: db.getMemoryCount(),
        topicCount: db.getTopicCount(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
        lastIntegrityCheckAt: integrity?.at ?? null,
        lastIntegrityCheckOk: integrity?.ok ?? null,
      }
      sendJson(res, 200, result)
      return
    }

    // GET /session/last?cwd=... — most recent session for a project (extraction wrapper)
    if (req.method === 'GET' && path === '/session/last') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const cwd = url.searchParams.get('cwd')
      if (!cwd) {
        sendJson(res, 400, { error: 'cwd query parameter required' })
        return
      }
      const projectId = cwd.replace(/\//g, '-')
      // Staleness gate (#55): the wrapper passes notBefore=<its launch time>.
      // A session whose endedAt predates the launch cannot be the one that
      // just closed — returning it would extract the WRONG session. endedAt,
      // not startedAt, so resumed sessions (old start, fresh messages) pass.
      // Clamp: the wrapper only ever sends "now". A spoofed far-future value
      // would mark every session permanently stale, forcing a full reindex on
      // each call (local DoS). Beyond a small clock-skew allowance, treat it
      // like an unparseable value (gate disabled). NaN fails the comparison,
      // so unparseable input stays NaN.
      const rawNotBeforeMs = Date.parse(url.searchParams.get('notBefore') ?? '')
      const notBeforeMs = rawNotBeforeMs <= Date.now() + 60_000 ? rawNotBeforeMs : NaN
      const isStale = (s: { endedAt: string | null }): boolean => {
        if (Number.isNaN(notBeforeMs)) return false
        const endedMs = s.endedAt ? Date.parse(s.endedAt) : NaN
        return Number.isNaN(endedMs) || endedMs < notBeforeMs
      }
      let last = db.getLastSession(projectId)
      if ((!last || isStale(last)) && opts.rescueReindex) {
        // Fresh-session race (#55): the extraction wrapper queries within
        // seconds of session close, before the watcher has indexed the fresh
        // JSONL. Same rescue as /session/end — reindex once and retry.
        try {
          await opts.rescueReindex()
        } catch (err) {
          console.warn('[session-last] rescue reindex failed:', scrubErrorMessage(err))
        }
        last = db.getLastSession(projectId)
      }
      if (!last || isStale(last)) {
        sendJson(res, 404, { error: 'no sessions found for project' })
        return
      }
      sendJson(res, 200, {
        sessionId: last.id,
        projectId: last.projectId,
        title: last.title,
        startedAt: last.startedAt,
        endedAt: last.endedAt,
      })
      return
    }

    // GET /memory/query?q=...&limit=...&project=...&maxTokens=...
    if (req.method === 'GET' && path === '/memory/query') {
      // Phase 4c touch made this a stateful endpoint (access_count / last_accessed).
      // Apply the same origin gate as POST so browser prefetches or CSRF from a
      // non-loopback origin cannot poison recall ranking.
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const q = url.searchParams.get('q') ?? ''
      const rawLimit = parseInt(url.searchParams.get('limit') ?? '5', 10)
      const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 5 : rawLimit
      const project = url.searchParams.get('project')
      const rawMaxTokens = url.searchParams.get('maxTokens')
      const maxTokens = rawMaxTokens === null
        ? null
        : (() => {
            const n = parseInt(rawMaxTokens, 10)
            return Number.isNaN(n) || n < 1 ? null : n
          })()

      if (!q) {
        sendJson(res, 200, { memories: [], totalTokenEstimate: 0, droppedCount: 0, truncated: false, query: q, limit })
        return
      }

      const rows = db.queryMemories(q, limit, project)
      // Apply token budget if requested. Truncation is per-row + cumulative;
      // dropped rows must NOT be touched (they never reached the caller).
      const budgeted = maxTokens !== null
        ? applyRowBudget(rows, maxTokens, DEFAULT_PER_ROW_CHAR_CAP)
        : { emitted: rows, droppedCount: 0, usedTokens: 0, truncated: false }
      memoryService.touch(budgeted.emitted.map(m => m.id), 'query')
      const memories = budgeted.emitted.map(m => ({
        content: m.content,
        source: memorySource(m),
        confidence: m.confidence,
        depth: null,
      }))
      const totalTokenEstimate = maxTokens !== null
        ? budgeted.usedTokens
        : Math.ceil(memories.reduce((sum, m) => sum + m.content.length, 0) / 4)

      sendJson(res, 200, {
        memories,
        totalTokenEstimate,
        droppedCount: budgeted.droppedCount,
        truncated: budgeted.truncated,
        query: q,
        limit,
      })

      appendRecallTelemetry({
        query: q,
        hitCount: memories.length,
        projectId: project,
        limit,
        maxTokens,
      })
      return
    }

    // GET /memory/startup?project=...&limit=...&maxTokens=...&q=<fallback>
    // SessionStart-tier retrieval: cold + recent-conf + FTS fallback,
    // closes the keyword echo chamber (see memory #119 / pi-plan 2026-05-13).
    if (req.method === 'GET' && path === '/memory/startup') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const project = url.searchParams.get('project')
      if (!project) {
        sendJson(res, 400, { error: 'project is required' })
        return
      }
      const rawLimit = parseInt(url.searchParams.get('limit') ?? '5', 10)
      const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 5 : rawLimit
      const rawMaxTokens = url.searchParams.get('maxTokens')
      const maxTokens = (() => {
        if (rawMaxTokens === null) return DEFAULT_MAX_TOKENS
        const n = parseInt(rawMaxTokens, 10)
        return Number.isNaN(n) || n < 1 ? DEFAULT_MAX_TOKENS : n
      })()
      const fallback = url.searchParams.get('q') ?? undefined
      const sessionId = url.searchParams.get('sessionId') || null

      const rows = db.getStartupMemories(project, limit, fallback)
      const budgeted = applyRowBudget(rows, maxTokens, DEFAULT_PER_ROW_CHAR_CAP)
      memoryService.touch(budgeted.emitted.map(m => m.id), 'startup', sessionId)

      const memories = budgeted.emitted.map(m => ({
        id: m.id,
        content: m.content,
        source: memorySource(m),
        confidence: m.confidence,
      }))

      sendJson(res, 200, {
        memories,
        emittedIds: budgeted.emitted.map(m => m.id),
        candidateCount: rows.length,
        totalTokenEstimate: budgeted.usedTokens,
        droppedCount: budgeted.droppedCount,
        truncated: budgeted.truncated,
        project,
        limit,
      })
      return
    }

    // POST /session/end
    if (req.method === 'POST' && path === '/session/end') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const body = await parseJsonBody(req, res)
      if (!body.ok) return
      const v = validateSessionEndBody(body.parsed)
      if ('error' in v) {
        sendJson(res, 400, v)
        return
      }
      let session = db.getSessionById(v.sessionId)
      if (!session && opts.rescueReindex) {
        // Fresh-session race: hook fires before the daemon has indexed the
        // JSONL. Run one reindex and retry — watcher will catch subsequent
        // changes but the extraction wrapper polling /session/last can't wait
        // for the next debounce (#55 fix chain).
        try {
          await opts.rescueReindex()
        } catch (err) {
          console.warn('[session-end] rescue reindex failed:', scrubErrorMessage(err))
        }
        session = db.getSessionById(v.sessionId)
      }
      if (!session) {
        sendJson(res, 404, { error: 'session not found' })
        return
      }
      sendJson(res, 200, { ok: true, sessionId: v.sessionId })
      return
    }

    // 404
    sendJson(res, 404, { error: 'Not found' })
  }
}
