# ccRecall

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20--22-339933.svg)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5-003B57.svg)](https://www.sqlite.org/)

[English](README.md)

Claude Code 的本地記憶服務——索引你的對話歷史，按需召回相關 context，注入到未來的 session。核心服務零 API 成本；選配的 post-session extraction 透過 Haiku 約 $0.001/session。

---

## 流派宣言

五個立場，不妥協：

1. **本地優先。** 你的機器，你的資料。不上雲、不開帳號、不信任 localhost 以外的任何服務。
2. **SQLite 就是 API。** 一個 `.db` 檔案。`sqlite3` 隨時可查。你的記憶從不是黑箱。
3. **FTS5，不用向量。** 程式碼對話搜的是檔案路徑、錯誤訊息、工具名稱——關鍵詞就夠了。幾百個 session 的規模，embedding 解決的是不存在的問題。
4. **LLM 蒸餾，人類策展。** Haiku 在 session 結束後自動萃取（~$0.001）。auto memory 存你親手命名的決策。ccRecall 存沒人會手寫的長尾。
5. **對 `~/.claude/` 唯讀。** 讀 JSONL 記錄，從不寫入 Claude Code 的狀態。最壞情況：搜尋結果不好。永遠不會：搞壞你的設定。

---

## 核心概念

每次開一個新的 Claude Code session，AI 就完全失憶。花 20 分鐘講清楚的架構、一起 debug 的那個 bug、做過的決策——全部歸零，下次重來。

CLAUDE.md 和 RESUME.md 能幫忙，但它們是你手動維護的靜態檔案。ccRecall 把這件事自動化：讀取 JSONL 對話記錄、建立可搜尋的索引、透過 hooks 和 MCP 工具把相關記憶回傳給 Claude Code。AI 自己記住學過的東西——你不用再提醒它。

ccRecall 是 [ccRewind](https://github.com/tznthou/ccRewind)（對話回放 GUI）的「記憶」對應。ccRewind 讓人回頭看發生了什麼；ccRecall 讓 AI 記住發生了什麼。

> **命名說明**：本專案與 [spences10/ccrecall](https://github.com/spences10/ccrecall)（一個 analytics 導向的工具，恰好同名）無關。由於 npm 上 `ccrecall` 已被佔用，我們以 `@tznthou/ccrecall` 發佈，CLI 命令名為 `ccmem`。

---

## Dogfood 基準線

單人日用實測數據，不是對照實驗。更新於 2026-07-23。

| 指標 | 數值 |
|------|------|
| 持續運行 | 97 天 |
| 已索引 session | 2,298 筆，橫跨 46 個專案 |
| 記憶總數 | 532 筆（93% 帶 key 去重） |
| Knowledge map topics | 18,495 |
| 磁碟佔用 | 50 MB |

n = 1。這些數字說明系統有在跑、有在累積資料——不代表每條記憶都有用。「這條記憶到底有沒有幫到 session」目前沒有好的量測方式，這是個[開放問題](https://github.com/tznthou/ccRecall/issues/71)。

數字看不出來的是體感：沒有 ccRecall，每個 session 從零開始——你要把昨天 AI 已經學過的東西重講一遍。有了它，startup injection 把相關記憶帶回來，session 直接從上次斷的地方接上。一次注入省掉五分鐘的前情提要，就值回整個 daemon 的存在。

---

## 功能特色

| 功能 | 說明 |
|------|------|
| **規則式摘要引擎** | 從 session 中提取意圖、動作、結果、標籤——不呼叫 LLM，零 API 成本 |
| **FTS5 全文搜尋** | 所有對話歷史的關鍵詞搜尋 <100ms，快到可以在 hook 中注入 |
| **CJK / 中英混合搜尋** | Trigram tokenizer 索引中日韓文字；短 token 查詢（如 `UI 記憶`）以 per-token AND LIKE fallback 補齊，避開 trigram 對 <3 字 token 的盲區 |
| **增量索引** | 只重新索引有變動的 session（mtime 比對），透過 UUID 去重處理接續 session |
| **元認知** | `knowledge_map` 聚合 session + memory 的主題提及。由 mention count 衍生深度（shallow / medium / deep）。透過 MCP `recall_context` 暴露 |
| **遺忘曲線** | 記憶隨時間壓縮：原始→摘要→一行結論→刪除。未使用的記憶信心衰減。背景維護 tick 每 5 分鐘跑一次 |
| **跨專案記憶**（v0.4.1） | 記憶透過 topic intersection 跨專案浮出——若兩個專案的 `knowledge_map` 有共同 topic，高信心記憶會出現在另一個專案的 startup injection（最多 3 條，confidence ≥ 0.8 gate） |
| **Watch mode** | 基於 chokidar 的 JSONL watcher 在 2 秒內偵測新 session；每 10 分鐘 full-resync 補救 FS 事件漏接 |
| **Rescue reindex** | `/session/end` 和 `/session/last` 都會在 miss 時重 index 再試一次，`/session/last` 另有 `notBefore` staleness gate——hook、wrapper、daemon 三方不會有 fresh-session race |
| **macOS 自動啟動** | `ccmem install-daemon` 安裝 LaunchAgent，重開機自動復原服務 |
| **純唯讀** | 絕不修改 `~/.claude/`——只讀取 JSONL 記錄 |

---

## 架構

```mermaid
flowchart TB
    subgraph Input["資料來源（唯讀）"]
        JSONL["~/.claude/projects/*/*.jsonl"]
    end

    subgraph Core["ccRecall 服務（port 7749）"]
        Watcher["Watcher<br/>chokidar，2 秒 debounce"]
        Scanner["Scanner<br/>掃描 JSONL 檔案"]
        Parser["Parser<br/>解析對話"]
        Summarizer["Summarizer<br/>規則式萃取"]
        DB[("SQLite + FTS5<br/>索引與搜尋")]
        API["HTTP API<br/>5 個端點"]
    end

    subgraph Consumers["使用端"]
        Hook["Claude Code Hooks<br/>SessionStart / SessionEnd"]
        Wrapper["Extraction wrapper<br/>session 結束後的 Haiku 抽取"]
        MCP["MCP Server<br/>recall_query / recall_save"]
    end

    JSONL --> Watcher --> Scanner --> Parser --> Summarizer --> DB
    DB <--> API
    Hook -->|"注入 / 收尾確認"| API
    Wrapper -->|"GET /session/last"| API
    MCP <-->|"WAL 模式共用 SQLite"| DB
```

箭頭方向代表「誰呼叫誰」：hooks 和 extraction wrapper 走 HTTP 找 daemon；MCP server 則是獨立進程，直接開同一個 SQLite 檔（WAL 模式）——完全不經過 HTTP API。

### Session 生命週期

一個 session 頭尾兩端（都是跟時間賽跑的環節）實際怎麼跑：

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant H as Hooks
    participant R as ccRecall
    participant W as Wrapper
    participant X as Haiku 抽取器

    rect rgb(235, 244, 255)
    Note over CC,R: Session 開始
    CC->>H: SessionStart
    H->>R: GET /memory/startup
    R-->>H: 三層記憶挑選（< 300 tokens）
    H-->>CC: 注入 context
    end

    Note over CC,R: Session 進行中，watcher 持續<br/>增量索引 JSONL（2 秒 debounce）

    rect rgb(255, 244, 235)
    Note over CC,X: Session 結束
    CC->>H: SessionEnd
    H->>R: POST /session/end（確認已索引 + rescue）
    W->>R: GET /session/last?notBefore=launch_ts
    R-->>W: sessionId（過 staleness gate、濾掉 subagent）
    W->>X: 純文字 transcript
    X->>R: recall_save × 0–5 筆（經 MCP）
    end
```

`notBefore` gate 擋掉「抽到上一個舊 session」的重複抽取；subagent 過濾擋掉 Agent tool 側線 session 蓋台。這兩道防線存在的原因是同一個：wrapper 在 session 關閉後幾秒內就查詢，跟 watcher 的索引在賽跑。

---

## 技術棧

| 技術 | 用途 | 備註 |
|------|------|------|
| Node.js 20–22 + TypeScript | 執行環境 | ES modules、strict mode |
| better-sqlite3 | 資料庫 | 同步 API、零外部依賴 |
| FTS5 | 全文搜尋 | SQLite 內建、trigram tokenizer，短 token / 中英混合查詢透過 LIKE fallback 補齊 |
| 原生 `http` | HTTP 伺服器 | 不用 Express——最小表面積、僅 localhost |
| chokidar | 檔案系統 watcher | 跨平台 JSONL 變動偵測，2 秒 debounce + single-flight |
| vitest | 測試 | 542 個測試（34 檔案）、整合式風格 |
| `@modelcontextprotocol/sdk` | MCP server | stdio transport，透過 WAL 共用 SQLite |

---

## 快速開始

> **第一次來？** 完整教學（npm 安裝 → MCP 設定 → 日常使用）在 [`docs/tutorial_zh.md`](docs/tutorial_zh.md)。下方是 contributor / 開發模式路徑。

### 環境需求

- Node.js `>=20.0.0,<23.0.0`
- pnpm

### 安裝

```bash
git clone https://github.com/tznthou/ccRecall.git
cd ccRecall

pnpm install

# 啟動開發伺服器（啟動時自動索引，並 watch ~/.claude/projects）
pnpm dev
```

服務啟動在 `http://127.0.0.1:7749`，會自動索引 `~/.claude/projects/` 下所有 JSONL 檔案。

### 驗證

```bash
# 健康檢查——sessionCount 應該 > 0
curl http://127.0.0.1:7749/health

# 搜尋你的對話歷史
curl "http://127.0.0.1:7749/memory/query?q=authentication&limit=5"
```

---

## API 端點

五個端點，每個都有活的 caller——v0.5.0 移除了其餘八個
（`/journal/*`、`/memory/save`、`/memory/context`、`/metacognition/check`、
`/session/checkpoint`、`/lint/warnings`），現在一律回 404。

| 端點 | 方法 | 說明 | Caller |
|------|------|------|--------|
| `/health` | GET | 服務健康 + DB 統計 + integrity 檢查狀態 | CLI、extraction wrapper |
| `/memory/startup?project=...` | GET | SessionStart 級檢索：cold + recent-confidence + FTS fallback，帶 token 預算 | SessionStart hook |
| `/memory/query?q=...&limit=...&project=...` | GET | FTS5 跨記憶搜尋，可選 project 過濾 | SessionStart hook（keyword 層） |
| `/session/end` | POST | 確認剛結束的 session 已被索引（miss 時 rescue reindex） | SessionEnd hook |
| `/session/last?cwd=...` | GET | 回傳專案路徑的最新 session metadata（`notBefore` staleness gate） | Extraction wrapper |

## MCP 工具

| 工具 | 用途 |
|------|------|
| `recall_query` | 使用者範圍的 FTS5 關鍵字搜尋，帶 project-aware 排序。跨專案記憶透過 topic intersection 浮出 |
| `recall_context` | 按 topic 分組的檢索——normalize keywords、依匹配 topic 分組 memories 並附 depth 訊號，無 topic 匹配時退回 per-keyword FTS |
| `recall_save` | 儲存新記憶，支援選填 `key` slug 做 dedup（同 key 更新而非重複）。自動抽取 topics 供跨專案檢索 |

**Memory types**（用於 `recall_save`）：

- `decision`（決策）— 有理由的明確選擇
- `discovery`（發現）— 非顯而易見的洞察
- `preference`（偏好）— 使用者風格或慣例
- `pattern`（模式）— 反覆出現的流程或程式碼範本
- `feedback`（回饋）— 使用者對過往工作的修正

註冊到 Claude Code。`pnpm build` 後 `dist/mcp/server.js` 就是可執行的 MCP server：

```bash
# 用 build 出的 bin（pnpm build 之後）
claude mcp add ccrecall --scope user -- /absolute/path/to/ccRecall/dist/mcp/server.js

# 或開發時用 tsx 不經 build
claude mcp add ccrecall --scope user -- /absolute/path/to/ccRecall/node_modules/.bin/tsx /absolute/path/to/ccRecall/src/mcp/server.ts
```

可直接複製的範本：[.mcp.json.example](.mcp.json.example)。

SessionStart / SessionEnd hook 安裝見 [hooks/README.md](hooks/README.md)。

---

## CLI 指令

`@tznthou/ccrecall` 提供兩個 binary：

- **`ccmem`** — daemon 啟動 + 管理指令
- **`ccmem-mcp`** — MCP server（透過 `claude mcp add` 註冊到 Claude Code）

Daemon 與 hook 生命週期（macOS）：

| 指令 | 用途 |
|------|------|
| `ccmem` | 前景跑 daemon |
| `ccmem install-daemon` | 註冊 LaunchAgent（開機自動啟動） |
| `ccmem uninstall-daemon` | 停掉並移除 LaunchAgent |
| `ccmem install-hooks` | 把 SessionStart / SessionEnd 條目合併進 `~/.claude/settings.json` |
| `ccmem uninstall-hooks` | 移除 ccRecall 自己的 hook 條目（其他 hook 不動） |
| `ccmem cleanup --orphans` | 列出（加 `--yes` 則刪除）session 已消失的 orphan 記憶 |

`ccmem promote` / `ccmem reject` 已於 v0.5.0 隨 journal 管線一併移除。

---

## ccRecall 與 auto memory 的分工

ccRecall 和 Claude Code 內建的 auto memory（`~/.claude/projects/*/memory/`）是互補關係，各司其職，不要混用。

|  | auto memory | ccRecall |
|---|---|---|
| **寫入路徑** | Claude 手動策展——新開一個 `.md` 檔 + 更新 MEMORY.md index | 雙軌：規則式 session 摘要（自動、免費）+ 選配 Haiku extraction（~$0.001/session，可搜尋的記憶主要來自這條路） |
| **讀取路徑** | 永遠在 session context（MEMORY.md 啟動時就載入） | auto memory 沒答案時，才用 MCP 查詢 |
| **訊號密度** | 高——值得被命名的決策和偏好 | 長尾——hook 能抓到的都留著 |
| **適用情境** | 「記住 X」「以後都 Y」——重要偏好、明確決策 | 「上次那個怎麼修的？」——跨多個 session 的回憶 |

**寫入預設：存 auto memory，ccRecall 讓 hook 自己抓就好。** 不要 auto memory 寫完一份、又呼叫 `recall_save` 複寫一次——雙寫只會製造噪音。

**查詢預設：MEMORY.md 已經在 context 裡，先看 index 有沒有。** auto memory 沒答案，才 fallback 到 `recall_query` / `recall_context`。

ccRecall 的價值在長尾——幾百個 session 不可能全手工整理。如果 Claude 兩邊都試，auto memory 永遠會贏（本來就在 context 裡而且已經被策展）。ccRecall 存在的意義是：策展索引漏掉時，長尾那堆還在資料庫裡可以撈出來。

**如果 Anthropic 自己做了呢？** 現在的 auto memory 是綁在 Claude Code 專案結構裡的 `.md` 檔案——文字可攜，但不能查詢。ccRecall 是一個 SQLite 檔案，`sqlite3` 直接查、SQL 隨便下、備份就是複製一個檔案、不依賴 Claude Code 的設定才能用。差異不在 local vs cloud——是策展型文件庫 vs 可搜尋的資料庫。如果內建 memory 夠用，用它。ccRecall 是給那些累積了幾百個 session、沒人會手動整理、但你還是想搜的長尾用的。

---

## 作為服務運行（macOS）

ccRecall 是本地 HTTP daemon。要重開機也維持運行，註冊 per-user LaunchAgent：

```bash
pnpm build
node dist/index.js install-daemon        # 或 `ccmem install-daemon`（若已全域 link）
node dist/index.js install-daemon --dry-run   # 預覽 plist 不寫檔

# 驗證
launchctl list | grep ccrecall
curl http://127.0.0.1:7749/health

# 移除
node dist/index.js uninstall-daemon
```

installer 的行為：
- 寫入 `~/Library/LaunchAgents/com.tznthou.ccrecall.plist`
- log 路由到 `~/Library/Logs/ccrecall/ccrecall.{out,err}.log`
- 從當前 shell 的 `CCRECALL_PORT` / `CCRECALL_DB_PATH` 寫入 plist，確保
  LaunchAgent 用和你互動執行時一致的設定
- 拒絕覆蓋 `Label` 不匹配的 plist（安全檢查）

完整手動安裝、troubleshooting、uninstall 文件：[docs/launchd.md](docs/launchd.md)。

Linux/Windows 對應版本（systemd unit、Windows service）列在未來版本。目前
Linux 可用 `nohup` 或自選 process manager。

---

## 監控

daemon 啟動時跑一次 `PRAGMA integrity_check`，之後每 6 小時重跑。結果
（timestamp + 布林值）會 cache 並透過 `/health` 的 `lastIntegrityCheckAt`
／ `lastIntegrityCheckOk` 欄位回報。偵測到 drift 時，完整 `integrity_check`
輸出會寫入 `~/.ccrecall/integrity-alerts/` 下含時間戳的檔案。

收到 drift alert 時，**先 snapshot DB，再執行 REINDEX**。REINDEX 修症狀但
抹掉現場：

```bash
cp ~/.ccrecall/ccrecall.db ~/ccrecall-drift-snapshot.db
sqlite3 ~/.ccrecall/ccrecall.db 'REINDEX;'
```

### WAL 維護

Indexer 每個 batch 結束時會跑 `PRAGMA wal_checkpoint(TRUNCATE)`，所以
`ccrecall.db-wal` sidecar 在每次 reindex 跑完都會被重設為 0 bytes。長期
運行的 daemon 上，WAL 大多時間會貼近 0，只在 batch 跑的當下短暫飆高。

如果發現 WAL 無界增長（接近主檔大小），檢查 stderr 是否有
`[indexer] WAL checkpoint busy` 警告——這代表有 reader 連續好幾個 batch
都把 snapshot hold 過了 `busy_timeout`，truncate 一直 defer。找出元凶
client 後，下一個乾淨 batch 就會回收磁碟空間。

---

## 專案結構

```
ccRecall/
├── src/
│   ├── core/
│   │   ├── types.ts                  # 所有型別定義
│   │   ├── parser.ts                 # JSONL 對話解析
│   │   ├── scanner.ts                # 檔案系統掃描
│   │   ├── summarizer.ts             # 規則式 session 摘要
│   │   ├── topic-extractor.ts        # 規則式 topic 抽取
│   │   ├── database.ts               # SQLite + FTS5(從 ccRewind 裁剪)
│   │   ├── indexer.ts                # 索引 pipeline 調度
│   │   ├── memory-service.ts         # 記憶生命週期(touch / delete / update)
│   │   ├── compression.ts            # L0→L1→L2→delete 狀態機
│   │   ├── maintenance-coordinator.ts # 背景壓縮 tick
│   │   ├── watcher.ts                # chokidar JSONL watcher(Phase 4e)
│   │   └── log-safe.ts               # scrubErrorMessage — log-injection 防護
│   ├── api/
│   │   ├── server.ts                 # HTTP 伺服器
│   │   └── routes.ts                 # 路由 + rescue reindex
│   ├── mcp/
│   │   ├── server.ts                 # MCP stdio server 入口(含 shebang)
│   │   └── tools.ts                  # recall_query + recall_context + recall_save
│   ├── cli/
│   │   └── daemon.ts                 # install-daemon / uninstall-daemon(macOS)
│   └── index.ts                      # HTTP 入口 + 子指令分派
├── hooks/
│   ├── session-start.mjs             # SessionStart 注入記憶(stdout)
│   ├── session-end.mjs               # SessionEnd 呼叫 /session/end
│   └── README.md                     # Hook 安裝指南
├── docs/
│   ├── tutorial_zh.md                # 使用者教學（安裝 → MCP → 日常使用）
│   ├── architecture_zh.md            # Daemon 設計取捨（給 contributor 看）
│   └── launchd.md                    # macOS LaunchAgent 安裝/troubleshoot
├── tests/                            # 542 個測試橫跨 34 檔案（parser、scanner、
│   │                                 # summarizer、database、indexer、e2e、MCP、
│   │                                 # memories、hooks、watcher、CLI、migrations、
│   │                                 # FTS5 CJK edge cases、integrity monitor 等）
│   └── fixtures/                     # 測試用 JSONL + 共用 helpers
├── .mcp.json.example                 # MCP client 設定範本
└── NOTICE / SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md
```

---

## 相關專案

- **[ccRewind](https://github.com/tznthou/ccRewind)** — Claude Code 的 session 回放 GUI。ccRecall 的核心模組（parser, scanner, summarizer, database, indexer）從 ccRewind 抽取而來。

---

## 設計哲學

### 為什麼做這個

Anthropic Claude Code 團隊的 Thariq 在 2026 年 4 月[發表了 context 管理的文章](https://x.com/trq212)——11,908 個書籤，因為大家存起來反覆看但沒人有工具做到。他把問題講得很精準：context rot 讓長 session 的模型表現退化，autocompact 在最爛的時機觸發。

他給了方法論，沒給工具。ccRecall 就是那個工具。

真正的觸發點更簡單：我受夠了每次跨 session 都要重新跟 Claude Code 解釋同一個架構。不是 AI 記性差——它根本不能記。每個 session 從零開始。CLAUDE.md 能幫忙，但它是我手動維護的靜態檔案。維護成本的增長速度超過知識的增值速度。聽起來很熟？這正是人類放棄 wiki 的原因（Karpathy 的 LLM Wiki 洞見）。

### 設計立場

每一條都從宣言延伸。每一條都是對流行做法的刻意拒絕。

**規則式，有天花板。** daemon 用 heuristic 萃取（regex 模式、工具使用分析、outcome 推斷）做 session 摘要——零 API 成本。做這件事，「Edit×8, 5 files, committed」比一段散文更有用。但 rule-based 有天花板：結構化訊號（tool call、檔案編輯、commit message）抓得到；討論中的決策、微妙的取捨、任何活在自然語言裡的東西，它抓不到。這就是 v0.4.1 加入 post-session Haiku extraction（~$0.001/session）的原因——用一次 LLM pass 補上 heuristic 的盲區。實際上，我真正會搜到的記憶大多來自 Haiku extraction 或手動 `recall_save`，不是規則式那層。daemon 本體永遠不呼叫 LLM；LLM pass 是選配的，作為獨立進程在 daemon 之外執行。

**FTS5，不用向量搜尋。** 語義搜尋聽起來更高級，但對話記錄搜的是具體的工具名、檔案路徑、錯誤訊息——關鍵詞匹配就夠了。FTS5 查詢在本地 <10ms。不需要 embedding model、不需要 Chroma、不需要 Docker container。在我們的規模（數百個 session，不是百萬文件），Karpathy 自己的分析也確認：「500 個來源以下，樸素索引 + 關鍵詞搜尋已經夠用。」

**HTTP + MCP 雙介面。** MCP tools 是注入 context 到 Claude 最穩定的方式（pull-based，Claude 決定何時取）。SessionStart hooks（push-based，自動注入）也穩定。ccRecall 兩個都跑：HTTP 給 hooks 用，MCP 給按需查詢。同一個 SQLite 後端，兩種存取模式。

**唯讀，無條件。** ccRecall 絕不修改 `~/.claude/`、絕不寫入 session 檔案、絕不自動把自己注入 Claude Code 的設定。這不是禮貌——是信任邊界。如果一個背景服務能寫入你的設定，一個 bug 就可能毀掉你的 session。使用者自己決定設定 hooks 和 MCP。ccRecall 不會自己安裝自己。

**刻意排除的技術棧。** 不用 Docker——`pnpm dev` 就能跑的東西不需要部署摩擦。不用 Electron——ccRecall 沒有 UI（那是 ccRewind 的事）。不用向量資料庫——在我們的規模解決的是不存在的問題。這些是立場，不是缺失。

**不做帶偏見的注入。** ccRecall 不替 Claude 決定該記住什麼。它提供搜尋 API——注入層呈現結果，Claude 自己整合。帶偏見的記憶篩選是過早優化，而且會以我們無法預測的方式出錯。

---

## 路線圖

| 版本 | 主題 | 狀態 |
|------|------|------|
| **v0.3.x** | 手動存、自動召回——記憶來自明確的 `recall_save` 呼叫；SessionStart hook 和 MCP 工具在未來 session 注入 | 已釋出 |
| **v0.4.x** | Post-session extraction via Haiku、跨專案 topic intersection 記憶、萃取管線強化（race gate、壓縮完整性、subagent 過濾、安全性） | 已釋出 |
| **v0.5.0** | 砍刀場：journal/scorer/harvester 管線移除（史上零 promotion）、端點 13 → 5、`message_uuids` 雙 hash 重建（DB 114MB → 42MB） | 已釋出 |
| **v0.5.2** | 召回權重：對數壓縮 half-life decay、FTS relevance-first 排序 `(-rank)*sqrt(EC)` | 已釋出 |
| **v0.5.3** | CJK topic 對齊：Han-aware topic 抽取（`\p{Script=Han}` tokenizer + 中文 stopwords 32 條 + 助詞分割）、session-less rebuild 修正 | 已釋出 |

追蹤於 [GitHub Issues](https://github.com/tznthou/ccRecall/issues)。

---

## 變更記錄

版本更新與歷程記錄在 [CHANGELOG_ZH.md](CHANGELOG_ZH.md)。每個 tag 都有對應條目；`Unreleased` 段是已進 `main`、尚未發 npm 的改動。

---

## 授權

本專案使用 Apache License 2.0 授權 —— 見 [LICENSE](LICENSE)。

Copyright 2026 tznthou

---

## 作者

tznthou — [tznthou.com](https://tznthou.com) · [tznthou@gmail.com](mailto:tznthou@gmail.com)
