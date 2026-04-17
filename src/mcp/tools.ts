import * as z from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../core/database.js'
import type { Memory, MemoryType } from '../core/types.js'

const MEMORY_TYPES = ['decision', 'discovery', 'preference', 'pattern', 'feedback'] as const

const recallQueryInput = {
  query: z.string().min(1).describe('FTS5 search query (keywords or phrase)'),
  limit: z.number().int().positive().max(50).optional().describe('Max results (default 10, max 50)'),
}

export function formatMemories(memories: Memory[], query: string): string {
  if (memories.length === 0) return `No memories found for: ${query}`
  return memories
    .map((m) => {
      const conf = m.confidence !== 1 ? ` (conf ${m.confidence.toFixed(2)})` : ''
      return `- [${m.type}]${conf} ${m.content}`
    })
    .join('\n')
}

export function recallQueryHandler(
  db: Database,
  args: { query: string; limit?: number },
) {
  try {
    const memories = db.queryMemories(args.query, args.limit ?? 10)
    return {
      content: [{ type: 'text' as const, text: formatMemories(memories, args.query) }],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text' as const, text: `Error querying memories: ${msg}` }],
      isError: true,
    }
  }
}

const recallSaveInput = {
  content: z.string().min(1).describe('Memory content — the fact or insight to remember'),
  type: z.enum(MEMORY_TYPES).describe('Memory category'),
  sessionId: z.string().nullable().optional().describe('Origin session ID (optional)'),
  messageId: z.string().nullable().optional().describe('Origin message ID (optional)'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (default 1)'),
}

export function recallSaveHandler(
  db: Database,
  args: {
    content: string
    type: MemoryType
    sessionId?: string | null
    messageId?: string | null
    confidence?: number
  },
) {
  try {
    const id = db.saveMemory({
      sessionId: args.sessionId ?? null,
      messageId: args.messageId ?? null,
      content: args.content,
      type: args.type,
      confidence: args.confidence ?? 1,
    })
    return {
      content: [{ type: 'text' as const, text: `Saved memory #${id} (type: ${args.type})` }],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text' as const, text: `Error saving memory: ${msg}` }],
      isError: true,
    }
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
