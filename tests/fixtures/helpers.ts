import http from 'node:http'
import type { IndexSessionParams } from '../../src/core/database.js'

export function sessionParams(
  o: Partial<IndexSessionParams> & { sessionId: string; projectId: string },
): IndexSessionParams {
  return {
    projectDisplayName: 'test',
    title: null,
    messageCount: 0,
    filePath: `/tmp/${o.sessionId}.jsonl`,
    fileSize: 0,
    fileMtime: '2026-04-17T00:00:00Z',
    startedAt: '2026-04-17T00:00:00Z',
    endedAt: '2026-04-17T01:00:00Z',
    messages: [],
    ...o,
  }
}

export function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        resolve({ status: res.statusCode!, body })
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

export function postJson(
  url: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(payload)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        resolve({ status: res.statusCode!, body })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}
