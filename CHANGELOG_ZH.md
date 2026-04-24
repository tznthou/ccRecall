# 變更記錄

ccRecall 的重要版本變更記錄在這裡。

格式大致依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)；版號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)（`1.0` 前屬 pre-stable，破壞性變更會記錄，但 minor 號偏向迭代計數而非嚴格 SemVer major）。

[English](CHANGELOG.md)

---

## [0.2.1] — 2026-04-25

### 新增

- **Runtime `PRAGMA integrity_check` 監測器** ——啟動 daemon 時跑一次、之後每 6 小時自動跑一次的 SQLite 健康檢查。專門抓 write-path bug 留下的沈默 index / FTS / B-tree drift——這類異常沒人跑 REINDEX 之前通常不會浮出來。使用的 pragma 是純唯讀的，在 live WAL DB 上跑不會和 reader / writer 爭搶。`setInterval` 的 timer 加了 `unref`，monitor 不會阻止 event loop 結束；正常關閉路徑走 `coordinator.stop()`。
- **`/health` 新增 `lastIntegrityCheckAt` 和 `lastIntegrityCheckOk`** 兩個欄位 ——讓 liveness probe 拿得到最近一次 tick 的 ISO 時間戳和通過與否。完整的 drift 輸出（多行 `PRAGMA integrity_check` 結果）另寫到 `~/.ccrecall/integrity-alerts/integrity-check-<timestamp>.log`，不塞進 cache ——`/health` 保持輕量 liveness 訊號的定位，不兼任鑑識紀錄存放處。
- **單飛排程（single-flight）** ——6 小時 interval 觸發時若上一輪還沒跑完，新呼叫直接丟棄，不和還在跑的 pragma 競速。

### 動機

2026-04-24 一次 ad-hoc 的 `PRAGMA integrity_check` 抓到沈默 index drift（`idx_memories_access` 漏了 row 48）——這個 drift 熬過了完整 `VACUUM`，最後靠手動 `REINDEX` 才修掉。這一版是**偵測層**：不會阻止 drift 發生，但把沈默 drift 的最長時間壓到 6 小時。抓到時，alert log 會明確叮嚀**先快照 DB**（`cp ~/.ccrecall/ccrecall.db ~/ccrecall-drift-snapshot.db`）**再**跑任何修復，保留鑑識狀態給後續分析。

### 文件

- 架構文件 / CLAUDE.md 註明 integrity monitor 在治理層的角色（偵測層；Tier 0/1 的 root-cause 工作還在後頭）。
- 記憶類型文件釐清 liveness 資料（`/health` cache）和鑑識紀錄（磁碟上的 alert files）的分野。

### 測試

- `tests/integrity-monitor.test.ts`（145 行）涵蓋 start/stop 生命週期、single-flight 防護、注入 clock 驗 timer cadence、`/health` 表面、alert file 格式、以及 live WAL DB 的唯讀保證。
- 測試數：451 → 463。

### 升級清單

```bash
# 1. 安裝 0.2.1
npm i -g @tznthou/ccrecall@0.2.1

# 2. 重啟 daemon 讓它吃到新 build
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. 驗證 monitor 有在跑
curl -s http://127.0.0.1:7749/health | jq '{lastIntegrityCheckAt, lastIntegrityCheckOk}'
# 預期：最近時間戳 + "lastIntegrityCheckOk": true
```

如果 `lastIntegrityCheckOk` 出現 `false`，先去 `~/.ccrecall/integrity-alerts/` 看完整 forensic 輸出再決定修復動作。

---

## [0.2.0] — 2026-04-21

### 破壞性變更

- **移除四張 messages 系列舊表** ——`messages`、`message_content`、`message_archive`、`messages_fts`（含它們的 FTS5 triggers 與 indexes）全砍掉。這些表是當初從 ccRewind 抽核心模組時帶進來的基因遺留；內部 audit 確認砍了零功能損失。記憶 recall、session 摘要、memories_fts / sessions_fts 的 FTS、harvest 流程一切不動——這些路徑全都走 `memories_fts` / `sessions_fts` / `sessions.summary_text`，從來沒碰 messages 系列。
- **移除 `Database` 公開 method**：`getMessages`、`getMessageContext`、`search`、`getSessionTokenStats`，以及對應型別 `Message`、`MessageContext`、`SearchPage`、`SearchResult`、`SearchScope`、`SessionTokenStats`。全專案 grep 確認 production 零 caller（hooks / MCP tools / HTTP routes 都沒用），它們只是被自家 test 撐著沒清的死碼。
- **Schema 升到 v20。**

### 使用者影響

**功能零影響** ——recall 行為完全一樣。差別在磁碟：一個健康的 ccRecall 跑兩週累積到 ~700 MB 的 DB，在 `sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'` 回收空間後會縮到個位數 MB。長期儲存曲線從每年 ~95 GB 降到十年 ~2 GB。

### Migration

- **首次啟動 daemon 自動跑**。v19 → v20 在單一 SQLite transaction 內完成：
  1. 執行前 `copyFileSync(dbPath, dbPath + '.pre-v20.bak')`——快照起來，避免 non-SQL 類故障（磁碟滿、segfault、WAL 壞軌）把資料孤立。SQL 層錯誤本來就有 transaction auto-rollback 蓋到。
  2. 建 `message_uuids (uuid PK, session_id REFERENCES sessions ON DELETE CASCADE)` + `idx_message_uuids_session`。
  3. 從 `messages` 回填，**依 session 年齡排序**（舊 session 在 replay 時擁有共享 uuid 的 ownership——和原本 dedup 語意一致）。
  4. 驗 `COUNT(DISTINCT uuid) FROM messages` = `COUNT(*) FROM message_uuids`。不等即 throw 附清楚錯誤訊息；transaction rollback，DB 停在 v19，backup 檔在磁碟上。
  5. 依相依順序砍四表 + triggers。
- **Migration 後的 auto-`VACUUM` 拿掉**。成熟的 ~700 MB DB 上它會讓 daemon 啟動卡數分鐘。VACUUM 改為 user-driven：`sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'`（先停 daemon——`ccmem uninstall-daemon` 或 `launchctl stop com.tznthou.ccrecall`）。
- 在 Database constructor 加 **`PRAGMA busy_timeout = 5000`**，避免並行 reader（例如使用者另開 `sqlite3` CLI）讓 daemon 吃 SQLITE_BUSY 崩掉。

### 新增

- **`ccmem cleanup --orphans`** CLI ——列出 `session_id` 指向已不存在 session row 的 memories（test fixture、手動 `DELETE FROM sessions`、partial-index race 會留下這種）。預設是**唯讀 dry-run** ——純 SELECT，可與 live daemon 並存。加 `--yes` 在 stdin 確認後於單一 transaction 內刪除。`--reconcile` 是 opt-in，會先跑完整 indexer pass（DB 疑似 stale 時才用）；這是寫入路徑，跑前必須先停 daemon 避免 SQLite writer 爭用。手動 memory（`session_id IS NULL`）完全不動。
- **`message_uuids` lookup 表** ——舊 messages 架構唯一存活的部分。`indexSession()` 寫 `{uuid, session_id}` 進去；`getExistingUuids()` 從這裡查 resumed-session replay dedup。表很小：一筆 uuid 一筆 row，不含 content，session_id FK ON DELETE CASCADE。

### 移除

- `search()` 移除後失去呼叫者的 private helpers——`fts5QuoteIfNeeded`、`likePattern`、`hasShortToken`、`VALID_OUTCOMES`、`parseOutcomeStatus`——**保留**，因為 `searchSessions()` 還在用。
- `deleteSubagentSession()` 拿掉顯式 `DELETE FROM messages`；現在靠 `sessions` 的 FK cascade 自動清 `message_uuids` 跟 `session_files`。

### 測試

- 刪 `tests/fts5-cjk.test.ts`（測 `db.search()`，現已不存在）。
- 刪 `tests/migration-v19.test.ts` ——其斷言驗的是 v20 馬上會 discard 的 schema 狀態，coverage 合進新的 `tests/migration-v20.test.ts`，後者跑：
  - 新 DB 狀態（v20 表存在、四舊表消失、`schema_version` 有 row 20、sessions → message_uuids 的 FK CASCADE）。
  - v19 → v20 升級 happy path（把新 DB rewind 回模擬 v19、seed messages、reopen、驗 backup 檔 + message_uuids 回填 + 舊表被砍）。
  - 回填順序語意（較舊的 session 擁有共享 uuid）。
  - 負路徑 abort（回填 count 不等直接 throw、transaction rollback、backup 還在）。
- 重寫 `tests/database.test.ts` / `tests/indexer.test.ts` 的 `indexSession` / `archiveStaleSessionsExcept` 斷言，改為檢查 `message_uuids` + `session.messageCount`，不再看 message content。
- 測試數：477 → 451（砍了 31 個針對已移除 code 的斷言；新增 11 個 v20 migration + cleanup CLI 測試）。

### 升級清單

```bash
# 1. 停 daemon
ccmem uninstall-daemon   # 或 launchctl stop com.tznthou.ccrecall

# 2. 安裝 0.2.0
npm i -g @tznthou/ccrecall@0.2.0

# 3. 啟動——首啟跑 migration，backup 會建在 DB 旁邊
ccmem install-daemon
tail -f ~/.ccrecall/daemon.log   # 看到 "Pre-v20 backup created at ..." 就是通過

# 4. 回收磁碟（選用，但建議）
launchctl stop com.tznthou.ccrecall
sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'
launchctl start com.tznthou.ccrecall

# 5. 確認沒問題後刪掉 backup
rm ~/.ccrecall/ccrecall.db.pre-v20.bak
```

---

## [0.1.7] — 2026-04-20

### 新增

- **`recall_query` / `recall_context` 加上 token budget** ([#12](https://github.com/tznthou/ccRecall/issues/12))——公開文件寫 recall 每次呼叫 `<300 tokens`，但實作直接把每筆命中的 `m.content` 全吐出，沒有任何 cap。一筆長敘事記憶就能讓 recall 呼叫漲到 1500+ tokens 而使用者毫無感覺。
  - 新增 `src/core/token-budget.ts`——CJK-aware 的 token 估算器（CJK 字 ≈ 1 token，Latin 字 ≈ 0.3 token），外加 code-point 安全的 `truncateToChars`。
  - Per-row 字元 cap（預設 150 chars，超過加 ellipsis），避免單一長記憶壟斷 output。
  - 總 output budget（預設 300 tokens），超過會在尾端補 `(... +N more memories truncated)` trailer——截斷永遠可見，不做靜默丟棄。
  - 兩個 MCP tool schema 都加 optional `maxTokens`（正整數，上限 2000）；不傳就守住公開合約，caller 有需要再自行提高。
  - `docs/tutorial.md` 跟 `docs/tutorial_zh.md` 把描述從硬上限改成「預設 ~300 tokens，可透過 `maxTokens` 調整」。

### 修正

- **`touch()` 會更新到被 budget 砍掉的 memory** ——加上 budget 截斷後，`recall_query` / `recall_context` 還是把 DB 全查詢結果都當成「surfaced」標記，等於把 caller 根本沒看到的記憶也延壽，長期會扭曲 decay / compression 決策。改成 `formatMemories` 跟 `formatContextResult` 回傳 `{ text, emittedIds }`，handler 只 touch 真的 emit 出去的那些。這是流水線跑 Codex adversarial review 當場抓到的。
- **Budget 漏算 header 跟 trailer** ——初版只算 memory row 的 token，trailer、blank line、以及 `formatContextResult` 動態產生的 markdown header（`# Relevant memories`、`## Topic: …`、`## FTS fallback`）都沒計，常見情境仍會超標。改成每個 header 用 `approximateTokens()` 實算，並預留 `TRAILER_RESERVE_TOKENS = 20` 給 trailer 跟 unmatched note。

### 備註

- #12 把 `maxTokens` 做成 soft target 不做 server-side hard cap。Codex 提出 MCP schema 欄位會讓 model-controlled caller 繞過 300 上限——這是設計取捨：schema description 明寫預設守住 `<300`，需要放寬時 opt-in，彈性優先。hard cap 屬另一個設計議題，不算 #12 的 bug。
- 總共新增 22 個測試（18 個 `token-budget.test.ts` + 4 個 MCP integration case），全專案 477 個測試通過。

---

## [0.1.6] — 2026-04-19

### 修正

- **CJK 查詢在 FTS5 永遠 0 筆結果** ([#10](https://github.com/tznthou/ccRecall/issues/10))——`unicode61` tokenizer 會把中日韓每個字都切成一個 token，比 FTS5 的最小匹配長度（通常 3）還短，所以繁體中文、日文、韓文關鍵字查下去永遠沒命中。使用者拿中文詞打 `recall_query` 只會拿到靜默的 0 row。
  - 把 3 張 FTS5 表（`memories_fts`、`sessions_fts`、`messages_fts`）的 tokenizer 從 `unicode61` 改成 `trigram`。
  - 任何含 < 3 字元 token 的查詢都走 LIKE fallback——順便修掉 `UI`、`DB`、`CI`、`PR` 這類 2 字元 Latin 縮寫原本也遇到的相同問題。
  - Migration **v19** 在單一 transaction 內 rebuild 三張 FTS 表（`DROP + CREATE + INSERT SELECT`）。實測在 587 MB / 109K 訊息的 DB 上約 1 秒完成（比 plan 預估的 30 秒快 30 倍）。

### 變更

- **`queryMemories` ORDER BY 調整** ——primary 從 `rank` 換成 `EFFECTIVE_CONFIDENCE DESC`，`rank` 降為 tiebreaker。trigram tokenizer 下 BM25 在短文本 ranking 不穩，而 decay 語意（記憶有壽命）本來就該是記憶的主要排序依據。

### 內部

- Codex adversarial review 抓到原 plan 的 blind spot：最初的 fallback gate 只 check CJK，但 trigram 對任何 < 3 字元的 token 都會 miss，跟語言無關。把 `containsCJK()` 改成 `hasShortToken()`，順手砍掉沒人用到的 CJK utility。
- 455 個測試通過（baseline 433 + 新增 22：15 個 FTS5 CJK regression + 7 個 migration v19 schema/backfill）。

---

## [0.1.5] — 2026-04-18

### 變更

- **MCP tool descriptions 明文讓位給 Claude Code auto memory** ([#9](https://github.com/tznthou/ccRecall/issues/9))——這版之前，每個 tool 的 description 都寫類似「當 user 提到過去的工作時使用」，跟 auto memory 的範圍完全重疊。結果 Claude 看哪邊的指令更具體就走哪邊（auto memory 透過 CLAUDE.md 有明確指示），`recall_query` / `recall_save` 幾乎被晾著沒用。
  - `recall_query`：「USE ONLY AFTER checking auto memory first」
  - `recall_context`：同樣明文讓位 + 加上「topic vs FTS」的判斷指引
  - `recall_save`：「RARELY USED MANUALLY — SessionEnd hook auto-harvests each session」
  - 兩份 README 新增 `## ccRecall vs auto memory` section，用表格說清楚分工。

### 安全強化

- **`install-hooks` tmp 檔的 mode 改成 0o600 [M01]** ——`writeFileSync` 原本靠預設的 `0o666 & ~umask`，在 atomic rename 之前 tmp `settings.json` 短暫世界可讀。release pipeline 的安全檢查抓到。

### 文件

- `docs/research/ai-long-term-memory-design.md` 裡提到私有工具的地方改寫成功能性描述，公開可安裝的工具（`Serena MCP` 等）保留原名。

---

## [0.1.4] — 2026-04-18

### 修正

- **`ccmem --version` / `-v` / `version`** ([#7](https://github.com/tznthou/ccRecall/issues/7))——以前會 fall through 到 `startDaemon()`，如果 LaunchAgent 在跑就 `EADDRINUSE` 炸掉，在新機器上則卡在 indexing。改成印版號後 exit。
- **`install-hooks` backup 檔名格式** ([#8](https://github.com/tznthou/ccRecall/issues/8))——從 epoch millis（`settings.json.bak-1776509587711`）換成 ISO-8601-ish（`settings.json.bak-2026-04-18T18-50-00-123`），可排序、Windows 可用、毫秒精度。
  - 第一版修法砍掉了毫秒精度。Codex 自動 review 當場抓出：同一秒內跑兩次 `install-hooks` 會用同一個 backup 檔名，等於靜默覆寫使用者唯一一份 `settings.json`。當版內修掉，regression test 把格式鎖住。

### 文件

- `docs/research/` 目錄公開——三份 research note（`ccrecall-for-kids`、`ai-long-term-memory-design`、`ccrewind-memory-service-architecture`）從私有 `.claude/` 搬出來。tutorial 的 "Going Deeper" link 終於能在 GitHub 上打開了。
- 新增 `docs/launchd_zh.md`，跟英文版 LaunchAgent 指南對應。
- 修掉 README 裡 ccRewind URL 的 typo（`github.com/user` → `github.com/tznthou`）。

---

## [0.1.3] — 2026-04-18

### 修正

- **`package.json` engines 語法** ([#1](https://github.com/tznthou/ccRecall/issues/1))——原本用逗號分隔，npm install 每次都噴 EBADENGINE 警告。改成 spec 規定的空白分隔。
- **`/health` 回報真實套件版號** ([#2](https://github.com/tznthou/ccRecall/issues/2))——之前 hardcode 成 `0.1.0`。
- **`/health` 回報 active SQLite path** ([#3](https://github.com/tznthou/ccRecall/issues/3))——之前是空字串。
- **`ccmem install-daemon` 真的驗證啟動** ([#4](https://github.com/tznthou/ccRecall/issues/4))——跑完會 poll launchctl 拿 PID，打一發 `/health` probe，印出三種狀態之一（running / crashed / indexing）。取代原本甩鍋給使用者「請用 launchctl list 驗證」。

### 新增

- **`ccmem install-hooks` / `ccmem uninstall-hooks`** ([#5](https://github.com/tznthou/ccRecall/issues/5))——自動配置 Claude Code 的 SessionStart / SessionEnd hook 到 `~/.claude/settings.json`，取代原本要手動算 `npm root -g` 再改 JSON 的繁瑣流程。
- **Tutorial 新增 "How It Runs in the Background" section** ([#6](https://github.com/tznthou/ccRecall/issues/6))——解釋 daemon / watcher / 10 分鐘 backstop / hook 的關係，讓使用者不用再問「我要定期手動重掃嗎」。

### 內部

- 第一次走完整 `tag push → OIDC → npm publish` pipeline 上架。
  - `publish.yml` 釘 Node 24——Node 22 / npm 10 會讓 npm 當前的 Trusted Publishing handshake 靜默失敗，npm 回一個誤導性的 `404 Not Found`。
  - `package.json` 必須 declare `repository.url` 精確對應 GitHub repo——npm 會用這個欄位驗 signed provenance bundle，不一致就回 `422 Unprocessable Entity`。
- 新增 37 個測試（28 個 `install-hooks`、6 個 daemon verify、3 個 `/health`）。總計 433 個測試通過，跨 27 個檔案。

---

## [0.1.1] — 2026-04-18

**第一個公開 release。**

### 修正

- **Fresh clone 測試綠了** ——`pnpm.onlyBuiltDependencies` 讓 `better-sqlite3` 跟 `esbuild` 在 install 時自動 build。之前 pnpm v10 會跳過 native binding build 導致 247 個測試掛掉。這版是第一次 `git clone && pnpm install && pnpm test` 能走到 396/396 全綠。

### 變更

- **完整 vendor Contributor Covenant v2.1** ——取代短版 stub，Code of Conduct 可獨立閱讀、離線可看。

### 狀態

Phase 1–4 完成：parser、資料層、MCP tools、metacognition（knowledge map）、遺忘曲線壓縮、JSONL watcher、macOS LaunchAgent daemon。跨 session 記憶召回在真實 Claude Code session 實測驗過。

---

## [0.1.0]

內部 baseline——未發到 npm。

Phase 1–4 實作完成：396 個測試通過，採 Apache-2.0 授權，repo 於 2026-04-18 公開。
