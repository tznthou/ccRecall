// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  appendRecallTelemetry,
  buildRecallTelemetryEntry,
} from '../src/core/recall-telemetry'

describe('recall-telemetry: buildRecallTelemetryEntry', () => {
  it('truncates query to 80 chars but preserves original queryLen', () => {
    const long = 'a'.repeat(200)
    const entry = buildRecallTelemetryEntry({
      query: long,
      hitCount: 3,
      limit: 5,
    })
    expect(entry.query.length).toBe(80)
    expect(entry.queryLen).toBe(200)
    expect(entry.hitCount).toBe(3)
    expect(entry.limit).toBe(5)
  })

  it('passes short query through unchanged', () => {
    const entry = buildRecallTelemetryEntry({
      query: 'ccRecall',
      hitCount: 1,
      limit: 5,
    })
    expect(entry.query).toBe('ccRecall')
    expect(entry.queryLen).toBe(8)
  })

  it('normalises projectId / maxTokens to null when absent', () => {
    const entry = buildRecallTelemetryEntry({
      query: 'q',
      hitCount: 0,
      limit: 5,
    })
    expect(entry.projectId).toBeNull()
    expect(entry.maxTokens).toBeNull()
  })

  it('uses injected clock for ts', () => {
    const fixed = new Date('2026-05-21T10:00:00.000Z')
    const entry = buildRecallTelemetryEntry(
      { query: 'q', hitCount: 0, limit: 5 },
      fixed,
    )
    expect(entry.ts).toBe('2026-05-21T10:00:00.000Z')
  })
})

describe('recall-telemetry: appendRecallTelemetry', () => {
  let tmpDir: string
  let logPath: string
  const originalOff = process.env.CCRECALL_RECALL_TELEMETRY_OFF
  const originalPath = process.env.CCRECALL_RECALL_TELEMETRY_PATH

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-telemetry-'))
    logPath = path.join(tmpDir, 'subdir', 'recall-query.log.jsonl')
    delete process.env.CCRECALL_RECALL_TELEMETRY_OFF
    delete process.env.CCRECALL_RECALL_TELEMETRY_PATH
  })

  afterEach(async () => {
    if (originalOff === undefined) {
      delete process.env.CCRECALL_RECALL_TELEMETRY_OFF
    } else {
      process.env.CCRECALL_RECALL_TELEMETRY_OFF = originalOff
    }
    if (originalPath === undefined) {
      delete process.env.CCRECALL_RECALL_TELEMETRY_PATH
    } else {
      process.env.CCRECALL_RECALL_TELEMETRY_PATH = originalPath
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes one JSONL row per call and creates parent dir', async () => {
    appendRecallTelemetry(
      { query: 'q1', hitCount: 2, limit: 5, projectId: 'p', maxTokens: 300 },
      { pathOverride: logPath },
    )
    appendRecallTelemetry(
      { query: 'q2', hitCount: 0, limit: 5 },
      { pathOverride: logPath },
    )

    const content = await readFile(logPath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    const row1 = JSON.parse(lines[0])
    expect(row1.query).toBe('q1')
    expect(row1.hitCount).toBe(2)
    expect(row1.projectId).toBe('p')
    expect(row1.maxTokens).toBe(300)
    expect(row1.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const row2 = JSON.parse(lines[1])
    expect(row2.query).toBe('q2')
    expect(row2.hitCount).toBe(0)
    expect(row2.projectId).toBeNull()
  })

  it('skips write when CCRECALL_RECALL_TELEMETRY_OFF=1', async () => {
    process.env.CCRECALL_RECALL_TELEMETRY_OFF = '1'
    appendRecallTelemetry(
      { query: 'q', hitCount: 1, limit: 5 },
      { pathOverride: logPath },
    )
    await expect(stat(logPath)).rejects.toThrow()
  })

  it('honours CCRECALL_RECALL_TELEMETRY_PATH env when no override given', async () => {
    process.env.CCRECALL_RECALL_TELEMETRY_PATH = logPath
    appendRecallTelemetry({ query: 'q', hitCount: 1, limit: 5 })
    const content = await readFile(logPath, 'utf8')
    expect(content.trim().split('\n').length).toBe(1)
  })

  it('fails silently when path is invalid (does not throw)', () => {
    // Append to a path under a non-writable parent — should not throw.
    // Use /dev/null as a parent to force ENOTDIR/EACCES.
    expect(() =>
      appendRecallTelemetry(
        { query: 'q', hitCount: 0, limit: 5 },
        { pathOverride: '/dev/null/subdir/log.jsonl' },
      ),
    ).not.toThrow()
  })
})
