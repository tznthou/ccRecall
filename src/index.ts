import path from 'node:path'
import os from 'node:os'
import { createServer } from './api/server.js'
import { Database } from './core/database.js'
import { runIndexer } from './core/indexer.js'

const PORT = parseInt(process.env.CCRECALL_PORT ?? '7749', 10)
const DB_PATH = process.env.CCRECALL_DB_PATH ?? path.join(os.homedir(), '.ccrecall', 'ccrecall.db')

// Initialize database
const db = new Database(DB_PATH)
console.log(`Database initialized at ${DB_PATH}`)

// Run initial indexer
console.log('Running indexer...')
runIndexer(db).then(() => {
  console.log('Indexer complete.')
}).catch((err) => {
  console.error('Indexer error:', err)
})

// Start HTTP server
const server = createServer(db)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ccRecall listening on http://127.0.0.1:${PORT}`)
})

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down...`)
    db.close()
    server.close(() => process.exit(0))
  })
}
