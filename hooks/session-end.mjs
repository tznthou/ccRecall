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

// Strip CR/LF and other control chars so attacker-controlled response bodies
// can't forge log entries when interpolated into console.error.
function sanitizeForLog(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
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
          console.error(`[ccRecall] harvest failed ${res.statusCode}: ${sanitizeForLog(body.slice(0, 200))}`)
          resolve()
          return
        }
        try {
          const parsed = JSON.parse(body)
          if (Array.isArray(parsed.memoriesSaved) && parsed.memoriesSaved.length === 0) {
            const reason = sanitizeForLog(String(parsed.reason ?? 'unknown'))
            console.error(`[ccRecall] harvest yielded 0 memories (reason: ${reason}).`)
          }
        } catch {
          // response wasn't JSON; already 200 so treat as success
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
