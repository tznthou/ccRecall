#!/usr/bin/env node
// ccRecall SessionStart hook — injects relevant memories as context at session start.
// Wired via ~/.claude/settings.json hooks.SessionStart. Output on stdout is
// prepended to Claude's context; errors go to stderr only.
import http from 'node:http'

const PORT = Number(process.env.CCRECALL_PORT ?? 7749)
const HOST = '127.0.0.1'
const TIMEOUT_MS = 2000
const MEMORY_LIMIT = 5

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function queryMemories(query, projectId) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({ q: query, limit: String(MEMORY_LIMIT) })
    if (projectId) params.set('project', projectId)
    const url = `/memory/query?${params.toString()}`
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: url,
      method: 'GET',
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[ccRecall] query failed ${res.statusCode}`)
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(body)
          resolve(Array.isArray(parsed.memories) ? parsed.memories : [])
        } catch {
          resolve([])
        }
      })
    })
    req.on('error', (err) => {
      console.error(`[ccRecall] query error: ${err.message} (is the service running on :${PORT}?)`)
      resolve([])
    })
    req.on('timeout', () => {
      console.error(`[ccRecall] query timeout after ${TIMEOUT_MS}ms`)
      req.destroy()
      resolve([])
    })
    req.end()
  })
}

function projectNameFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return ''
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

// Matches Claude Code's project-directory encoding under ~/.claude/projects/
function projectIdFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return ''
  return cwd.replace(/\//g, '-')
}

function formatMemories(memories, query) {
  if (memories.length === 0) return ''
  const lines = memories.map((m) => {
    const conf = m.confidence != null && m.confidence !== 1
      ? ` (conf ${Number(m.confidence).toFixed(2)})`
      : ''
    return `- ${m.content}${conf}`
  })
  return [
    '[ccRecall memory recall]',
    '',
    ...lines,
    '',
    `(matched via project keyword: "${query}")`,
  ].join('\n')
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

  // 'resume' continues an existing session; context is already there.
  if (input.source === 'resume') return

  const query = projectNameFromCwd(input.cwd)
  if (!query) return
  const projectId = projectIdFromCwd(input.cwd)

  const memories = await queryMemories(query, projectId)
  const text = formatMemories(memories, query)
  if (text) process.stdout.write(text)
}

main().catch((err) => {
  console.error(`[ccRecall] unexpected error: ${err.message}`)
})
