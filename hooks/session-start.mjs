#!/usr/bin/env node
// ccRecall SessionStart hook — injects relevant memories as context at session start.
// Wired via ~/.claude/settings.json hooks.SessionStart. Output on stdout is
// prepended to Claude's context; errors go to stderr only.
//
// Strategy dispatch via CCRECALL_SESSION_START_STRATEGY (default: 'legacy'):
//   - 'legacy'     : project-name FTS via /memory/query (with token budget)
//   - 'startup-v1' : cold + recent-conf + FTS fallback via /memory/startup
//                    (closes keyword echo chamber — memory #119)
//   - 'off'        : no injection
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PORT = Number(process.env.CCRECALL_PORT ?? 7749)
const HOST = '127.0.0.1'
const TIMEOUT_MS = 2000
const MEMORY_LIMIT = 5
const MAX_TOKENS = 300
const STRATEGY = process.env.CCRECALL_SESSION_START_STRATEGY ?? 'startup-v1'
const TELEMETRY_OFF = process.env.CCRECALL_TELEMETRY === 'off'
const TELEMETRY_PATH = path.join(os.homedir(), '.ccrecall', 'startup-recall.log.jsonl')

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function httpGet(pathWithQuery) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: pathWithQuery,
      method: 'GET',
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[ccRecall] query failed ${res.statusCode}`)
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', (err) => {
      console.error(`[ccRecall] query error: ${err.message} (is the service running on :${PORT}?)`)
      resolve(null)
    })
    req.on('timeout', () => {
      console.error(`[ccRecall] query timeout after ${TIMEOUT_MS}ms`)
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

async function queryLegacy(query, projectId) {
  const params = new URLSearchParams({
    q: query,
    limit: String(MEMORY_LIMIT),
    maxTokens: String(MAX_TOKENS),
  })
  if (projectId) params.set('project', projectId)
  const result = await httpGet(`/memory/query?${params.toString()}`)
  return result && Array.isArray(result.memories) ? result.memories : []
}

async function queryStartupV1(query, projectId, sessionId) {
  const params = new URLSearchParams({
    project: projectId,
    q: query,
    limit: String(MEMORY_LIMIT),
    maxTokens: String(MAX_TOKENS),
  })
  if (sessionId) params.set('sessionId', sessionId)
  const result = await httpGet(`/memory/startup?${params.toString()}`)
  if (!result) return { memories: [], emittedIds: [], droppedCount: 0 }
  return {
    memories: Array.isArray(result.memories) ? result.memories : [],
    emittedIds: Array.isArray(result.emittedIds) ? result.emittedIds : [],
    droppedCount: typeof result.droppedCount === 'number' ? result.droppedCount : 0,
  }
}

function writeTelemetry(record) {
  if (TELEMETRY_OFF) return
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true })
    fs.appendFileSync(TELEMETRY_PATH, JSON.stringify(record) + '\n', 'utf8')
  } catch (err) {
    console.error(`[ccRecall] telemetry write failed: ${err.message}`)
  }
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

function formatStartupV1(memories, query, totalMemoryCount) {
  if (memories.length === 0 && totalMemoryCount === 0) return ''
  const lines = memories.map((m) => {
    const conf = m.confidence != null && m.confidence !== 1
      ? ` (conf ${Number(m.confidence).toFixed(2)})`
      : ''
    // #77: each line is a ~150-char excerpt of a memory averaging ~600, and the
    // cut typically lands before the conclusion. The key is the only handle that
    // makes the rest reachable — without it the reader can see that a line was
    // clipped (the ellipsis) but has no way to ask for the remainder. Appended
    // rather than prefixed so the content still leads.
    const handle = m.key ? ` [key: ${m.key}]` : ''
    return `- ${m.content}${conf}${handle}`
  })
  const parts = ['[ccRecall memory recall]', '']
  if (lines.length > 0) parts.push(...lines, '')
  if (lines.length > 0) {
    // The old footer only reported how many rows existed, which implied the rows
    // shown were whole. Say plainly that they are excerpts, and name the way out.
    const available = totalMemoryCount > memories.length
      ? ` ${totalMemoryCount} memories available.`
      : ''
    parts.push(
      `(Each line is a ~150-char excerpt — conclusions are often past the cut.`
      + ` recall_query a [key] for the full text.${available})`,
    )
  } else if (totalMemoryCount > 0) {
    parts.push(`(${totalMemoryCount} memories available — use recall_query to search.)`)
  }
  return parts.join('\n')
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
  if (STRATEGY === 'off') return

  const query = projectNameFromCwd(input.cwd)
  if (!query) return
  const projectId = projectIdFromCwd(input.cwd)
  const sessionId = input.session_id || null

  let text
  if (STRATEGY === 'startup-v1') {
    const [result, health] = await Promise.all([
      queryStartupV1(query, projectId, sessionId),
      httpGet('/health'),
    ])
    const memories = result.memories
    const totalMemoryCount = health && typeof health.memoryCount === 'number'
      ? health.memoryCount : 0
    writeTelemetry({
      ts: new Date().toISOString(),
      projectId,
      emittedIds: result.emittedIds,
      droppedCount: result.droppedCount,
    })
    text = formatStartupV1(memories, query, totalMemoryCount)
  } else {
    const memories = await queryLegacy(query, projectId)
    text = formatMemories(memories, query)
  }

  if (text) process.stdout.write(text)
}

main().catch((err) => {
  console.error(`[ccRecall] unexpected error: ${err.message}`)
})
