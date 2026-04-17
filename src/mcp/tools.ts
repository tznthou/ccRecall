import * as z from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../core/database.js'
import type { Memory, MemoryType, KnowledgeDepth } from '../core/types.js'
import { deriveDepth } from '../core/types.js'
import { normalizeTopicKey } from '../core/topic-extractor.js'

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
}

function formatMemoryLine(m: Memory): string {
  const conf = m.confidence !== 1 ? ` (conf ${m.confidence.toFixed(2)})` : ''
  return `- [${m.type}]${conf} ${m.content}`
}

export function formatMemories(memories: Memory[], query: string): string {
  if (memories.length === 0) return `No memories found for: ${query}`
  return memories.map(formatMemoryLine).join('\n')
}

export function recallQueryHandler(
  db: Database,
  args: { query: string; limit?: number },
): McpTextResult {
  try {
    const memories = db.queryMemories(args.query, args.limit ?? 10)
    return textResult(formatMemories(memories, args.query))
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
): string {
  if (clusters.length === 0 && (!fallbackMemories || fallbackMemories.length === 0)) {
    return `No relevant memories for: ${keywords.join(', ')}`
  }
  const parts: string[] = [`# Relevant memories for: ${keywords.join(', ')}`, '']
  for (const c of clusters) {
    parts.push(`## Topic: ${c.topic} (${c.depth}, ${c.mentionCount} mentions)`)
    if (c.memories.length === 0) {
      parts.push('(no memories linked yet)')
    } else {
      for (const m of c.memories) parts.push(formatMemoryLine(m))
    }
    parts.push('')
  }
  if (fallbackMemories && fallbackMemories.length > 0) {
    parts.push('## FTS fallback (no topic match)')
    for (const m of fallbackMemories) parts.push(formatMemoryLine(m))
    parts.push('')
  }
  if (unmatchedKeywords.length > 0) {
    parts.push(`(No topic match for: ${unmatchedKeywords.join(', ')})`)
  }
  return parts.join('\n').trimEnd()
}

const recallContextInput = {
  projectId: z.string().min(1).describe('Project ID (derived from cwd, e.g. "-Users-foo-my-project")'),
  keywords: z.array(z.string().min(1)).min(1).describe('Candidate topic keywords (e.g. ["typescript", "mcp"])'),
  memoryLimit: z.number().int().positive().max(20).optional().describe('Max memories per topic (default 5)'),
}

export function recallContextHandler(
  db: Database,
  args: { projectId: string; keywords: string[]; memoryLimit?: number },
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

    return textResult(formatContextResult(clusters, unmatched, fallback, args.keywords))
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
  server.registerTool(
    'recall_query',
    {
      title: 'Query ccRecall Memories',
      description: [
        'Search ccRecall memories by keyword (FTS5 full-text search).',
        '',
        'USE THIS WHEN:',
        '- User references past work ("what did we decide", "previously", "last time")',
        '- Continuing a topic from a prior Claude Code session',
        '- You need context about past decisions, discoveries, patterns, or preferences',
        '',
        'Returns: formatted list of matching memories with type and confidence.',
      ].join('\n'),
      inputSchema: recallQueryInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => recallQueryHandler(db, args),
  )

  server.registerTool(
    'recall_context',
    {
      title: 'Get Topic-Clustered Memories',
      description: [
        'Retrieve memories clustered by topic (uses knowledge_map, not plain FTS).',
        '',
        'USE THIS WHEN:',
        '- Starting work on a topic and want to see what you already know about it',
        '- User asks "what do we know about X" / "what\'s our take on Y"',
        '- You want memories grouped by theme, with knowledge depth signals',
        '',
        'vs recall_query:',
        '- recall_query: raw FTS search, returns flat list',
        '- recall_context: topic-aware, groups results, shows mention count + depth',
        '',
        'Returns: markdown with memory clusters by topic, plus FTS fallback if no topic match.',
      ].join('\n'),
      inputSchema: recallContextInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => recallContextHandler(db, args),
  )

  server.registerTool(
    'recall_save',
    {
      title: 'Save Memory to ccRecall',
      description: [
        'Save a new memory to ccRecall for recall in future sessions.',
        '',
        'USE THIS WHEN:',
        '- User states a decision worth remembering across sessions',
        '- You discover something non-obvious (bug cause, API quirk, design constraint)',
        '- User explicitly says "remember this" or "save this"',
        '',
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
