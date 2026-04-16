import http from 'node:http'
import { URL } from 'node:url'
import { sendJson } from './server.js'
import type { Database } from '../core/database.js'
import type { HealthResult } from '../core/types.js'

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
      const sessionCount = db.getMainSessionCount()
      const result: HealthResult = {
        status: 'ok',
        version: '0.1.0',
        dbPath: '', // TODO: expose from Database
        sessionCount,
        memoryCount: 0, // Phase 2
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

      // Search messages via FTS5
      const messagePage = db.search(q, null, 0, limit)
      // Search sessions via FTS5
      const sessionPage = db.searchSessions(q, null, 0, limit)

      // Map to memory query result format
      const memories = [
        ...messagePage.results.map((r, i) => ({
          content: r.snippet,
          source: `${r.sessionId}:msg:${r.messageId}`,
          confidence: Math.max(0.1, 1 - i * 0.15),
          depth: null,
        })),
        ...sessionPage.results.map((r, i) => ({
          content: r.snippet,
          source: `${r.sessionId}:session`,
          confidence: Math.max(0.1, 0.8 - i * 0.15),
          depth: null,
        })),
      ].slice(0, limit)

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
      // TODO: integrate with memory store (Phase 2)
      sendJson(res, 200, { ok: true })
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
      // TODO: integrate with session end pipeline (Phase 2)
      sendJson(res, 200, { ok: true })
      return
    }

    // 404
    sendJson(res, 404, { error: `Not found: ${req.method} ${path}` })
  }
}
