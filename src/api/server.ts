import http from 'node:http'
import type { Database } from '../core/database.js'
import { createRequestHandler } from './routes.js'

export function createServer(db: Database): http.Server {
  const handleRequest = createRequestHandler(db)

  return http.createServer(async (req, res) => {
    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

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

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
