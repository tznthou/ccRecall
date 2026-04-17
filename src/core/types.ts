// ── 從 ccRewind 抽取：JSONL Parser 型別 ──

/** 單行 JSONL 解析結果 */
export interface ParsedLine {
  type: string
  uuid: string | null
  parentUuid: string | null
  sessionId: string | null
  timestamp: string | null
  role: 'user' | 'assistant' | null
  contentText: string | null
  contentJson: string | null
  hasToolUse: boolean
  hasToolResult: boolean
  toolNames: string[]
  rawJson: string
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  model: string | null
  requestId: string | null
}

/** 整個 session 解析結果 */
export interface ParsedSession {
  sessionId: string
  title: string | null
  messages: ParsedLine[]
  startedAt: string | null
  endedAt: string | null
  skippedLines: number
  totalLines: number
}

// ── 從 ccRewind 抽取：Scanner 型別 ──

/** 掃描到的 session 檔案資訊 */
export interface ScannedSession {
  filePath: string
  fileSize: number
  fileMtime: string
  sessionId: string
}

/** 掃描到的 subagent 檔案資訊 */
export interface ScannedSubagent {
  filePath: string
  fileSize: number
  fileMtime: string
  subagentId: string
  parentSessionId: string
  agentType: string | null
}

/** 掃描到的專案資訊 */
export interface ScannedProject {
  projectId: string
  displayName: string
  sessions: ScannedSession[]
}

// ── 從 ccRewind 抽取：DB / 共用型別 ──

/** 專案 */
export interface Project {
  id: string
  displayName: string
  sessionCount: number
  lastActivityAt: string | null
}

/** session_files 操作類型 */
export type FileOperation = 'read' | 'edit' | 'write' | 'discovery'

/** session_files 表記錄 */
export interface SessionFile {
  sessionId: string
  filePath: string
  operation: FileOperation
  count: number
  firstSeenSeq: number
  lastSeenSeq: number
}

/** session_files 寫入用型別（解決 summarizer ↔ database 循環依賴） */
export interface SessionFileInput {
  filePath: string
  operation: FileOperation
  count: number
  firstSeenSeq: number
  lastSeenSeq: number
}

/** Session 摘要 */
export interface SessionMeta {
  id: string
  projectId: string
  title: string | null
  messageCount: number
  startedAt: string | null
  endedAt: string | null
  archived: boolean
  summaryText: string | null
  intentText: string | null
  outcomeStatus: OutcomeStatus
  durationSeconds: number | null
  activeDurationSeconds: number | null
  summaryVersion: number | null
  tags: string | null
  filesTouched: string | null
  toolsUsed: string | null
  totalInputTokens: number | null
  totalOutputTokens: number | null
}

/** 訊息 */
export interface Message {
  id: number
  sessionId: string
  type: 'user' | 'assistant' | 'queue-operation' | 'last-prompt'
  role: 'user' | 'assistant' | null
  contentText: string | null
  contentJson: string | null
  hasToolUse: boolean
  hasToolResult: boolean
  toolNames: string[] | null
  timestamp: string | null
  sequence: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  model: string | null
}

/** Session Token 統計 */
export interface SessionTokenStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  cacheHitRate: number
  models: string[]
  primaryModel: string | null
  turns: Array<{
    sequence: number
    timestamp: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    contextTotal: number
    hasToolUse: boolean
    toolNames: string[]
    model: string | null
  }>
}

/** 訊息上下文（搜尋結果預覽用） */
export interface MessageContext {
  target: Message | null
  before: Message[]
  after: Message[]
}

/** 搜尋範圍 */
export type SearchScope = 'messages' | 'sessions'
export type SearchSortBy = 'rank' | 'date'

/** 搜尋選項 */
export interface SearchOptions {
  dateFrom?: string
  dateTo?: string
  sortBy?: SearchSortBy
}

/** 搜尋結果 */
export interface SearchResult {
  sessionId: string
  sessionTitle: string | null
  projectId: string
  projectName: string
  messageId: number
  snippet: string
  timestamp: string | null
  sessionStartedAt: string | null
}

/** 搜尋分頁回應 */
export interface SearchPage {
  results: SearchResult[]
  offset: number
  hasMore: boolean
}

/** Session 層級搜尋結果 */
export interface SessionSearchResult {
  sessionId: string
  sessionTitle: string | null
  projectId: string
  projectName: string
  tags: string | null
  filesTouched: string | null
  snippet: string
  startedAt: string | null
  outcomeStatus: OutcomeStatus
}

/** Session 搜尋分頁回應 */
export interface SessionSearchPage {
  results: SessionSearchResult[]
  offset: number
  hasMore: boolean
}

/** 檔案歷史條目 */
export interface FileHistoryEntry {
  sessionId: string
  sessionTitle: string | null
  projectId: string
  projectName: string
  operation: FileOperation
  count: number
  startedAt: string | null
}

/** Subagent session */
export interface SubagentSession {
  id: string
  parentSessionId: string
  agentType: string | null
  filePath: string
  fileSize: number | null
  fileMtime: string | null
  messageCount: number
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

/** 索引進度 */
export interface IndexerStatus {
  phase: 'scanning' | 'parsing' | 'indexing' | 'done'
  progress: number
  total: number
  current: number
}

// ── 從 ccRewind 抽取：Summarizer 型別 ──

export type OutcomeStatus = 'committed' | 'tested' | 'in-progress' | 'quick-qa' | null

export interface OutcomeSignals {
  gitCommitInvoked: boolean
  testCommandRan: boolean
  endedWithEdits: boolean
  isQuickQA: boolean
}

export interface SessionSummary {
  intentText: string
  activityText: string
  outcomeStatus: OutcomeStatus
  outcomeSignals: OutcomeSignals
  summaryText: string
  tags: string
  filesTouched: string
  toolsUsed: string
  summaryVersion: number
  durationSeconds: number | null
  activeDurationSeconds: number | null
}

// ── ccRecall 新增：記憶層型別 ──

/** 記憶類型 */
export type MemoryType = 'decision' | 'discovery' | 'preference' | 'pattern' | 'feedback'

/** 記憶條目 */
export interface Memory {
  id: number
  sessionId: string | null
  messageId: string | null
  content: string
  type: MemoryType
  confidence: number
  createdAt: string
}

// ── ccRecall 新增：元認知型別（Phase 3） ──

/** 知識深度（由 mention_count 衍生：>=5 deep, >=2 medium, else shallow） */
export type KnowledgeDepth = 'deep' | 'medium' | 'shallow' | 'none'

/** knowledge_map 條目（DB row） */
export interface Topic {
  topicKey: string
  projectId: string
  mentionCount: number
  lastTouched: string
}

/** knowledge_map 查詢用（含衍生 depth） */
export interface TopicWithDepth extends Topic {
  depth: KnowledgeDepth
}

/** session 中途快照 */
export interface SessionCheckpoint {
  id: number
  sessionId: string
  projectId: string
  snapshotText: string
  createdAt: string
}

// ── ccRecall 新增：API 回應型別 ──

/** /memory/query 回應 */
export interface MemoryQueryResult {
  memories: Array<{
    content: string
    source: string
    confidence: number
    depth: KnowledgeDepth | null
  }>
  totalTokenEstimate: number
}

/** /memory/context 回應 */
export interface SessionContextResult {
  summary: string | null
  decisions: string[]
  filesTouched: string[]
}

/** /metacognition/check summary 模式回應 */
export interface MetacognitionSummary {
  projectId: string
  topTopics: TopicWithDepth[]
  recentTopics: TopicWithDepth[]
  staleTopics: TopicWithDepth[]
  counts: {
    totalTopics: number
    totalMemories: number
    totalSessions: number
  }
}

/** /metacognition/check detail 模式回應 */
export interface TopicDetail {
  topicKey: string
  projectId: string
  mentionCount: number
  lastTouched: string
  depth: KnowledgeDepth
  memories: Memory[]
  relatedTopics: string[]
}

/** /session/checkpoint 回應 */
export interface CheckpointResult {
  ok: boolean
  checkpointId: number
}

/** /health 回應 */
export interface HealthResult {
  status: 'ok' | 'error'
  version: string
  dbPath: string
  sessionCount: number
  memoryCount: number
  topicCount: number
  uptime: number
}
