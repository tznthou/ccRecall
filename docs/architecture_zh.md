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
│  │ 10min backstop│ │ 壓縮排程     │  │ 注入查詢   │      │
│  │ single-flight│  │ single-flight│  │ rescue     │      │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘      │
│         │                 │                │              │
│         └──── SQLite (WAL 模式) ←──────────┘              │
└──────────────────────────────────────────────────────────┘
```

每個引擎職責獨立；那些 `single-flight` guard 不是花拳繡腿——它們必須存在，因為真實負載下衝突無可避免。

---

## Bootstrap：為何要 await 第一次索引

`src/index.ts:92-152`

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

獨立的 5 分鐘 timer、獨立的 single-flight。每 tick 一件事：
`CompressionPipeline.runOnce({ batchSize: 50 })`——讓記憶老化、分階段壓縮
（raw → summary → 一行）、60 天沒被 access 就砍。（v0.5.0 前這個 tick 還會
sweep journal 表；那條管線已移除。）

它**不**共用 watcher 的 single-flight。為什麼：watcher 寫 `sessions/messages/topics`，coordinator 寫 `memories`。兩邊表 disjoint，不會污染彼此 state。唯一可能衝突的是 SQLite writer（WAL 一次一個 writer），但那是吞吐量問題不是正確性問題。每引擎各自 single-flight 就是讓各自最壞 case 只綁自己，不拖累別的引擎。

`timer.unref()`——coordinator 的 interval 不擋 process 存活。HTTP server 才是 authoritative keep-alive。這在測試環境下重要：server close 時壓縮 timer 不會卡死 process。

---

## 引擎 3：HTTP + session 收尾確認

`src/api/routes.ts`

Memory 不是 watcher 建的。Watcher 把 **session summary** 寫進 `sessions` 表；memory 由 post-session extraction wrapper（Haiku → MCP `recall_save`）與手動 `recall_save` 寫入。`/session/end` 做的事更窄但承重：確認剛結束的 session 已被索引，miss 時觸發 rescue reindex。這 endpoint 由 SessionEnd hook `hooks/session-end.mjs` 觸發。

（歷史：v0.3.0 到 v0.4.x 這個 endpoint 還會把規則計分的候選 harvest 進 `session_journal` 審閱佇列。佇列史上零 promotion，post-session extraction 又讓它徹底多餘——v0.5.0 整條管線移除。下方「Trust grade」一節留了墓誌銘。）

### 為什麼 session 收尾靠 hook 不靠 watcher

Session 的 JSONL 只要使用者一直 resume 就會一直長。Watcher 看得到檔案寫入、看不到 session 生命週期——只有 Claude Code 知道 session 什麼時候真的結束，而需要這個時刻的兩個消費者（這裡的索引確認、extraction wrapper 的 `/session/last` 查詢）都只要它發生一次；所以才靠 hook。

`hooks/session-end.mjs:82` 那個 `reason: 'resume'` 的 filter 是 contract 的另一半——resume 不算 end event，跳過。

### rescueReindex：刻意繞過

Hook 觸發時 daemon 可能還沒看到那個 JSONL（fresh-session race：hook fire 比 chokidar `add` event 更早），endpoint 會先 `rescueReindex` 再放棄。關鍵：

```ts
// src/index.ts:143
const server = createServer(db, {
  rescueReindex: coalesceRescue(() => runIndexer(db)),
  ...
})
```

`coalesceRescue` 在 `/session/end` 和 `/session/last` 同一次 session close 都 miss 時共用（而非丟棄）同一次 run。`watcher.runNow()` 會尊重 watcher 的 single-flight——也就是已經有 scan 在跑時 rescue 會被默默 drop（只翻 `dirty`）。那是我們**不**想要的：client 正在等 200 回來，而 extraction wrapper 馬上就要用 `/session/last` 查這個 session。直接呼 `runIndexer(db)` 繞過 single-flight，給 caller 確定性的執行。

取捨：兩個 `runIndexer` 同時跑可能 writer 爭用。實際上不會 corrupt——SQLite WAL 會 serialize write——而且 window 很窄（rescue 只在 cache miss 時跑）。

---

## Trust grade vs persistence gate（墓誌銘）

兩代寫入路徑設計死在這裡；文件留著它們的故事，因為兩座墳都解釋了現在的形狀。

**Persistence gate（0.3.0 前）。** `summarizer.ts` 的 rule scorer 直接決定 harvest 是否被持久化（`score >= KNOWLEDGE_THRESHOLD`）。對 39 筆 known-good outcome 的 corpus audit 結果是 **0** 過 threshold——regex 計分系統性低估真實 outcome（[issue #25](https://github.com/tznthou/ccRecall/issues/25)）。

**Trust 二層（v0.3.0 → v0.4.x）。** 結構性修法把 scorer 從 gate 上移開：harvest 一律落進 recall 讀不到的 low-trust `session_journal` 佇列，由人工 `ccmem promote` 升級進 `memories`。Race-safe、測試完整、哲學上站得住——然後**史上零 promotion**。沒有人會去審一個佇列。同時 v0.4.1 的 post-session extraction 開始直接寫入審過、有 key、去重的記憶，把佇列一直在等人做的策展做掉了。

v0.5.0 下了結論：journal 管線、rule scorer、harvest 分支整組移除。今天只剩一條自動寫入路徑（extraction → `recall_save`）加一條手動路徑（session 中 `recall_save`），都落在 `memories`。值得留下的教訓：一個永遠等不到審閱者的審閱佇列不是 trust boundary，是死信箱。

---

## 我們選的取捨

| 選擇 | 替代方案 | 為什麼 |
|---|---|---|
| 事件驅動 + 10min backstop | 純每 N 秒 polling | 閒置時 polling 浪費工；純事件抓不到 APFS/NFS 邊角。Backstop 是保險不是主線 |
| Rule-based summarizer（零 LLM）| 呼叫 Claude 做 summary | 每個 session 都燒錢。Rule-based 覆蓋主流形狀；邊角 fallback 到 `discovery` confidence 0.7，Claude recall 時自己判 |
| 每引擎獨立 single-flight | 一個 global lock | Global lock 會讓壓縮擋索引反之亦然。per-engine 隔離爆炸半徑 |
| Session 收尾信號靠 hook | Watcher 側偵測 | 只有 Claude Code 知道 session 真正什麼時候結束。Watcher 看到的是檔案寫入，不是 session 生命週期 |
| Rescue 繞 single-flight | Rescue 尊重 single-flight | Rescue 是 blocking HTTP request。被 watcher 的 `dirty` flag 默默吞掉會讓 hook 收到 404。確定執行贏過一致性 |
| 單一寫入路徑、LLM 策展（v0.5.0） | 規則計分審閱佇列（v0.3.0–v0.4.x） | 佇列史上零 promotion；extraction 直接寫審過、有 key 的記憶。沒人駐守的 trust boundary 就是死信箱——見上方墓誌銘 |
| Replay 去重用雙 64-bit hash（v0.5.0） | 36 字元 TEXT uuid | 登記表只回答「看過沒」——沒有任何地方要把 uuid 讀回來。40 萬筆從 73.6MB 縮到 17.3MB；4×10⁻⁹ 的碰撞頂多跳過一則 replay 訊息 |

---

## 已知限制

故意**不**把具體數字寫死在本文——這種東西壞得快。現況請看：

- Open issues：[#11](https://github.com/tznthou/ccRecall/issues/11)（WAL/VACUUM 物理壓縮——0.2.0 已把 VACUUM 移出 daemon startup，部分緩解）、[#13](https://github.com/tznthou/ccRecall/issues/13)（FTS5 CJK edge cases）

真實狀態永遠以 `gh issue list` + 專案筆記為準，不是本檔。

---

## 要繼續追哪些 source

| 問題 | file:line |
|---|---|
| Bootstrap 順序長怎樣 | `src/index.ts`（grep `startDaemon`） |
| Watcher 怎麼決定什麼時候 scan | `src/core/watcher.ts:73-109` |
| runIndexer 實際做什麼 | `src/core/indexer.ts:62-271` |
| Session 結束後 memory 怎麼寫入 | `scripts/post-session-extract.sh` + `scripts/extraction-prompt.md` |
| Summarizer 吐什麼出來 | `src/core/summarizer.ts`（grep `summarizeSession`） |
| 為什麼 `reason: 'resume'` 要跳 | `hooks/session-end.mjs:82` |
| Compression 怎麼排程 | `src/core/maintenance-coordinator.ts:48-54` |
| v24 砍刀場 migration 在哪定義 | `src/core/database.ts`（grep `version: 24`） |
| 雙 hash 去重登記表怎麼運作 | `src/core/database.ts`（grep `hash64`） |

發現本檔寫錯的地方、或某個 trade-off 沒講到？開 [GitHub Issue](https://github.com/tznthou/ccRecall/issues)——code 才是 truth，本檔只該追著它走。
