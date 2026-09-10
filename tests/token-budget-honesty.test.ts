// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Database } from '../src/core/database'
import { createServer } from '../src/api/server'
import { extractTopicsFromContent } from '../src/core/topic-extractor'
import {
  applyRowBudget, approximateTokens,
  startupLineCost, promptLineCost,
  STARTUP_CHROME_TOKENS, PROMPT_CHROME_TOKENS,
  DEFAULT_MAX_TOKENS, DEFAULT_PER_ROW_CHAR_CAP,
} from '../src/core/token-budget'

/**
 * The budget claimed "under 300 tokens" while pricing only `content` — not the
 * "- " prefix, the confidence suffix, the [key: …] handle, or the header and
 * footer the hook wraps around them. Measured 2026-09-11 against the real hook
 * with a corpus-shaped payload: contract 300, daemon claimed 225, hook actually
 * emitted 363.
 *
 * Two of these tests spawn the real hook rather than re-deriving its format.
 * A second copy of the rendering is exactly how the two drift apart — which is
 * the bug being fixed here, so reproducing it in the test would be absurd.
 */

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hooks')

let tmpHomes: string[] = []
afterEach(async () => {
  await Promise.all(tmpHomes.map(h => rm(h, { recursive: true, force: true })))
  tmpHomes = []
})

type Row = { id: number; content: string; source: string; confidence: number; key: string | null }

function rows(n: number, opts: { chars?: number; key?: string | null; confidence?: number; cjk?: boolean } = {}): Row[] {
  const chars = opts.chars ?? 663           // live median content length
  const unit = opts.cjk ? '記憶注入截斷測試' : 'finding pre-verify the pattern first '
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    content: unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars),
    source: `sess-${i}:session`,
    confidence: opts.confidence ?? 0.92,
    key: opts.key === undefined ? `synthetic-memory-key-slug-number-${i}-pad` : opts.key,
  }))
}

/** Run a hook for real and return what it wrote to stdout. */
async function runHook(
  hook: 'session-start.mjs' | 'user-prompt-submit.mjs',
  payload: Record<string, unknown>,
  respond: (url: string) => unknown,
): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'budget-hook-'))
  tmpHomes.push(home)
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(respond(req.url ?? '')))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  try {
    return await new Promise<string>((resolve) => {
      const child = spawn('node', [path.join(HOOKS, hook)], {
        env: { ...process.env, HOME: home, CCRECALL_PORT: String(port), CCRECALL_SESSION_START_STRATEGY: 'startup-v1' },
      })
      let out = ''
      child.stdout.on('data', c => { out += c })
      child.on('close', () => resolve(out))
      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    })
  } finally {
    server.close()
  }
}

describe('applyRowBudget accounting', () => {
  it('prices a row with the supplied cost function, not just its content', () => {
    const [row] = rows(1, { chars: 100 })
    const contentOnly = applyRowBudget([row], 1000, 100)
    const withDecoration = applyRowBudget([row], 1000, 100, {
      costOf: (clipped) => approximateTokens(clipped) + 20,
    })
    expect(withDecoration.usedTokens).toBe(contentOnly.usedTokens + 20)
  })

  it('subtracts reserved tokens from the budget before admitting rows', () => {
    const three = rows(3, { chars: 100 })
    const unreserved = applyRowBudget(three, 200, 100)
    const reserved = applyRowBudget(three, 200, 100, { reservedTokens: 150 })
    expect(reserved.emitted.length).toBeLessThan(unreserved.emitted.length)
  })

  it('counts reserved tokens in usedTokens, so the number means total output', () => {
    // Reporting only the rows would understate the very thing this fixes.
    const budgeted = applyRowBudget(rows(1, { chars: 50 }), 500, 50, { reservedTokens: 40 })
    expect(budgeted.usedTokens).toBeGreaterThanOrEqual(40)
  })

  it('without a cost function it behaves exactly as before', () => {
    const three = rows(3, { chars: 200 })
    expect(applyRowBudget(three, 300, 150)).toEqual(applyRowBudget(three, 300, 150, {}))
  })
})

describe('minimum-one-row floor', () => {
  it('emits nothing when the first row does not fit and the floor is off', () => {
    // Historical behaviour, kept as the default so nothing changes silently.
    const budgeted = applyRowBudget(rows(1, { chars: 600, cjk: true }), 50, 150)
    expect(budgeted.emitted).toEqual([])
  })

  it('with the floor on, trims the first row to fit instead of dropping it', () => {
    // A CJK memory costs 1 token per character, so at 149 chars it alone
    // exceeds the mid-conversation budget and the caller received nothing at
    // all. Trimming keeps the contract intact while still saying something.
    const budgeted = applyRowBudget(rows(1, { chars: 600, cjk: true }), 50, 150, {
      minimumOneRow: true,
    })
    expect(budgeted.emitted).toHaveLength(1)
    expect(approximateTokens(budgeted.emitted[0].content)).toBeLessThanOrEqual(50)
    expect(budgeted.usedTokens).toBeLessThanOrEqual(50)
  })

  it('the floor never inflates a row that already fits', () => {
    const small = rows(1, { chars: 30 })
    const withFloor = applyRowBudget(small, 300, 150, { minimumOneRow: true })
    const without = applyRowBudget(small, 300, 150)
    expect(withFloor.emitted[0].content).toBe(without.emitted[0].content)
  })

  it('the floor gives up rather than emit a bullet that says nothing', () => {
    // Budget deliberately set so the trim loop RUNS and can only produce a few
    // characters. The first version of this test used reservedTokens equal to
    // the budget, which returned early on `budget <= 0` and never reached the
    // loop — it passed while asserting nothing about it. Caught by mutation:
    // removing the guard inside the loop left the suite green.
    const cjk = rows(1, { chars: 600, cjk: true, key: null })
    const overhead = promptLineCost('', { key: null })
    const budgeted = applyRowBudget(cjk, overhead + 3, 150, {
      costOf: promptLineCost, minimumOneRow: true,
    })
    expect(budgeted.emitted).toEqual([])
  })

  it('the floor does emit once there is room for something readable', () => {
    // The counter-probe for the test above: same shape, enough budget. Without
    // this, tightening MIN_TRIMMED_CHARS to infinity would satisfy the pair.
    const cjk = rows(1, { chars: 600, cjk: true, key: null })
    const overhead = promptLineCost('', { key: null })
    const budgeted = applyRowBudget(cjk, overhead + 40, 150, {
      costOf: promptLineCost, minimumOneRow: true,
    })
    expect(budgeted.emitted).toHaveLength(1)
    expect(Array.from(budgeted.emitted[0].content).length).toBeGreaterThanOrEqual(12)
  })
})

describe('cost functions mirror what the hooks actually write', () => {
  it('startup: predicted total matches the real hook output', async () => {
    const payload = rows(5)
    const budgeted = applyRowBudget(payload, DEFAULT_MAX_TOKENS, DEFAULT_PER_ROW_CHAR_CAP, {
      costOf: startupLineCost,
      reservedTokens: STARTUP_CHROME_TOKENS,
    })

    const stdout = await runHook('session-start.mjs', { cwd: '/tmp/p', session_id: 's1', source: 'startup' }, (url) =>
      url.startsWith('/health')
        ? { status: 'ok', memoryCount: 1639 }
        : {
            memories: budgeted.emitted,
            emittedIds: budgeted.emitted.map(m => m.id),
            candidateCount: payload.length,
            totalTokenEstimate: budgeted.usedTokens,
            droppedCount: budgeted.droppedCount,
            truncated: budgeted.truncated,
            project: '-p',
            limit: 5,
          })

    const actual = approximateTokens(stdout)
    expect(actual).toBeGreaterThan(0)
    // The estimate must not UNDERSTATE reality — that is the whole bug. A small
    // overestimate is acceptable and safe; the assertion is one-directional on
    // purpose, with a ceiling so a wildly conservative estimate still fails.
    expect(budgeted.usedTokens).toBeGreaterThanOrEqual(actual)
    expect(budgeted.usedTokens).toBeLessThanOrEqual(actual + 25)
  })

  it('startup: the real hook output stays within the contract', async () => {
    const payload = rows(5)
    const budgeted = applyRowBudget(payload, DEFAULT_MAX_TOKENS, DEFAULT_PER_ROW_CHAR_CAP, {
      costOf: startupLineCost,
      reservedTokens: STARTUP_CHROME_TOKENS,
    })
    const stdout = await runHook('session-start.mjs', { cwd: '/tmp/p', session_id: 's1', source: 'startup' }, (url) =>
      url.startsWith('/health')
        ? { status: 'ok', memoryCount: 1639 }
        : { memories: budgeted.emitted, emittedIds: [], candidateCount: 5, totalTokenEstimate: 0, droppedCount: 0, truncated: true, project: '-p', limit: 5 })

    expect(approximateTokens(stdout)).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS)
  })

  it('prompt: predicted total matches the real hook output', async () => {
    const payload = rows(2)
    const budgeted = applyRowBudget(payload, 170, DEFAULT_PER_ROW_CHAR_CAP, {
      costOf: promptLineCost,
      reservedTokens: PROMPT_CHROME_TOKENS,
      minimumOneRow: true,
    })

    const stdout = await runHook('user-prompt-submit.mjs', {
      cwd: '/tmp/p', session_id: 's1',
      prompt: 'what timeout does the prompt hook use and why is it that value',
    }, () => ({
      memories: budgeted.emitted,
      emittedIds: budgeted.emitted.map(m => m.id),
      droppedCount: budgeted.droppedCount,
      throttled: false,
      project: '-p',
    }))

    const actual = approximateTokens(stdout)
    expect(actual).toBeGreaterThan(0)
    expect(budgeted.usedTokens).toBeGreaterThanOrEqual(actual)
    expect(budgeted.usedTokens).toBeLessThanOrEqual(actual + 25)
  })

  it('a longer key costs more, because the hook renders it', () => {
    const short = startupLineCost('body', { confidence: 0.9, key: 'ab' })
    const long = startupLineCost('body', { confidence: 0.9, key: 'a'.repeat(58) })
    expect(long).toBeGreaterThan(short)
  })

  it('a key the hook refuses to render is not charged for', () => {
    // The hook drops any key over 60 chars rather than truncate it, so pricing
    // one would reserve tokens for text nobody ever sees.
    const rendered = startupLineCost('body', { confidence: 0.9, key: 'a'.repeat(58) })
    const dropped = startupLineCost('body', { confidence: 0.9, key: 'a'.repeat(61) })
    expect(dropped).toBeLessThan(rendered)
  })

  it('confidence of exactly 1 is not charged, because the hook omits it', () => {
    const shown = startupLineCost('body', { confidence: 0.92, key: null })
    const omitted = startupLineCost('body', { confidence: 1, key: null })
    expect(omitted).toBeLessThan(shown)
  })

  it('prompt lines are never charged for a confidence suffix', () => {
    // formatRecall in user-prompt-submit.mjs renders no confidence at all.
    expect(promptLineCost('body', { confidence: 0.5, key: null }))
      .toBe(promptLineCost('body', { confidence: 1, key: null }))
  })
})

describe('end to end: real endpoint into the real hook', () => {
  // The tests above prove the cost functions are right. They do NOT prove
  // routes.ts passes them — an endpoint that forgot `costOf` would keep every
  // one of them green while shipping the original bug. This is the only test
  // that fails if the wiring is dropped.
  let tmpDir: string
  let db: Database
  let server: http.Server
  let port: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'budget-e2e-'))
    db = new Database(path.join(tmpDir, 'e2e.db'))
    for (const row of rows(8)) {
      db.saveMemory({
        sessionId: null, messageId: null, content: row.content,
        type: 'discovery', confidence: row.confidence,
        projectId: '-budget-e2e', key: row.key,
      })
    }
    server = createServer(db)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()))
    db.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('what the user sees stays inside the contract', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'budget-e2e-home-'))
    tmpHomes.push(home)
    const stdout = await new Promise<string>((resolve) => {
      const child = spawn('node', [path.join(HOOKS, 'session-start.mjs')], {
        env: {
          ...process.env, HOME: home, CCRECALL_PORT: String(port),
          CCRECALL_SESSION_START_STRATEGY: 'startup-v1',
        },
      })
      let out = ''
      child.stdout.on('data', c => { out += c })
      child.on('close', () => resolve(out))
      child.stdin.write(JSON.stringify({ cwd: '/tmp/budget-e2e', session_id: 's1', source: 'startup' }))
      child.stdin.end()
    })

    expect(stdout).toContain('[ccRecall memory recall]')
    expect(approximateTokens(stdout)).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS)
  })

  it('what the endpoint reports covers everything the hook then writes', async () => {
    // The one assertion that actually pins honesty: feed the endpoint's own
    // response to the real hook and compare its stdout against the number the
    // endpoint reported. Anything the endpoint forgets to price — the chrome,
    // the handles, the confidence suffix — shows up here as stdout exceeding
    // the claim.
    //
    // Earlier attempts compared against the bare row content plus a constant.
    // Both passed while a mutant dropped `reservedTokens`, because the per-row
    // decoration alone (87 tokens at this size) already exceeded the chrome
    // reservation (52). Only the real output settles it.
    const res = await fetch(`http://127.0.0.1:${port}/memory/startup?project=-budget-e2e&limit=5`)
    const body = await res.json() as {
      totalTokenEstimate: number
      memories: { id: number; content: string; source: string; confidence: number; key: string | null }[]
    }

    const home = await mkdtemp(path.join(os.tmpdir(), 'budget-e2e-claim-'))
    tmpHomes.push(home)
    const stdout = await runHook('session-start.mjs', { cwd: '/tmp/p', session_id: 's1', source: 'startup' }, (url) =>
      url.startsWith('/health') ? { status: 'ok', memoryCount: 1639 } : body)

    const actual = approximateTokens(stdout)
    expect(actual).toBeGreaterThan(0)
    expect(body.totalTokenEstimate).toBeGreaterThanOrEqual(actual)
    expect(actual).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS)
  })

  it('the prompt endpoint still says something when one CJK memory blows the budget', async () => {
    // The floor has to be wired at the endpoint, not just available in the
    // library. A CJK memory costs one token per character, so at the 149-char
    // cap a single one exceeds the mid-conversation budget and the caller used
    // to receive an empty list — indistinguishable from "nothing relevant".
    const cjkDir = await mkdtemp(path.join(os.tmpdir(), 'budget-cjk-'))
    const cjkDb = new Database(path.join(cjkDir, 'cjk.db'))
    const content = '注入的內容為什麼會被裁切'.repeat(40)
    const memId = cjkDb.saveMemory({
      sessionId: null, messageId: null, content,
      type: 'discovery', confidence: 0.9, projectId: '-budget-cjk', key: 'cjk-key',
    })
    // saveMemory does not write memory_topics — recallSaveHandler does, and the
    // prompt path retrieves by topic. Skipping this returns an empty result for
    // a reason that has nothing to do with the budget.
    cjkDb.saveMemoryTopics(memId, '-budget-cjk', extractTopicsFromContent(content))
    const cjkServer = createServer(cjkDb)
    await new Promise<void>(r => cjkServer.listen(0, '127.0.0.1', () => r()))
    const cjkPort = (cjkServer.address() as { port: number }).port
    try {
      const res = await fetch(
        `http://127.0.0.1:${cjkPort}/memory/prompt?project=-budget-cjk&q=${encodeURIComponent('注入的內容為什麼會被裁切')}&sessionId=s-cjk`,
      )
      const body = await res.json() as { memories: { content: string }[] }
      expect(body.memories.length).toBeGreaterThanOrEqual(1)
      expect(body.memories[0].content.length).toBeGreaterThan(0)
    } finally {
      await new Promise<void>(r => cjkServer.close(() => r()))
      cjkDb.close()
      await rm(cjkDir, { recursive: true, force: true })
    }
  })
})
