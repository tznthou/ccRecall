# 使用 ccRecall — 從零到跨 session 記憶

> [English](tutorial.md)

## 這是什麼

你有個超聰明的朋友叫 Claude，寫程式、debug、重構都厲害，但他金魚腦——每次見完面下次就忘光。昨天一起解的 bug，明天變陌生人。架構花 20 分鐘講清楚，下週重開 session 要再講一次。

ccRecall 就是幫 Claude 裝記憶的小幫手。它讀你跟 Claude Code 的對話記錄（`~/.claude/projects/` 裡的 JSONL 檔），偷偷畫重點存進 SQLite，Claude 下次開工前自動遞張小紙條：「上次你們決定用 A 方案、解了 B 問題。」整件事零 API 成本，本地跑完。

想看更詳細的運作原理，結尾有「想深入？」一節。

---

## 開始前

這份教學假設你：

- 裝好 **Claude Code CLI**（沒裝看 [官方指南](https://docs.anthropic.com/claude-code)）
- **macOS**（Linux 和 Windows 的 auto-start 是 Phase 5，但手動跑 daemon 本身跨平台）
- **Node.js 20–22**（`node --version` 確認）
- 能用 terminal

不需要懂 SQLite、FTS5、MCP 的細節——下面會現場講。

---

## 3 步上手

### 步驟 1：裝

```bash
npm install -g @tznthou/ccrecall
```

裝完你會拿到兩個 CLI 命令：

- `ccmem`：跑 daemon（服務本體）
- `ccmem-mcp`：給 Claude Code 呼叫的 MCP server

> 為什麼 CLI 叫 `ccmem`？因為 npm 上 `ccrecall` 已經被 [spences10/ccrecall](https://github.com/spences10/ccrecall)（不同的 analytics 工具）用掉了。專案名還是 ccRecall，只有 bin 名字避開衝突。

### 步驟 2：讓 daemon 開機自動跑（macOS）

```bash
ccmem install-daemon
```

這會：
1. 寫一個 LaunchAgent plist 到 `~/Library/LaunchAgents/com.tznthou.ccrecall.plist`
2. 建 log 目錄 `~/Library/Logs/ccrecall/`
3. 立刻啟動 daemon，之後每次登入也會跑

**Linux / Windows / 只想試玩** 的人可以改用前景跑：

```bash
ccmem    # 停在前景，Ctrl+C 結束
```

### 步驟 3：接上 Claude Code（設 MCP）

```bash
claude mcp add ccrecall --scope user -- ccmem-mcp
```

這把 ccRecall 的 MCP server（`ccmem-mcp`）註冊給 Claude Code。`--scope user` 代表在所有專案都能用。

---

## 日常如何自動運作

裝完三步後，你大概會想「所以它會自己跑？我還要做什麼嗎？」答案是：**幾乎什麼都不用**。四個零件在你背後接力：

1. **Daemon（背景服務）**
   `ccmem install-daemon` 把它註冊成 macOS LaunchAgent，開機自動啟動，駐在背景等 HTTP 請求。電腦開著它就在。

2. **Watcher（檔案監聽）**
   Daemon 用 chokidar 盯住 `~/.claude/projects/`。每次 Claude Code 寫新的 session JSONL，watcher 幾秒內就抓到、丟去索引、更新 SQLite。不用手動重掃。

3. **10 分鐘 backstop（兜底掃描）**
   檔案系統偶爾會漏事件（macOS sleep/wake、外接硬碟插拔等），所以每 10 分鐘再全掃一次當保險。漏掉的 JSONL 這邊會接住。

4. **Hooks（Claude Code 生命週期鉤子）**
   下一節會教你設 hook。設好之後 Claude Code 會在兩個時機自動叫 ccRecall：
   - **SessionStart**：開新 session 前，把相關記憶注入 context（Claude 不用自己決定要不要查）
   - **SessionEnd**：session 結束時，把剛剛這段萃取成一筆新的 memory

一句話：**裝完 + 配好 hook，之後就不用管，它自己累積。**

---

## 設 Hooks（一行搞定）

Step 3 的 MCP 是「Claude 想查才去查」。Hook 則是「每次 session 開頭/結尾自動跑」，是自動累積記憶的關鍵。

```bash
ccmem install-hooks
```

這會：
1. 找到 `~/.claude/settings.json`（不存在就建一個 `{}`）
2. 備份原檔到 `settings.json.bak-<timestamp>`
3. 合併（非覆蓋）`SessionStart` 和 `SessionEnd` 兩個 hook 的註冊
4. 你原本寫過的其他 hook 完全不動

**裝完要重開 Claude Code session**——hook 設定不會 hot-reload。

想看會寫什麼而不真的寫：`ccmem install-hooks --dry-run`。
要拔掉：`ccmem uninstall-hooks`（只刪 ccRecall 自己的 entry，不會誤動你其他 hook）。

### 驗證 hook 真的有觸發

```bash
# 記下目前 memory 數
sqlite3 ~/.ccrecall/ccrecall.db "SELECT COUNT(*) FROM memories"

# 開新 Claude Code session，聊幾句，關掉

# 再數一次，應該 +1
sqlite3 ~/.ccrecall/ccrecall.db "SELECT COUNT(*) FROM memories"

# 或者 tail daemon log 看 /session/end 被打到
tail -f ~/Library/Logs/ccrecall/ccrecall.out.log
```

---

## 怎麼知道它在運作

### 確認 daemon 活著

```bash
curl http://127.0.0.1:7749/health
```

回 `{"status":"ok"}` 就對了。`7749` 是預設 port，要改的話在 plist 裡改 `CCRECALL_PORT`。

### 確認 MCP 接上

重新開一個 Claude Code session，隨便問一句：

> 「上次我們有沒有聊過 xxx？」

Claude 應該會主動呼叫 `mcp__ccrecall__recall_query` 工具搜尋你以前的對話。看到它「正在查記憶」就是接上了。

### 為什麼第一次可能拉空

Daemon 啟動當下會自動跑 `runIndexer`，把 `~/.claude/projects/` 下所有歷史 JSONL 掃一遍建索引。掃完後 watcher 才開始監看新檔案。**首次啟動期間查不到東西是正常的**，掃描時間視歷史量而定——十幾個 session 幾秒、幾百個 session 可能要一兩分鐘。

想知道進度可以 tail log：

```bash
tail -f ~/Library/Logs/ccrecall/ccrecall.out.log
# 看到 "Indexer complete." 就是掃完了
```

---

## 日常三情境

### 情境一：跨 session 召回「上次那個 bug」

你上週跟 Claude 一起 debug 了某個 race condition，解法細節記不清了。新 session：

```
你：之前我們修過 watcher 的 race condition 對吧？記不得細節，查一下
Claude：（呼叫 recall_query('race condition watcher')）
Claude：找到了——你們用 async/await 強制 scanProjects 完成後才 watcher.start()，
         避開 chokidar ignoreInitial=true 的 race。commit ee64c6b。
```

ccRecall 在背景把這段記憶以 `~300 tokens` 的小紙條塞進 Claude 的 context（預設 budget，caller 可透過 `maxTokens` 最多提高到 2000），他看到就能延續。

### 情境二：主動存「這個是重要決策」

不是所有決策都會自動被 harvest。遇到關鍵 trade-off 想讓下次一定記得：

```
你：記住我們決定走 Trusted Publishing 而非 NPM_TOKEN——理由是 OIDC 零 token 維護
Claude：（呼叫 recall_save 存一筆 type=decision 的記憶）
Claude：存了。下次問 npm publish 相關會主動想起。
```

你也可以直接在 terminal 叫 daemon：

```bash
curl -X POST http://127.0.0.1:7749/memory/save \
  -H 'Content-Type: application/json' \
  -d '{"content":"決定用 Trusted Publishing","type":"decision","confidence":0.9}'
```

### 情境三：元認知「最近在忙什麼」

某天開 session 想知道這個 project 最近討論的主軸：

```
你：我們這個月在 ccRecall 主要討論哪些 topic？
Claude：（呼叫 recall_context('ccRecall') with knowledge_map）
Claude：三大 cluster：
         1. npm publishing + Trusted Publishing（近 2 週）
         2. pnpm packaging + CI workflow（3 週前）
         3. Phase 4 forgetting curve（1 月前）
```

這是 ccRecall 的元認知層——不只記個別 memory，還會聚合成「你跟 AI 在這個 project 討論過什麼 topic」。

---

## 進階

### Hook 的細節 / 手動設定

上面「設 Hooks」那節的 `ccmem install-hooks` 大部分情境夠用。如果你想手動編 `~/.claude/settings.json`、了解 hook 腳本行為、或遇到問題要 troubleshoot，看 [`hooks/README.md`](../hooks/README.md)——裡面有腳本細節、手動 JSON 範本、以及 nvm/fnm 切 Node 版本後 HOOKS_DIR 飄移的處理。

如果 daemon 的 log 看到 `/session/end` 請求、DB memories 數字有動，就代表 hook 串通了。

### macOS 開機自動啟動（daemon 本體）

步驟 2 已經 cover 了基本流程。深入的 plist 手動寫法、uninstall、port 衝突處理見 [`docs/launchd_zh.md`](./launchd_zh.md)。

---

## 常見問題

**Q: 裝完 `ccmem --help` 說 command not found？**
A: npm global bin 不在 PATH 上。跑 `npm config get prefix` 看位置，把 `<prefix>/bin` 加到 PATH。

**Q: daemon 起不來、log 一直看到 EADDRINUSE？**
A: 7749 port 被其他服務佔了。改 `CCRECALL_PORT`：
```bash
export CCRECALL_PORT=17749
ccmem install-daemon    # 重裝 plist 吃新 port
```

**Q: Claude 沒自動呼叫 recall_query？**
A: 確認 `claude mcp list` 有 `ccrecall`。若沒有重跑 `claude mcp add`。另外 Claude 不一定每次都 call——它會根據 context 判斷。強制觸發方式：
- 查：「請你用 recall_query 查 xxx」
- 存：「幫我用 recall_save 記住這件事：xxx」

直接點名工具名稱基本上都會成功 call。

**Q: 我的對話記錄會被上傳到雲端嗎？**
A: 不會。ccRecall 完全本地跑，SQLite DB 在 `~/.ccrecall/`，零外呼。摘要引擎是規則式，不呼叫 LLM。

**Q: 會修改 `~/.claude/` 裡的檔案嗎？**
A: 不會。ccRecall 嚴格唯讀 `~/.claude/`，只寫自己的 `~/.ccrecall/` 和 `~/Library/Logs/ccrecall/`。

---

## 解除安裝

```bash
# 1. 停並移除 LaunchAgent
ccmem uninstall-daemon

# 2. 移除 Claude Code MCP 註冊
claude mcp remove ccrecall -s user

# 3. 移除 npm package
npm uninstall -g @tznthou/ccrecall

# 4.（可選）清資料與 log
rm -rf ~/.ccrecall ~/Library/Logs/ccrecall

# 5.（可選）清 hook 設定
ccmem uninstall-hooks
```

前三步做完 ccRecall 就完全下線。後兩步是清痕跡，想留記憶 DB 備份就只做前三步。

---

## 想深入？

- **十歲版運作原理**：[`docs/research/ccrecall-for-kids.md`](./research/ccrecall-for-kids.md) — 用金魚腦比喻講五步驟
- **架構設計為什麼長這樣**：[`docs/architecture_zh.md`](./architecture_zh.md) — daemon 為何三引擎並行、`awaitWriteFinish` 為何 500ms、`rescueReindex` 為何繞過 watcher
- **AI 長期記憶設計**：[`docs/research/ai-long-term-memory-design.md`](./research/ai-long-term-memory-design.md) — 遺忘曲線、壓縮 pipeline
- **架構源流**：[`docs/research/ccrewind-memory-service-architecture.md`](./research/ccrewind-memory-service-architecture.md) — 從 ccRewind 抽取的模組設計

有問題或發現 bug，歡迎開 [GitHub Issue](https://github.com/tznthou/ccRecall/issues)。
