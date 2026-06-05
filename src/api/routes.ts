// SPDX-License-Identifier: Apache-2.0
import http from 'node:http'
import { URL } from 'node:url'
import { sendJson, parseJsonBody } from './server.js'
import type { Database, MemoryInput } from '../core/database.js'
import { MemoryService } from '../core/memory-service.js'
import { runLint } from '../core/lint.js'
import { scrubErrorMessage } from '../core/log-safe.js'
import { scoreKnowledgeBearing } from '../core/outcome-scorer.js'
import { applyRowBudget, DEFAULT_MAX_TOKENS, DEFAULT_PER_ROW_CHAR_CAP } from '../core/token-budget.js'
import { appendRecallTelemetry } from '../core/recall-telemetry.js'
import type {
  HealthResult, Memory, MemoryType, SessionMeta, OutcomeStatus,
  KnowledgeDepth, Topic, TopicDetail, MetacognitionSummary, CheckpointResult,
  JournalEntryInput,
} from '../core/types.js'
import { deriveDepth } from '../core/types.js'
import type { IntegrityCheckRecord } from '../core/integrity-monitor.js'

const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set([
  'decision', 'discovery', 'preference', 'pattern', 'feedback', 'query',
])

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

type SaveBody = {
  content?: unknown
  type?: unknown
  sessionId?: unknown
  messageId?: unknown
  confidence?: unknown
  projectId?: unknown
}

function optionalString(
  value: unknown,
  field: string,
): { value: string | null } | { error: string } {
  if (value == null) return { value: null }
  if (typeof value === 'string') return { value }
  return { error: `${field} must be string or null` }
}

type SessionEndBody = {
  sessionId?: unknown
  dryRun?: unknown
}

function validateSessionEndBody(
  raw: unknown,
): { sessionId: string; dryRun: boolean } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be JSON object' }
  const b = raw as SessionEndBody
  if (typeof b.sessionId !== 'string' || b.sessionId.trim() === '') {
    return { error: 'sessionId must be non-empty string' }
  }
  if (b.dryRun != null && typeof b.dryRun !== 'boolean') {
    return { error: 'dryRun must be boolean' }
  }
  return { sessionId: b.sessionId, dryRun: b.dryRun === true }
}

export function inferConfidence(outcome: OutcomeStatus): number {
  if (outcome === 'committed') return 0.9
  if (outcome === 'tested') return 0.8
  return 0.7
}

/** P1 (#21): hook auto-harvester 改寫 session_journal 不寫 memories;
 *  manual recall_save 仍直寫 memories。promote 路徑 (C4) 會把 journal entry
 *  搬到 memories table 並設 confidence。
 *
 *  Score 重算: summarizer 已用 scorer 過 noise/process-report hard floor,
 *  但 score + reasons metadata 沒儲在 sessions.harvest_text。重算成本低
 *  (regex 對 <2KB 文字),換 schema 不變的代價可接受。 */
export function buildJournalCandidate(session: SessionMeta): JournalEntryInput | null {
  const harvestText = session.harvestText?.trim()
  if (!harvestText) return null
  const result = scoreKnowledgeBearing(harvestText)
  // Defense in depth: 單元測試可能直接餵 SessionMeta, hard floor 仍應生效。
  if (result.reasons.includes('noise') || result.reasons.includes('process-report')) return null
  return {
    sessionId: session.id,
    messageId: null,
    content: harvestText,
    score: result.score,
    reasonsJson: JSON.stringify(result.reasons),
    projectId: session.projectId ?? null,
  }
}

function validateSaveBody(raw: unknown): MemoryInput | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be JSON object' }
  const b = raw as SaveBody
  if (typeof b.content !== 'string' || b.content.trim() === '') {
    return { error: 'content must be non-empty string' }
  }
  if (typeof b.type !== 'string' || !VALID_MEMORY_TYPES.has(b.type as MemoryType)) {
    return { error: `type must be one of: ${[...VALID_MEMORY_TYPES].join(', ')}` }
  }
  const sessionIdResult = optionalString(b.sessionId, 'sessionId')
  if ('error' in sessionIdResult) return sessionIdResult
  const messageIdResult = optionalString(b.messageId, 'messageId')
  if ('error' in messageIdResult) return messageIdResult
  const projectIdResult = optionalString(b.projectId, 'projectId')
  if ('error' in projectIdResult) return projectIdResult
  let confidence: number | undefined
  if (b.confidence != null) {
    if (typeof b.confidence !== 'number' || b.confidence < 0 || b.confidence > 1) {
      return { error: 'confidence must be number in [0, 1]' }
    }
    confidence = b.confidence
  }
  return {
    content: b.content,
    type: b.type as MemoryType,
    sessionId: sessionIdResult.value,
    messageId: messageIdResult.value,
    confidence,
    projectId: projectIdResult.value,
  }
}

function topicWithDepth(t: Topic): Topic & { depth: KnowledgeDepth } {
  return { ...t, depth: deriveDepth(t.mentionCount) }
}

type CheckpointBody = {
  sessionId?: unknown
  snapshot?: unknown
}

const SNAPSHOT_MAX_BYTES = 64 * 1024

function validateCheckpointBody(
  raw: unknown,
): { sessionId: string; snapshot: string } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be JSON object' }
  const b = raw as CheckpointBody
  if (typeof b.sessionId !== 'string' || b.sessionId.trim() === '') {
    return { error: 'sessionId must be non-empty string' }
  }
  if (typeof b.snapshot !== 'string' || b.snapshot.trim() === '') {
    return { error: 'snapshot must be non-empty string' }
  }
  if (Buffer.byteLength(b.snapshot, 'utf8') > SNAPSHOT_MAX_BYTES) {
    return { error: `snapshot must be <= ${SNAPSHOT_MAX_BYTES} bytes` }
  }
  return { sessionId: b.sessionId, snapshot: b.snapshot }
}

const startTime = Date.now()

export interface RequestHandlerOptions {
  /** Called when /session/end sees a missing session — typically `() => runIndexer(db)`
   *  — so a fresh-session hook can harvest after a forced reindex retry. */
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
        sessionCount: db.getMainSessionCount(),
        memoryCount: db.getMemoryCount(),
        topicCount: db.getTopicCount(),
        journalPendingCount: db.getJournalPendingCount(),
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
      const last = db.getLastSession(projectId)
      if (!last) {
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
      memoryService.touch(budgeted.emitted.map(m => m.id))
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

      const rows = db.getStartupMemories(project, limit, fallback)
      const budgeted = applyRowBudget(rows, maxTokens, DEFAULT_PER_ROW_CHAR_CAP)
      memoryService.touch(budgeted.emitted.map(m => m.id))

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

    // GET /memory/context?session_id=...
    if (req.method === 'GET' && path === '/memory/context') {
      const sessionId = url.searchParams.get('session_id') ?? ''
      // TODO: integrate with session context lookup
      sendJson(res, 200, { summary: null, decisions: [], filesTouched: [], sessionId })
      return
    }

    // POST /memory/save
    if (req.method === 'POST' && path === '/memory/save') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const body = await parseJsonBody(req, res)
      if (!body.ok) return
      const v = validateSaveBody(body.parsed)
      if ('error' in v) {
        sendJson(res, 400, v)
        return
      }
      const id = db.saveMemory(v)
      sendJson(res, 200, { ok: true, id })
      return
    }

    // POST /journal/promote — manual promote a journal entry to memories (#21 P1)
    if (req.method === 'POST' && path === '/journal/promote') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const body = await parseJsonBody(req, res)
      if (!body.ok) return
      const b = body.parsed as { id?: unknown; type?: unknown; confidence?: unknown }
      if (typeof b.id !== 'number' || !Number.isInteger(b.id) || b.id <= 0) {
        sendJson(res, 400, { error: 'id must be positive integer' })
        return
      }
      const type: MemoryType = (typeof b.type === 'string' && VALID_MEMORY_TYPES.has(b.type as MemoryType))
        ? b.type as MemoryType
        : 'discovery'
      let confidence = 0.7
      if (b.confidence != null) {
        if (typeof b.confidence !== 'number' || b.confidence < 0 || b.confidence > 1) {
          sendJson(res, 400, { error: 'confidence must be number in [0, 1]' })
          return
        }
        confidence = b.confidence
      }
      const entry = db.getJournalEntry(b.id)
      if (!entry) {
        sendJson(res, 404, { error: 'journal entry not found' })
        return
      }
      if (entry.status !== 'pending') {
        sendJson(res, 409, { error: `journal entry status='${entry.status}', expected 'pending'` })
        return
      }

      let memoryId = 0
      try {
        db.runTransaction(() => {
          memoryId = db.saveMemory({
            sessionId: entry.sessionId,
            messageId: entry.messageId,
            content: entry.content,
            type,
            confidence,
            projectId: entry.projectId,
          })
          // 繼承 session topics → memory_topics, 重建 knowledge_map (對齊 v0.2.x harvest 行為)
          if (entry.sessionId) {
            const session = db.getSessionById(entry.sessionId)
            if (session) {
              const sessionTopics = db.getSessionTopicKeys(session.id)
              if (sessionTopics.length > 0) {
                db.saveMemoryTopics(memoryId, session.projectId, sessionTopics)
              }
              db.rebuildKnowledgeMap(session.projectId)
            }
          }
          // Race guard: pre-read 後 status 若被改 (multi-daemon, 直接 SQL),
          // promoteJournalEntry 會回 false; throw 觸發 transaction rollback,
          // 避免 memories 多一筆 orphan 而 journal status 沒翻 promoted。
          if (!db.promoteJournalEntry(entry.id, memoryId)) {
            throw new Error('JOURNAL_RACE: status changed during transaction')
          }
        })
      } catch (err) {
        if ((err as Error).message?.startsWith('JOURNAL_RACE:')) {
          sendJson(res, 409, { error: 'journal entry status changed during transaction; re-fetch and retry' })
          return
        }
        throw err
      }
      sendJson(res, 200, { ok: true, memoryId, journalId: entry.id })
      return
    }

    // GET /journal/pending?limit=N — list pending journal entries for promote/reject (#21 P1 fix-up)
    if (req.method === 'GET' && path === '/journal/pending') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const rawLimit = parseInt(url.searchParams.get('limit') ?? '20', 10)
      const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 100)
      const entries = db.getPendingJournalEntries(limit)
      sendJson(res, 200, { entries, total: entries.length })
      return
    }

    // POST /journal/reject — mark a journal entry as rejected (decay sweep cleans up)
    if (req.method === 'POST' && path === '/journal/reject') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const body = await parseJsonBody(req, res)
      if (!body.ok) return
      const b = body.parsed as { id?: unknown }
      if (typeof b.id !== 'number' || !Number.isInteger(b.id) || b.id <= 0) {
        sendJson(res, 400, { error: 'id must be positive integer' })
        return
      }
      // Decay TTL: 7 days; sweep cron (C5) cleans up after expires_at
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      const ok = db.rejectJournalEntry(b.id, expiresAt)
      if (!ok) {
        sendJson(res, 404, { error: 'journal entry not found or not pending' })
        return
      }
      sendJson(res, 200, { ok: true, journalId: b.id, expiresAt })
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
        // changes but this first harvest can't wait for the next debounce.
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
      const candidate = buildJournalCandidate(session)
      if (!candidate) {
        sendJson(res, 200, {
          ok: true,
          sessionId: v.sessionId,
          journalSaved: [],
          dryRun: v.dryRun,
          reason: 'session has no harvest candidate',
        })
        return
      }

      // P1 (#21): journal 用 content_hash UNIQUE INDEX dedup; saveJournalEntry
      // 在重複 hash 時回 0。不再需要 v0.2.x 的 alreadyHarvested split-brain check;
      // memory_topics / rebuildKnowledgeMap 留給 promote 路徑 (C4) 處理。
      const savedIds: number[] = []
      if (!v.dryRun) {
        const id = db.saveJournalEntry(candidate)
        if (id > 0) savedIds.push(id)
      }
      sendJson(res, 200, {
        ok: true,
        sessionId: v.sessionId,
        journalSaved: savedIds,
        dryRun: v.dryRun,
        candidate: v.dryRun ? candidate : undefined,
      })
      return
    }

    // GET /metacognition/check?projectId=X[&topic=Y][&limit=N]
    if (req.method === 'GET' && path === '/metacognition/check') {
      // detail mode returns memory content; loopback gate matches POST mutation endpoints
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const projectId = url.searchParams.get('projectId')
      if (!projectId) {
        sendJson(res, 400, { error: 'projectId query param required' })
        return
      }
      const topicParam = url.searchParams.get('topic')
      const rawLimit = parseInt(url.searchParams.get('limit') ?? '10', 10)
      const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 10 : Math.min(rawLimit, 50)

      if (topicParam) {
        // Detail mode
        const topic = db.getTopic(topicParam, projectId)
        if (!topic) {
          sendJson(res, 404, { error: 'topic not found' })
          return
        }
        const related = db.getRelatedTopics(topicParam, projectId, 10)
        const memories = db.getMemoriesByTopics(projectId, [topicParam], limit)
        const detail: TopicDetail = {
          topicKey: topic.topicKey,
          projectId: topic.projectId,
          mentionCount: topic.mentionCount,
          lastTouched: topic.lastTouched,
          depth: deriveDepth(topic.mentionCount),
          memories,
          relatedTopics: related,
        }
        sendJson(res, 200, detail)
        return
      }

      // Summary mode
      const top = db.getKnowledgeMap(projectId, { limit, sortBy: 'mention' }).map(topicWithDepth)
      const recent = db.getKnowledgeMap(projectId, { limit, sortBy: 'recent' }).map(topicWithDepth)
      const stale = db.getKnowledgeMap(projectId, { limit, sortBy: 'stale' }).map(topicWithDepth)
      const counts = db.getKnowledgeMapCounts(projectId)
      const summary: MetacognitionSummary = {
        projectId,
        topTopics: top,
        recentTopics: recent,
        staleTopics: stale,
        counts,
      }
      sendJson(res, 200, summary)
      return
    }

    // POST /session/checkpoint
    if (req.method === 'POST' && path === '/session/checkpoint') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const body = await parseJsonBody(req, res)
      if (!body.ok) return
      const v = validateCheckpointBody(body.parsed)
      if ('error' in v) {
        sendJson(res, 400, v)
        return
      }
      const session = db.getSessionById(v.sessionId)
      if (!session) {
        sendJson(res, 404, { error: 'session not found' })
        return
      }
      const checkpointId = db.saveCheckpoint(session.id, session.projectId, v.snapshot)
      const result: CheckpointResult = { ok: true, checkpointId }
      sendJson(res, 200, result)
      return
    }

    // GET /lint/warnings — orphan / stale memory detection (Phase 4d)
    if (req.method === 'GET' && path === '/lint/warnings') {
      // Reveals memory metadata (ids, session refs, decay numbers) — same
      // loopback gate as other introspection endpoints so a non-loopback
      // origin cannot enumerate recall internals via a browser prefetch.
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      const report = runLint(db)
      sendJson(res, 200, report)
      return
    }

    // 404
    sendJson(res, 404, { error: 'Not found' })
  }
}
