import http from 'node:http'
import type { Database } from '../core/database.js'
import { createRequestHandler, type RequestHandlerOptions } from './routes.js'

export function createServer(db: Database, opts: RequestHandlerOptions = {}): http.Server {
  const handleRequest = createRequestHandler(db, opts)

  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res)
    } catch (err) {
      console.error('Unhandled error:', err)
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
