#!/usr/bin/env node
import path from 'node:path'
import os from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Database } from '../core/database.js'
import { registerTools } from './tools.js'

const DB_PATH = process.env.CCRECALL_DB_PATH ?? path.join(os.homedir(), '.ccrecall', 'ccrecall.db')

async function main(): Promise<void> {
  const db = new Database(DB_PATH)
  const server = new McpServer(
    { name: 'ccrecall', version: '0.2.0' },
    {
      instructions:
        'ccRecall is a local memory service for Claude Code. ' +
        'Use recall_query to search past decisions, discoveries, and patterns ' +
        'when the user references prior work or you need context from earlier sessions.',
    },
  )

  registerTools(server, db)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`ccRecall MCP server running on stdio (db: ${DB_PATH})`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      db.close()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  console.error('MCP server fatal:', err)
  process.exit(1)
})
