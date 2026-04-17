import * as z from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../core/database.js'
import type { Memory } from '../core/types.js'

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
}
