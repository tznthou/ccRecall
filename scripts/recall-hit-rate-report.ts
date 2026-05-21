// SPDX-License-Identifier: Apache-2.0
//
// recall_hit_rate analysis script — reads telemetry log, cross-references
// memories DB, prints cold-rate root-cause breakdown.
//
// Usage:
//   pnpm tsx scripts/recall-hit-rate-report.ts
//   pnpm tsx scripts/recall-hit-rate-report.ts --log <path> --db <path> --json

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import {
  analyzeRecallTelemetry,
  formatRecallHitRateReport,
} from '../src/core/recall-hit-rate-report.js'
import type { RecallTelemetryEntry } from '../src/core/recall-telemetry.js'

interface CliArgs {
  logPath: string
  dbPath: string
  json: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    logPath: path.join(os.homedir(), '.ccrecall', 'recall-query.log.jsonl'),
    dbPath: path.join(os.homedir(), '.ccrecall', 'ccrecall.db'),
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--log' && argv[i + 1]) {
      args.logPath = argv[++i]
    } else if (a === '--db' && argv[i + 1]) {
      args.dbPath = argv[++i]
    } else if (a === '--json') {
      args.json = true
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: pnpm tsx scripts/recall-hit-rate-report.ts [--log <path>] [--db <path>] [--json]\n',
      )
      process.exit(0)
    }
  }
  return args
}

function readTelemetryLog(logPath: string): RecallTelemetryEntry[] {
  if (!existsSync(logPath)) {
    process.stderr.write(`telemetry log not found: ${logPath}\n`)
    process.exit(1)
  }
  const raw = readFileSync(logPath, 'utf8')
  const entries: RecallTelemetryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as RecallTelemetryEntry)
    } catch {
      // skip malformed lines (forward-compat with future schema changes)
    }
  }
  return entries
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const entries = readTelemetryLog(args.logPath)

  if (!existsSync(args.dbPath)) {
    process.stderr.write(`db not found: ${args.dbPath}\n`)
    process.exit(1)
  }

  const db = new BetterSqlite3(args.dbPath, { readonly: true, fileMustExist: true })
  const stmt = db.prepare('SELECT 1 FROM memories WHERE content LIKE ? LIMIT 1')
  const matcher = (q: string): boolean => stmt.get(`%${q}%`) !== undefined

  const analysis = analyzeRecallTelemetry(entries, matcher)
  db.close()

  if (args.json) {
    process.stdout.write(JSON.stringify(analysis, null, 2) + '\n')
  } else {
    process.stdout.write(formatRecallHitRateReport(analysis) + '\n')
  }
}

main()
