# 變更記錄

ccRecall 的重要版本變更記錄在這裡。

格式大致依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)；版號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)（`1.0` 前屬 pre-stable，破壞性變更會記錄，但 minor 號偏向迭代計數而非嚴格 SemVer major）。

[English](CHANGELOG.md)

---

## [Unreleased]

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
