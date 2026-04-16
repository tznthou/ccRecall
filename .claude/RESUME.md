# ccRecall — 接續文件

> 最後更新：2026-04-16

## 專案背景

ccRecall 是 ccRewind（Claude Code 對話回放考古工具，v1.8.0）的**姐妹作**。

| | ccRewind | ccRecall |
|---|---------|----------|
| 做什麼 | **考古**：事後看 session 發生了什麼 | **記憶**：讓 AI 自動記住、按需回憶 |
| 使用者 | 人（Electron GUI） | AI（Claude Code hooks + HTTP API） |
| 核心問題 | 「這個 session 做了什麼？」 | 「AI 怎麼在下個 session 記住這次學到的？」 |

## 目前進度

### ✅ Phase 1：核心搬遷 + Search API（MVP）— 已完成

- [x] 型別定義（`src/core/types.ts`）：ccRewind 型別 + 記憶/元認知新型別 + DB/Search 型別
- [x] parser.ts（240 LOC）：JSONL 解析，從 ccRewind 搬遷
- [x] scanner.ts（131 LOC）：檔案掃描，從 ccRewind 搬遷
- [x] summarizer.ts（476 LOC）：規則式摘要，循環依賴修正（SessionFileInput 移到 types.ts）
- [x] database.ts（1243 LOC）：SQLite + FTS5，裁剪 10 個 UI dashboard 方法
- [x] indexer.ts（253 LOC）：索引 pipeline，從 ccRewind 搬遷
- [x] barrel export（`src/core/index.ts`）
- [x] 測試搬遷：148 個 unit tests 全通過
- [x] API 接上真實 DB：`/health` 回傳真實統計、`/memory/query` 接 FTS5 搜尋
- [x] E2E 驗證（6 個 integration tests）
- [x] 總計 154 tests 全通過

### 🔲 Phase 2：MCP Server + Hooks + 記憶寫入

研究已確認（`.claude/pi-research/hooks-context-injection-feasibility.md`）：
- **MCP server 是主要注入方案**（最穩定的 context 注入管道）
- SessionStart hook 穩定可用（stdout prepend 到 context）
- UserPromptSubmit hook 設計上支持但有 bug

待做：
- [ ] MCP server interface（stdio transport，與 HTTP 並存）
- [ ] MCP tools：recall_query, recall_context, recall_save
- [ ] SessionStart hook script（自動注入記憶底）
- [ ] memories table schema + CRUD
- [ ] POST /memory/save 實作
- [ ] POST /session/checkpoint + /session/end 實作

### 🔲 Phase 3：元認知層

- [ ] knowledge_map table schema + CRUD
- [ ] GET /metacognition/check 接真實資料
- [ ] 自動更新 knowledge_map on session indexing
- [ ] 交叉引用追蹤

### 🔲 Phase 4：遺忘曲線 + 優化

- [ ] 壓縮 pipeline（原始→摘要→一行結論→刪除）
- [ ] confidence 衰減
- [ ] Lint 機制（矛盾、過時、孤立記憶）
- [ ] launchd plist 開機自啟動

## 技術棧

- Node.js 22 + TypeScript（ES modules）
- better-sqlite3 + FTS5
- HTTP: Node.js native `http`（port 7749）
- 測試: vitest（154 tests）
- DB path: `~/.ccrecall/ccrecall.db`

## 架構（Phase 1 完成後）

```
src/
  core/
    types.ts       — 全部型別定義
    parser.ts      — JSONL 解析
    scanner.ts     — 檔案掃描
    summarizer.ts  — 規則式摘要
    database.ts    — SQLite + FTS5（裁剪版）
    indexer.ts     — 索引 pipeline
    index.ts       — barrel export
  api/
    server.ts      — HTTP server（接收 db 參數）
    routes.ts      — 7 端點（/health + /memory/query 已接真實 DB）
  index.ts         — 入口（DB init + indexer + server）
tests/
  fixtures/        — 測試 JSONL 檔案
  parser.test.ts   — 44 tests
  scanner.test.ts  — 19 tests
  summarizer.test.ts — 42 tests
  database.test.ts — 35 tests
  indexer.test.ts  — 12 tests
  e2e.test.ts      — 6 tests
```

## 核心差異化 vs claude-mem

| | claude-mem | ccRecall |
|---|-----------|----------|
| 摘要引擎 | Claude API（要花錢） | 規則式（零成本） |
| 搜尋 | Chroma 向量 DB | FTS5 + 關鍵詞 |
| 元認知 | 無 | knowledge_map（Phase 3） |
| 遺忘曲線 | 無 | 分層壓縮（Phase 4） |

## 參考文件

- `.claude/pi-research/hooks-context-injection-feasibility.md` — hooks 注入可行性分析
- `.claude/pi-research/llm-wiki-karpathy-analysis.md` — LLM Wiki 範式分析
- `.claude/pi-research/ccrewind-memory-service-architecture.md` — 架構設計
- `.claude/pi-research/ai-memory-systems-landscape.md` — AI 記憶全景
- `.claude/pi-research/ai-long-term-memory-design.md` — 元認知設計
