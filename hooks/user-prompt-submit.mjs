#!/usr/bin/env node
// ccRecall UserPromptSubmit hook — mid-conversation recall (L1).
// Wired via ~/.claude/settings.json hooks.UserPromptSubmit. Stdout is added to
// Claude's context for this turn; errors go to stderr only.
//
// Why this exists: SessionStart injects once, at second zero. Everything after
// it — however long the session runs, whatever subject it turns to — had no
// memory access at all, which is why recall_query accounted for under 1% of all
// memory surfacing. This is the second trigger point.
//
// Why it is deliberately timid:
//   - It runs on EVERY prompt, blocking the user's path to a response. A slow
//     or dead daemon must cost nothing, so the timeout is short and every
//     failure path exits 0 with no output.
//   - additionalContext accumulates in history rather than being request-scoped
//     (anthropics/claude-code#40216), so each injection is permanent context
//     weight. Per-session dedup and a hard ceiling live in the daemon; the
//     cheap skips (short prompts, slash commands) live here so they cost no
//     round trip at all.
//
// Plain stdout is used rather than hookSpecificOutput JSON: the docs support
// both for this event, and the JSON form errors on the first message of a new
// session (anthropics/claude-code#17550).
import http from 'node:http'

const PORT = Number(process.env.CCRECALL_PORT ?? 7749)
const HOST = '127.0.0.1'
// This hook runs on every prompt, so it needs a kill switch that does not
// require editing settings.json — same shape as CCRECALL_SESSION_START_STRATEGY.
const DISABLED = process.env.CCRECALL_PROMPT_RECALL === 'off'
// 300ms: a localhost topic lookup over an indexed table answers in well under
// 50ms. This is generous headroom, and still short enough that a hung daemon is
// imperceptible rather than a stall the user feels on every prompt.
const TIMEOUT_MS = 300
// Below this a prompt is almost always a continuation that introduces no new
// subject, so there is nothing to recall against and no reason to pay for a
// round trip. Two thresholds because one code-point count cannot serve both
// scripts: 「這個 bug 怎麼修」 carries a full question in 10 characters while
// "ok go ahead now" carries none in 15. The codebase already draws this
// distinction (MIN_TOPIC_LENGTH 3 vs MIN_TOPIC_LENGTH_CJK 2 in topic-extractor).
const MIN_PROMPT_CHARS = 12
const MIN_PROMPT_CHARS_CJK = 6
const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
// Prompt text is only a topic-extraction seed; the opening sentences carry the
// subject, and a pasted file would otherwise push a huge query string.
const MAX_QUERY_CHARS = 300
// A key longer than this is not rendered at all rather than truncated: a clipped
// key is a handle that silently resolves to nothing. Observed keys run to 52
// characters, while the write schema permits 100.
const MAX_KEY_CHARS = 60

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
          console.error(`[ccRecall] prompt recall failed ${res.statusCode}`)
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
    // Diagnostics go to stderr, never stdout: stdout is context. Without these
    // a dead daemon is indistinguishable from "nothing relevant" — the same
    // silent-failure shape this release fixes on the extraction side.
    req.on('error', (err) => {
      console.error(`[ccRecall] prompt recall error: ${err.message} (service on :${PORT}?)`)
      resolve(null)
    })
    req.on('timeout', () => {
      req.destroy()
      console.error(`[ccRecall] prompt recall timeout after ${TIMEOUT_MS}ms`)
      resolve(null)
    })
    req.end()
  })
}

// Matches Claude Code's project-directory encoding under ~/.claude/projects/
function projectIdFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return ''
  return cwd.replace(/\//g, '-')
}

function formatRecall(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return ''
  const lines = memories.map((m) => {
    const handle = m.key && m.key.length <= MAX_KEY_CHARS ? ` [key: ${m.key}]` : ''
    return `- ${m.content}${handle}`
  })
  return [
    '[ccRecall — related to what you just asked]',
    '',
    ...lines,
    '',
    '(Excerpts — recall_query a [key] for the full text.)',
  ].join('\n')
}

async function main() {
  if (DISABLED) return
  let input
  try {
    const raw = await readStdin()
    input = raw ? JSON.parse(raw) : {}
  } catch {
    return
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) return
  // Slash commands address the harness, not the subject matter.
  if (prompt.startsWith('/')) return
  const minChars = CJK_REGEX.test(prompt) ? MIN_PROMPT_CHARS_CJK : MIN_PROMPT_CHARS
  if (Array.from(prompt).length < minChars) return

  const projectId = projectIdFromCwd(input.cwd)
  if (!projectId) return

  // Neither limit nor maxTokens is sent: the daemon owns budget policy, and it
  // can be changed by upgrading the service rather than by rewriting a hook
  // file already installed in the user's settings.
  const params = new URLSearchParams({
    project: projectId,
    q: Array.from(prompt).slice(0, MAX_QUERY_CHARS).join(''),
  })
  if (input.session_id) params.set('sessionId', input.session_id)

  const result = await httpGet(`/memory/prompt?${params.toString()}`)
  if (!result || result.throttled) return

  const text = formatRecall(result.memories)
  if (text) process.stdout.write(text + '\n')
}

main().catch((err) => {
  // Never let a recall failure interfere with the user's prompt.
  console.error(`[ccRecall] prompt recall failed: ${err.message}`)
})
