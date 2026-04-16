# ccRewind Memory Service — 方向與架構設計
- **Date**: 2026-04-14
- **Status**: 設計階段，待正式開工
- **Origin**: 從 ccRewind 核心模組抽取，建立獨立的 AI 記憶服務

---

## 一、產品定位

### 從考古到記憶

```
ccRewind（現有）→ 人用的 GUI，看對話、搜尋、考古
新專案（本文件）→ AI 用的記憶服務，hooks 查詢、按需注入、元認知
```

兩者共享核心技術（JSONL parser、SQLite、FTS5、摘要引擎），但使用者和介面完全不同。

### 一句話定義

> 一個跑在本地的背景服務，讀取 Claude Code 的對話歷史，讓 AI 在未來的 session 中能「記住」過去的經驗——不是全部載入，而是按需注入最相關的片段。

### 解決的核心問題

**Context Paradox**：載入記憶佔 token → token 不夠工作 → 但不載入就忘記。

本服務的解法：記憶不在 AI 腦裡，在服務的 SQLite 裡。AI 永遠只拿到「此刻需要的那一小片」。

---

## 二、架構概覽

```
┌─────────────────────────────────────────────────┐
│                 Claude Code Session              │
│                                                  │
│  UserPromptSubmit hook ──→ HTTP GET /memory/query │
│                          ←── 相關記憶片段 (<300t) │
│                                                  │
│  PreCompact hook ────────→ HTTP POST /memory/save │
│                          ←── 確認存檔              │
│                                                  │
│  Stop hook ──────────────→ HTTP POST /session/end │
│                          ←── session 摘要存檔      │
└─────────────────────────────────────────────────┘
                        ▲
                        │ HTTP (localhost:PORT)
                        ▼
┌─────────────────────────────────────────────────┐
│              Memory Service（背景服務）            │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ JSONL    │  │ 摘要引擎  │  │ 記憶查詢引擎   │  │
│  │ Parser   │  │ (規則式)  │  │ (FTS5+Jaccard)│  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │             │                │           │
│       ▼             ▼                ▼           │
│  ┌──────────────────────────────────────────┐    │
│  │           SQLite + FTS5                   │    │
│  │  sessions / messages / memories /         │    │
│  │  knowledge_map / messages_fts             │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────┐  ┌──────────┐                      │
│  │ 增量索引  │  │ 遺忘曲線  │                      │
│  │ Pipeline  │  │ 壓縮器   │                      │
│  └──────────┘  └──────────┘                      │
└─────────────────────────────────────────────────┘
```

---

## 三、從 ccRewind 抽取的核心模組

| 模組 | 來源檔案 | LOC | 依賴 | 抽取難度 |
|------|---------|-----|------|---------|
| **JSONL Parser** | `src/main/parser.ts` | 240 | 零（純 fs + 型別） | 低 |
| **Scanner** | `src/main/scanner.ts` | 131 | 零（純 fs） | 低 |
| **Summarizer** | `src/main/summarizer.ts` | 476 | 零（純邏輯） | 低 |
| **Database + FTS5** | `src/main/database.ts` | 1665 | better-sqlite3 | 中（需裁剪 UI 相關 query） |
| **Indexer** | `src/main/indexer.ts` | 253 | 依賴上述四個模組 | 低 |
| **Types** | `src/shared/types.ts` | — | 零 | 低 |

**不需要的**：Electron shell、React UI、IPC handlers、exporter、updater

**抽取順序**：types → parser → scanner → summarizer → database（裁剪）→ indexer

---

## 四、新增模組設計

### 4.1 HTTP API Server

輕量 HTTP 服務，給 Claude Code hooks 用。

**技術選擇**：Node.js native `http` 模組或 Bun HTTP server（參考 claude-mem 的做法）

**端點設計**：

```
GET  /memory/query?q={text}&limit={n}
  → FTS5 搜尋 + Jaccard 相似度
  → 返回最相關的記憶片段（限制 < 300 tokens）
  → Response: { memories: [{ content, source, confidence, depth }] }

GET  /memory/context?session_id={id}
  → 返回特定 session 的摘要 + 關鍵決策
  → Response: { summary, decisions, files_touched }

POST /memory/save
  → 手動標記「這個要記住」
  → Body: { content, type, confidence, session_id }

POST /session/checkpoint                          ← 2026-04-14 新增
  → PreCompact hook 觸發，compact 前的中間存檔
  → 讀取 transcript_path 取得最新對話
  → 增量提取新記憶（跟上次 checkpoint 的 offset 比對）
  → 存入 memories table + 更新 knowledge_map
  → Body: { session_id, transcript_path, trigger }
  → Response: { ok, memories_saved, topics_updated }
  → 失敗時 hook 會 exit 2 阻擋 compaction

POST /session/end
  → Stop hook 觸發，Session 結束時的完整回顧
  → 產生整個 session 的摘要（含所有 checkpoint 之後的殘餘）
  → 最終 knowledge_map 更新
  → Body: { session_id }

GET  /metacognition/check?topic={text}
  → 查詢 knowledge_map：這個主題 AI 知道多少？
  → Response: { topic, depth, confidence, session_count, last_touched }

GET  /health
  → 服務狀態 + 索引統計
```

### 4.2 Claude Code Hooks 整合

> **2026-04-14 更新**：Claude Code 2.1.105 正式發布 PreCompact hook，支援阻擋 compaction（exit code 2 或 `{"decision":"block"}`）。以下設計基於已確認的技術規格。

#### PreCompact hook 技術規格（2.1.105 確認）

| 項目 | 規格 |
|------|------|
| **stdin** | `session_id`、`transcript_path`、`cwd`、`compaction_trigger`（auto/manual） |
| **阻擋方式** | exit code 2 + stderr 原因，或 `{"decision":"block","reason":"..."}` |
| **additionalContext** | **不支持**——PreCompact 是純 gate 機制，不能注入 context |
| **timeout** | 預設 600 秒，超時後 compaction 強制執行 |
| **matcher** | 可區分 `auto` / `manual` 觸發方式 |

**關鍵發現**：stdin 包含 `transcript_path`（完整 JSONL 對話紀錄路徑），hook 可直接讀取整個 session 內容。

#### 分階段 Hook 設計

**階段 A（已實作）：auto-compact 安全閥**

不需要 Memory Service。阻擋 auto-compact + 通知超超先存檔，5 分鐘 fallback 避免 session 崩潰。
已部署：`~/.claude/hooks/pre-compact.sh`

**階段 B（需 Memory Service）：自動安全存檔**

```jsonc
// .claude/settings.json — 搭配 Memory Service 的完整設定
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/memory-session-start.sh",
        "timeout": 10
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/memory-query.sh",
        "timeout": 5
      }]
    }],
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/memory-checkpoint.sh",
        "timeout": 60
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/memory-session-end.sh",
        "timeout": 30
      }]
    }]
  }
}
```

**memory-checkpoint.sh（PreCompact hook，階段 B 核心）：**

```bash
#!/bin/bash
PAYLOAD=$(cat)
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id')
TRANSCRIPT=$(echo "$PAYLOAD" | jq -r '.transcript_path')
TRIGGER=$(echo "$PAYLOAD" | jq -r '.compaction_trigger')

# 通知 Memory Service 做 checkpoint（不是 end，因為 compact 後 session 還在）
RESULT=$(curl -sf -X POST "http://localhost:PORT/session/checkpoint" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SESSION_ID\",\"transcript_path\":\"$TRANSCRIPT\",\"trigger\":\"$TRIGGER\"}" \
  --max-time 30)

if [ $? -ne 0 ]; then
  echo "Memory Service 存檔失敗，阻擋 compaction 以防記憶遺失" >&2
  exit 2
fi

exit 0
```

#### /session/checkpoint vs /session/end 分工

| 端點 | 觸發 hook | 時機 | 做什麼 | 頻率 |
|------|-----------|------|--------|------|
| `/session/checkpoint` | PreCompact | compact 前 | 增量存檔 + 更新 knowledge_map | 每次 compact（可能多次） |
| `/session/end` | Stop | session 結束 | 完整 session 摘要 + 最終 knowledge_map 更新 | 一次 |

PreCompact 可能在長 session 中觸發多次，所以 `/session/checkpoint` 需要增量 diff 邏輯——只處理上次 checkpoint 之後的新對話。

#### Hook 輸出格式（僅 UserPromptSubmit / SessionStart 支持 additionalContext）

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Related memories from past sessions:\n- [2026-04-13] 研究了 AI 記憶三大流派（depth: deep, confidence: high）\n- [2026-04-10] 討論了 Obsidian 分享會的四步流程\nKnowledge check: topic 'AI記憶' → depth: deep, 3 related sessions"
  }
}
```

### 4.3 記憶寫入層

新增 SQLite table，**不碰原始 JSONL 或 ccRewind 的 DB**：

```sql
-- 手動標記的記憶
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,                    -- 來源 session
  message_id TEXT,                    -- 來源 message（optional）
  content TEXT NOT NULL,              -- 記憶內容
  type TEXT NOT NULL,                 -- decision / discovery / preference / pattern / feedback
  confidence REAL DEFAULT 0.8,        -- 0.0 ~ 1.0
  created_at TEXT NOT NULL,
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0,
  compressed_at TEXT,                 -- 壓縮時間（遺忘曲線用）
  compression_level INTEGER DEFAULT 0 -- 0=原始, 1=摘要, 2=一行結論
);

CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_confidence ON memories(confidence);
```

### 4.4 元認知索引

```sql
-- AI 的自我認知地圖
CREATE TABLE knowledge_map (
  topic TEXT PRIMARY KEY,
  depth TEXT NOT NULL,              -- deep / medium / shallow / none
  confidence REAL DEFAULT 0.5,
  session_count INTEGER DEFAULT 0,  -- 研究過幾次
  last_session_id TEXT,
  last_touched TEXT,
  summary TEXT,                     -- 一行摘要
  related_topics TEXT               -- JSON array of related topic names
);

CREATE INDEX idx_knowledge_depth ON knowledge_map(depth);
```

**更新時機**：
- Session 結束時，summarizer 分析 session 涉及的主題 → 更新 knowledge_map
- 手動標記記憶時，自動關聯到 topic
- 定期掃描：距離 last_touched 超過 N 天的 topic，confidence 自動衰減

### 4.5 遺忘曲線壓縮器

```
Day 0:  compression_level = 0（原始記憶）
Day 7:  compression_level = 1（AI 壓縮成重點摘要）
Day 30: compression_level = 2（壓成一行結論）
Day 90: confidence 衰減到 0.3（查詢時排序靠後）
```

可用 cron job 或服務啟動時掃描觸發。壓縮策略：
- Level 0 → 1：保留 content 原文，新增 compressed_content 欄位
- Level 1 → 2：只保留 compressed_content
- 不刪除，只衰減 confidence——最壞情況是排序靠後，不是消失

---

## 五、技術棧

| 組件 | 選擇 | 原因 |
|------|------|------|
| Runtime | Node.js（或 Bun） | ccRewind 核心模組用 Node.js，直接相容 |
| DB | better-sqlite3 + FTS5 | ccRewind 已驗證，同步 API 適合本地服務 |
| HTTP | Node.js `http` 或 Fastify | 輕量、無多餘依賴 |
| 程序管理 | launchd plist（macOS） | 開機自動啟動、crash 自動重啟 |
| 語言 | TypeScript | 跟 ccRewind 一致 |
| 測試 | vitest | 跟 ccRewind 一致 |

**不用 Docker**：這是本地服務，存取 `~/.claude/` 目錄，Docker 增加不必要的複雜度（volume mount、native module 平台問題、port mapping）。

**不用 Electron**：不需要 GUI，純背景服務。如果未來需要管理介面，可以用 web dashboard（localhost:PORT/dashboard）。

---

## 六、專案結構

```
ccrewind-memory/                    （暫定名稱）
├── src/
│   ├── core/                       ← 從 ccRewind 抽取
│   │   ├── parser.ts              （JSONL 解析）
│   │   ├── scanner.ts             （檔案掃描）
│   │   ├── summarizer.ts          （規則式摘要）
│   │   ├── database.ts            （SQLite + FTS5，裁剪版）
│   │   ├── indexer.ts             （增量索引 pipeline）
│   │   └── types.ts               （共用型別）
│   ├── memory/                     ← 新增：記憶層
│   │   ├── memory-store.ts        （memories table CRUD）
│   │   ├── knowledge-map.ts       （knowledge_map table CRUD）
│   │   ├── compressor.ts          （遺忘曲線壓縮器）
│   │   └── query-engine.ts        （FTS5 + Jaccard + 元認知整合查詢）
│   ├── api/                        ← 新增：HTTP API
│   │   ├── server.ts              （HTTP 服務啟動）
│   │   ├── routes.ts              （端點定義）
│   │   └── hooks-formatter.ts     （輸出格式化成 hooks 期望的 JSON）
│   └── index.ts                    ← 服務入口
├── hooks/                          ← Claude Code hooks 範例
│   ├── memory-session-start.sh    （SessionStart hook）
│   ├── memory-query.sh            （UserPromptSubmit hook）
│   ├── memory-checkpoint.sh       （PreCompact hook — 增量存檔 + 安全閥）
│   ├── memory-session-end.sh      （Stop hook）
│   └── install.sh                 （一鍵安裝 hooks 到 settings.json）
├── tests/
├── package.json
├── tsconfig.json
└── README.md
```

---

## 七、實作路線圖

### Phase 1：核心搬遷 + HTTP API（MVP）

- [ ] 新建 repo
- [ ] 從 ccRewind 抽取 core 模組（parser, scanner, summarizer, database, indexer, types）
- [ ] 裁剪 database.ts（移除 UI 相關 query，保留 FTS5 + Jaccard）
- [ ] 建立 HTTP server + 基本端點（/memory/query, /health）
- [ ] 寫 UserPromptSubmit hook 範例
- [ ] 驗證：hooks 打 API → 取得相關記憶 → 注入 context

**完成標準**：Claude Code session 中，打字時 hook 自動查詢過去的對話，注入相關片段。

### Phase 2：記憶寫入 + PreCompact 安全存檔（階段 B）

> **2026-04-14 更新**：PreCompact hook 已在階段 A 實作為 auto-compact 安全閥（`~/.claude/hooks/pre-compact.sh`）。Phase 2 將其升級為搭配 Memory Service 的自動存檔。

- [ ] 新增 memories table
- [ ] 實作 /memory/save 端點
- [ ] **實作 /session/checkpoint 端點**（PreCompact hook 專用）
  - 讀取 transcript_path → 增量提取上次 checkpoint 之後的新對話
  - 存入 memories table + 更新 knowledge_map
  - 返回成功/失敗 → hook 據此決定放行或阻擋 compaction
- [ ] 實作 Stop hook → /session/end 完整 session 摘要
- [ ] 升級 pre-compact.sh：從「純阻擋通知」改為「POST /session/checkpoint + 失敗阻擋」
- [ ] 增量 diff 邏輯：記錄每次 checkpoint 的 transcript offset，避免重複處理

**完成標準**：auto-compact 觸發時，記憶自動安全存入 SQLite 後才放行壓縮。失敗時阻擋 compaction 並通知使用者。

### Phase 3：元認知層（階段 C）

> **2026-04-14 更新**：PreCompact 是元認知更新的最佳觸發點——比 Stop 更好，因為長 session 中每個階段的知識增量都能被獨立記錄。

- [ ] 新增 knowledge_map table
- [ ] 實作 /metacognition/check 端點
- [ ] **PreCompact checkpoint 時同步更新 knowledge_map**
  - 分析 checkpoint 區間涉及的主題
  - 增量更新 depth / session_count / confidence
  - 粒度從「每 session」變成「每 compact 週期」
- [ ] Stop 時做最終 knowledge_map 更新（覆蓋最後一段殘餘）
- [ ] Hook 注入時附帶 knowledge depth 資訊

**完成標準**：AI 在回答問題前，hook 告訴它「你對這個主題研究過 3 次 / 完全沒碰過」。knowledge_map 在每次 compact 週期都會更新，不只依賴 session 結束。

### Hook 生態系完整生命週期（Phase 2+3 完成後）

```
SessionStart ────→ /memory/query ──→ 注入歷史相關記憶（additionalContext）
     ↓
UserPromptSubmit → /memory/query ──→ 即時比對記憶庫（additionalContext）
     ↓               /metacognition/check → 附帶知識深度
每次打字都觸發
     ↓
PreCompact ──────→ /session/checkpoint → 增量存檔 + 更新 knowledge_map
     ↓              失敗 → exit 2 阻擋
     ↓              成功 → exit 0 放行
[compaction 執行]
     ↓
（可能重複多次 UserPromptSubmit + PreCompact 循環）
     ↓
Stop ────────────→ /session/end → 完整 session 摘要 + 最終 knowledge_map
```

### Phase 4：遺忘曲線 + 優化

- [ ] 實作 compressor（定期壓縮舊記憶）
- [ ] Confidence 衰減機制
- [ ] 查詢效能優化（大量記憶時的 FTS5 + 排序）
- [ ] launchd plist 開機自啟動

### Phase 5（未來）：進階功能

- [ ] Web dashboard（localhost:PORT/dashboard）管理記憶
- [ ] 多 AI 工具支援（Codex / Gemini hooks）
- [ ] BYOK 模式：用 LLM 產生更高品質的摘要和壓縮
- [ ] 記憶匯入/匯出（跟 Obsidian vault 整合）

---

## 八、跟現有方案的差異化

| | claude-mem | Letta | 本專案 |
|---|-----------|-------|--------|
| 資料來源 | hooks 觀察 tool usage | 自建記憶流 | **完整 JSONL 對話紀錄**（最豐富） |
| 摘要引擎 | Claude agent-sdk（花 API 錢） | LLM 驅動 | **規則式引擎（零成本）** |
| 搜尋 | Chroma 向量 | 自建向量 | **FTS5 全文 + Jaccard**（已驗證） |
| 元認知 | 無 | 低 | **knowledge_map（核心差異）** |
| 遺忘曲線 | 無 | 無 | **分層壓縮** |
| GUI | 無 | 無 | ccRewind 可做前端（未來整合） |
| 基礎設施成熟度 | 從零建 | 獨立框架 | **ccRewind 已驗證的模組** |

---

## 九、命名討論

暫定名稱候選：

| 名稱 | 概念 |
|------|------|
| `ccRewind-memory` | 直接延伸 ccRewind 品牌 |
| `ccRecall` | Recall = 回憶，從 Rewind（回放）到 Recall（記憶） |
| `ccMind` | 致敬 obsidian-mind |
| `claude-memory` | 直白 |

---

## 十、相關研究文件

| 文件 | 位置 |
|------|------|
| AI 記憶系統全景 | `.claude/pi-research/ai-memory-systems-landscape.md` |
| Obsidian AI 記憶研究 | `.claude/pi-research/obsidian-ai-deep-memory.md` |
| 記憶系統設計（元認知核心） | `.claude/pi-research/ai-long-term-memory-design.md` |
| ccRewind 原始碼 | `/Users/tznthou/Documents/ccRwind/` |

---

*本文件定義了從 ccRewind 考古工具延伸出 AI 記憶服務的完整架構。核心差異化在於元認知層（knowledge_map）——讓 AI 不只記住過去，還知道自己知道什麼。*
