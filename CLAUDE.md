# ccRecall — AI Memory Service for Claude Code

> ccRewind 的姐妹作。ccRewind 做「考古」（事後看 session 發生了什麼），ccRecall 做「記憶」（讓 AI 在未來 session 中自動記住過去的經驗）。

## 定位

本地背景服務，讀取 Claude Code 對話歷史，讓 AI 在未來 session 中按需記憶——不全部載入，只注入最相關的片段（<300 tokens）。

核心模組從 ccRewind 抽取（parser, scanner, summarizer, database, indexer），新增記憶層、HTTP API、元認知索引。

## 指令

- dev: `pnpm dev`
- build: `pnpm build`
- test: `pnpm vitest run`
- lint: `pnpm eslint . --fix`
- start: `pnpm start`

## 技術約束

- Runtime: Node.js + TypeScript
- DB: better-sqlite3 + FTS5（同步 API，零外部依賴）
- HTTP: 輕量 HTTP server（localhost only）
- 摘要引擎: 規則式（零 API 成本），不依賴 LLM
- 純唯讀應用——絕對不修改 `~/.claude/` 下的任何檔案
- JSONL parser 採寬容模式：未知結構保留 raw JSON，不中斷解析
- 不用 Docker、不用 Electron、不用向量資料庫

## 架構

三條讀取路徑 + 一條寫入路徑，共用同一個 SQLite 檔（MCP 走 WAL 直接開檔，不經 HTTP）。

```
讀（注入）
  SessionStart hook      ──HTTP──→ /memory/startup  ┐
  UserPromptSubmit hook  ──HTTP──→ /memory/prompt   ├─→ ccRecall daemon :7749 ─┐
  MCP recall_query/context ─────── WAL 直接開檔 ─────────────────────────────┐ │
                                                                            ↓ ↓
寫（產生記憶）                                            SQLite + FTS5 ├── memories
  ccrecall-extract wrapper → Haiku → MCP recall_save ──→                ├── memory_topics
  手動 recall_save ────────────────────────────────→                    ├── knowledge_map
                                                                        ├── injection_log
索引（唯讀來源）                                                        └── sessions/messages
  ~/.claude/**/*.jsonl → watcher → scanner → parser → summarizer → indexer ↑
```

⚠️ **摘要引擎（summarizer）是規則式零成本，但記憶抽取（extraction）走 Haiku**——
兩件事，別混為一談。SessionEnd hook 只標記結束，不抽取；抽取只在 `ccrecall-extract`
（zsh alias `ccdm`）收尾時跑。

## 測試誠信

- 測試紅了先修程式，禁止為通過測試而改斷言
- 先寫測試、後寫實作
- 測試不碰生產資料：使用 mkdtemp 隔離，不操作真實 `~/.claude/`

## 接續

- 新 session 開始前，先讀取 `.claude/RESUME.md`

## 相關專案

- ccRewind: `/Users/tznthou/Documents/ccRwind/`（考古 GUI，核心模組來源）

## 參考文件（需要時再讀）

- 架構設計: `.claude/pi-research/ccrewind-memory-service-architecture.md`
- AI 記憶全景: `.claude/pi-research/ai-memory-systems-landscape.md`
- 元認知設計: `.claude/pi-research/ai-long-term-memory-design.md`
- Obsidian 記憶研究: `.claude/pi-research/obsidian-ai-deep-memory.md`
- Hooks 注入可行性: `.claude/pi-research/hooks-context-injection-feasibility.md`
- LLM Wiki 範式分析: `.claude/pi-research/llm-wiki-karpathy-analysis.md`

## 核心模組（源自 ccRewind，抽取已完成）

六個模組全部就位，`src/core/` 是唯一權威版本；不要回頭去 ccRewind 找。

| 模組 | 現在的位置 | LOC | 測試 |
|------|-----------|-----|------|
| types | `src/core/types.ts` | 280 | — |
| parser | `src/core/parser.ts` | 241 | `tests/parser.test.ts` |
| scanner | `src/core/scanner.ts` | 132 | `tests/scanner.test.ts` |
| summarizer | `src/core/summarizer.ts` | 476 | `tests/summarizer.test.ts` |
| database | `src/core/database.ts` | 2601 | `tests/database.test.ts` |
| indexer | `src/core/indexer.ts` | 271 | `tests/indexer.test.ts` |

抽取後 ccRecall 自己長出來的：`memory-service` / `compression` / `token-budget` /
`topic-extractor` / `watcher` / `integrity-monitor` / `maintenance-coordinator` /
`recall-telemetry` / `project-id` / `log-safe`。零 Electron 依賴，外部依賴只有
better-sqlite3。
