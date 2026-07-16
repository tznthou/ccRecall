// SPDX-License-Identifier: Apache-2.0
import http from 'node:http'
import type { Database } from '../core/database.js'
import { createRequestHandler, type RequestHandlerOptions } from './routes.js'
import { scrubErrorMessage } from '../core/log-safe.js'

export function createServer(db: Database, opts: RequestHandlerOptions = {}): http.Server {
  const handleRequest = createRequestHandler(db, opts)

  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res)
    } catch (err) {
      // scrub before logging: SQLite errors can embed user content (e.g.
      // memory content via constraint violations) that may carry ANSI / CR
      // control bytes. Pattern matches every other error log site.
      console.error('Unhandled error:', scrubErrorMessage(err))
      sendJson(res, 500, { error: 'Internal server error' })
    }
  })
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const MAX_BODY_BYTES = 1 * 1024 * 1024 // 1 MB

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      if (exceeded) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        exceeded = true
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString())
    })
    req.on('error', reject)
  })
}

/** Read + JSON-parse a request body. On size overflow sends 413, on parse
 *  error sends 400, then returns { ok: false } so the caller can early-return.
 *  The ok branch returns parsed (object/null/array — same shape as JSON.parse).
 *  Empty body parses as {} so endpoint validators see the no-keys case. */
export async function parseJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<{ ok: true; parsed: unknown } | { ok: false }> {
  let bodyText: string
  try {
    bodyText = await readBody(req)
  } catch (err) {
    const msg = (err as Error).message
    if (msg === 'body too large') {
      sendJson(res, 413, { error: msg })
      return { ok: false }
    }
    throw err
  }
  try {
    return { ok: true, parsed: bodyText ? JSON.parse(bodyText) : {} }
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return { ok: false }
  }
}
