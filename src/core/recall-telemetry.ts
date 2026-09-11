// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from 'node:fs'
import { ensureCcrecallDir, secureCcrecallFile, CCRECALL_FILE_MODE } from './secure-dir.js'
import path from 'node:path'
import os from 'node:os'

const QUERY_TRUNCATE_LEN = 80

export interface RecallTelemetryInput {
  query: string
  hitCount: number
  projectId?: string | null
  limit: number
  maxTokens?: number | null
}

export interface RecallTelemetryEntry {
  ts: string
  query: string
  queryLen: number
  hitCount: number
  projectId: string | null
  limit: number
  maxTokens: number | null
}

function defaultTelemetryPath(): string {
  return path.join(os.homedir(), '.ccrecall', 'recall-query.log.jsonl')
}

function resolveTelemetryPath(override?: string): string {
  if (override) return override
  const envPath = process.env.CCRECALL_RECALL_TELEMETRY_PATH
  if (envPath) return envPath
  return defaultTelemetryPath()
}

export function buildRecallTelemetryEntry(
  input: RecallTelemetryInput,
  now: Date = new Date(),
): RecallTelemetryEntry {
  return {
    ts: now.toISOString(),
    query: input.query.slice(0, QUERY_TRUNCATE_LEN),
    queryLen: input.query.length,
    hitCount: input.hitCount,
    projectId: input.projectId ?? null,
    limit: input.limit,
    maxTokens: input.maxTokens ?? null,
  }
}

export function appendRecallTelemetry(
  input: RecallTelemetryInput,
  options: { pathOverride?: string; now?: Date } = {},
): void {
  if (process.env.CCRECALL_RECALL_TELEMETRY_OFF === '1') return

  const telemetryPath = resolveTelemetryPath(options.pathOverride)
  const entry = buildRecallTelemetryEntry(input, options.now)

  try {
    // #95: this was the one creator that already passed a mode, and it is now
    // routed through the shared helper so it also repairs a directory an older
    // install left at 0755 — passing `mode` only ever affected a directory this
    // call actually created.
    ensureCcrecallDir(path.dirname(telemetryPath))
    appendFileSync(telemetryPath, JSON.stringify(entry) + '\n', { mode: CCRECALL_FILE_MODE })
    secureCcrecallFile(telemetryPath)
  } catch {
    // telemetry write must never affect endpoint response;
    // swallow errors (privilege issues, disk full, etc.)
  }
}
