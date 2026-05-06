// SPDX-License-Identifier: Apache-2.0
import http from 'node:http'
import { URL } from 'node:url'
import { sendJson, readBody } from './server.js'
import type { Database, MemoryInput } from '../core/database.js'
import { MemoryService } from '../core/memory-service.js'
import { runLint } from '../core/lint.js'
import { scrubErrorMessage } from '../core/log-safe.js'
import { scoreKnowledgeBearing } from '../core/outcome-scorer.js'
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
        uptime: Math.floor((Date.now() - startTime) / 1000),
        lastIntegrityCheckAt: integrity?.at ?? null,
        lastIntegrityCheckOk: integrity?.ok ?? null,
      }
      sendJson(res, 200, result)
      return
    }

    // GET /memory/query?q=...&limit=...&project=...
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

      if (!q) {
        sendJson(res, 200, { memories: [], totalTokenEstimate: 0, query: q, limit })
        return
      }

      const rows = db.queryMemories(q, limit, project)
      // Phase 4c: touch surfaced memories so their access_count and last_accessed
      // feed into the decay formula at next query time. MemoryService.touch
      // noops on empty input, no need to guard here.
      memoryService.touch(rows.map(m => m.id))
      const memories = rows.map(m => ({
        content: m.content,
        source: memorySource(m),
        confidence: m.confidence,
        depth: null,
      }))
      const totalTokenEstimate = Math.ceil(
        memories.reduce((sum, m) => sum + m.content.length, 0) / 4,
      )

      sendJson(res, 200, { memories, totalTokenEstimate, query: q, limit })
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
      let bodyText: string
      try {
        bodyText = await readBody(req)
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'body too large') {
          sendJson(res, 413, { error: msg })
          return
        }
        throw err
      }
      let parsed: unknown
      try {
        parsed = bodyText ? JSON.parse(bodyText) : {}
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const v = validateSaveBody(parsed)
      if ('error' in v) {
        sendJson(res, 400, v)
        return
      }
      const id = db.saveMemory(v)
      sendJson(res, 200, { ok: true, id })
      return
    }

    // POST /session/end
    if (req.method === 'POST' && path === '/session/end') {
      if (!isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'cross-origin requests forbidden' })
        return
      }
      let bodyText: string
      try {
        bodyText = await readBody(req)
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'body too large') {
          sendJson(res, 413, { error: msg })
          return
        }
        throw err
      }
      let parsed: unknown
      try {
        parsed = bodyText ? JSON.parse(bodyText) : {}
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const v = validateSessionEndBody(parsed)
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
      let bodyText: string
      try {
        bodyText = await readBody(req)
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'body too large') {
          sendJson(res, 413, { error: msg })
          return
        }
        throw err
      }
      let parsed: unknown
      try {
        parsed = bodyText ? JSON.parse(bodyText) : {}
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const v = validateCheckpointBody(parsed)
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
