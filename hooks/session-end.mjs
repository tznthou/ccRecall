#!/usr/bin/env node
// ccRecall SessionEnd hook — harvests the just-ended session into memories.
// Wired via ~/.claude/settings.json hooks.SessionEnd. Non-blocking.
import http from 'node:http'

const PORT = Number(process.env.CCRECALL_PORT ?? 7749)
const HOST = '127.0.0.1'
const TIMEOUT_MS = 5000

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function postSessionEnd(sessionId) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ sessionId })
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: '/session/end',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[ccRecall] harvest failed ${res.statusCode}: ${body.slice(0, 200)}`)
        }
        resolve()
      })
    })
    req.on('error', (err) => {
      console.error(`[ccRecall] harvest error: ${err.message} (is the service running on :${PORT}?)`)
      resolve()
    })
    req.on('timeout', () => {
      console.error(`[ccRecall] harvest timeout after ${TIMEOUT_MS}ms`)
      req.destroy()
      resolve()
    })
    req.write(payload)
    req.end()
  })
}

async function main() {
  let input
  try {
    const raw = await readStdin()
    input = raw ? JSON.parse(raw) : {}
  } catch (err) {
    console.error(`[ccRecall] failed to parse hook input: ${err.message}`)
    return
  }

  // 'resume' means session is continuing, not ending — skip harvest.
  if (input.reason === 'resume') return

  const sessionId = input.session_id
  if (!sessionId) return

  await postSessionEnd(sessionId)
}

main().catch((err) => {
  console.error(`[ccRecall] unexpected error: ${err.message}`)
})
