// SPDX-License-Identifier: Apache-2.0
import BetterSqlite3 from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Project, SessionMeta, SearchOptions, SessionSearchPage, SessionFile, FileOperation, OutcomeStatus, FileHistoryEntry, SubagentSession, SessionFileInput, Memory, MemoryType, Topic, SessionCheckpoint } from './types.js'
import { scrubErrorMessage } from './log-safe.js'

/** 寫入 memories 時使用的參數型別 */
export interface MemoryInput {
  sessionId: string | null
  messageId: string | null
  content: string
  type: MemoryType
  confidence?: number
  /** Phase 4b: denormalized project scope. Session-backed memories auto-derive
   *  this from sessions.project_id if omitted. Manual memories should set this
   *  to avoid cross-project leakage. */
  projectId?: string | null
}

/** 寫入 messages 時使用的參數型別 */
export interface MessageInput {
  type: string
  uuid: string | null
  role: string | null
  contentText: string | null
  contentJson: string | null
  hasToolUse: boolean
  hasToolResult: boolean
  toolNames: string[]
  timestamp: string | null
  sequence: number
  rawJson: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  model: string | null
}

/** indexSession 的參數型別 */
export interface IndexSessionParams {
  sessionId: string
  projectId: string
  projectDisplayName: string
  title: string | null
  messageCount: number
  filePath: string
  fileSize: number
  fileMtime: string
  startedAt: string | null
  endedAt: string | null
  summaryText?: string | null
  intentText?: string | null
  outcomeStatus?: OutcomeStatus
  outcomeSignals?: string | null
  durationSeconds?: number | null
  activeDurationSeconds?: number | null
  summaryVersion?: number | null
  tags?: string | null
  filesTouched?: string | null
  toolsUsed?: string | null
  sessionFiles?: SessionFileInput[]
  messages: MessageInput[]
}

/** sessions 資料表的完整欄位 SELECT 子句（getSessions / getSessionById 共用） */
const SESSION_SELECT_COLUMNS = `id, project_id, title, message_count, started_at, ended_at, archived,
       summary_text, intent_text, outcome_status, duration_seconds, active_duration_seconds, summary_version,
       tags, files_touched, tools_used, total_input_tokens, total_output_tokens`

interface SessionRow {
  id: string
  project_id: string
  title: string | null
  message_count: number
  started_at: string | null
  ended_at: string | null
  archived: number
  summary_text: string | null
  intent_text: string | null
  outcome_status: string | null
  duration_seconds: number | null
  active_duration_seconds: number | null
  summary_version: number | null
  tags: string | null
  files_touched: string | null
  tools_used: string | null
  total_input_tokens: number | null
  total_output_tokens: number | null
}

function mapSessionRow(r: SessionRow): SessionMeta {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    messageCount: r.message_count,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    archived: r.archived === 1,
    summaryText: r.summary_text,
    intentText: r.intent_text,
    outcomeStatus: (r.outcome_status as OutcomeStatus) ?? null,
    durationSeconds: r.duration_seconds,
    activeDurationSeconds: r.active_duration_seconds,
    summaryVersion: r.summary_version,
    tags: r.tags,
    filesTouched: r.files_touched,
    toolsUsed: r.tools_used,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
  }
}

interface MemoryRow {
  id: number
  session_id: string | null
  message_id: string | null
  content: string
  type: string
  confidence: number
  created_at: string
}

/** Phase 4d compression candidate row — LEFT JOIN sessions for summary/intent. */
interface CompressionCandidateRow {
  id: number
  session_id: string | null
  content: string
  compression_level: number
  access_count: number
  age_days: number
  effective_confidence: number | null
  summary_text: string | null
  intent_text: string | null
  session_exists: number
}

/** Phase 4d: normalised shape consumed by the compression pipeline. */
export interface CompressionCandidate {
  id: number
  sessionId: string | null
  content: string
  compressionLevel: number
  accessCount: number
  ageDays: number
  effectiveConfidence: number
  summaryText: string | null
  intentText: string | null
  /** True when the session row that `sessionId` points at still exists.
   *  False for manual memories (sessionId is null) or orphaned rows. Used by
   *  the compression pipeline to block irreversible auto-delete of orphans. */
  sessionExists: boolean
}

function mapMemoryRow(r: MemoryRow): Memory {
  return {
    id: r.id,
    sessionId: r.session_id,
    messageId: r.message_id,
    content: r.content,
    type: r.type as MemoryType,
    confidence: r.confidence,
    createdAt: r.created_at,
  }
}

interface TopicRow {
  topic_key: string
  project_id: string
  mention_count: number
  last_touched: string
}

function mapTopicRow(r: TopicRow): Topic {
  return {
    topicKey: r.topic_key,
    projectId: r.project_id,
    mentionCount: r.mention_count,
    lastTouched: r.last_touched,
  }
}

interface CheckpointRow {
  id: number
  session_id: string
  project_id: string
  snapshot_text: string
  created_at: string
}

function mapCheckpointRow(r: CheckpointRow): SessionCheckpoint {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    snapshotText: r.snapshot_text,
    createdAt: r.created_at,
  }
}

/** Migration 定義 */
interface Migration {
  version: number
  description: string
  up: (db: BetterSqlite3.Database) => void
}

/** 重建 message_content / message_archive 表，修正 FK 指向 messages */
function rebuildSideTables(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE message_content RENAME TO message_content_old;
    CREATE TABLE message_content (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      content_json TEXT
    );
    INSERT INTO message_content SELECT * FROM message_content_old;
    DROP TABLE message_content_old;

    ALTER TABLE message_archive RENAME TO message_archive_old;
    CREATE TABLE message_archive (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      raw_json TEXT
    );
    INSERT INTO message_archive SELECT * FROM message_archive_old;
    DROP TABLE message_archive_old;
  `)
}

/** 所有 migrations，依 version 遞增排列 */
const migrations: Migration[] = [
  {
    version: 1,
    description: 'split messages: content_json → message_content, raw_json → message_archive',
    up: (db) => {
      // 檢查是否為舊 schema（messages 表有 content_json 欄位）
      // 新建的 DB 已在 initSchema 用 slim schema，不需搬移
      const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>
      const hasContentJson = cols.some(c => c.name === 'content_json')
      if (!hasContentJson) return // 新 DB，不需 migration

      // 1. 建立新表（IF NOT EXISTS 因為 initSchema 可能已建過空表）
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_content (
          message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          content_json TEXT
        );

        CREATE TABLE IF NOT EXISTS message_archive (
          message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          raw_json TEXT
        );
      `)

      // 2. 批量搬移資料（OR IGNORE 防止 initSchema 先建表後殘留資料導致 UNIQUE 衝突）
      db.exec(`
        INSERT OR IGNORE INTO message_content (message_id, content_json)
          SELECT id, content_json FROM messages WHERE content_json IS NOT NULL;

        INSERT OR IGNORE INTO message_archive (message_id, raw_json)
          SELECT id, raw_json FROM messages WHERE raw_json IS NOT NULL;
      `)

      // 3. Rename + recreate slim messages table
      // 注意：ALTER TABLE RENAME 會自動更新所有 FK references 指向新名稱
      // 所以 message_content/message_archive 的 FK 會被改成指向 messages_old
      // 必須在 DROP messages_old 後重建這兩張表
      db.exec(`
        ALTER TABLE messages RENAME TO messages_old;

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          type TEXT NOT NULL,
          role TEXT,
          content_text TEXT,
          has_tool_use INTEGER DEFAULT 0,
          has_tool_result INTEGER DEFAULT 0,
          tool_names TEXT,
          timestamp TEXT,
          sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO messages (id, session_id, type, role, content_text, has_tool_use, has_tool_result, tool_names, timestamp, sequence, created_at)
          SELECT id, session_id, type, role, content_text, has_tool_use, has_tool_result, tool_names, timestamp, sequence, created_at
          FROM messages_old;

        DROP TABLE messages_old;

        CREATE INDEX idx_messages_session ON messages(session_id, sequence);
      `)

      // 4. 重建 message_content / message_archive（FK 被 RENAME 改壞了）
      rebuildSideTables(db)

      // 5. 重建 FTS5 triggers（舊 trigger 隨 messages_old 一起消失了）
      db.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;

        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
        END;

        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
        END;
      `)
    },
  },
  {
    version: 2,
    description: 'add archived column to sessions',
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
      if (cols.some(c => c.name === 'archived')) return // 新 DB 已有
      db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0')
    },
  },
  // v3 被開發期間的臨時 migration 佔用（已 apply 到生產 DB），故跳至 v4
  {
    version: 4,
    description: 'fix FK references broken by v1 rename (message_content/archive → messages)',
    up: (db) => {
      // v1 的 ALTER TABLE messages RENAME TO messages_old 會讓
      // message_content/archive 的 FK 自動被 SQLite 改成指向 messages_old
      const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE name='message_content'").get() as { sql: string })?.sql ?? ''
      if (!schema.includes('messages_old')) return // FK 已正確

      rebuildSideTables(db)
    },
  },
  {
    version: 5,
    description: 'add session summary columns (summary_text, tags, files_touched, tools_used)',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
      if (cols.some(c => c.name === 'summary_text')) return
      db.exec(`
        ALTER TABLE sessions ADD COLUMN summary_text TEXT;
        ALTER TABLE sessions ADD COLUMN tags TEXT;
        ALTER TABLE sessions ADD COLUMN files_touched TEXT;
        ALTER TABLE sessions ADD COLUMN tools_used TEXT;
      `)
      // 清空 file_mtime 強制所有既有 session 在下次 indexer run 時 re-index
      db.exec("UPDATE sessions SET file_mtime = NULL")
    },
  },
  {
    version: 6,
    description: 'add sessions_fts for session-level search (title, tags, files_touched, summary_text)',
    up: (db) => {
      const exists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_fts'",
      ).get()
      if (exists) return
      db.exec(`
        CREATE VIRTUAL TABLE sessions_fts USING fts5(
          title,
          tags,
          files_touched,
          summary_text,
          content='sessions',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
      // 回填既有 session 資料
      db.exec(`
        INSERT INTO sessions_fts(rowid, title, tags, files_touched, summary_text)
        SELECT rowid, COALESCE(title,''), COALESCE(tags,''), COALESCE(files_touched,''), COALESCE(summary_text,'')
        FROM sessions;
      `)
    },
  },
  {
    version: 7,
    description: 'add token usage columns to messages and sessions (Phase 2.5 Context Budget)',
    up: (db) => {
      const msgCols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      if (msgCols.some(c => c.name === 'input_tokens')) return
      db.exec(`
        ALTER TABLE messages ADD COLUMN input_tokens INTEGER;
        ALTER TABLE messages ADD COLUMN output_tokens INTEGER;
        ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER;
        ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER;
        ALTER TABLE messages ADD COLUMN model TEXT;
        ALTER TABLE sessions ADD COLUMN total_input_tokens INTEGER;
        ALTER TABLE sessions ADD COLUMN total_output_tokens INTEGER;
      `)
      // 清空 file_mtime 強制 re-index，讓既有 session 填入 token 資料
      db.exec("UPDATE sessions SET file_mtime = NULL")
    },
  },
  {
    version: 8,
    description: 'Phase 3: structured summary + session_files reverse index',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'intent_text')) {
        db.exec(`
          ALTER TABLE sessions ADD COLUMN intent_text TEXT;
          ALTER TABLE sessions ADD COLUMN outcome_status TEXT;
          ALTER TABLE sessions ADD COLUMN outcome_signals TEXT;
          ALTER TABLE sessions ADD COLUMN duration_seconds INTEGER;
          ALTER TABLE sessions ADD COLUMN summary_version INTEGER;
        `)
      }
      // session_files 反向索引表
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_files (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          operation TEXT NOT NULL,
          count INTEGER DEFAULT 1,
          first_seen_seq INTEGER,
          last_seen_seq INTEGER,
          PRIMARY KEY (session_id, file_path, operation)
        );
        CREATE INDEX IF NOT EXISTS idx_session_files_path ON session_files(file_path);
        CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
      `)
      // 清空 file_mtime 強制全量 re-index
      db.exec("UPDATE sessions SET file_mtime = NULL")
    },
  },
  {
    version: 9,
    description: 'rebuild sessions_fts with intent_text column for search enhancement',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS sessions_fts;
        CREATE VIRTUAL TABLE sessions_fts USING fts5(
          title,
          tags,
          files_touched,
          summary_text,
          intent_text,
          content='sessions',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        INSERT INTO sessions_fts(rowid, title, tags, files_touched, summary_text, intent_text)
        SELECT rowid, COALESCE(title,''), COALESCE(tags,''), COALESCE(files_touched,''),
               COALESCE(summary_text,''), COALESCE(intent_text,'')
        FROM sessions;
      `)
    },
  },
  {
    version: 10,
    description: 'add uuid column to messages for cross-session dedup (resumed sessions)',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      if (cols.some(c => c.name === 'uuid')) return
      db.exec(`
        ALTER TABLE messages ADD COLUMN uuid TEXT;
        CREATE INDEX idx_messages_uuid ON messages(uuid);
      `)
      // 強制全量 re-index，讓既有 messages 填入 uuid
      db.exec("UPDATE sessions SET file_mtime = NULL")
    },
  },
  {
    version: 11,
    description: 'add active_duration_seconds column to sessions',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
      if (cols.some(c => c.name === 'active_duration_seconds')) return
      db.exec('ALTER TABLE sessions ADD COLUMN active_duration_seconds INTEGER')
      // 強制全量 re-index，讓既有 sessions 填入 active_duration_seconds
      db.exec("UPDATE sessions SET file_mtime = NULL")
    },
  },
  {
    version: 12,
    description: 'add subagent_sessions table for subagent file scanning',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subagent_sessions (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          agent_type TEXT,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          file_mtime TEXT,
          message_count INTEGER DEFAULT 0,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_sessions(parent_session_id);
      `)
    },
  },
  {
    version: 13,
    description: 'force re-index to fix UUID self-dedup bug (v12 re-index dropped messages with uuid)',
    up: (db) => {
      db.exec("UPDATE sessions SET file_mtime = NULL")
    },
  },
  {
    version: 14,
    description: 'force re-index for requestId token dedup (fix ~2.3x inflated token counts)',
    up: (db) => {
      db.exec("UPDATE sessions SET file_mtime = NULL")
      db.exec("UPDATE subagent_sessions SET file_mtime = NULL")
    },
  },
  {
    version: 15,
    description: 'force re-index to strip system XML from contentText',
    up: (db) => {
      db.exec("UPDATE sessions SET file_mtime = NULL")
      db.exec("UPDATE subagent_sessions SET file_mtime = NULL")
    },
  },
  {
    version: 16,
    description: 'add memories table + memories_fts for Phase 2 memory layer',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          message_id TEXT,
          content TEXT NOT NULL,
          type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.8,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='id',
          tokenize='unicode61'
        );

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;
      `)
    },
  },
  {
    version: 17,
    description: 'Phase 3a — knowledge_map + session_topics + memory_topics + session_checkpoints',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_map (
          topic_key     TEXT NOT NULL,
          project_id    TEXT NOT NULL REFERENCES projects(id),
          mention_count INTEGER DEFAULT 0,
          last_touched  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (topic_key, project_id)
        );

        CREATE TABLE IF NOT EXISTS session_topics (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          topic_key  TEXT NOT NULL,
          project_id TEXT NOT NULL,
          PRIMARY KEY (session_id, topic_key)
        );

        CREATE TABLE IF NOT EXISTS memory_topics (
          memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          topic_key  TEXT NOT NULL,
          project_id TEXT NOT NULL,
          PRIMARY KEY (memory_id, topic_key)
        );

        CREATE TABLE IF NOT EXISTS session_checkpoints (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          project_id    TEXT NOT NULL,
          snapshot_text TEXT NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_knowledge_map_project ON knowledge_map(project_id, last_touched DESC);
        CREATE INDEX IF NOT EXISTS idx_session_topics_topic  ON session_topics(topic_key, project_id);
        CREATE INDEX IF NOT EXISTS idx_memory_topics_topic   ON memory_topics(topic_key, project_id);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_session   ON session_checkpoints(session_id, created_at DESC);
      `)
      // 強制 reindex：existing sessions 需 re-run indexer 才會 populate session_topics + knowledge_map
      db.exec("UPDATE sessions SET file_mtime = NULL")
    },
  },
  {
    version: 18,
    description: 'Phase 4 — memories lifecycle: access tracking + compression metadata + project_id denormalize + FTS update trigger',
    up: (db) => {
      db.exec(`
        ALTER TABLE memories ADD COLUMN last_accessed TEXT;
        ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE memories ADD COLUMN compressed_at TEXT;
        ALTER TABLE memories ADD COLUMN compression_level INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE memories ADD COLUMN project_id TEXT;
      `)
      // Backfill session-backed memories' project_id from sessions table.
      // Manual memories (session_id IS NULL) remain NULL until Phase 4b wires the MCP param.
      db.exec(`
        UPDATE memories
        SET project_id = (
          SELECT project_id FROM sessions WHERE sessions.id = memories.session_id
        )
        WHERE session_id IS NOT NULL
      `)
      // AFTER UPDATE trigger: when memory.content is rewritten (e.g. compression),
      // keep memories_fts in sync. Existing _ai / _ad triggers only cover insert/delete.
      db.exec(`
        CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
        CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(last_accessed, access_count);
      `)
    },
  },
  {
    version: 19,
    description: 'switch FTS5 tokenizer to trigram for CJK support (3 tables)',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS memories_fts;
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='id',
          tokenize='trigram'
        );
        INSERT INTO memories_fts(rowid, content)
        SELECT id, COALESCE(content, '') FROM memories;

        DROP TABLE IF EXISTS sessions_fts;
        CREATE VIRTUAL TABLE sessions_fts USING fts5(
          title,
          tags,
          files_touched,
          summary_text,
          intent_text,
          content='sessions',
          content_rowid='rowid',
          tokenize='trigram'
        );
        INSERT INTO sessions_fts(rowid, title, tags, files_touched, summary_text, intent_text)
        SELECT rowid, COALESCE(title,''), COALESCE(tags,''), COALESCE(files_touched,''),
               COALESCE(summary_text,''), COALESCE(intent_text,'')
        FROM sessions;

        DROP TABLE IF EXISTS messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content_text,
          content='messages',
          content_rowid='id',
          tokenize='trigram'
        );
        INSERT INTO messages_fts(rowid, content_text)
        SELECT id, COALESCE(content_text, '') FROM messages;
      `)
    },
  },
  {
    version: 20,
    description: 'drop messages/message_archive/message_content/messages_fts; introduce message_uuids lookup for UUID dedup',
    up: (db) => {
      // SQLite DDL is transactional — a throw here auto-rollbacks the migration
      // (unlike MySQL). runMigrations wraps each migration in db.transaction().
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_uuids (
          uuid TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_message_uuids_session ON message_uuids(session_id);
      `)

      const messagesExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
      ).get()
      if (!messagesExists) return

      // Ordered backfill: older sessions first, then by sequence, so if two
      // sessions share a uuid (replay case) the earliest "owns" it via
      // INSERT OR IGNORE — matches production dedup semantics.
      db.exec(`
        INSERT OR IGNORE INTO message_uuids (uuid, session_id)
        SELECT m.uuid, m.session_id FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE m.uuid IS NOT NULL
        ORDER BY COALESCE(s.file_mtime, s.started_at, m.timestamp, m.created_at), m.sequence, m.id
      `)

      const oldCount = (db.prepare(
        "SELECT COUNT(DISTINCT uuid) AS c FROM messages WHERE uuid IS NOT NULL",
      ).get() as { c: number }).c
      const newCount = (db.prepare(
        "SELECT COUNT(*) AS c FROM message_uuids",
      ).get() as { c: number }).c
      if (oldCount !== newCount) {
        throw new Error(
          `v20 UUID backfill count mismatch (old=${oldCount}, new=${newCount}). ` +
          'This should not happen; please open a GitHub issue and attach ' +
          'your ~/.ccrecall/ccrecall.db.pre-v20.bak file.',
        )
      }

      db.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TABLE IF EXISTS message_content;
        DROP TABLE IF EXISTS message_archive;
        DROP TABLE IF EXISTS messages_fts;
        DROP TABLE IF EXISTS messages;
      `)
    },
  },
]

export class Database {
  private db: BetterSqlite3.Database
  private readonly dbPath: string

  /** Subagent 排除子查詢：用於所有面向使用者的 query，只顯示主 session */
  private static readonly EXCLUDE_SUBAGENTS = 'NOT IN (SELECT id FROM subagent_sessions)'

  /** Phase 4b: SQL snippet for effective confidence with exponential decay and
   *  access-extended half-life. Assumes `m` is the memories alias.
   *    age_days   = julianday(now) − julianday(COALESCE(last_accessed, created_at))
   *    half_life  = 7 + 7 · min(access_count, 4)  days
   *    effective  = confidence · exp(−ln 2 · age_days / half_life)
   *  Use in ORDER BY; requires exp() user function registered in the constructor. */
  private static readonly EFFECTIVE_CONFIDENCE = `(
    m.confidence * exp(
      -0.6931471805599453 *
      (julianday('now') - julianday(COALESCE(m.last_accessed, m.created_at))) /
      (7.0 + 7.0 * MIN(m.access_count, 4))
    )
  )`

  constructor(dbPath: string) {
    this.dbPath = dbPath
    // :memory: 不需要建目錄
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.db = new BetterSqlite3(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    // Phase 4b: register exp() as a user function for effective-confidence decay
    // in ORDER BY. SQLite's built-in math functions require a special compile flag
    // that better-sqlite3 does not enable by default.
    // Return NULL (not NaN) for non-finite inputs so ORDER BY sorts the row last
    // instead of first — SQLite treats NaN REAL values as larger than all finite
    // numbers in DESC ordering, which would let a corrupt row dominate recall.
    this.db.function('exp', { deterministic: true }, (x: unknown): number | null => {
      if (typeof x !== 'number' || !Number.isFinite(x)) return null
      return Math.exp(x)
    })
    this.initSchema()
    this.runMigrations()
  }

  close(): void {
    this.db.close()
  }

  /** Run `PRAGMA integrity_check`. Returns `['ok']` on a clean DB, otherwise one
   *  line per issue (e.g. 'row 48 missing from index idx_memories_access').
   *  Read-only; safe to call on a live WAL DB. Consumed by IntegrityMonitor. */
  integrityCheck(): string[] {
    const rows = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>
    return rows.map(r => r.integrity_check)
  }

  /** ⚠️ 測試專用：接受任意 SQL，禁止接到 IPC handler */
  rawAll<T>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[]
  }

  /** ⚠️ 測試專用：執行 DDL/DML，禁止接到 IPC handler */
  rawExec(sql: string): void {
    this.db.exec(sql)
  }

  private initSchema(): void {
    // Tables that exist at every schema version — safe to always CREATE IF NOT EXISTS.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        session_count INTEGER DEFAULT 0,
        last_activity_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT,
        message_count INTEGER DEFAULT 0,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        file_mtime TEXT,
        started_at TEXT,
        ended_at TEXT,
        archived INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS session_files (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        operation TEXT NOT NULL,
        count INTEGER DEFAULT 1,
        first_seen_seq INTEGER,
        last_seen_seq INTEGER,
        PRIMARY KEY (session_id, file_path, operation)
      );

      CREATE TABLE IF NOT EXISTS subagent_sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_type TEXT,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        file_mtime TEXT,
        message_count INTEGER DEFAULT 0,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_files_path ON session_files(file_path);
      CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
      CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_sessions(parent_session_id);

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        description TEXT
      );
    `)

    const hasBaseline = this.db.prepare('SELECT version FROM schema_version WHERE version = 0').get()
    if (!hasBaseline) {
      this.db.prepare("INSERT INTO schema_version (version, description) VALUES (0, 'baseline')").run()
    }

    const current = (this.db.prepare(
      'SELECT MAX(version) AS v FROM schema_version',
    ).get() as { v: number | null })?.v ?? 0

    if (current < 20) {
      // Pre-v20 legacy schema — migrations v1..v19 assume these tables exist
      // (v19 rebuilds messages_fts from messages, etc.). Only create them on
      // a DB that hasn't yet reached v20. Once v20 runs and drops them,
      // reopening with `current >= 20` MUST NOT recreate them, or the
      // destructive migration silently un-persists on every restart.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          type TEXT NOT NULL,
          role TEXT,
          content_text TEXT,
          has_tool_use INTEGER DEFAULT 0,
          has_tool_result INTEGER DEFAULT 0,
          tool_names TEXT,
          timestamp TEXT,
          sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS message_content (
          message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          content_json TEXT
        );

        CREATE TABLE IF NOT EXISTS message_archive (
          message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          raw_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sequence);
      `)

      const ftsExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'",
      ).get()
      if (!ftsExists) {
        this.db.exec(`
          CREATE VIRTUAL TABLE messages_fts USING fts5(
            content_text,
            content='messages',
            content_rowid='id',
            tokenize='unicode61'
          );
          CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
          END;
          CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
          END;
        `)
      }
    } else {
      // v20+ baseline — message_uuids carries the UUID dedup set.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS message_uuids (
          uuid TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_message_uuids_session ON message_uuids(session_id);
      `)
    }
  }

  /** 依序執行尚未套用的 migrations */
  private runMigrations(): void {
    const current = this.getSchemaVersion()

    // v20 destructively drops 4 tables (~700 MB on mature DBs). Snapshot the
    // file before attempting so non-SQL failures (disk full, segfault, WAL
    // corruption) don't orphan data. SQL errors are covered by transaction
    // auto-rollback; this guards the rest. Guard covers any DB that has run
    // at least one migration (current > 0) — so a user jumping from v15 or
    // v18 directly to v20 also gets a backup. Fresh DBs (current === 0)
    // race from 0 → 20 on an empty schema and have nothing worth saving.
    if (current > 0 && current < 20 && this.dbPath !== ':memory:') {
      const backupPath = this.dbPath + '.pre-v20.bak'
      if (!existsSync(backupPath)) {
        // Flush WAL pages into the main file first. `copyFileSync` on its
        // own misses any committed-but-uncheckpointed pages living in the
        // -wal sidecar; TRUNCATE checkpoint forces them out so the backup
        // is a complete, restorable snapshot.
        this.db.pragma('wal_checkpoint(TRUNCATE)')
        copyFileSync(this.dbPath, backupPath)
        console.log(`[ccRecall] Pre-v20 backup created at ${backupPath}`)
      }
    }

    for (const m of migrations) {
      if (m.version <= current) continue
      const migrate = this.db.transaction(() => {
        m.up(this.db)
        this.db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(m.version, m.description)
      })
      migrate()
    }
    // Post-migration VACUUM is user-driven. Auto-VACUUM on a ~700 MB DB froze
    // daemon startup for minutes; users run `sqlite3 <db> 'VACUUM'` when ready.
  }

  /** 取得目前 schema 版本 */
  getSchemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
    return row?.v ?? 0
  }

  // ── Projects ──

  upsertProject(id: string, displayName: string): void {
    this.db.prepare(`
      INSERT INTO projects (id, display_name)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name
    `).run(id, displayName)
  }

  getMainSessionCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM sessions WHERE id ${Database.EXCLUDE_SUBAGENTS}`,
    ).get() as { c: number }
    return row.c
  }

  updateProjectStats(projectId: string): void {
    this.db.prepare(`
      UPDATE projects SET
        session_count = (SELECT COUNT(*) FROM sessions WHERE project_id = ? AND id ${Database.EXCLUDE_SUBAGENTS}),
        last_activity_at = (SELECT MAX(ended_at) FROM sessions WHERE project_id = ? AND id ${Database.EXCLUDE_SUBAGENTS})
      WHERE id = ?
    `).run(projectId, projectId, projectId)
  }

  getProjects(): Project[] {
    const rows = this.db.prepare(
      'SELECT id, display_name, session_count, last_activity_at FROM projects ORDER BY last_activity_at DESC',
    ).all() as Array<{
      id: string
      display_name: string
      session_count: number
      last_activity_at: string | null
    }>

    return rows.map(r => ({
      id: r.id,
      displayName: r.display_name,
      sessionCount: r.session_count,
      lastActivityAt: r.last_activity_at,
    }))
  }

  // ── Sessions ──

  getSessionMtime(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT file_mtime FROM sessions WHERE id = ?',
    ).get(sessionId) as { file_mtime: string } | undefined

    return row?.file_mtime ?? null
  }

  getSessions(projectId: string): SessionMeta[] {
    const rows = this.db.prepare(
      `SELECT ${SESSION_SELECT_COLUMNS}
       FROM sessions
       WHERE project_id = ?
         AND id ${Database.EXCLUDE_SUBAGENTS}
       ORDER BY started_at DESC`,
    ).all(projectId) as SessionRow[]

    return rows.map(mapSessionRow)
  }

  getSessionById(sessionId: string): SessionMeta | null {
    const row = this.db.prepare(
      `SELECT ${SESSION_SELECT_COLUMNS}
       FROM sessions
       WHERE id = ?`,
    ).get(sessionId) as SessionRow | undefined

    return row ? mapSessionRow(row) : null
  }

  /** 將 DB 中不在 keepIds 集合的 session 標記為 archived（JSONL 已從磁碟消失），排除 subagent sessions */
  archiveStaleSessionsExcept(keepIds: Set<string>): void {
    const allRows = this.db.prepare(`SELECT id FROM sessions WHERE archived = 0 AND id ${Database.EXCLUDE_SUBAGENTS}`).all() as Array<{ id: string }>
    const archiveStmt = this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?')
    const doArchive = this.db.transaction(() => {
      for (const row of allRows) {
        if (!keepIds.has(row.id)) {
          archiveStmt.run(row.id)
        }
      }
    })
    doArchive()
  }

  /** 一次取得所有 session 的 file_mtime + archived 狀態（增量索引批次比對用） */
  getAllSessionMtimes(): Map<string, { mtime: string; archived: boolean }> {
    const rows = this.db.prepare('SELECT id, file_mtime, archived FROM sessions').all() as Array<{ id: string; file_mtime: string; archived: number }>
    const map = new Map<string, { mtime: string; archived: boolean }>()
    for (const r of rows) {
      map.set(r.id, { mtime: r.file_mtime, archived: r.archived === 1 })
    }
    return map
  }

  // ── Subagent sessions ──

  /** 寫入 subagent session 記錄（upsert：重複 id 更新 mtime/count） */
  indexSubagentSession(params: {
    id: string
    parentSessionId: string
    agentType: string | null
    filePath: string
    fileSize: number | null
    fileMtime: string | null
    messageCount: number
    startedAt: string | null
    endedAt: string | null
  }): void {
    this.db.prepare(`
      INSERT INTO subagent_sessions (id, parent_session_id, agent_type, file_path, file_size, file_mtime, message_count, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_type = excluded.agent_type,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        message_count = excluded.message_count,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at
    `).run(
      params.id, params.parentSessionId, params.agentType,
      params.filePath, params.fileSize, params.fileMtime,
      params.messageCount, params.startedAt, params.endedAt,
    )
  }

  /** 取得指定 parent session 下的所有 subagent sessions */
  getSubagentSessions(parentSessionId: string): SubagentSession[] {
    const rows = this.db.prepare(
      `SELECT id, parent_session_id, agent_type, file_path, file_size, file_mtime,
              message_count, started_at, ended_at, created_at
       FROM subagent_sessions WHERE parent_session_id = ? ORDER BY started_at`,
    ).all(parentSessionId) as Array<{
      id: string
      parent_session_id: string
      agent_type: string | null
      file_path: string
      file_size: number | null
      file_mtime: string | null
      message_count: number
      started_at: string | null
      ended_at: string | null
      created_at: string
    }>

    return rows.map(r => ({
      id: r.id,
      parentSessionId: r.parent_session_id,
      agentType: r.agent_type,
      filePath: r.file_path,
      fileSize: r.file_size,
      fileMtime: r.file_mtime,
      messageCount: r.message_count,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      createdAt: r.created_at,
    }))
  }

  /** 刪除指定 parent session 的所有 subagent sessions */
  deleteSubagentSessions(parentSessionId: string): void {
    this.db.prepare('DELETE FROM subagent_sessions WHERE parent_session_id = ?').run(parentSessionId)
  }

  /** 刪除單一 subagent session（session_files / message_uuids 會經 FK CASCADE 清除） */
  deleteSubagentSession(subagentId: string): void {
    const doDelete = this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_files WHERE session_id = ?').run(subagentId)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(subagentId)
      this.db.prepare('DELETE FROM subagent_sessions WHERE id = ?').run(subagentId)
    })
    doDelete()
  }

  /** 取得指定 parent session 的所有 subagent ID */
  getSubagentSessionIds(parentSessionId: string): string[] {
    const rows = this.db.prepare('SELECT id FROM subagent_sessions WHERE parent_session_id = ?').all(parentSessionId) as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  /** 在單一 transaction 中執行多個 DB 操作 */
  runTransaction(fn: () => void): void {
    const tx = this.db.transaction(fn)
    tx()
  }

  /** 一次取得所有 subagent sessions 的 file_mtime（增量比對用） */
  getAllSubagentMtimes(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, file_mtime FROM subagent_sessions').all() as Array<{ id: string; file_mtime: string | null }>
    const map = new Map<string, string>()
    for (const r of rows) {
      if (r.file_mtime) map.set(r.id, r.file_mtime)
    }
    return map
  }

  // ── UUID dedup helper ──

  /** 查詢 DB 中已存在的 uuid（用於跨 session 去重 resumed session replay） */
  getExistingUuids(uuids: string[], excludeSessionId: string): Set<string> {
    const result = new Set<string>()
    for (let i = 0; i < uuids.length; i += 500) {
      const chunk = uuids.slice(i, i + 500)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db.prepare(
        `SELECT uuid FROM message_uuids WHERE session_id != ? AND uuid IN (${placeholders})`,
      ).all(excludeSessionId, ...chunk) as Array<{ uuid: string }>
      for (const r of rows) result.add(r.uuid)
    }
    return result
  }

  // ── Atomic session indexing ──

  indexSession(params: IndexSessionParams): void {
    const doIndex = this.db.transaction(() => {
      // 清除 sessions_fts 中的舊資料（external content 模式需手動維護）
      const oldSession = this.db.prepare('SELECT rowid, title, tags, files_touched, summary_text, intent_text FROM sessions WHERE id = ?').get(params.sessionId) as
        { rowid: number; title: string | null; tags: string | null; files_touched: string | null; summary_text: string | null; intent_text: string | null } | undefined
      if (oldSession) {
        this.db.prepare(
          "INSERT INTO sessions_fts(sessions_fts, rowid, title, tags, files_touched, summary_text, intent_text) VALUES ('delete', ?, ?, ?, ?, ?, ?)",
        ).run(oldSession.rowid, oldSession.title ?? '', oldSession.tags ?? '', oldSession.files_touched ?? '', oldSession.summary_text ?? '', oldSession.intent_text ?? '')
      }
      this.db.prepare('DELETE FROM session_files WHERE session_id = ?').run(params.sessionId)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(params.sessionId)
      this.upsertProject(params.projectId, params.projectDisplayName)
      // 計算 token 彙總
      let totalInput = 0
      let totalOutput = 0
      for (const m of params.messages) {
        if (m.inputTokens != null) totalInput += m.inputTokens
        if (m.outputTokens != null) totalOutput += m.outputTokens
      }
      const insertResult = this.db.prepare(`
        INSERT INTO sessions (id, project_id, title, message_count, file_path, file_size, file_mtime, started_at, ended_at,
          summary_text, intent_text, outcome_status, outcome_signals, duration_seconds, active_duration_seconds, summary_version,
          tags, files_touched, tools_used, total_input_tokens, total_output_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.sessionId, params.projectId, params.title, params.messageCount,
        params.filePath, params.fileSize, params.fileMtime,
        params.startedAt, params.endedAt,
        params.summaryText ?? null, params.intentText ?? null,
        params.outcomeStatus ?? null, params.outcomeSignals ?? null,
        params.durationSeconds ?? null, params.activeDurationSeconds ?? null, params.summaryVersion ?? null,
        params.tags ?? null,
        params.filesTouched ?? null, params.toolsUsed ?? null,
        totalInput || null, totalOutput || null,
      )
      // 新增 sessions_fts 條目（用 INSERT 回傳的 rowid 避免多餘查詢）
      this.db.prepare(
        'INSERT INTO sessions_fts(rowid, title, tags, files_touched, summary_text, intent_text) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(insertResult.lastInsertRowid, params.title ?? '', params.tags ?? '', params.filesTouched ?? '', params.summaryText ?? '', params.intentText ?? '')
      // 寫入 session_files
      if (params.sessionFiles && params.sessionFiles.length > 0) {
        const insertFile = this.db.prepare(`
          INSERT INTO session_files (session_id, file_path, operation, count, first_seen_seq, last_seen_seq)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const f of params.sessionFiles) {
          insertFile.run(params.sessionId, f.filePath, f.operation, f.count, f.firstSeenSeq, f.lastSeenSeq)
        }
      }
      // message_uuids: 寫入 uuid 登記表，供跨 session replay dedup 查詢。
      // 舊 session row 已由上面的 DELETE FROM sessions 透過 FK CASCADE 自動清除。
      const insertUuid = this.db.prepare(
        'INSERT OR IGNORE INTO message_uuids (uuid, session_id) VALUES (?, ?)',
      )
      for (const m of params.messages) {
        if (m.uuid != null) {
          insertUuid.run(m.uuid, params.sessionId)
        }
      }
    })

    doIndex()
  }

  // ── FTS5 Search ──

  static readonly SEARCH_PAGE_SIZE = 30

  /** Cap for short-token LIKE fallback. Each token contributes 1 (memories)
   *  or 5 (sessions) bind params; an unbounded query would let a caller pass
   *  N=10000 tokens and stall the event loop in `prepare()` or hit
   *  SQLITE_MAX_VARIABLE_NUMBER. 20 covers any realistic search query. */
  private static readonly MAX_FALLBACK_TOKENS = 20

  private static readonly VALID_OUTCOMES = new Set(['committed', 'tested', 'in-progress', 'quick-qa'])
  private static parseOutcomeStatus(v: string | null): OutcomeStatus {
    return v && Database.VALID_OUTCOMES.has(v) ? v as OutcomeStatus : null
  }

  /** FTS5 安全引號包裹：所有 token 無條件包引號，防止 operator injection */
  private static fts5QuoteIfNeeded(query: string): string {
    return query.split(/\s+/).filter(Boolean).map(token =>
      `"${token.replace(/"/g, '""')}"`,
    ).join(' ')
  }

  /** LIKE pattern builder for fallback. Escapes SQL LIKE wildcards so user
   *  input `%` / `_` / `\` are treated as literals. Used with `LIKE ? ESCAPE '\'`. */
  private static likePattern(query: string): string {
    return '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
  }

  /** True iff any whitespace-separated token in the query is shorter than 3
   *  characters, which the trigram tokenizer cannot index. Applies to every
   *  language — 2-char Latin acronyms like `UI` / `DB` fail just as hard as
   *  2-char CJK like `記憶`. Gates the LIKE fallback path. */
  private static hasShortToken(query: string): boolean {
    return query.trim().split(/\s+/).some(t => t.length > 0 && t.length < 3)
  }

  /** 搜尋 session 標題 / 標籤 / 檔案路徑 / 摘要 / 意圖 */
  searchSessions(query: string, projectId?: string | null, offset = 0, limit = Database.SEARCH_PAGE_SIZE, options?: SearchOptions): SessionSearchPage {
    limit = Math.min(limit, 100)
    const rawQuery = query
    query = Database.fts5QuoteIfNeeded(query)
    try {
      let sql = `
        SELECT
          s.id AS session_id,
          s.title AS session_title,
          s.project_id,
          p.display_name AS project_name,
          s.tags,
          s.files_touched,
          snippet(sessions_fts, -1, x'EE8080', x'EE8081', '...', 128) AS snippet,
          s.started_at,
          s.outcome_status
        FROM sessions_fts
        JOIN sessions s ON s.rowid = sessions_fts.rowid
        JOIN projects p ON p.id = s.project_id
        WHERE sessions_fts MATCH ?
          AND s.id ${Database.EXCLUDE_SUBAGENTS}
      `
      const params: (string | number | null)[] = [query]

      if (projectId) {
        sql += ' AND s.project_id = ?'
        params.push(projectId)
      }
      if (options?.dateFrom) {
        sql += ' AND date(s.started_at) >= ?'
        params.push(options.dateFrom)
      }
      if (options?.dateTo) {
        sql += ' AND date(s.started_at) <= ?'
        params.push(options.dateTo)
      }

      sql += options?.sortBy === 'date' ? ' ORDER BY s.started_at DESC, s.rowid DESC' : ' ORDER BY rank, s.rowid DESC'
      sql += ' LIMIT ? OFFSET ?'
      params.push(limit + 1, offset)

      const rows = this.db.prepare(sql).all(...params) as Array<{
        session_id: string
        session_title: string | null
        project_id: string
        project_name: string
        tags: string | null
        files_touched: string | null
        snippet: string
        started_at: string | null
        outcome_status: string | null
      }>

      if (rows.length === 0 && Database.hasShortToken(rawQuery)) {
        return this.searchSessionsFallback(rawQuery, projectId, offset, limit, options)
      }

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      const results = rows.map(r => ({
        sessionId: r.session_id,
        sessionTitle: r.session_title,
        projectId: r.project_id,
        projectName: r.project_name,
        tags: r.tags,
        filesTouched: r.files_touched,
        snippet: r.snippet,
        startedAt: r.started_at,
        outcomeStatus: Database.parseOutcomeStatus(r.outcome_status),
      }))

      return { results, offset, hasMore }
    } catch {
      return { results: [], offset, hasMore: false }
    }
  }

  /** Short-token LIKE fallback for searchSessions. Scans all FTS5-indexed
   *  columns (title, tags, files_touched, summary_text, intent_text) since a
   *  short query could match any of them, and trigram cannot tokenize tokens
   *  shorter than 3 characters.
   *
   *  Multi-token queries AND each token's per-column OR — every token must
   *  appear in some column, but tokens may live in different columns (e.g.
   *  `UI auth` could match a session whose title has UI and whose tags have
   *  auth). Substring-on-the-whole-query would lose those cross-column hits. */
  private searchSessionsFallback(
    rawQuery: string,
    projectId: string | null | undefined,
    offset: number,
    limit: number,
    options: SearchOptions | undefined,
  ): SessionSearchPage {
    const tokens = rawQuery.trim().split(/\s+/).filter(Boolean).slice(0, Database.MAX_FALLBACK_TOKENS)
    if (tokens.length === 0) return { results: [], offset, hasMore: false }
    const patterns = tokens.map(t => Database.likePattern(t))
    const tokenClause = tokens.map(() => `(
        s.title LIKE ? ESCAPE '\\'
        OR s.tags LIKE ? ESCAPE '\\'
        OR s.files_touched LIKE ? ESCAPE '\\'
        OR s.summary_text LIKE ? ESCAPE '\\'
        OR s.intent_text LIKE ? ESCAPE '\\'
      )`).join(' AND ')

    let sql = `
      SELECT
        s.id AS session_id,
        s.title AS session_title,
        s.project_id,
        p.display_name AS project_name,
        s.tags,
        s.files_touched,
        s.started_at,
        s.outcome_status
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
      WHERE ${tokenClause}
        AND s.id ${Database.EXCLUDE_SUBAGENTS}
    `
    const params: (string | number | null)[] = []
    for (const p of patterns) {
      params.push(p, p, p, p, p)
    }

    if (projectId) {
      sql += ' AND s.project_id = ?'
      params.push(projectId)
    }
    if (options?.dateFrom) {
      sql += ' AND date(s.started_at) >= ?'
      params.push(options.dateFrom)
    }
    if (options?.dateTo) {
      sql += ' AND date(s.started_at) <= ?'
      params.push(options.dateTo)
    }

    sql += ' ORDER BY s.started_at DESC, s.rowid DESC LIMIT ? OFFSET ?'
    params.push(limit + 1, offset)

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        session_id: string
        session_title: string | null
        project_id: string
        project_name: string
        tags: string | null
        files_touched: string | null
        started_at: string | null
        outcome_status: string | null
      }>
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      const results = rows.map(r => ({
        sessionId: r.session_id,
        sessionTitle: r.session_title,
        projectId: r.project_id,
        projectName: r.project_name,
        tags: r.tags,
        filesTouched: r.files_touched,
        snippet: '',
        startedAt: r.started_at,
        outcomeStatus: Database.parseOutcomeStatus(r.outcome_status),
      }))
      return { results, offset, hasMore }
    } catch {
      return { results: [], offset, hasMore: false }
    }
  }

  // ── Session Files (Reverse Index) ──

  /** 反向查詢：某檔案出現在哪些 session（按時間倒序） */
  getFileHistory(filePath: string): FileHistoryEntry[] {
    const rows = this.db.prepare(`
      SELECT sf.session_id, s.title AS session_title, s.project_id, p.display_name AS project_name,
             sf.operation, sf.count, s.started_at
      FROM session_files sf
      JOIN sessions s ON s.id = sf.session_id
      JOIN projects p ON p.id = s.project_id
      WHERE sf.file_path = ?
        AND s.id ${Database.EXCLUDE_SUBAGENTS}
      ORDER BY s.started_at DESC
    `).all(filePath) as Array<{
      session_id: string
      session_title: string | null
      project_id: string
      project_name: string
      operation: FileOperation
      count: number
      started_at: string | null
    }>
    return rows.map(r => ({
      sessionId: r.session_id,
      sessionTitle: r.session_title,
      projectId: r.project_id,
      projectName: r.project_name,
      operation: r.operation,
      count: r.count,
      startedAt: r.started_at,
    }))
  }

  /** 正向查詢：某 session 操作了哪些檔案 */
  getSessionFiles(sessionId: string): SessionFile[] {
    const rows = this.db.prepare(`
      SELECT session_id, file_path, operation, count, first_seen_seq, last_seen_seq
      FROM session_files WHERE session_id = ?
      ORDER BY last_seen_seq DESC
    `).all(sessionId) as Array<{
      session_id: string
      file_path: string
      operation: string
      count: number
      first_seen_seq: number
      last_seen_seq: number
    }>
    return rows.map(r => ({
      sessionId: r.session_id,
      filePath: r.file_path,
      operation: r.operation as FileOperation,
      count: r.count,
      firstSeenSeq: r.first_seen_seq,
      lastSeenSeq: r.last_seen_seq,
    }))
  }

  // ── Memories ──

  saveMemory(input: MemoryInput): number {
    // Phase 4b: denormalize project_id.
    // Session-backed memories are ALWAYS derived from sessions.project_id — caller-
    // supplied projectId is ignored for session-backed rows to prevent forged scope
    // via a stale or orphaned sessions row (Phase 3 stale-denorm lesson). If the
    // session is missing, project_id falls back to NULL rather than trusting the
    // caller's claim.
    // Manual memories (no sessionId) use caller-supplied projectId directly, or
    // NULL when absent.
    let projectId: string | null
    if (input.sessionId) {
      const row = this.db.prepare(
        'SELECT project_id FROM sessions WHERE id = ?',
      ).get(input.sessionId) as { project_id: string } | undefined
      projectId = row?.project_id ?? null
    } else {
      projectId = input.projectId ?? null
    }
    const info = this.db.prepare(`
      INSERT INTO memories (session_id, message_id, content, type, confidence, project_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.messageId,
      input.content,
      input.type,
      input.confidence ?? 0.8,
      projectId,
    )
    return Number(info.lastInsertRowid)
  }

  queryMemories(query: string, limit: number, projectId?: string | null): Memory[] {
    const rawQuery = query
    const q = Database.fts5QuoteIfNeeded(query)
    if (!q) return []
    try {
      const cappedLimit = Math.min(limit, 100)
      const rows = projectId
        ? this.db.prepare(`
            SELECT m.id, m.session_id, m.message_id, m.content, m.type, m.confidence, m.created_at
            FROM memories_fts
            JOIN memories m ON m.id = memories_fts.rowid
            LEFT JOIN sessions s ON m.session_id = s.id
            WHERE memories_fts MATCH ?
              AND (
                (m.session_id IS NOT NULL AND s.project_id = ?) OR
                (m.session_id IS NULL AND m.project_id = ?)
              )
            ORDER BY ${Database.EFFECTIVE_CONFIDENCE} DESC, rank, m.id DESC
            LIMIT ?
          `).all(q, projectId, projectId, cappedLimit)
        : this.db.prepare(`
            SELECT m.id, m.session_id, m.message_id, m.content, m.type, m.confidence, m.created_at
            FROM memories_fts
            JOIN memories m ON m.id = memories_fts.rowid
            WHERE memories_fts MATCH ?
            ORDER BY ${Database.EFFECTIVE_CONFIDENCE} DESC, rank, m.id DESC
            LIMIT ?
          `).all(q, cappedLimit)
      const mapped = (rows as MemoryRow[]).map(mapMemoryRow)
      if (mapped.length === 0 && Database.hasShortToken(rawQuery)) {
        return this.queryMemoriesFallback(rawQuery, cappedLimit, projectId)
      }
      return mapped
    } catch (err) {
      // FTS5 errors echo the user-supplied query verbatim; scrub to avoid
      // log injection via control chars.
      console.warn('[memories] queryMemories error:', scrubErrorMessage(err))
      return []
    }
  }

  /** Short-token LIKE fallback for queryMemories. Trigram tokenizer cannot
   *  match queries shorter than 3 chars; LIKE scans content. EFFECTIVE_CONFIDENCE
   *  (confidence × decay) replaces FTS5 rank as the primary ordering.
   *
   *  Multi-token queries (e.g. mixed Latin acronyms + CJK like `UI 記憶`) AND
   *  each token's LIKE clause so a doc must contain every token somewhere.
   *  Substring-on-the-whole-query would silently lose `UI 元件設計優化記憶`
   *  for query `UI 記憶`. */
  private queryMemoriesFallback(
    rawQuery: string,
    limit: number,
    projectId: string | null | undefined,
  ): Memory[] {
    const tokens = rawQuery.trim().split(/\s+/).filter(Boolean).slice(0, Database.MAX_FALLBACK_TOKENS)
    if (tokens.length === 0) return []
    const patterns = tokens.map(t => Database.likePattern(t))
    const where = tokens.map(() => "m.content LIKE ? ESCAPE '\\'").join(' AND ')
    try {
      const rows = projectId
        ? this.db.prepare(`
            SELECT m.id, m.session_id, m.message_id, m.content, m.type, m.confidence, m.created_at
            FROM memories m
            LEFT JOIN sessions s ON m.session_id = s.id
            WHERE ${where}
              AND (
                (m.session_id IS NOT NULL AND s.project_id = ?) OR
                (m.session_id IS NULL AND m.project_id = ?)
              )
            ORDER BY ${Database.EFFECTIVE_CONFIDENCE} DESC, m.created_at DESC, m.id DESC
            LIMIT ?
          `).all(...patterns, projectId, projectId, limit)
        : this.db.prepare(`
            SELECT m.id, m.session_id, m.message_id, m.content, m.type, m.confidence, m.created_at
            FROM memories m
            WHERE ${where}
            ORDER BY ${Database.EFFECTIVE_CONFIDENCE} DESC, m.created_at DESC, m.id DESC
            LIMIT ?
          `).all(...patterns, limit)
      return (rows as MemoryRow[]).map(mapMemoryRow)
    } catch (err) {
      console.warn('[memories] queryMemoriesFallback error:', scrubErrorMessage(err))
      return []
    }
  }

  /** Phase 4b: Increment access_count + stamp last_accessed for each id.
   *  Caller is responsible for dedup (use MemoryService.touch for that). Runs
   *  inside a transaction so partial failure does not leave half-applied state. */
  touchMemory(ids: number[]): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed = datetime('now')
      WHERE id = ?
    `)
    const run = this.db.transaction((memIds: number[]) => {
      for (const id of memIds) stmt.run(id)
    })
    run(ids)
  }

  /** Phase 4b: Delete a memory by id. memories_ad trigger syncs memories_fts. */
  deleteMemory(id: number): boolean {
    const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return info.changes > 0
  }

  /** Phase 4b: Update memory content and stamp compression metadata atomically.
   *  memories_au trigger syncs memories_fts. Used by the compression pipeline. */
  updateMemoryContent(id: number, content: string, level: number, compressedAt: string): boolean {
    const info = this.db.prepare(`
      UPDATE memories
      SET content = ?, compression_level = ?, compressed_at = ?
      WHERE id = ?
    `).run(content, level, compressedAt, id)
    return info.changes > 0
  }

  getMemoriesBySessionId(sessionId: string): Memory[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, message_id, content, type, confidence, created_at
      FROM memories
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as MemoryRow[]
    return rows.map(mapMemoryRow)
  }

  getMemoryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }
    return row.c
  }

  /** Phase 4d lint: memories whose session_id references a session row that no
   *  longer exists (user scrubbed ~/.claude/projects, or pre-index race). Manual
   *  memories (session_id IS NULL) are not orphan candidates by definition. */
  getOrphanMemoryIds(limit = 1000): Array<{ memoryId: number; sessionId: string }> {
    // Capped — a bulk wipe of ~/.claude could otherwise return tens of thousands
    // of rows into one JSON response, blocking the event loop on serialisation.
    const rows = this.db.prepare(`
      SELECT m.id AS memory_id, m.session_id
      FROM memories m
      WHERE m.session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = m.session_id)
      ORDER BY m.id ASC
      LIMIT ?
    `).all(limit) as Array<{ memory_id: number; session_id: string }>
    return rows.map(r => ({ memoryId: r.memory_id, sessionId: r.session_id }))
  }

  /** Phase 4d lint: memories that have fully decayed — effective confidence under
   *  threshold AND never accessed AND older than `ageDays`. Strict `>` on age so
   *  callers can use 90 as "more than 90 days" without fencepost ambiguity. */
  getStaleMemoryIds(opts: { effectiveConfidence: number; ageDays: number }): Array<{
    memoryId: number
    ageDays: number
    effectiveConfidence: number
  }> {
    const rows = this.db.prepare(`
      SELECT memory_id, age_days, effective_confidence
      FROM (
        SELECT
          m.id AS memory_id,
          m.access_count,
          (julianday('now') - julianday(COALESCE(m.last_accessed, m.created_at))) AS age_days,
          ${Database.EFFECTIVE_CONFIDENCE} AS effective_confidence
        FROM memories m
      )
      WHERE access_count = 0 AND age_days > ? AND effective_confidence < ?
      ORDER BY memory_id ASC
    `).all(opts.ageDays, opts.effectiveConfidence) as Array<{
      memory_id: number; age_days: number; effective_confidence: number
    }>
    return rows.map(r => ({
      memoryId: r.memory_id,
      ageDays: r.age_days,
      effectiveConfidence: r.effective_confidence,
    }))
  }

  /** Phase 4d: fetch a batch of memories with everything the compression pipeline
   *  needs to plan a transition — current level / access / age / effective confidence
   *  plus the owning session's summary_text / intent_text for content rewrite.
   *
   *  LEFT JOIN sessions so session-backed memories whose session row was deleted
   *  (manual scrub of ~/.claude) still surface; the pipeline detects the NULL
   *  summary and falls back to syntactic truncation, matching manual memories. */
  getCompressionCandidates(limit: number): CompressionCandidate[] {
    // Only return rows that match at least one level's transition gates — ORDER
    // BY id ASC + LIMIT would otherwise stall on the first `batchSize` of rows
    // whose access_count permanently disqualifies them (e.g. high-access L0
    // that can never reach L1), starving truly eligible rows further back.
    //
    // `session_exists = 1` is surfaced so the pipeline can block auto-delete
    // of orphaned rows (sessionId points at a session that was scrubbed) —
    // deleting an orphan is irreversible data loss since the source JSONL is
    // already gone.
    const rows = this.db.prepare(`
      SELECT id, session_id, content, compression_level, access_count,
             age_days, effective_confidence, summary_text, intent_text,
             session_exists
      FROM (
        SELECT
          m.id, m.session_id, m.content, m.compression_level, m.access_count,
          (julianday('now') - julianday(COALESCE(m.last_accessed, m.created_at))) AS age_days,
          ${Database.EFFECTIVE_CONFIDENCE} AS effective_confidence,
          s.summary_text, s.intent_text,
          CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS session_exists
        FROM memories m
        LEFT JOIN sessions s ON m.session_id = s.id
      )
      WHERE
        (compression_level = 0 AND age_days >= 7 AND access_count < 2 AND effective_confidence < 0.5)
        OR (compression_level = 1 AND age_days >= 30 AND access_count < 4)
        OR (compression_level = 2 AND age_days >= 60 AND session_id IS NOT NULL
            AND session_exists = 1 AND access_count = 0)
      ORDER BY id ASC
      LIMIT ?
    `).all(limit) as CompressionCandidateRow[]
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      content: r.content,
      compressionLevel: r.compression_level,
      accessCount: r.access_count,
      ageDays: r.age_days,
      effectiveConfidence: r.effective_confidence ?? 0,
      summaryText: r.summary_text,
      intentText: r.intent_text,
      sessionExists: r.session_exists === 1,
    }))
  }

  // ── Knowledge Map / Topics (Phase 3a) ──

  saveSessionTopics(sessionId: string, projectId: string, topicKeys: string[]): void {
    const run = this.db.transaction((keys: string[]) => {
      this.db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(sessionId)
      if (keys.length === 0) return
      const stmt = this.db.prepare(
        'INSERT INTO session_topics (session_id, topic_key, project_id) VALUES (?, ?, ?)',
      )
      for (const k of keys) stmt.run(sessionId, k, projectId)
    })
    run(topicKeys)
  }

  saveMemoryTopics(memoryId: number, projectId: string, topicKeys: string[]): void {
    const run = this.db.transaction((keys: string[]) => {
      this.db.prepare('DELETE FROM memory_topics WHERE memory_id = ?').run(memoryId)
      if (keys.length === 0) return
      const stmt = this.db.prepare(
        'INSERT INTO memory_topics (memory_id, topic_key, project_id) VALUES (?, ?, ?)',
      )
      for (const k of keys) stmt.run(memoryId, k, projectId)
    })
    run(topicKeys)
  }

  /** Full rebuild of knowledge_map for a project. project_id for memory_topics is derived
      from sessions.project_id (not the denormalized column) so repo renames / reindex won't
      leave stale cross-project associations. */
  rebuildKnowledgeMap(projectId: string): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_map WHERE project_id = ?').run(projectId)
      this.db.prepare(`
        INSERT INTO knowledge_map (topic_key, project_id, mention_count, last_touched)
        SELECT topic_key, project_id, COUNT(*) AS mention_count, MAX(touched_at) AS last_touched
        FROM (
          SELECT st.topic_key, s.project_id,
                 COALESCE(s.ended_at, s.started_at, datetime('now')) AS touched_at
          FROM session_topics st
          JOIN sessions s ON s.id = st.session_id
          WHERE s.project_id = ?
            AND s.id ${Database.EXCLUDE_SUBAGENTS}
          UNION ALL
          SELECT mt.topic_key, s.project_id,
                 COALESCE(m.created_at, datetime('now')) AS touched_at
          FROM memory_topics mt
          JOIN memories m ON m.id = mt.memory_id
          JOIN sessions s ON s.id = m.session_id
          WHERE s.project_id = ?
            AND s.id ${Database.EXCLUDE_SUBAGENTS}
        )
        GROUP BY topic_key, project_id
      `).run(projectId, projectId)
    })
    run()
  }

  private static readonly TOPIC_ORDER_BY: Record<'mention' | 'recent' | 'stale', string> = {
    mention: 'mention_count DESC, last_touched DESC',
    recent: 'last_touched DESC',
    stale: 'last_touched ASC',
  }

  getKnowledgeMap(
    projectId: string,
    opts: { limit?: number; sortBy?: 'mention' | 'recent' | 'stale' } = {},
  ): Topic[] {
    const { limit = 50, sortBy = 'mention' } = opts
    const cappedLimit = Math.min(limit, 500)
    const rows = this.db.prepare(`
      SELECT topic_key, project_id, mention_count, last_touched
      FROM knowledge_map
      WHERE project_id = ?
      ORDER BY ${Database.TOPIC_ORDER_BY[sortBy]}
      LIMIT ?
    `).all(projectId, cappedLimit) as TopicRow[]
    return rows.map(mapTopicRow)
  }

  getMemoriesByTopics(projectId: string, topicKeys: string[], limit: number): Memory[] {
    if (topicKeys.length === 0) return []
    const cappedLimit = Math.min(limit, 100)
    const placeholders = topicKeys.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT DISTINCT m.id, m.session_id, m.message_id, m.content, m.type, m.confidence, m.created_at
      FROM memory_topics mt
      JOIN memories m ON m.id = mt.memory_id
      JOIN sessions s ON s.id = m.session_id
      WHERE s.project_id = ?
        AND s.id ${Database.EXCLUDE_SUBAGENTS}
        AND mt.topic_key IN (${placeholders})
      ORDER BY ${Database.EFFECTIVE_CONFIDENCE} DESC, m.id DESC
      LIMIT ?
    `).all(projectId, ...topicKeys, cappedLimit) as MemoryRow[]
    return rows.map(mapMemoryRow)
  }

  getTopicCount(projectId?: string): number {
    const row = projectId
      ? this.db.prepare('SELECT COUNT(*) AS c FROM knowledge_map WHERE project_id = ?').get(projectId) as { c: number }
      : this.db.prepare('SELECT COUNT(*) AS c FROM knowledge_map').get() as { c: number }
    return row.c
  }

  getSessionTopicKeys(sessionId: string): string[] {
    const rows = this.db.prepare(
      'SELECT topic_key FROM session_topics WHERE session_id = ? ORDER BY topic_key',
    ).all(sessionId) as Array<{ topic_key: string }>
    return rows.map(r => r.topic_key)
  }

  getTopic(topicKey: string, projectId: string): Topic | null {
    const row = this.db.prepare(`
      SELECT topic_key, project_id, mention_count, last_touched
      FROM knowledge_map
      WHERE topic_key = ? AND project_id = ?
    `).get(topicKey, projectId) as TopicRow | undefined
    return row ? mapTopicRow(row) : null
  }

  /** 共現 topics（與目標共享 session 或 memory），按共現次數排序。
      project_id 透過 JOIN sessions 決定，避免 memory_topics 過時的 project_id 汙染。 */
  getRelatedTopics(topicKey: string, projectId: string, limit: number): string[] {
    const cappedLimit = Math.min(limit, 50)
    const rows = this.db.prepare(`
      SELECT k, COUNT(*) AS c FROM (
        SELECT st2.topic_key AS k
        FROM session_topics st1
        JOIN session_topics st2 ON st1.session_id = st2.session_id AND st2.topic_key != st1.topic_key
        JOIN sessions s ON s.id = st1.session_id
        WHERE st1.topic_key = ? AND s.project_id = ? AND s.id ${Database.EXCLUDE_SUBAGENTS}
        UNION ALL
        SELECT mt2.topic_key AS k
        FROM memory_topics mt1
        JOIN memory_topics mt2 ON mt1.memory_id = mt2.memory_id AND mt2.topic_key != mt1.topic_key
        JOIN memories m ON m.id = mt1.memory_id
        JOIN sessions s ON s.id = m.session_id
        WHERE mt1.topic_key = ? AND s.project_id = ? AND s.id ${Database.EXCLUDE_SUBAGENTS}
      )
      GROUP BY k ORDER BY c DESC, k ASC LIMIT ?
    `).all(topicKey, projectId, topicKey, projectId, cappedLimit) as Array<{ k: string; c: number }>
    return rows.map(r => r.k)
  }

  getKnowledgeMapCounts(projectId: string): {
    totalTopics: number; totalMemories: number; totalSessions: number
  } {
    const topics = this.db.prepare('SELECT COUNT(*) AS c FROM knowledge_map WHERE project_id = ?').get(projectId) as { c: number }
    const mems = this.db.prepare(`
      SELECT COUNT(*) AS c FROM memories m
      JOIN sessions s ON s.id = m.session_id
      WHERE s.project_id = ? AND s.id ${Database.EXCLUDE_SUBAGENTS}
    `).get(projectId) as { c: number }
    const sess = this.db.prepare(`
      SELECT COUNT(*) AS c FROM sessions WHERE project_id = ? AND id ${Database.EXCLUDE_SUBAGENTS}
    `).get(projectId) as { c: number }
    return { totalTopics: topics.c, totalMemories: mems.c, totalSessions: sess.c }
  }

  // ── Session Checkpoints (Phase 3d) ──

  saveCheckpoint(sessionId: string, projectId: string, snapshotText: string): number {
    const info = this.db.prepare(`
      INSERT INTO session_checkpoints (session_id, project_id, snapshot_text)
      VALUES (?, ?, ?)
    `).run(sessionId, projectId, snapshotText)
    return Number(info.lastInsertRowid)
  }

  getCheckpointById(id: number): SessionCheckpoint | null {
    const row = this.db.prepare(`
      SELECT id, session_id, project_id, snapshot_text, created_at
      FROM session_checkpoints WHERE id = ?
    `).get(id) as CheckpointRow | undefined
    return row ? mapCheckpointRow(row) : null
  }

  getCheckpointsBySessionId(sessionId: string): SessionCheckpoint[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, project_id, snapshot_text, created_at
      FROM session_checkpoints WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(sessionId) as CheckpointRow[]
    return rows.map(mapCheckpointRow)
  }
}
