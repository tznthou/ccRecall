import http from 'node:http'
import { URL } from 'node:url'
import { sendJson, readBody } from './server.js'
import type { Database, MemoryInput } from '../core/database.js'
import type { HealthResult, Memory, MemoryType, SessionMeta, OutcomeStatus } from '../core/types.js'

const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set([
  'decision', 'discovery', 'preference', 'pattern', 'feedback',
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

export function inferMemoryType(outcome: OutcomeStatus): MemoryType {
  if (outcome === 'committed') return 'decision'
  return 'discovery'
}

export function inferConfidence(outcome: OutcomeStatus): number {
  if (outcome === 'committed') return 0.9
  if (outcome === 'tested') return 0.8
  return 0.7
}

export function buildMemoryFromSession(session: SessionMeta): MemoryInput | null {
  const summary = session.summaryText?.trim()
  if (!summary) return null
  const parts: string[] = []
  const intent = session.intentText?.trim()
  if (intent) parts.push(`[intent] ${intent}`)
  parts.push(summary)
  return {
    sessionId: session.id,
    messageId: null,
    content: parts.join('\n'),
    type: inferMemoryType(session.outcomeStatus),
    confidence: inferConfidence(session.outcomeStatus),
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
  }
}

const startTime = Date.now()

export function createRequestHandler(db: Database) {
  return async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    // GET /health
    if (req.method === 'GET' && path === '/health') {
      const result: HealthResult = {
        status: 'ok',
        version: '0.1.0',
        dbPath: '', // TODO: expose from Database
        sessionCount: db.getMainSessionCount(),
        memoryCount: db.getMemoryCount(),
        topicCount: 0, // Phase 3
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }
      sendJson(res, 200, result)
      return
    }

    // GET /memory/query?q=...&limit=...
    if (req.method === 'GET' && path === '/memory/query') {
      const q = url.searchParams.get('q') ?? ''
      const rawLimit = parseInt(url.searchParams.get('limit') ?? '5', 10)
      const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 5 : rawLimit

      if (!q) {
        sendJson(res, 200, { memories: [], totalTokenEstimate: 0, query: q, limit })
        return
      }

      const rows = db.queryMemories(q, limit)
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

    // GET /metacognition/check?topic=...
    if (req.method === 'GET' && path === '/metacognition/check') {
      const topic = url.searchParams.get('topic') ?? ''
      // TODO: integrate with knowledge_map
      sendJson(res, 200, {
        topic,
        depth: 'none',
        confidence: 0,
        sessionCount: 0,
        lastTouched: null,
        summary: null,
      })
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

    // POST /session/checkpoint
    if (req.method === 'POST' && path === '/session/checkpoint') {
      // TODO: integrate with checkpoint pipeline (Phase 2)
      sendJson(res, 200, { ok: true, memoriesSaved: 0, topicsUpdated: 0 })
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
      const session = db.getSessionById(v.sessionId)
      if (!session) {
        sendJson(res, 404, { error: 'session not found' })
        return
      }
      const candidate = buildMemoryFromSession(session)
      if (!candidate) {
        sendJson(res, 200, {
          ok: true,
          sessionId: v.sessionId,
          memoriesSaved: [],
          dryRun: v.dryRun,
          reason: 'session has no summary',
        })
        return
      }
      const savedIds: number[] = []
      if (!v.dryRun) {
        savedIds.push(db.saveMemory(candidate))
      }
      sendJson(res, 200, {
        ok: true,
        sessionId: v.sessionId,
        memoriesSaved: savedIds,
        dryRun: v.dryRun,
        candidate: v.dryRun ? candidate : undefined,
      })
      return
    }

    // 404
    sendJson(res, 404, { error: 'Not found' })
  }
}
