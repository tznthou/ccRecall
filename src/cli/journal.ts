// SPDX-License-Identifier: Apache-2.0
import http from 'node:http'

const DEFAULT_PORT = 7749

export interface PromoteOptions {
  type?: string
  confidence?: number
}

function getPort(): number {
  const raw = parseInt(process.env.CCRECALL_PORT ?? String(DEFAULT_PORT), 10)
  return Number.isFinite(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_PORT
}

interface JsonResponse<T> {
  status: number
  body: T
}

function postJson<T>(reqPath: string, payload: unknown): Promise<JsonResponse<T>> {
  return new Promise((resolve, reject) => {
    const port = getPort()
    const data = JSON.stringify(payload)
    const req = http.request({
      hostname: '127.0.0.1', port, path: reqPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString()) as T
          resolve({ status: res.statusCode ?? 0, body: parsed })
        } catch (err) { reject(err as Error) }
      })
      res.on('error', reject)
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`Cannot connect to daemon on 127.0.0.1:${port}. Is ccRecall daemon running?`))
      } else {
        reject(err)
      }
    })
    req.write(data)
    req.end()
  })
}

export function parsePromoteFlags(args: string[]): { idStr?: string; opts: PromoteOptions } {
  let idStr: string | undefined
  const opts: PromoteOptions = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--type' && i + 1 < args.length) {
      opts.type = args[++i]
    } else if (a === '--confidence' && i + 1 < args.length) {
      const c = parseFloat(args[++i])
      if (Number.isFinite(c)) opts.confidence = c
    } else if (!a.startsWith('--') && idStr === undefined) {
      idStr = a
    }
  }
  return { idStr, opts }
}

export async function runPromote(idStr: string | undefined, opts: PromoteOptions = {}): Promise<number> {
  if (!idStr) {
    console.error('Usage: ccmem promote <journal_id> [--type discovery|decision|...] [--confidence 0.7]')
    return 1
  }
  const id = parseInt(idStr, 10)
  if (!Number.isInteger(id) || id <= 0) {
    console.error(`Invalid id: ${idStr}`)
    return 1
  }
  try {
    const { status, body } = await postJson<{
      ok?: boolean; memoryId?: number; journalId?: number; error?: string
    }>('/journal/promote', { id, type: opts.type, confidence: opts.confidence })
    if (status === 200 && body.ok) {
      console.log(`Promoted journal #${body.journalId} → memory #${body.memoryId}`)
      return 0
    }
    console.error(`promote failed (${status}): ${body.error ?? 'unknown error'}`)
    return 1
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
}

export async function runReject(idStr: string | undefined): Promise<number> {
  if (!idStr) {
    console.error('Usage: ccmem reject <journal_id>')
    return 1
  }
  const id = parseInt(idStr, 10)
  if (!Number.isInteger(id) || id <= 0) {
    console.error(`Invalid id: ${idStr}`)
    return 1
  }
  try {
    const { status, body } = await postJson<{
      ok?: boolean; journalId?: number; expiresAt?: string; error?: string
    }>('/journal/reject', { id })
    if (status === 200 && body.ok) {
      console.log(`Rejected journal #${body.journalId} — expires ${body.expiresAt}`)
      return 0
    }
    console.error(`reject failed (${status}): ${body.error ?? 'unknown error'}`)
    return 1
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
}
