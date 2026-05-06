# 架構設計 — daemon 為什麼長這樣

> [English](architecture.md)

這不是 tutorial。想裝 ccRecall 來用請看 [tutorial_zh.md](tutorial_zh.md)。想知道 daemon 為什麼要跑三個 timer 而不是一個、為什麼 `awaitWriteFinish` 要設 500ms、為什麼 `/session/end` 明明可以重用 watcher 卻選擇繞過它——這篇是為你寫的。

Source code 是 truth。像 `src/core/watcher.ts:73` 這種指標帶你直接跳過去看。下面寫的是那些塞不進 code comment 的推論跟取捨。

---

## 一個 process 三個引擎

`ccmem` 啟動時不是開一個 loop——是同時編排三個：

```
┌──────────────────────────────────────────────────────────┐
│  同一個 process（port 7749）                              │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐      │
│  │ JsonlWatcher │  │ Maintenance  │  │ HTTP/MCP   │      │
│  │（事件驅動）  │  │ Coordinator  │  │ Server     │      │
│  │              │  │（5 分鐘 tick）│ │（需求觸發）│      │
│  │ 2s debounce  │  │              │  │            │      │
│  │ 10min backstop│ │ 壓縮排程     │  │ harvest    │      │
│  │ single-flight│  │ single-flight│  │ rescue     │      │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘      │
│         │                 │                │              │
│         └──── SQLite (WAL 模式) ←──────────┘              │
└──────────────────────────────────────────────────────────┘
```

每個引擎職責獨立；那些 `single-flight` guard 不是花拳繡腿——它們必須存在，因為真實負載下衝突無可避免。

---

## Bootstrap：為何要 await 第一次索引

`src/index.ts:100-148`

順序有講究：

1. 開 SQLite
2. **Await** 完整跑一次 `runIndexer(db)`
3. 啟動 `MaintenanceCoordinator`
4. 啟動 `JsonlWatcher`（await 它的 `ready` event）
5. HTTP listen

Step 2 到 step 4 之間有 race window。如果 chokidar 用 `ignoreInitial: true` 在你自己 tree walk 完成**之前**就起來，那個 window 裡被寫的 JSONL 兩條路都看不到——chokidar 跳過（檔案 chokidar 一開始就在了）、indexer 也已經掃過那個目錄。這檔要嘛等 10 分鐘 backstop，要嘛 `/session/end` rescue 觸發才會被發現。

Await 第一次 indexer 就是讓 `ignoreInitial` 的 contract 乾淨：「目前 disk 上所有東西都由我們掌握；chokidar 啊，只告訴我們**這一刻之後**的變動就好。」

---

## 引擎 1：JsonlWatcher

`src/core/watcher.ts`

### Debounce

Claude Code 寫 JSONL 是流式爆發——每個 tool call 可能在同一檔上毫秒內觸發好幾個 `change` event。沒 debounce 就每 event 跑一次 `runIndexer`，每次都全樹掃 + N 檔 parse。Debounce 把一陣 event 合併成「最後一個 event 後 2 秒跑一次 scan」。

### Backstop

Debounce 會被餓死。如果 session 很愛講話——每 1.5 秒一個 tool call、跑一小時——每個 event 都把 debounce 往後推，scan 永遠輪不到。所以 backstop 直接繞過 debounce：

```ts
setInterval(() => { void this.runScan() }, this.fullResyncMs)   // 10 min
```

這不是備援 chokidar 的正確性。Chokidar 大致可靠，但檔案系統有邊角——APFS rename race、NFS event loss、跨 mount 的 symlink。Backstop 是保險，不是冗余。

### awaitWriteFinish: 500ms

Claude Code 整個 session 共用同一個 open file handle 寫 JSONL。`change` event 可能在一行寫到一半時觸發——`{"type":"assistant"...` 才剛 flush 一半你就 parse，parse error 就錯過一筆有效 message。`awaitWriteFinish.stabilityThreshold: 500` 的意思：等 500ms 沒新 byte 才視為「改動完成」。夠長擋得住半寫入，夠短感覺不到遲鈍。

### single-flight

Scan 跑到一半又來 event，我們不 queue——設一個 `dirty` flag 等現在這次跑完，然後只排一次 follow-up。Queue 的替代方案有病態 case：scan N、N 期間來 event、queue N+1、N+1 期間又來 event、queue N+2... 持續寫入壓力下工作量無界。

---

## 引擎 2：MaintenanceCoordinator

`src/core/maintenance-coordinator.ts`

獨立的 5 分鐘 timer、獨立的 single-flight。每 tick 兩個 sweep（v0.3.0 起）：

1. `CompressionPipeline.runOnce({ batchSize: 50 })`——讓記憶老化、分階段壓縮（raw → summary → 一行）、60 天沒被 access 就砍。
2. `sweepJournal()`——刪掉 `rejected` 過期（7 天 `expires_at`）的 journal 條目，加上 `pending` 超過 30 天的條目。`promoted` 條目不刪，留作 audit trail（promotion 當下已經寫了一筆 `memories` row）。

兩個 sweep 共用 coordinator 自己的 single-flight；watcher 那條獨立。

它**不**共用 watcher 的 single-flight。為什麼：watcher 寫 `sessions/messages/topics`，coordinator 寫 `memories`。兩邊表 disjoint，不會污染彼此 state。唯一可能衝突的是 SQLite writer（WAL 一次一個 writer），但那是吞吐量問題不是正確性問題。每引擎各自 single-flight 就是讓各自最壞 case 只綁自己，不拖累別的引擎。

`timer.unref()`——coordinator 的 interval 不擋 process 存活。HTTP server 才是 authoritative keep-alive。這在測試環境下重要：server close 時壓縮 timer 不會卡死 process。

---

## 引擎 3：HTTP + harvest endpoint

`src/api/routes.ts`

Memory 不是 watcher 建的。Watcher 把 **session summary** 寫進 `sessions` 表；把 summary 萃取成 journal 候選只在 `/session/end` 被呼叫時才發生。這 endpoint 由 SessionEnd hook `hooks/session-end.mjs` 觸發。

v0.3.0 起 harvest 寫入目標是 `session_journal`，**不是** `memories`。Hook 產出的是 low-trust 候選；要變成 high-trust memory 需要顯式呼叫 `POST /journal/promote`（一般透過 `ccmem promote <id>`）。Manual `POST /memory/save` 跟 MCP `recall_save` 仍然直寫 `memories`——完全不經 journal。Rationale 見下方「Trust grade vs persistence gate」。

### 為什麼 harvest 靠 hook 不靠 watcher

Session 的 JSONL 只要使用者一直 resume 就會一直長。你不會想每次檔案變動都 harvest——會產生幾千筆重複或半成品 memory。你要的是「session 真正結束的那一下 harvest 一次」。只有 Claude Code 知道 session 什麼時候真的結束；所以才靠 hook。

`hooks/session-end.mjs:82` 那個 `reason: 'resume'` 的 filter 是 contract 的另一半——resume 不算 end event，跳過。（實際上我們懷疑這個 filter 判太寬——看下面「已知限制」的 harvest rate gap。）

### rescueReindex：刻意繞過

Hook 觸發時 daemon 可能還沒看到那個 JSONL（fresh-session race：hook fire 比 chokidar `add` event 更早），endpoint 會先 `rescueReindex` 再放棄。關鍵：

```ts
// src/index.ts:141
const server = createServer(db, {
  rescueReindex: () => runIndexer(db),   // 不是 watcher.runNow()
  ...
})
```

`watcher.runNow()` 會尊重 watcher 的 single-flight——也就是已經有 scan 在跑時 rescue 會被默默 drop（只翻 `dirty`）。那是我們**不**想要的：client 正在等 200 回來。直接呼 `runIndexer(db)` 繞過 single-flight，給 caller 確定性的執行。

取捨：兩個 `runIndexer` 同時跑可能 writer 爭用。實際上不會 corrupt——SQLite WAL 會 serialize write——而且 window 很窄（rescue 只在 cache miss 時跑）。

### Promote 與 reject 路徑

`POST /journal/promote` 在單一 BEGIN/COMMIT 裡跑四步：`saveMemory` → `saveMemoryTopics` → `rebuildKnowledgeMap` → `promoteJournalEntry`（後者把 journal row 設成 `status = 'promoted'` 並 link `promoted_memory_id`）。任一步 throw，transaction rollback，journal row 留在 `pending`。`promoteJournalEntry()` 回 `false`（並發 promote race）會在 transaction 內 re-throw，已經寫進去的 memory row 也跟著 rollback——race-safe by construction，不靠 `SELECT … FOR UPDATE` 把戲。

`POST /journal/reject` 簡單：把 `status` 設 `rejected`、`expires_at` 設 now + 7 天。Engine 2 的 decay sweep 之後收。選 soft-delete + TTL（而不是立即 `DELETE`）的理由：誤 reject 一週內救得回來——`UPDATE session_journal SET status = 'pending', expires_at = NULL WHERE id = ?` 就好。

---

## Trust grade vs persistence gate（0.3.0 重設計）

v0.3.0 之前，`summarizer.ts` 的 rule scorer 直接決定 harvest 是否被持久化（`score >= KNOWLEDGE_THRESHOLD`）。對 39 筆 known-good outcome 的 corpus audit 結果是 **0** 過 threshold——scorer 系統性低估真實 outcome（failure 場景整理在 [issue #25](https://github.com/tznthou/ccRecall/issues/25)）。再加 regex pattern 只會延後下次撞牆。

結構性修法是把 scorer 從 persistence gate 上移開。Harvest 現在**永遠**會落地；scorer 改成提供 trust grade 與 promote 優先序，不再是 yes/no。兩張表、兩個 trust 層：

| 表 | 寫入路徑 | Trust | 讀取路徑 |
|---|---|---|---|
| `session_journal` | SessionEnd hook（自動） | 低——需審閱 | `/journal/pending`、`/health.journalPendingCount` |
| `memories` | `recall_save`（手動）**或** `ccmem promote` | 高——明確人工 OK | `recall_query`、`recall_context`、`/memory/query` |

Hard floor 仍在。Scorer 的 `noise` 與 `process-report` reason 仍然 short-circuit（不論落到哪都不算 knowledge），所以 Claude Code 的 session 收尾摘要也不會污染 journal。

這套設計買到的：harvester 廣捕、recall 結果不被污染；trust 決策可以隨 pattern 演化重放，不需重跑 harvester、不會掉資料。代價：要有人做 promotion。Manual-only by design——auto-promote at threshold *正是*我們剛剛拆掉的 persistence gate，會重蹈失敗模式。`/health` 露 pending 計數、`/journal/pending` 列完整清單，是 surfacing 機制。

---

## 我們選的取捨

| 選擇 | 替代方案 | 為什麼 |
|---|---|---|
| 事件驅動 + 10min backstop | 純每 N 秒 polling | 閒置時 polling 浪費工；純事件抓不到 APFS/NFS 邊角。Backstop 是保險不是主線 |
| Rule-based summarizer（零 LLM）| 呼叫 Claude 做 summary | 每個 session 都燒錢。Rule-based 覆蓋主流形狀；邊角 fallback 到 `discovery` confidence 0.7，Claude recall 時自己判 |
| 每引擎獨立 single-flight | 一個 global lock | Global lock 會讓壓縮擋索引反之亦然。per-engine 隔離爆炸半徑 |
| Hook-driven harvest | Watcher-driven harvest | 只有 Claude Code 知道 session 真正什麼時候結束。Watcher 看到的是檔案寫入，不是 session 生命週期 |
| Rescue 繞 single-flight | Rescue 尊重 single-flight | Rescue 是 blocking HTTP request。被 watcher 的 `dirty` flag 默默吞掉會讓 hook 收到 404。確定執行贏過一致性 |
| 兩個 trust 層（`session_journal` + `memories`）| 單表加一個 `trust` 欄位 | 表 disjoint 讓 `recall_query` 簡單明確——不用每次都 `WHERE trust = 'high'`。Hook 寫入永遠不會誤汙染 recall，就算未來某 bug 忘了過濾欄位也安全。代價是多一張表，遷移一次付完；recall 端的省則是永久的 |
| 只開 manual promotion | 分數到 threshold 就 auto-promote | Auto-promote at threshold *就是*我們剛剛拆掉的 persistence gate。Threshold-driven persistence 正是 0/39 audit 的兇手。Manual promote（搭配 `/health` surfacing）讓人工留在我們已知 scorer 不可信的決策點上 |

---

## 已知限制

故意**不**把具體數字寫死在本文——這種東西壞得快。現況請看：

- Open issues：[#11](https://github.com/tznthou/ccRecall/issues/11)（WAL/VACUUM 物理壓縮——0.2.0 已把 VACUUM 移出 daemon startup，部分緩解）、[#13](https://github.com/tznthou/ccRecall/issues/13)（FTS5 CJK edge cases）
- Harvest rate gap：實際上有非同小可的 session 明明有 summary 卻被跳過。主要嫌疑犯是 `reason: 'resume'` filter 判太寬；log `reason` 分布在 quick-fix 清單

真實狀態永遠以 `gh issue list` + 專案筆記為準，不是本檔。

---

## 要繼續追哪些 source

| 問題 | file:line |
|---|---|
| Bootstrap 順序長怎樣 | `src/index.ts:100-148` |
| Watcher 怎麼決定什麼時候 scan | `src/core/watcher.ts:73-109` |
| runIndexer 實際做什麼 | `src/core/indexer.ts:62-262` |
| Harvest 怎麼從 session 組出 memory | `src/api/routes.ts:85-99` + `:285-375` |
| Summarizer 吐什麼出來 | `src/core/summarizer.ts:420-480` |
| 為什麼 `reason: 'resume'` 要跳 | `hooks/session-end.mjs:82` |
| Compression 怎麼排程 | `src/core/maintenance-coordinator.ts:51-57` |
| v22 schema migration 在哪定義 | `src/core/database.ts`（grep `journalCreateSql`） |
| `POST /journal/promote` 怎麼維持 atomic | `src/api/routes.ts`（grep `promoteJournal`） |
| Journal decay sweep 在哪跑 | `src/core/maintenance-coordinator.ts`（grep `sweepJournal`） |
| `ccmem promote` / `reject` CLI 在哪 | `src/cli/journal.ts` |

發現本檔寫錯的地方、或某個 trade-off 沒講到？開 [GitHub Issue](https://github.com/tznthou/ccRecall/issues)——code 才是 truth，本檔只該追著它走。
