// SPDX-License-Identifier: Apache-2.0
import * as z from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../core/database.js'
import { MemoryService } from '../core/memory-service.js'
import type { Memory, MemoryType, KnowledgeDepth } from '../core/types.js'
import { deriveDepth } from '../core/types.js'
import { normalizeTopicKey } from '../core/topic-extractor.js'
import {
  approximateTokens,
  truncateToChars,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PER_ROW_CHAR_CAP,
} from '../core/token-budget.js'

// Reserve tokens for trailer + possible unmatched-keyword note before
// selecting memory rows, so final text respects the maxTokens target.
const TRAILER_RESERVE_TOKENS = 20

const MEMORY_TYPES = ['decision', 'discovery', 'preference', 'pattern', 'feedback'] as const

type McpTextResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
}

function textResult(text: string): McpTextResult {
  return { content: [{ type: 'text' as const, text }] }
}

function textError(prefix: string, err: unknown): McpTextResult {
  const msg = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text' as const, text: `${prefix}: ${msg}` }], isError: true }
}

const recallQueryInput = {
  query: z.string().min(1).describe('FTS5 search query (keywords or phrase)'),
  limit: z.number().int().positive().max(50).optional().describe('Max results (default 10, max 50)'),
  maxTokens: z.number().int().positive().max(2000).optional().describe(
    `Approximate total output token budget (default ${DEFAULT_MAX_TOKENS}). Results are truncated with per-row ellipsis and a trailer so clipping is always visible.`,
  ),
}

function formatMemoryLine(m: Memory): string {
  const conf = m.confidence !== 1 ? ` (conf ${m.confidence.toFixed(2)})` : ''
  return `- [${m.type}]${conf} ${truncateToChars(m.content, DEFAULT_PER_ROW_CHAR_CAP)}`
}

function takeWithinBudget(
  memories: Memory[],
  budget: number,
): { taken: string[]; takenIds: number[]; dropped: number; usedTokens: number } {
  const taken: string[] = []
  const takenIds: number[] = []
  let used = 0
  for (let i = 0; i < memories.length; i++) {
    const line = formatMemoryLine(memories[i])
    const cost = approximateTokens(line)
    if (used + cost > budget) {
      return { taken, takenIds, dropped: memories.length - i, usedTokens: used }
    }
    taken.push(line)
    takenIds.push(memories[i].id)
    used += cost
  }
  return { taken, takenIds, dropped: 0, usedTokens: used }
}

export interface FormattedResult {
  text: string
  emittedIds: number[]
}

export function formatMemories(
  memories: Memory[],
  query: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): FormattedResult {
  if (memories.length === 0) return { text: `No memories found for: ${query}`, emittedIds: [] }
  const memoryBudget = Math.max(0, maxTokens - TRAILER_RESERVE_TOKENS)
  const { taken, takenIds, dropped } = takeWithinBudget(memories, memoryBudget)
  if (dropped > 0) taken.push(`(... +${dropped} more memories truncated)`)
  return { text: taken.join('\n'), emittedIds: takenIds }
}

export function recallQueryHandler(
  db: Database,
  memoryService: MemoryService,
  args: { query: string; limit?: number; maxTokens?: number },
): McpTextResult {
  try {
    const memories = db.queryMemories(args.query, args.limit ?? 10)
    const { text, emittedIds } = formatMemories(memories, args.query, args.maxTokens)
    // Phase 4c: touch only memories that actually reached the caller.
    // Budget-dropped rows are not "surfaced" — bumping their access_count
    // would skew decay / compression toward unused content.
    memoryService.touch(emittedIds)
    return textResult(text)
  } catch (err) {
    return textError('Error querying memories', err)
  }
}

const recallSaveInput = {
  content: z.string().min(1).describe('Memory content — the fact or insight to remember'),
  type: z.enum(MEMORY_TYPES).describe('Memory category'),
  sessionId: z.string().nullable().optional().describe('Origin session ID (optional)'),
  messageId: z.string().nullable().optional().describe('Origin message ID (optional)'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (default 1)'),
  projectId: z.string().nullable().optional().describe(
    'Project ID for scoped queries. Session-backed memories derive this from sessions.project_id automatically; manual memories should set this to avoid cross-project leakage.',
  ),
}

interface TopicCluster {
  topic: string
  depth: KnowledgeDepth
  mentionCount: number
  memories: Memory[]
}

export function formatContextResult(
  clusters: TopicCluster[],
  unmatchedKeywords: string[],
  fallbackMemories: Memory[] | null,
  keywords: string[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
): FormattedResult {
  if (clusters.length === 0 && (!fallbackMemories || fallbackMemories.length === 0)) {
    return { text: `No relevant memories for: ${keywords.join(', ')}`, emittedIds: [] }
  }
  let remaining = Math.max(0, maxTokens - TRAILER_RESERVE_TOKENS)
  const mainHeader = `# Relevant memories for: ${keywords.join(', ')}`
  remaining -= approximateTokens(mainHeader)
  const parts: string[] = [mainHeader, '']
  const emittedIds: number[] = []
  let totalDropped = 0
  for (const c of clusters) {
    const clusterHeader = `## Topic: ${c.topic} (${c.depth}, ${c.mentionCount} mentions)`
    const headerCost = approximateTokens(clusterHeader)
    if (remaining < headerCost) {
      totalDropped += c.memories.length
      continue
    }
    parts.push(clusterHeader)
    remaining -= headerCost
    if (c.memories.length === 0) {
      parts.push('(no memories linked yet)')
    } else {
      const result = takeWithinBudget(c.memories, remaining)
      parts.push(...result.taken)
      remaining -= result.usedTokens
      totalDropped += result.dropped
      emittedIds.push(...result.takenIds)
    }
    parts.push('')
  }
  if (fallbackMemories && fallbackMemories.length > 0) {
    const fbHeader = '## FTS fallback (no topic match)'
    const headerCost = approximateTokens(fbHeader)
    if (remaining < headerCost) {
      totalDropped += fallbackMemories.length
    } else {
      parts.push(fbHeader)
      const result = takeWithinBudget(fallbackMemories, remaining - headerCost)
      parts.push(...result.taken)
      totalDropped += result.dropped
      emittedIds.push(...result.takenIds)
      parts.push('')
    }
  }
  if (totalDropped > 0) {
    parts.push(`(... +${totalDropped} more memories truncated)`)
  }
  if (unmatchedKeywords.length > 0) {
    parts.push(`(No topic match for: ${unmatchedKeywords.join(', ')})`)
  }
  return { text: parts.join('\n').trimEnd(), emittedIds }
}

const recallContextInput = {
  projectId: z.string().min(1).describe('Project ID (derived from cwd, e.g. "-Users-foo-my-project")'),
  keywords: z.array(z.string().min(1)).min(1).describe('Candidate topic keywords (e.g. ["typescript", "mcp"])'),
  memoryLimit: z.number().int().positive().max(20).optional().describe('Max memories per topic (default 5)'),
  maxTokens: z.number().int().positive().max(2000).optional().describe(
    `Approximate total output token budget (default ${DEFAULT_MAX_TOKENS}). Results are truncated with per-row ellipsis and a trailer so clipping is always visible.`,
  ),
}

export function recallContextHandler(
  db: Database,
  memoryService: MemoryService,
  args: { projectId: string; keywords: string[]; memoryLimit?: number; maxTokens?: number },
): McpTextResult {
  try {
    const memoryLimit = args.memoryLimit ?? 5
    const normalized = args.keywords
      .map(k => ({ raw: k, key: normalizeTopicKey(k) }))
      .filter((x): x is { raw: string; key: string } => x.key !== null)

    const clusters: TopicCluster[] = []
    const unmatched: string[] = []

    for (const { raw, key } of normalized) {
      const topic = db.getTopic(key, args.projectId)
      if (!topic) {
        unmatched.push(raw)
        continue
      }
      const memories = db.getMemoriesByTopics(args.projectId, [key], memoryLimit)
      clusters.push({
        topic: key,
        depth: deriveDepth(topic.mentionCount),
        mentionCount: topic.mentionCount,
        memories,
      })
    }

    // FTS fallback if no topic matched — per-keyword union (queryMemories quotes every
    // token into a phrase, so "foo OR bar" collapses to a phrase query, not a boolean OR)
    let fallback: Memory[] | null = null
    if (clusters.length === 0 && args.keywords.length > 0) {
      const seen = new Set<number>()
      const aggregated: Memory[] = []
      for (const kw of args.keywords) {
        if (aggregated.length >= memoryLimit) break
        const results = db.queryMemories(kw, memoryLimit, args.projectId)
        for (const m of results) {
          if (aggregated.length >= memoryLimit) break
          if (!seen.has(m.id)) {
            seen.add(m.id)
            aggregated.push(m)
          }
        }
      }
      fallback = aggregated
    }

    const { text, emittedIds } = formatContextResult(
      clusters,
      unmatched,
      fallback,
      args.keywords,
      args.maxTokens,
    )
    // Phase 4c: touch only memories that actually reached the caller.
    // MemoryService.touch dedupes internally.
    memoryService.touch(emittedIds)
    return textResult(text)
  } catch (err) {
    return textError('Error building context', err)
  }
}

export function recallSaveHandler(
  db: Database,
  args: {
    content: string
    type: MemoryType
    sessionId?: string | null
    messageId?: string | null
    confidence?: number
    projectId?: string | null
  },
): McpTextResult {
  try {
    const id = db.saveMemory({
      sessionId: args.sessionId ?? null,
      messageId: args.messageId ?? null,
      content: args.content,
      type: args.type,
      confidence: args.confidence ?? 1,
      projectId: args.projectId ?? null,
    })
    return textResult(`Saved memory #${id} (type: ${args.type})`)
  } catch (err) {
    return textError('Error saving memory', err)
  }
}

export function registerTools(server: McpServer, db: Database): void {
  const memoryService = new MemoryService(db)
  server.registerTool(
    'recall_query',
    {
      title: 'Query ccRecall Memories',
      description: [
        'Search ccRecall memories by keyword (FTS5 full-text search).',
        '',
        'DEFERENCE — USE ONLY AFTER checking auto memory first.',
        'Claude Code loads ~/.claude/projects/*/memory/MEMORY.md into session',
        'context at startup; the curated index is already visible above this',
        'conversation. ccRecall is the long-tail fallback for details that',
        'were not worth hand-curating.',
        '',
        'USE THIS WHEN:',
        '- Auto memory has no relevant entry AND user references past work',
        '  ("what did we decide", "last time", "didn\'t we fix that")',
        '- Continuing a topic across many old sessions — harvester covers',
        '  what the curated index misses',
        '',
        'DO NOT USE:',
        '- When MEMORY.md already has the answer in context',
        '- As a first-line search — check auto memory first every time',
        '',
        'Returns: formatted list of matching memories with type and confidence.',
      ].join('\n'),
      inputSchema: recallQueryInput,
      // Phase 4c touch mutates access_count / last_accessed, so this tool is no
      // longer read-only or idempotent. Mislabelling would let MCP hosts retry
      // or cache under the wrong assumption and silently skew recall ranking.
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args) => recallQueryHandler(db, memoryService, args),
  )

  server.registerTool(
    'recall_context',
    {
      title: 'Get Topic-Clustered Memories',
      description: [
        'Retrieve memories clustered by topic (uses knowledge_map, not plain FTS).',
        '',
        'DEFERENCE — same as recall_query. USE ONLY AFTER auto memory misses.',
        'MEMORY.md is already in session context; reach for this tool when the',
        'hand-curated index has no dedicated entry for the topic.',
        '',
        'USE THIS WHEN:',
        '- Starting work on a topic AND auto memory has no dedicated entry',
        '- User asks "what do we know about X" and X is not indexed in MEMORY.md',
        '- You want memories grouped by theme with knowledge depth signals',
        '  (mention counts, depth tier) that auto memory does not carry',
        '',
        'vs recall_query:',
        '- recall_query: raw FTS, flat list — when you have specific keywords',
        '- recall_context: topic-aware, grouped, shows mention count + depth —',
        '  when exploring a theme',
        '',
        'Returns: markdown with memory clusters by topic, plus FTS fallback if no topic match.',
      ].join('\n'),
      inputSchema: recallContextInput,
      // Phase 4c touch mutates access_count / last_accessed per surfaced memory
      // (with cross-cluster dedup), so this tool is no longer read-only or
      // idempotent — same reasoning as recall_query above.
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args) => recallContextHandler(db, memoryService, args),
  )

  server.registerTool(
    'recall_save',
    {
      title: 'Save Memory to ccRecall',
      description: [
        'Save a new memory to ccRecall for recall in future sessions.',
        '',
        'RARELY USED MANUALLY. SessionEnd hook auto-harvests each session into',
        'ccRecall, so the long-tail path is already covered. The default for',
        'user-stated facts is auto memory: write a new .md file in',
        '~/.claude/projects/*/memory/ and add a line to MEMORY.md.',
        '',
        'USE THIS ONLY WHEN:',
        '- SessionEnd hook is demonstrably broken (harvest silently failing —',
        '  confirm via daemon log before reaching for this tool)',
        '- The fact is critical but auto memory is the wrong home (ephemeral',
        '  debug artifact that should not pollute the curated index)',
        '- User explicitly says "also save this to ccRecall" (the generic',
        '  "remember this" means auto memory)',
        '',
        'Do NOT call this to mirror a fact you already wrote to auto memory —',
        'the hook will harvest the session independently and duplicate writes',
        'create noise.',
        '',
        // Keep in sync with README.md + README_ZH.md "Memory types" section
        'Types:',
        '- decision: explicit choice with rationale',
        '- discovery: non-obvious finding',
        '- preference: user style or convention',
        '- pattern: recurring workflow or code template',
        '- feedback: user correction on past work',
        '',
        'Returns: memory ID and type confirmation.',
      ].join('\n'),
      inputSchema: recallSaveInput,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args) => recallSaveHandler(db, args),
  )
}
