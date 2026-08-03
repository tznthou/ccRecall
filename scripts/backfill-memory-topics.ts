// SPDX-License-Identifier: Apache-2.0
//
// Maintenance script for memory_topics.
//
// Two modes:
//   backfill (default) — topics for memories that have none. Phase 3.0
//     prerequisite: Tier 0 cross-project queries need memory_topics.
//   --rebuild          — recompute topics for EVERY memory. Required whenever
//     extractTopicsFromContent changes (e.g. #80's Intl.Segmenter switch),
//     because backfill skips any memory that already has rows and therefore
//     leaves stale topics in place.
//
// Usage:
//   pnpm tsx scripts/backfill-memory-topics.ts
//   pnpm tsx scripts/backfill-memory-topics.ts --rebuild --dry-run
//   pnpm tsx scripts/backfill-memory-topics.ts --rebuild
//   pnpm tsx scripts/backfill-memory-topics.ts --db <path>
//
// After a --rebuild, run rebuildKnowledgeMap for each affected project so the
// knowledge_map aggregate reflects the new topic keys.

import path from 'node:path'
import os from 'node:os'
import { Database } from '../src/core/database.js'
import { extractTopicsFromContent } from '../src/core/topic-extractor.js'

const argv = process.argv
const dbPath = argv.includes('--db')
  ? argv[argv.indexOf('--db') + 1]
  : path.join(os.homedir(), '.ccrecall', 'ccrecall.db')
const rebuild = argv.includes('--rebuild')
const dryRun = argv.includes('--dry-run')

// backfillMemoryTopics has no dry-run path, so the flag cannot be honoured in
// default mode. Refuse rather than write while the user believes nothing is
// being written.
if (dryRun && !rebuild) {
  console.error('--dry-run is only supported with --rebuild.')
  console.error('Backfill mode has no preview path; re-run with --rebuild --dry-run,')
  console.error('or drop --dry-run to backfill topic-less memories for real.')
  process.exit(1)
}

console.log(`DB: ${dbPath}`)
console.log(`Mode: ${rebuild ? 'rebuild (all memories)' : 'backfill (topic-less only)'}${dryRun ? ' [dry run]' : ''}`)

const db = new Database(dbPath)

const orphansRemoved = dryRun ? 0 : db.cleanOrphanedMemoryTopics()
if (!dryRun) console.log(`Orphaned memory_topics removed: ${orphansRemoved}`)

if (rebuild) {
  const cjkBefore = db.rawAll<{ c: number }>(
    "SELECT COUNT(*) AS c FROM memory_topics WHERE topic_key GLOB '*[一-龥]*'",
  )[0].c

  const r = db.rebuildMemoryTopics(extractTopicsFromContent, { dryRun })

  console.log(`Memories scanned            : ${r.scanned}`)
  console.log(`Memories with changed topics: ${r.changed}`)
  console.log(`memory_topics rows before   : ${r.topicsBefore}`)
  console.log(`memory_topics rows after    : ${r.topicsAfter}`)
  console.log(`  ...of which CJK before    : ${cjkBefore}`)

  if (!dryRun) {
    const cjkAfter = db.rawAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM memory_topics WHERE topic_key GLOB '*[一-龥]*'",
    )[0].c
    console.log(`  ...of which CJK after     : ${cjkAfter}`)
    console.log('')
    console.log('Next: rebuild knowledge_map for affected projects.')
  } else {
    console.log('')
    console.log('Dry run — nothing written.')
  }
} else {
  const backfilled = db.backfillMemoryTopics(extractTopicsFromContent)
  console.log(`Memories backfilled with topics: ${backfilled}`)
  if (backfilled === 0) {
    console.log('')
    console.log('0 processed. If the extractor changed, this mode cannot help —')
    console.log('it only sees memories with no topics at all. Use --rebuild.')
  }
}

db.close()
