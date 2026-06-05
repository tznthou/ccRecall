// SPDX-License-Identifier: Apache-2.0
//
// One-off script: backfill memory_topics for existing memories + clean orphans.
// Phase 3.0 prerequisite — Tier 0 cross-project queries need memory_topics.
//
// Usage:
//   pnpm tsx scripts/backfill-memory-topics.ts
//   pnpm tsx scripts/backfill-memory-topics.ts --db <path>

import path from 'node:path'
import os from 'node:os'
import { Database } from '../src/core/database.js'
import { extractTopicsFromContent } from '../src/core/topic-extractor.js'

const dbPath = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : path.join(os.homedir(), '.ccrecall', 'ccrecall.db')

console.log(`DB: ${dbPath}`)

const db = new Database(dbPath)

const orphansRemoved = db.cleanOrphanedMemoryTopics()
console.log(`Orphaned memory_topics removed: ${orphansRemoved}`)

const backfilled = db.backfillMemoryTopics(extractTopicsFromContent)
console.log(`Memories backfilled with topics: ${backfilled}`)

db.close()
