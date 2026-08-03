# 變更記錄

ccRecall 的重要版本變更記錄在這裡。

格式大致依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)；版號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)（`1.0` 前屬 pre-stable，破壞性變更會記錄，但 minor 號偏向迭代計數而非嚴格 SemVer major）。

[English](CHANGELOG.md)

---

## [未發布]

### 修正

- **`scripts/usefulness-report.sql` 把兩種注入來源算成同一種**（#82）—
  COVERAGE 段直接 `FROM injection_log` 沒有 source 條件，`COUNT(DISTINCT
  memory_id)` 因此把 startup 注入和 v0.6.0 對話中喚起寫進同一張表的 `prompt`
  列混為一談。同一段還報 lifetime 跨度，但這個數字只有放在近期窗口看才有
  意義。現在拆成兩張依 source 分組的表——lifetime 一張，rolling 7 天一張
  （用滾動窗口而非寫死日期）。各 source 的列不能相加：同一則記憶被兩種來源
  注入時，在各自的列裡都算 distinct。

---

## [0.7.0] — 2026-08-03

CJK topic 有 91.5% 是 singleton（Latin 是 52.1%），因為舊 extractor 只能拿
標點切漢字串：沒標點的長串直接整條丟掉，有標點的切出黏連子句碎片
（`否開始作用`）——這種 key 不會有任何其他文字再產生一次。寫入側和查詢側
都在鑄造沒人對得上的鑰匙。

### 新增

- **CJK 字典分詞**（#80）— 純漢字 token 改走 `Intl.Segmenter('zh-TW')`。
  Latin 刻意不進分詞器：ICU 會把 `better-sqlite3` 切成 `better`/`sqlite3`，
  等於毀掉索引裡佔約 97% 的 Latin 部分。
- **small-icu 防護** — 沒帶完整 ICU 資料的 build（如 Fedora 的 `nodejs`
  沒裝 `nodejs-full-i18n`）建構 segmenter 是 SIGSEGV 不是可攔的例外
  （[nodejs/node#51752](https://github.com/nodejs/node/issues/51752)），而本模組
  在 daemon import 時就載入。改在建構前檢查
  `process.config.variables.icu_small`，這類 build 降級回舊切法。並導出
  `SEGMENTER_OK` 讓 CI 驗證 runtime 真的在做字典分詞而不是靜默降級。
- **`rebuildMemoryTopics()`** — 對每一則記憶重算 `memory_topics`，包含已有
  topic 者。`backfillMemoryTopics()` 的過濾條件是 `NOT IN memory_topics`，
  語料補完後它就處理零筆——extractor 本身換版時完全派不上用場。
  `scripts/backfill-memory-topics.ts` 新增 `--rebuild`，附前後 topic 數的
  dry-run 投影。
- **CJK stopword 擴充** — 分詞後虛詞會以獨立 token 出現，故過濾純虛詞
  （`是否`、`因此`、`目前`…）。刻意保守：帶專案語義的詞即使看起來泛用
  也保留。

## [0.6.0] — 2026-08-02

記憶只在第 0 秒被端出來一次。session 之後跑幾小時、轉到什麼題目，都不會再
查一次記憶庫——這就是 `recall_query` 佔全部記憶浮現不到 1% 的原因。這一版
補上第二個觸發點，讓注入時被切掉的內容可以用 `recall_query` 撈回全文，並讓一個長期隱形的
extraction 失敗現形。

### 新增

- **對話中喚起記憶** —— 新的 `UserPromptSubmit` hook
  （`hooks/user-prompt-submit.mjs`），後端是 `GET /memory/prompt`。從 prompt
  抽出 topic，在 session 進行中撈出相關記憶。

  設計上刻意節制，因為注入的 context 會累積在對話裡而不是被替換
  （[claude-code#40216](https://github.com/anthropics/claude-code/issues/40216)）
  ——每次注入都是永久的重量。太短的 prompt 和斜線指令連網路請求都不發；
  本 session 已經給過的記憶不再重複；每個 session 上限 8 則；300ms 逾時；
  任何錯誤都靜默放行。在 742 則記憶的庫上實測端到端約 40ms。
  設 `CCRECALL_PROMPT_RECALL=off` 可關閉。

  排序用 topic 的逆文件頻率，以專案為範圍計算，並除以該則記憶自身的 topic
  數做正規化——少了這步，長記憶會不分主題地壓過所有結果，那正是 startup
  選擇邏輯身上同一種長度偏差。

- **注入的記憶帶上 key。** startup 每列是約 150 字元的節錄，而記憶平均長得
  多，切點通常落在結論之前。key 現在會跟著 API 一路送到注入層，渲染成可用的
  handle，切掉的部分可以用 `recall_query` 撈回全文。footer 也改了措辭，
  明講這些是節錄，而不是只報「還有幾則可以搜」——後者讀起來像在說眼前這些
  是完整的。

- **extraction 靜默漏抽的偵測。** extraction 模型有時會把 `recall_save(...)`
  印成文字而不是真的呼叫工具：那次 run 會 exit 0、stderr 全空、什麼都沒寫
  進去，在遙測裡跟「這個 session 真的沒東西好存」長得一模一樣。wrapper 現在
  會數這種被印出來的呼叫語法，寫進新的 `recallSaveTextCount` 遙測欄位（只記
  次數，不留任何被比對到的內容），並在乾淨結束卻出現這種情況時於終端示警。

### 變更

- **`ccmem install-hooks` 現在會註冊三個 hook**，在 `SessionStart`、
  `SessionEnd` 之外多了 `UserPromptSubmit`。在既有安裝上重跑 install 會把它
  加進去。跟另外兩個不同，這個每次送出 prompt 都會跑——節制機制與關閉開關
  見 `hooks/README.md`。

## [0.5.6] — 2026-07-26

### 變更

- **`/health` 欄位 `sessionCount` 更名為 `mainSessionCount`** —— 這個值
  一直只計算 main session（排除 subagent session），舊名稱讀起來像
  sessions 表的總量，實際不是。若有 script 讀 `/health`，請更新欄位名。

### 新增

- **SessionEnd hook 的 harvest 決策記錄到 stderr** —— skip（resume /
  缺 session_id）與 harvest 啟動現在都會記錄 hook `reason`，事後可以
  聚合出 reason 分布來診斷 harvest 漏抓。先前 skip 完全靜默，漏抓無從查起。

## [0.5.5] — 2026-07-24

### 變更

- **Tier 0 啟動注入現在會輪替**（#71 Phase B）—— Tier 0 排序先前是純靜態，
  同樣三筆記憶每個 session 都佔據啟動注入的位置。現在以 injection_log
  subquery 作為第二排序鍵：confidence 降冪，其次最久未注入者優先
  （從未注入 = 最高優先），再以 created_at 降冪。

### 新增

- **`scripts/usefulness-report.sql`** —— topic 重疊分析（#71 S1），含資料
  品質閘門、重疊分布、各 source 細分、注入次數 top-10 記憶。

## [0.5.4] — 2026-07-23

### 新增

- **injection_log**（#71 Phase A）—— migration v25 新增 `injection_log` 表，
  記錄每次記憶 `touch()` 的 source（startup / query / recall_query /
  recall_context）與可選的 session_id，為 usefulness 歸因鋪路。
  SessionStart hook 現在會把 session_id 傳給 `/memory/startup`；
  sessionId 由 server 端正規化（空字串 → null）；INSERT OR IGNORE
  讓不存在的 memory ID 也能安全記錄。

## [0.5.3] — 2026-07-23

### 變更

- **Topic extraction 現在保留 CJK 字元** —— `normalizeTopicKey` 改用
  `\p{Script=Han}`（Unicode property escape）而非全部剝除非 ASCII 字元。
  中文詞彙如砍刀場、版本、驗證現在會出現在 knowledge map 的 topic key 中。
  內容抽取在中文標點和常用語法助詞（的/了/是/在）處切分，實現輕量分詞而無需
  外部依賴。CJK 停用詞約 32 個過濾雜訊；純漢字連續超過 6 字的段落跳過
  （由 FTS5 trigram 覆蓋）。生產驗證：CJK topic 從 0 升至 772 筆，
  總量僅增 1.09 倍。

### 修復

- **`rebuildKnowledgeMap` 漏掉 session-less 記憶** —— memory_topics 分支
  對 sessions 用 INNER JOIN，靜默丟棄所有 `recall_save` 記憶（佔總數 14%）。
  改用 LEFT JOIN + `COALESCE(s.project_id, m.project_id)` 回退。
- **`getMemoriesByTopics` 同樣有 INNER JOIN 缺口** —— topic 檢索現在與
  rebuild 路徑一致，session-less 記憶既被計入也可被查到。
  （PTA cross-source finding：Simplify 與 Security 獨立指出。）

### 升級指南

**僅限記憶內容含 CJK 文字的使用者**（中文、日文漢字、韓文漢字）。
純英文使用者無需任何動作，升級即完成。

新的 CJK 抽取器只影響**升級後**寫入的記憶。要為既有記憶補上 CJK topics，
升級 `npm install -g` 後跑一次：

```sh
pnpm tsx scripts/backfill-memory-topics.ts
```

此腳本會跳過已有 topics 的記憶，不會自動重新抽取 CJK topics。如果你從
≤ 0.5.2 升級且想為舊記憶補 CJK topics，用以下指令（可重複執行，
重複的會被忽略）：

```sh
npx tsx -e "
  import {Database} from './src/core/database.js';
  import {extractTopicsFromContent} from './src/core/topic-extractor.js';
  const db = new Database(require('os').homedir()+'/.ccrecall/ccrecall.db');
  const mems = db.rawAll('SELECT id,content,project_id,session_id FROM memories');
  let n = 0;
  for (const m of mems) {
    const cjk = extractTopicsFromContent(m.content).filter(t => /\p{Script=Han}/u.test(t));
    if (!cjk.length) continue;
    const pid = m.project_id || '';
    if (!pid) continue;
    for (const t of cjk) {
      try { db.rawExec(\`INSERT OR IGNORE INTO memory_topics VALUES (\${m.id},'\${t}','\${pid}')\`); n++; } catch {}
    }
  }
  const projects = db.rawAll('SELECT id FROM projects');
  for (const p of projects) db.rebuildKnowledgeMap(p.id);
  console.log(n + ' CJK topic entries added');
  db.close();
"
```

## [0.5.2] — 2026-07-23

### 變更

- **Recall 排序改為 FTS 相關度與 confidence 乘法混合** ——
  `recall_query` 原本先按 effective confidence 排序、FTS rank 只當同分決勝；
  一筆新鮮但匹配鬆散的記憶可能排在老舊但精確匹配的前面。新公式
  `(-rank) * sqrt(EC)` 同時加權兩個訊號，文字匹配強的記憶即使衰減中等也能
  贏過匹配弱但新鮮的。API 回傳格式不變，排序更合理。

- **Half-life 在 4 次存取之後改為對數成長** —— 存取次數 1–4 的 half-life
  維持 14–35 天（與 v0.5.1 完全相同）。超過 4 次後，half-life 改走
  `7 + 7 · (min(k,4) + 2.5 · ln(1 + max(0, k−4)))` 而非一律封頂在 35 天。
  k=10 → ~69 天、k=50 → ~102 天、k=302 → ~135 天。常被存取的記憶衰減更慢，
  但不會變成永生。

- Age days 加 `MAX(0, ...)` 夾鉗，防止時鐘飄移或手動編輯造成的未來時間戳。

## [0.5.0] — 2026-07-16

砍刀場版本。2026-06-10 的全面體檢給出裁決，這一版負責執行：journal 管線
**史上零 promotion**（177 筆 pending = 死信佇列）、13 個 HTTP endpoint 有 8
個零 caller、整顆資料庫 65% 在養簿記表。死掉的東西這次一刀清完，breaking
一次付清。留下來的是真正在跑的管線：post-session extraction → keyed
memories → 啟動注入 / MCP recall。

### 移除（breaking）

- **Journal 管線整組** —— `session_journal` 表、`/journal/promote`、
  `/journal/pending`、`/journal/reject` 三個 endpoint、`ccmem promote` /
  `ccmem reject` CLI、decay sweep、以及 v0.3.0 的 trust 二層寫入路徑。
  自動 harvest 進審核佇列的設計從頭到尾沒換來一次 promotion；v0.4.1 的
  post-session extraction 直接寫入去重後的記憶，佇列早已失去存在理由。
- **規則 scorer 與 outcome harvester** —— `outcome-scorer.ts`、
  `outcome-extractor.ts`、summarizer 的 harvest 分支、
  `sessions.harvest_text`。它們都是為了餵 journal 而存在的。
- **`session_checkpoints`** 表與 `POST /session/checkpoint`（零 caller）。
- **`GET /metacognition/check`** —— knowledge map 本體還在，查詢面保留
  MCP `recall_context`。
- **`GET /lint/warnings`** 與 `lint.ts`（零 caller）。
- **`POST /memory/save`** —— MCP `recall_save` 直連資料庫寫入，HTTP 鏡像
  已無人使用。
- **`GET /memory/context`** —— 從第一天起就是回空欄位的 stub。

### 變更（breaking）

- **`POST /session/end`** 不再 harvest。現在只做一件事：確認剛結束的
  session 已被索引（miss 時觸發 rescue reindex——#55 修法鏈原封不動）。
  回應不再帶 `journalSaved` / `dryRun`。v0.4.x 的 SessionEnd hook 完全相容。
- **`GET /health`** 不再回報 `journalPendingCount`。
- **`message_uuids` 重建為雙 64-bit hash**（migration v24）。replay 去重
  登記表原本把 40 萬筆 UUID 以 36 字元 TEXT 存了三份 b-tree——73.6MB，
  佔全庫 65%。現在每個 uuid / session id 取 SHA-256 前 8 bytes 當
  signed integer；`uuid_hash` 直接作為 rowid，primary key 零成本。同一
  張表：17.3MB。40 萬筆的碰撞機率約 4×10⁻⁹，最壞後果是一則 replay 訊息
  被跳過——拿這個換 56MB，划算。

### 升級指南

Migration v24 首次啟動自動執行（單一 transaction；失敗自動 rollback 回
v23 原狀）。已用生產快照實測：40 萬筆約 1 秒，零遺失。兩個手動步驟：

1. **升級前**先快照資料庫（一行保險）：
   `cp ~/.ccrecall/ccrecall.db ~/.ccrecall/ccrecall.db.bak-v0.4.8`
2. **升級後**手動回收空間：
   `sqlite3 ~/.ccrecall/ccrecall.db 'VACUUM'`
   （實測 114MB → 42MB）。ccRecall 從不自動 VACUUM——大庫上會讓 daemon
   凍住數分鐘（v20 的教訓）。不跑也無害：SQLite 會重用釋出的 page，只是
   檔案不縮。

要降版的話，重裝 `@tznthou/ccrecall@0.4.8` 並還原備份——v24 schema 舊版
程式讀不懂。

## [0.4.8] — 2026-07-16

### 修復

- **Post-session extraction 靜默漏抽約每五場一場 session（`no-session-id`）** —
  extraction wrapper 用 `echo` 把 `/session/last` 的 JSON 回應接給 `jq`，而
  zsh 的 `echo` 預設會展開跳脫序列：session title 含 JSON 跳脫 `\n` 時（多行
  開場 prompt——全庫 21.5% 的 session 都是），JSON 在進 `jq` 前就被弄壞。
  parse error 被 `2>/dev/null` 吞掉、`session_id` 留空，extraction 就這樣跳過。
  佈防一週的 probe 收網結案：39 次 daemon 回應全是 HTTP 200 且 payload 正確，
  損壞完全發生在 client 端——先前的「daemon 404」推論也一併撤銷。wrapper 改用
  `printf '%s'` 逐 byte 原樣傳遞。注意 wrapper 位於 `scripts/`（由 shell rc
  source，不在 npm package 內）：pull 之後重開 shell 才會生效。(#63)
- **`/session/last` 可能回傳 subagent 而非剛結束的主 session** — subagent 的
  `sessions` row 可能短暫存在而 `subagent_sessions` 登記缺席（2026-07-13 生產
  環境實地拍到），此時 `NOT IN` 排除失效，端點回傳 `<parent>/agent-…`。wrapper
  的 UUID 檢查會擋掉這種形狀，結果是同樣的靜默跳過。`getLastSession` 現在直接
  以 id 形狀過濾——複合 id 絕不會是主 session——正確性不再依賴登記時序。JSONL
  已從磁碟消失的 archived rows 也一併排除。(#63)

### 文件

- 架構圖修正：MCP server 是直接以 WAL 模式開 SQLite，從來不在 HTTP API 後面。
  箭頭改為呼叫方向，watcher 與 extraction wrapper 進入圖中。新增 session
  生命週期時序圖，涵蓋頭尾兩個與時間賽跑的環節（啟動注入、session 後抽取），
  含 `notBefore` gate 與 subagent 過濾。(#63)

## [0.4.7] — 2026-07-05

### 修復

- **壓縮把同 session 的多筆記憶塌縮成一模一樣的重複內容** — 壓縮
  session-backed 記憶時，pipeline 會把內容改寫成所屬 session 的
  `summary_text`（L1）或 `intent_text`（L2）。但這份摘要描述的是*整場
  session*，當一個 session 產出多筆記憶時——post-session extraction 上線後
  這是常態（有記憶的 session 中 86% 超過一筆）——每筆 sibling 都被改寫成同
  一段 session 級文字。各自獨立的蒸餾事實塌縮成 byte-identical 副本，且壓
  縮是就地覆寫，原始內容從資料庫中無法復原（生產環境確認 7 個 session 共
  23 筆受害）。pipeline 現在只在該記憶是 session *唯一*一筆時才採用 session
  摘要；有 siblings 時改為各自截斷自己的內容，保持彼此可區分。來源
  transcript 還在的記憶，可對該 session 重跑 extraction 重建。

## [0.4.6] — 2026-07-04

### 修復

- **Session 剛結束時，post-session extraction 會跳過、甚至抽錯 session** —
  wrapper 在 session 關閉後數秒內查詢 `/session/last`，與 indexer 賽跑。這個
  race 有兩張臉：專案沒有其他已索引 session 時，端點回 404、extraction 直接
  跳過（修復前一週 `no-session-id` skip 佔比達 24%）；有舊 session 時，端點
  回的是「舊的那一個」——舊記憶被重複抽取，剛結束的 session 反而被靜默漏掉
  （telemetry 中找到 6 筆重複抽取）。`/session/last` 現在比照 `/session/end`
  既有做法，rescue reindex 後再重查一次；wrapper 也會帶上
  `notBefore=<啟動時刻>`，讓「啟動之前就結束」的 session 視同查無，而不是照
  樣回傳。過期判定錨在 `endedAt` 而非 `startedAt`，resume 的 session——舊的
  開始時間、新的訊息——不會被誤殺。兩個端點同時觸發的 rescue 會合流成一次
  indexer 執行，不再疊加全量掃描。

### 安全

- **箝制過遠未來的 `notBefore`** — 偽造的時間戳（如 `9999-01-01`）會讓所有
  session 永遠被判過期，每個請求都強制一次全量 reindex（本機 DoS 放大器：
  合流只擋並發、擋不了連續請求）。超出 60 秒時鐘偏移容忍的值一律忽略；
  wrapper 只會送出自己的啟動時刻。

## [0.4.5] — 2026-06-27

### 修復

- **Post-session extraction 把 Haiku 的雜散輸出印到 terminal** — Haiku 被要求
  不要產生任何文字（只有 `recall_save` tool call 帶結果），但小模型偶爾會印出
  雜散摘要，且可能漂移到不相關的語言——曾觀察到一份韓文報告。wrapper 原本透過
  `exec 3>&1` fd 操作把 Haiku 的 stdout 串流到 terminal；現在完全丟棄 stdout
  （`2>&1 1>/dev/null`），只顯示自己的狀態行。記憶從未受損——雜散輸出根本沒進
  到資料庫。

### 安全

- **stdout 不再寫入 log，stderr 脫敏範圍擴大。** 上述修復的中途版本曾把 stdout
  捕獲進 telemetry log；審查發現若模型複述 transcript 內容，session secret 可能
  繞過只認 `sk-ant-` 的脫敏而被留存，因此 stdout 改為丟棄而非記錄。stderr 脫敏
  也從 `sk-ant-` 擴大到涵蓋常見的 OpenAI（`sk-proj-`）、GitHub（`ghp_` /
  `github_pat_`）、AWS（`AKIA`）token 前綴。

## [0.4.4] — 2026-06-20

### 修復

- **Post-session extraction 誤報「Exceeded USD budget (0.1)」中止** —
  `--max-budget-usd` 以 API 等價成本為閘門，但未設 `ANTHROPIC_API_KEY` 時
  `claude -p` 走 Pro/Max 訂閱額度、不實際計費，該 flag 因此誤殺了已寫完記憶的
  run。budget cap 現在只在 API key 計費下套用（預設 `0.50`，可用
  `CCRECALL_EXTRACT_MAX_BUDGET_USD` 覆寫）。`claude -c` continue fallback——會載入
  完整 session、為常態零產出燒額度——改為 skip，並記錄 `reason`。

- **`extraction-prompt.md` 在 zsh 下從未被讀取** — `CCRECALL_SCRIPT_DIR` 以
  `BASH_SOURCE[0]` 解析，但在 zsh 下為空，於是 fallback 成 `$PWD`，prompt 檔案
  靜默地永遠找不到（改用內嵌 fallback prompt）。現在在 zsh 下改用 `%x` prompt
  expansion 解析。

### 安全

- 在 extraction stderr 寫入 telemetry log 前，redact 掉 `sk-ant-*` API key。
- 在 extraction prompt 標記 session transcript 為不可信資料，降低 prompt
  injection 驅動 `recall_save` 失控呼叫的風險。

### 變更

- Extraction stderr 現在捕獲進 telemetry log（valid JSONL），不再以 `2>/dev/null`
  丟棄。
- 每條存入的記憶現在帶有 origin session ID 以供溯源。

## [0.4.3] — 2026-06-17

### 修復

- **完整性監測誤報「FTS5 損壞」警報** — 週期性的 `PRAGMA integrity_check` 在 daemon
  長連線上執行，對健康的磁碟資料可能誤報「malformed inverted index for FTS5
  table」（external-content FTS5 在長連線下的暫態現象）。改為每次在全新的唯讀連線上
  檢查，消除誤報。磁碟資料全程確認健康。

## [0.4.2] — 2026-06-06

### 修復

- **Post-session extraction 在長 session 觸發「Prompt is too long」** — 以 JSONL
  text-only extraction 取代 `claude -c`（載入完整對話歷史）。只萃取 human 和
  assistant 的文字訊息（比原始 JSONL 小約 98%），消除任意長度 session 的 context
  溢出問題。包含 session ID 的 UUID 驗證、寬容 JSONL 解析（`fromjson?`）、UTF-8
  安全截斷。

- **Extraction agent 產出對話式輸出** — 強化 extraction prompt 宣告非互動 pipeline
  模式。Agent 現在只呼叫 `recall_save`，不再產生摘要、問題、或下一步建議等無人會閱讀
  的文字。

## [0.4.1] — 2026-06-05

### 新增

- **`recall_save` Key-based upsert** — 新增選填 `key` 參數（穩定的 hyphenated
  slug）。同一 `(projectId, key)` 再次存會更新而非重複建立。Upsert 重設 access
  count 和壓縮 metadata，讓更新後的內容重新進入 recall pool。Migration v23 加入
  `key` 欄位與 partial unique index。

- **`recall_save` 自動 topic extraction** — 每條存入的記憶自動產生
  `memory_topics` 條目（從 content 抽取）。Phase 3 跨專案 topic-intersecting
  檢索的前置條件。

- **`GET /session/last?cwd=...` endpoint** — 回傳指定專案路徑的最新 session
  metadata（sessionId、projectId、title、timestamps）。Post-session extraction
  wrapper 使用。

- **Post-session memory extraction pipeline** — 結構化 Haiku extraction prompt
  (`scripts/extraction-prompt.md`)，含 triage/extract 規則、scope 判定、key slug
  生成、sanitization 指令。Shell wrapper template (`scripts/post-session-extract.sh`)
  含 daemon health check、`/session/last` API 呼叫、jq telemetry logging。

- **跨專案記憶可見性（Tier 0）** — `getStartupMemories` 透過 topic intersection
  從其他專案 surface 記憶。若 Project B 的 `knowledge_map` 與 Project A 的記憶
  有共同 topic，該記憶會出現在 Project B 的 startup injection（最多 3 條，
  confidence ≥ 0.8 gate）。全域記憶（`project_id = NULL`）在 topic 匹配時也會
  出現。

- **`backfillMemoryTopics()` + `cleanOrphanedMemoryTopics()`** — 既有記憶的
  one-off 遷移用 database 方法。Backfill 從 content 抽取 topics；orphan cleanup
  清除指向已刪除記憶的 `memory_topics` 條目。One-off script：
  `scripts/backfill-memory-topics.ts`。

### 變更

- `recall_query` tool description 從「project-scoped long-term memory store」
  改為「user-scoped memory store with project-aware ranking」——反映跨專案可見性。

- `recall_save` tool description 更新跨專案引導：「Omit projectId for knowledge
  reusable across all projects」及 key slug 文件。

- `Memory` interface 及所有 SELECT 查詢現在包含 `key` 欄位。

- `getStartupMemories` Tier 1 現在傳入扣除 Tier 0 已用量後的 LIMIT，與 Tier 2
  一致。

## [0.4.0] — 2026-06-03

### 變更

- **SessionStart 預設策略從 `legacy` 切換為 `startup-v1`。**
  legacy 策略用專案名稱關鍵字做 FTS 比對，造成 echo chamber——同樣 4-5 條記憶每次
  session 都被撈出來。`startup-v1` 優先 surface 從未被讀取的冷記憶，再補填近期/高信心
  記憶，打破 echo chamber，讓被埋沒的知識浮出。新格式顯示 pointer hint（「N memories
  available — use recall_query to search more」）取代舊的「matched via project
  keyword」footer。Legacy 仍可透過 `CCRECALL_SESSION_START_STRATEGY=legacy` 使用。

- **`recall_save` tool description 重新定位為主要寫入路徑。**
  新增具體「何時該存」場景、self-contained 記憶撰寫指引（包含 WHY、用具體細節、避免
  代名詞），以及冷啟動引導（recall_query 結果為空時建議存下有價值的發現）。

- **`recall_query` tool description 新增 sufficiency hint。**
  結果稀疏時建議嘗試不同關鍵字或更具體的詞。

### 修正

- **全域記憶（project_id=NULL）現在納入 scoped startup 查詢。**
  （來自 [0.3.4] PR #44——首次隨本版部署。）

## [0.3.4] — 2026-05-24

### 修正

- **`recall_query` 跨所有 project 搜尋,而非只搜當前 project。** MCP
  `recall_query` tool 呼叫 `db.queryMemories(query, limit)` 時沒帶 `projectId`,
  走進無過濾分支 — 在 project A 查詢可能撈到 project B 的記憶。`recall_query`
  早於 `project_id` 機制(phase-4b),在 query handler 接上 scoping 時(phase-4c)
  被漏掉;`recall_context`、`recall_save`、HTTP `/memory/query` 都已正確 scoped。
  跨 project 可見性是開發初期就明確排除的 non-goal。修法:`recall_query` 現在接
  required `projectId`(對齊 `recall_context`),傳入 `db.queryMemories` 與
  `appendRecallTelemetry`(telemetry `projectId` 原本寫死 `null`,也一併修好
  per-project 分組)。Cross-project isolation 測試加在 `tests/mcp.test.ts`。

### 備註

- 此修正後跨 project 的「偶然命中」會消失,6/04 hit-rate window 的 cold-rate
  數字可能上升。先前 baseline 被這個 bug 虛高 — 修正後的數字才反映真實
  project-scoped 召回率,應如此判讀。
- `projectId` 由 client 提供(從 cwd 推導),跟其他 MCP tools 一致。是否改成
  server-side project binding 記錄在 #41,等未來威脅模型超出本機單機使用時再評估。

---

## [0.3.3] — 2026-05-22

### 修正

- **`recall_query` MCP path 漏 instrument telemetry。** v0.3.2 只在 HTTP
  `GET /memory/query` route 加 `appendRecallTelemetry`,沒同步加到 MCP
  `recall_query` tool handler(`src/mcp/tools.ts`)。大多數 client
  (Claude Code、Claude Desktop)是透過 MCP 而非直接 HTTP 連 daemon,所以
  telemetry log(`~/.ccrecall/recall-query.log.jsonl`)實際只記到 ship
  smoke-test 流量,正常 user 呼叫全被靜默丟掉。修法:`recallQueryHandler`
  現在會呼叫 `appendRecallTelemetry`,`hitCount = emittedIds.length`
  (post-budget,跟 HTTP 語意一致)、`projectId = null`(MCP schema 未帶
  project 參數)。Regression test 加在 `tests/mcp.test.ts`,用
  `CCRECALL_RECALL_TELEMETRY_PATH` 隔離 test log。

### 備註

- 在觀察 v0.3.2 7 天 hit-rate window 的人,原訂 5/28 deadline 應視為失效,
  從 v0.3.3 ship 日重新起算(新目標:6/04)。Bug 期內取得的樣本只反映
  HTTP-direct 流量,無法外推到母體 — 該期間推估的 cold-rate 數值不是
  v0.4.0 batch 決策的可靠證據。

---

## [0.3.2] — 2026-05-21

### 新增

- **`recall_query` telemetry,為 hit-rate 分析鋪基。** 每次 `GET /memory/query`
  呼叫現在會 append 一筆 JSONL 到 `~/.ccrecall/recall-query.log.jsonl`:
  truncate 過的 query(80 chars)、原始 `queryLen`、`hitCount`、`projectId`、
  `limit`、`maxTokens`。Append 失敗會被吞掉 — telemetry 絕不能影響 endpoint
  回應。兩個 opt-out 開關:`CCRECALL_RECALL_TELEMETRY_OFF=1` 關掉寫入;
  `CCRECALL_RECALL_TELEMETRY_PATH` 改寫 log 路徑(test 用,避免污染 host 真實 log)。

- **`scripts/recall-hit-rate-report.ts` 分析腳本。** 讀 telemetry log + 對照
  `memories` 表,把 zero-hit query 拆兩桶 — *literal mismatch*(keyword 出現在
  某筆 memory body 但 FTS5 沒抓到) vs *truly absent*(keyword 不存在任一
  memory)。輸出(markdown 或 `--json`):總數、hit rate、zero-hit 拆分、
  per-project 計數、query length 分布、每類最多 10 筆 sample。設計為 L0
  quick-fix 餵 v0.4.0 batch 排序:1 天 instrumentation + 7 天觀察 → 用實證
  決定 `#28` surfacing UX、`#15` tag first-class + Topic CJK、`#29` scorer
  epistemic 之間的優先序。

### 為什麼

Cold rate 訊號(116 筆 memories 96 筆從未召回,4 批重大事件落到 auto memory
而非 ccRecall DB)需要 evidence 基底才能決定 v0.4.0 batch 方向。本版純
instrumentation — 不動 scoring、schema、recall 行為 — 讓 7 天觀察期保持乾淨。

### 備註

- Privacy:query 字串 log 前 truncate 到 80 chars。`queryLen` 保留原長度可看
  長 query 分布。考慮過 hashing 但拒絕,因為 hashing 會阻擋拆分 literal
  mismatch / truly absent 所需的 substring 對照。
- 效能:`appendFileSync` 跑在 response path 上;E2E test 驗證 telemetry 開
  狀態下整段 round-trip 仍 < 100ms。
- 本版**不**翻 `CCRECALL_SESSION_START_STRATEGY` 預設值 — 等 metric 證據到位後
  跟 v0.4.0 一起出。

---

## [0.3.1] — 2026-05-13

### 修正

- **SessionStart hook keyword echo chamber。** 原本 `hooks/session-start.mjs`
  用 `projectNameFromCwd(cwd)` 當唯一 FTS5 keyword 打 `GET /memory/query`，
  導致只有 content 含專案名稱字串的記憶能 surface。Manual 寫的 atomic
  knowledge（沒提到專案名的）全 cold，user-prompt 殘片（含專案名的）
  反而每次 session start 都被 inject，`access_count` 累積成假象。線上 DB
  audit 證實訊號倒置：5/6 trust split 後 4 筆 manual `recall_save` 100%
  cold；9 筆 prompt 殘片（佔 corpus 7.6%）貢獻 45% 全部 access。修法：
  opt-in `CCRECALL_SESSION_START_STRATEGY=startup-v1` 把 hook 切到新的
  `GET /memory/startup` endpoint，走 3 階層 selection（cold project-scoped
  → recent-confidence fill → FTS fallback）。預設 strategy 維持 `legacy`
  不打擾 v0.3.0 觀察期。

- **Hook injection path 缺 token budget。** `GET /memory/query` 跟
  SessionStart hook 原本沒做 token cap，單筆長 memory 可能靜默吃掉幾千
  token 的 context。兩條路徑現在都收 optional `maxTokens`（`/memory/startup`
  預設 300），套 CJK-aware per-row truncation via 新增的 `applyRowBudget`
  helper，且 `memoryService.touch` 只動 budget-emitted rows，避免 dropped
  rows 污染 `access_count`。

### 新增

- **`GET /memory/startup?project=&limit=&maxTokens=&q=<fallback>`** —
  SessionStart-tier retrieval。project 必填。回 `{ memories, emittedIds,
  candidateCount, totalTokenEstimate, droppedCount, truncated, project, limit }`。
- **`Database.getStartupMemories(projectId, limit, fallbackKeyword?)`** —
  3 階層 selection helper，供想跳過 HTTP overhead 的 caller 使用。
- **`applyRowBudget(rows, maxTokens, perRowCharCap)`** 加進
  `src/core/token-budget.ts` — generic CJK-aware row budget helper，
  `/memory/query` 跟 `/memory/startup` 用同一份。
- **`CCRECALL_SESSION_START_STRATEGY` 環境變數** — `legacy`（預設）|
  `startup-v1` | `off`，控制 SessionStart hook 用哪條 retrieval 路徑。
- **Opt-in JSONL telemetry** 寫到 `~/.ccrecall/startup-recall.log.jsonl`，
  只在 `startup-v1` 啟用時寫（`CCRECALL_TELEMETRY=off` 可關）。每次 session
  start 紀錄 `{ ts, projectId, emittedIds, droppedCount }` — 足夠讓 7 天
  dogfood gate 量化 atomic knowledge surface 改善程度。

### 升級

不動 schema。既有 `~/.claude/settings.json` 裡的 hook 不必重裝；新 strategy
完全 opt-in via 環境變數。

---

## [0.3.0] — 2026-05-06

### ⚠️ Breaking — harvest 寫入路徑

Hook auto-harvester（`POST /session/end`）改寫到新建的 `session_journal`
表,不再寫 `memories`。Manual `recall_save` 不受影響——仍直寫 `memories`。
這是 issue #21（也是 issue #25 0/39 命中率底層根因）的架構修正:rule scorer
原本架在 persistence gate,實際位置應該是 trust grade。再補 regex 只會延後
下次撞牆。把 low-trust harvest 跟 high-trust memories 分開後,harvester 可以
廣捕候選,但 recall 結果保持乾淨。

`recall_query` / `recall_context` 結果不受 journal 影響——by design 它們只
讀 `memories`。

**Response 欄位改名**: `POST /session/end` 回 `journalSaved`(原 `memoriesSaved`)。
Hook 端不解析 response body,既裝 hook 不需重裝。

### 新增

- **Schema v22**: `session_journal` 表含 `(session_id, message_id, content,
  content_hash, score, reasons_json, status, expires_at, promoted_memory_id,
  project_id, created_at)`。`idx_journal_status` 與 `idx_journal_hash UNIQUE`
  支撐 sweep + idempotency。
- **`ccmem promote <id>`** — manual 升級到 memories。Atomic: saveMemory
  → saveMemoryTopics → rebuildKnowledgeMap → promoteJournalEntry。
  optional `--type`(預設 `discovery`)、`--confidence`(預設 `0.7`)。已 promoted
  回 409;不存在回 404。
- **`ccmem reject <id>`** — soft-delete,7 天 TTL via `expires_at`。decay sweep
  到期後清理。
- **`/health` endpoint** 加 `journalPendingCount`。surfacing pending queue 是
  user 發現可 promote 候選的方式——manual-only by design;auto-promote 會
  重蹈 threshold gate 覆轍。
- **Decay sweep** 在既有 `MaintenanceCoordinator` tick 內: rejected 過
  `expires_at` + pending 超過 30 天 → DELETE。promoted 留作 audit trail。
  memories 表不被碰(manual 寫入由 table 邊界自動 exempt)。

### 變更

- `summarizer.ts` 移除 `score >= KNOWLEDGE_THRESHOLD`(≥ 2)persistence gate。
  hard floor 保留: `noise` / `process-report` 仍 short-circuit(這些不論落
  到哪裡都不是 knowledge)。
- `buildMemoryFromSession` rename 為 `buildJournalCandidate`,return
  `JournalEntryInput` 含重新 score 後的 `score` + `reasonsJson` metadata。
  Score 在 journal 寫入時重算(<2KB 文字 regex,成本低),不需 v23 migration
  加 `harvest_score` 欄位。

### Migration

- v22 migration 在 daemon startup 自動跑。pre-check: `memories` 表必須存在
  (否則 dangle FK,throw 提示從 pre-v22 backup restore)。
- **升級前建議先 backup**:
  `cp ~/.ccrecall/ccrecall.db ~/.ccrecall/ccrecall.db.pre-v22.bak`
- 既有 memories rows 不變。v0.2.x 17 筆 `type='query'` 記憶不被搬到 journal
  ——凍結在原位,新 harvest 從現在開始寫 journal。

### 測試

- 跨 5 個 commit 加 +22 tests(schema target / journal DAO / trust boundary
  / promote+reject endpoints / sweep TTL / health 欄位)
- 535 → 557 tests passing。

### 首發觀察期

Plan-critic acceptance criteria:

| 天數 | 指標 | 通過閾值 | 不通過解讀 |
|---|---|---|---|
| 14 | journal 寫入總筆數 | ≥ 50 | 移除 gate 沒解到問題——上游 `pickLastSubstantialAssistant` 才是真根因 |
| 30 | manual promote 累計 | ≥ 3 | surfacing 不夠——啟動 issue #21 P2 規劃 |

追蹤: [issue #21](https://github.com/tznthou/ccRecall/issues/21)。

### 升級清單

- `pnpm install -g @tznthou/ccrecall@0.3.0`(或您慣用的安裝路徑)。
- 可選: 重啟前先 backup DB(見 Migration 段)。
- `launchctl kickstart -k gui/$UID/com.tznthou.ccrecall` 重啟 daemon,
  v22 migration 在第一次連線時跑。
- `curl http://127.0.0.1:7749/health` 驗 `version: "0.3.0"` 及新增的
  `journalPendingCount` 欄位。

---

## [0.2.7] — 2026-05-06

### 修正

- **`extractOutcome` 跳過 session 收尾報告**（PR #24）。Dogfood corpus audit（39 筆 v=2 committed/tested sessions）發現 100% sub-threshold,因為 `pickLastSubstantialAssistant` 抓到 session 收尾摘要報告（process meta）而非真實 implementation outcome。walk-back 迴圈改成 skip process-report,往前找前一段 substantial assistant text。`scoreKnowledgeBearing` 同步加 process-report short-circuit → score 0（defense in depth）。

### 新增

- `src/core/outcome-scorer.ts` export `isProcessReport(text)`,給 `outcome-extractor.ts` 用。`PROCESS_REPORT_RES` 用 `^` anchor,長文本 mid-text 提及不誤殺。Pattern 覆蓋繁中與英文 session 收尾標記、slash command 形式、冒號分隔標題,可選 markdown heading prefix 與 emoji（`💾🟢✅`）。
- `isProcessReport` 加 `PROCESS_REPORT_MAX_LEN = 5000` 長度閘門,防 regex 對 megabyte 尺寸 assistant text 做 linear scan（security: ReDoS prevention）。

### ⚠️ 已知限制——前置修補,不充分

這次修補解開 harvester 對真實 outcome 的視野（收尾報告不再屏蔽）,但**單獨無法把命中率拉到 0 之上**。Audit 顯示真實 implementation outcome 現在能到達 scorer,但仍 sub-threshold——5 類 rule scorer 的覆蓋缺口:

- 中文 commit confirmation（`Commit 6de0666 落地`）→ score 0
- `## 修復總結 / 完工總結` 表格 → score 1（偶中 decision-language）
- Phase milestone（`## Phase 1 完成 ✅ | Step | Commit |`）→ score 0

追蹤:[issue #25](https://github.com/tznthou/ccRecall/issues/25)。沿用 #23 的協議——3+ 條 corroborating 報告匯聚同一 category gap 才擴 anchor patterns。

### 測試

- +11 個新單元測試（8 個 process-report scorer cases + 2 個 extractor fallback cases + 1 個 oversized input length-gate test）。
- 測試數:524 → 535。

### 品質流水線

- ✅ Codex Review:1 Medium（slash/colon regex 缺口）+ 1 Low（`流程` alternation 太寬）→ 兩個都修。
- ⏭️ Simplify:4 個候選審完全部 ruled out（無真實簡化空間）。
- ✅ Security:1 Medium（ReDoS length gate）修;3 Low 依 gogo 行為覆寫不修。
- ✅ Final Verify:build / typecheck / lint / 535 tests 全綠。

### 升級清單

- `pnpm install -g @tznthou/ccrecall@0.2.7`（或您慣用的安裝路徑）。
- `launchctl kickstart -k gui/$UID/com.tznthou.ccrecall` 重啟 daemon。
- `curl http://127.0.0.1:7749/health` 驗 `version: "0.2.7"`。
- 本版無 schema migration。不需 DB backup。

---

## [0.2.6] — 2026-04-30

### 變更

- **Harvester 抓取來源由「first user prompt」翻為「outcome cluster」**（closes #18）。0.2.6 之前的 harvester 抓 user 第一句 prompt 標 `type='query'`——線上 audit（n=104）顯示 94% 雜訊、**自動 harvester 抓的 100 筆裡 0 筆是真實知識**;4 筆高品質寫入全來自 manual `recall_save`。新 pipeline 改抓 session 內最後一段 substantial assistant text,過 5 類規則式 scorer（decision-language / impl-facts / constraints / cause-effect / validation,門檻 ≥ 2）才寫入。

### 新增

- `src/core/outcome-extractor.ts`——挑出 session 內最後一段 substantial assistant text。`isSubstantial()` 三條 branch:長度 ≥ 200 chars、markdown 結構（header / fenced code / bullet / checkbox）、或過 scorer 門檻。
- `src/core/outcome-scorer.ts`——5 類 regex scorer,內建 noise short-circuit（`done` / `完成` / `ok` 等短 ack token 直接歸 0,避免被 weak signal 累計湊到門檻）。
- Schema migration **v21**:`sessions` 表加 `harvest_text TEXT` 欄。Idempotent ALTER TABLE,forward-only——既有 sessions 的 `harvest_text` 維持 NULL（by design）。
- `MAX_HARVEST_LEN = 2000` 截斷上限,寫入前 trim,對齊讀取端的 `<300 tokens per memory` 注入預算。

### ⚠️ 已知限制——英文覆蓋率

Scorer 的 pattern set 只在**繁中 session 上做過 corpus 實測**（維護者自己 dogfood 的 ccRecall DB):

- A 組:91 筆 noise sub-threshold(90/91 = 98.9%)
- B 組:50 筆 outcome session(49/50 sub-threshold = 98%)

每個 category 起手 1-3 個 anchor pattern 是 plan-time scaffolding。**英文 session 過門檻機率比 plan-target 60-80% skip rate 暗示的還低**——對純英文 user 來說,在 pattern 覆蓋擴充之前,harvester 寫進來的新記憶會比預期少。

追蹤:[issue #23](https://github.com/tznthou/ccRecall/issues/23)。如果觀察到英文 session 該抓的 outcome 沒被抓到,請去那條 issue 留 redacted 對話片段。當 3+ 條 report 收斂到同一 category 的 gap,我們會擴 anchor patterns 並用該 corpus 重做驗證,而不是靠猜。

### Migration notes

- Migration v21 是 **forward-only**。0.2.6 之前 indexed 的 sessions `harvest_text` 維持 NULL,不進新 harvest pipeline。Indexer 重 fire 只看 `mtime` 變化(`indexer.ts:95`),`SUMMARY_VERSION` 1→2 刻意不觸發歷史 sessions 全 reindex。
- 0.2.6 之前累積的 memories **保留**。另一個 cleanup release 會清掉 `[intent]` 前綴的舊雜訊(條件:`access_count = 0 AND type = 'query' AND content LIKE '[intent]%'`),配 backup table 跟 7 天觀察期。
- `buildMemoryFromSession` 嚴格 no-fallback contract:`harvestText` 為 NULL 時,`intentText` / `summaryText` / `outcomeStatus` 全部忽略,回 `null`,`/session/end` 回 `reason: 'session has no summary'`。

### 測試

- 34 條新 unit test 涵蓋 extractor(10)+ scorer(20)+ `tests/session-end.test.ts` 4 條 no-fallback contract test。
- 測試數:528 → 524(淨 -4;新增 34、刪掉 6 條 dead `collectToolEvidence` evidence test、其他併整)。
- 沒有為了通過測試軟化斷言——`session-end.test.ts` fixture 重寫的 commit message 寫清「sample session 換成 outcome cluster 是需求變更(issue #18 翻 source 後 invariant 翻轉),不是改測試符合實作」。

### 品質流水線

- **Codex review**(2 中修 1):M1 `isSubstantial()` 加 scorer fallback,讓短純文字 outcome(<200 chars 無 markdown)如「Root cause: x.ts:42. 495/495 tests pass.」不會在 scorer 之前就被 length gate 砍掉。M2(把 `hasCommitInvoked`/`filesTouched` 包進 `harvestText`)decline——minimal `{lastAssistantText}` payload 是 plan-critic round 2 刻意設計,避免結構化雜訊污染 FTS5 ranking。
- **Simplify**(7 中採 4):砍 dead `collectToolEvidence` + evidence tests(grep 全 src/ 無 downstream consumer);structural regex 改成 `ReadonlyArray<RegExp>` 對齊 codebase idiom;`IMPL_FACTS` 副檔名清單對齊 + 加 `\b`;trim 掉指向已移除 `isHarvestNoise` overlap 的過時 comment。3 條 decline:`harvester-filter.ts` orphan 出 scope、其餘 JSON.parse consolidation 是 pre-existing。
- **Security review**(Critical:0 High:0 Medium:2 Low:2):兩條 Medium 一處解——A10 `harvest_text` 寫入 DB 沒上限 + A09 dry-run `candidate.content` 在 response JSON 沒截斷,都靠 `MAX_HARVEST_LEN = 2000` cap 解掉。兩條 Low report 不修(gogo policy)。
- **Final verify**:build / typecheck / lint / 524 tests 全綠。

### 升版步驟

```bash
# 1. Migration v21 之前先備份(建議——Code Protection Protocol)
cp ~/.ccrecall/ccrecall.db ~/.ccrecall/ccrecall.db.pre-issue18.$(date +%Y%m%d).bak

# 2. 安裝 0.2.6
npm i -g @tznthou/ccrecall@0.2.6

# 3. 重啟 daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 4. 驗證版本 + integrity
curl -s http://127.0.0.1:7749/health | jq .
# 期望:version="0.2.6"、lastIntegrityCheckOk=true
# (sessions 表多了 harvest_text 欄,既有 row 為 NULL by design)

# 5. 7 天觀察期後手動清 backup
rm ~/.ccrecall/ccrecall.db.pre-issue18.*.bak
```

Closes [#18](https://github.com/tznthou/ccRecall/issues/18)。追蹤限制:[#23](https://github.com/tznthou/ccRecall/issues/23)。

---

## [0.2.5] — 2026-04-29

### 修正

- **長 uptime daemon 的 WAL 檔無界增長**（issue #11）。`runIndexer` 現在會以 `PRAGMA wal_checkpoint(TRUNCATE)` 收尾——這是唯一一個會把 WAL 檔在磁碟上實際縮回 0 bytes 的 checkpoint 模式。先前 WAL 會在 SQLite 兩次 passive auto-checkpoint 之間累積到接近主檔大小——issue #11 證據顯示 8.4 小時 uptime 撐到 624 MB。PASSIVE / FULL 模式被排除：它們只把 frame 標記為可重用，磁碟檔大小不變，看 `du` 的 operator 會以為 fix 沒生效。

### 動機

ccRecall 跑 22.9 小時 uptime 在真實 workload 下，WAL sidecar 累到 6.8 MB——數字小但上限無界，issue #11 那次 624 MB 的觀察證明上限實際就是主檔大小。我們評估三種做法選一：

| 方案 | 真縮磁碟檔 | 阻塞 reader | 結論 |
|------|----------|-----------|------|
| 調 `wal_autocheckpoint` 閾值 | 否（passive） | 否 | 解不了 disk 可見的成長 |
| 背景 timer | 是 | 短暫 stall | 多了 timer 生命週期跟 race surface |
| **Batch 結束 TRUNCATE** | **是** | **batch 結束時很安全** | 選這個 |

Indexer batch 結束沒併發 indexer 寫入、HTTP query 讀都是毫秒級，stall 影響可忽略。萬一有 long-running reader 撐住 snapshot 超過 `busy_timeout`，SQLite 回 `busy=1`，下次 batch 自然再試——`console.warn` 把這個狀況打出來給 operator 知道。

### 為什麼不只在 SIGTERM 加 checkpoint

原本草稿的 quick-fix 是「SIGTERM handler 加 `wal_checkpoint(TRUNCATE)`」。隔離復現實驗證實 `db.close()` 已經觸發 SQLite last-connection truncate（200 sessions 寫入 → close → WAL 4.1 MB → 0 bytes），所以 SIGTERM hook 是 redundant，而且不能解 issue #11 真正關心的「daemon 跑期間累積」。

### 測試

- `tests/wal-checkpoint.test.ts` 新增 3 條測試：method 自身行為（200 sessions 寫入 → TRUNCATE → 0 bytes）、空 WAL 上 idempotent、indexer 整合（50 sessions batch → `runIndexer` 跑完 WAL = 0）。
- 測試數：492 → 495。

### 品質流水線

- Codex review（1 Medium 修了）：`busy=1` 被吞掉沒 log，現在會 `console.warn`「`[indexer] WAL checkpoint busy — readers held snapshot; deferred to next batch`」。
- Simplifier（2 處精簡）：拿掉不會走到的 nullish fallback（`PRAGMA wal_checkpoint` 的 contract 保證一定回一 row）、多餘的 comment 收緊。
- Security review：C:0 H:0 M:0 L:2——兩個 Low 都是 log message 診斷精度議題，依 gogo 規則不修。
- Final verify：build / typecheck / lint / 495 tests 全綠。

### 升級清單

```bash
# 1. 安裝 0.2.5
npm i -g @tznthou/ccrecall@0.2.5

# 2. 重啟 daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. 驗證
curl -s http://127.0.0.1:7749/health | jq .version
# 預期: "0.2.5"

# 4. 下一次 indexer batch 跑完後看 WAL
ls -lah ~/.ccrecall/ccrecall.db-wal
# 預期：通常 0 bytes（或近 0，如果 checkpoint 那當下剛好有 reader 在 hold snapshot）
```

Closes [#11](https://github.com/tznthou/ccRecall/issues/11)。

---

## [0.2.4] — 2026-04-28

### 新增

- **英文進度殼 / 控制指令噪音規則**——加進 `isProgressShell()`。0.2.3 的 noise filter slash command 是 language-neutral 沒問題，但 progress shell 跟反思 pattern 都只擋中文——英文使用者會把 0.2.3 砍掉的 25-30% 噪音原樣帶回來。新的 `ENGLISH_PROGRESS_RES` 列表涵蓋 `status?` / `any progress?` / `what's next` / `where are we` / `are we done yet?` / `continue` / `keep going` / `proceed` / `done?` / `all good?` 跟 case-insensitive 變體。所有 pattern 都 `^...$` anchor，帶具體技術名詞的詢問（例：`what's next on the roadmap`、`continue with the auth refactor`）仍會被保留。Closes #17。

### 動機

0.2.3 的 audit corpus（n=89）全是中文 prompts。filter 設計上是針對手上的 live data 測過，但設計本身把 dataset bias 寫進規則裡——progress 跟 reflection 都做成中文專屬，英文使用者完全裸奔。Slash command 本來就跨語言，但 `status?` / `continue` / `where are we` 跟中文「確認進度」「繼續」是同一類對話操控殼——短、反覆、零知識價值。

### 不做的部分

- **英文 reflection pattern 故意不加**。`did we just X` 跟 `didn't we just Y` 對「純推測」跟「具體詢問」（例：`did we just commit the migration?`）兩個語意都會 match，誤殺風險高。0.2.3 砍掉中文 `^我們剛剛` 是同一個陷阱——英文沒有像中文 `^我們剛是不是` 那樣 high-signal 的純推測 subset 可以 anchor，安全做法是英文 reflection 全保留。
- 其他 CJK 語言（日文 進捗、韓文 진행）——等真實使用者出現再擴 vocab。

### 測試

- `tests/harvester-filter.test.ts` 新增 5 條測試覆蓋英文殼正向命中、case-insensitive、false-positive guard（具體 topic 後綴不擋）、英文 reflection 故意不擋的設計決策。
- 測試數：487 → 492。

### 升級清單

```bash
# 1. 安裝 0.2.4
npm i -g @tznthou/ccrecall@0.2.4

# 2. 重啟 daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. 驗證
curl -s http://127.0.0.1:7749/health | jq .version
# 預期: "0.2.4"
```

---

## [0.2.3] — 2026-04-28

### 新增

- **Harvest 噪音過濾器**（`isHarvestNoise()`，`src/core/harvester-filter.ts`）。Hook auto-harvest 寫進 memories table 之前會先擋掉對話操控類噪音：純 slash 指令（`/clear`、`/model`、`/compact`）、純中文進度查詢殼（`繼續我們的進度`、`確認我們現在的進度`、`這個專案進度如何?`）、推測式自我反思開頭（`我們剛是不是 …`）。誤殺防護：slash 跟 progress 偵測都有 30 字短文本上限，帶具體技術細節的 audit query 仍會被保留；reflection 只留 `^我們剛是不是` 一條 high-signal pattern，所以「我們剛剛 github 沒有發 tag ？」這種具體 issue 詢問還是會進去。
- **新增 `'query'` MemoryType**——加進 union、MCP `MEMORY_TYPES` enum、HTTP `VALID_MEMORY_TYPES` set。Hook 抓進來的記憶從此一律標 `type='query'`，不再看 session outcome——prompt 本身就是查詢，不是 decision 也不是 discovery，就算這次 session 真的 commit 了也一樣。`decision` / `discovery` / `feedback` / `preference` / `pattern` 留給 `recall_save` 手動寫入用。

### 變更

- **`buildMemoryFromSession()` 不再用 outcome 推 memory type**。outcome（`committed` / `tested` / `null`）仍驅動 `confidence`（0.9 / 0.8 / 0.7——確定度的訊號是真的），但把 outcome 直接當分類依據的設計，會把每一個有 commit 的 session 都硬塞成 `decision`，即使 prompt 只是查進度殼。

### 移除

- `inferMemoryType()`——sole caller 已砍，不是 public API。

### 動機

線上 DB audit 顯示 hook 抓的記憶有 84% 從未被 recall。往下看底層 entries 才知道真正的成本：純 `/clear`、`/model` 指令、反覆的「確認進度」殼、對話反思——全都當 `discovery` 或 `decision` 級記憶寫進去。Topic 系統（89 筆 memory 對應 1,767 條 memory↔topic link，平均每筆 19.9 個 topic）進一步把 top-topic 命中率推到 80% 以上，因為噪音記憶都灌到 `docs`、`bug-fix`、`testing` 這些通用英文 `topic_key`——跟整個 corpus 撞同一組 tag。新 filter 對線上 89 筆既有資料 dry-run，flagged 23 筆（25.8%）為噪音——幾乎正好就是底部四分位的 recall cohort。剩下的全標 `query` 切開「user 在時點 T 問了 X」跟「我們學到了 Y」這兩件事，未來在 `recall_query` 加一層 filter 就能 opt out「query 當記憶回」。既有 89 筆不做 backfill——歷史記錄保留原 type，audit history 不動。

### 測試

- `tests/harvester-filter.test.ts` 12 條新測試（slash / progress / reflection / fallback / false-positive guard）+ `tests/session-end.test.ts` 加 2 條 integration case 覆蓋噪音 skip 跟 audit-query 保留。
- 測試數：475 → 487。

### 升級清單

```bash
# 1. 安裝 0.2.3
npm i -g @tznthou/ccrecall@0.2.3

# 2. 重啟 daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. 驗證
curl -s http://127.0.0.1:7749/health | jq .version
# 預期: "0.2.3"
```

---

## [0.2.2] — 2026-04-27

### 修復

- **CJK case 5：LIKE fallback 改用 per-token AND**。短 token fallback（query 任一 whitespace-split token 不到 3 字元時觸發；trigram tokenizer 對 <3 字元 token 沒辦法 index，所以走 LIKE）本來把整個 raw query 包成 `%...%`——AND 語義被吃掉、變成 substring match：`queryMemories('UI 記憶')` 只會命中文檔字面上 `UI` 後面緊跟一個空格再接 `記憶` 的連續字串。混合中英查詢（最常見的 query 形狀——`UI 記憶`、`DB 查詢`、`API 路由`、`CI 流程`）只要兩個 token 中間隔著別的字就 silent false negative——使用者完全不知道自己漏抓。修正後 fallback 改 split on whitespace、對每個 token 各跑一次 LIKE 再 AND 起來；`searchSessionsFallback` 在每個 token 內仍保留跨 5 個 FTS 欄位的 OR。純單 token 的短查詢（`記憶`、`UI` 自己）退化成原本的 single-LIKE，行為不變。

### 安全

- **LIKE fallback token 數上限 20**，防 SQL prepare 階段資源爆炸。沒這個 cap 的話，呼叫端可以丟 `'a b c d e ...'` 一萬個 token，要嘛把同步 `prepare()` 卡到 event loop stall，要嘛撞到 `SQLITE_MAX_VARIABLE_NUMBER`（`queryMemoriesFallback` 每 token 1 個 bind param，`searchSessionsFallback` 每 token 5 個）。20 對任何真實 search query 都很夠。對應 OWASP A10（例外狀況處理失當，資源消耗無上限）和 AI 漏洞 #5（缺少輸入驗證）。

### 動機

#13 追蹤的 5 個 deferred CJK edge case 全部本機重現過，**Case 5 對使用者衝擊最大**——recall 出現 silent false negative，沒有任何訊號讓使用者知道漏抓——而且也是唯一不用做 ingest re-index 就能修的。Case 1（全形標點切斷 trigram）/ Case 2（NFC ↔ NFD divergence）/ Case 4（半形 ↔ 全形片假名）需要在 ingest 和 query 兩端都做 NFKC normalization，先擱著等儲存治理收斂。Case 3（trigram tokenizer 下的 snippet 邊界）純 UX 問題，繼續 deferred。

### 測試

- 9 個新測試，分布 `tests/memories.test.ts`（7）和 `tests/database.test.ts`（2）——單 token 行為不變、混合中英 AND、token 順序無關、whitespace normalize、wildcard escape、DoS token-cap 防護。
- 測試數：463 → 472。

### 升級清單

```bash
# 1. 安裝 0.2.2
npm i -g @tznthou/ccrecall@0.2.2

# 2. 重啟 daemon
launchctl kickstart -k gui/$(id -u)/com.tznthou.ccrecall

# 3. 驗證
curl -s http://127.0.0.1:7749/health | jq .version
# 預期: "0.2.2"
```

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
