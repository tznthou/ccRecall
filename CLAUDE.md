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

```
Claude Code hooks ──HTTP──→ ccRecall Service ──→ SQLite + FTS5
                                                  ├── memories
                                                  ├── knowledge_map
                                                  └── sessions/messages (from JSONL)
```

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

## 核心模組來源（從 ccRewind 抽取）

抽取順序：types → parser → scanner → summarizer → database（裁剪 UI query）→ indexer

| 模組 | ccRewind 來源 | LOC | 測試 | 狀態 |
|------|--------------|-----|------|------|
| types | `src/shared/types.ts` | — | — | ✓ 已抽取（`src/core/types.ts`） |
| parser | `src/main/parser.ts` | 240 | `tests/parser.test.ts` | 待抽取 |
| scanner | `src/main/scanner.ts` | 131 | `tests/scanner.test.ts` | 待抽取 |
| summarizer | `src/main/summarizer.ts` | 476 | `tests/summarizer.test.ts` | 待抽取 |
| database | `src/main/database.ts` | 1665 | `tests/database.test.ts` | 待抽取（需裁剪 UI query） |
| indexer | `src/main/indexer.ts` | 253 | `tests/indexer.test.ts` | 待抽取 |

所有模組零 Electron 依賴，可原樣搬遷。唯一外部依賴：better-sqlite3（database.ts）。
