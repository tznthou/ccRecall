# Research: AI 長期記憶系統設計
- **Date**: 2026-04-13
- **Providers**: claude（純思辨討論，非搜尋研究）
- **Topic**: 超越現有進度存檔機制的 AI 長期記憶機制設計，核心問題：元認知（AI 知道自己知道什麼）
- **Status**: 進行中，待後續 session 繼續深挖

---

## 這份文件的由來

這份文件來自我和 Claude 在 2026-04-13 的一次深度討論。起因是研究 Obsidian 分享會教學包時，延伸到 AI 記憶長久化的根本問題。我明確指出：這是目前 AI 體系最重大的問題之一。

討論的推理路徑：
1. 研究 Karpathy Index 法和 obsidian-mind → 發現它們都在解「AI 記憶持久化」
2. 分析 obsidian-mind 的分層載入機制 → 理解「省 token」的技術細節
3. 比較 Karpathy vs obsidian-mind → 發現根本差異不在 hooks，而在知識流向（AI 是主人 vs 管家）
4. 跳出分享會脈絡，討論「AI 記憶長久化還有什麼做法？」
5. 提出記憶分離架構（身份/反應/知識三層）→ 我認為值得深挖
6. 分析現有進度存檔機制的痛點 → 我指出問題不只是存檔機制本身，而是 Claude Code 記憶機制的根本限制
7. 討論收斂到核心問題：**元認知——AI 不知道自己知道什麼**
8. 我的觀察：「AI 一定不會承認自己不知道」「關掉 session 就遺忘一切」

---

## 問題定義

### Claude Code 記憶機制的根本限制

| 限制 | 具體問題 |
|------|---------|
| MEMORY.md 有天花板 | 200 行截斷，記越多越擠 |
| 每次 session 從零開始 | AI 不是「記住」，是「重新讀檔案理解」 |
| context window 是消耗品 | 記憶檔案載入就佔 token，擠壓工作空間 |
| auto-compact 不可控 | 系統決定壓縮什麼、丟什麼，使用者無法干預 |
| 無連續性 | session A 的推理過程，session B 完全不知道 |
| 記憶和遺忘都是被動的 | 不會主動記重要的，也不會主動忘不重要的 |

**核心矛盾**：載入記憶佔 token → token 不夠工作 → 但不載入就忘記 → 永遠在「記住」和「能用」之間拉扯。

### 元認知缺失：最根本的問題

```
人類做決策的流程：
  遇到問題 → 「這個我知道嗎？」→ 知道 → 直接回答
                                → 不確定 → 去查
                                → 不知道 → 承認不知道

AI 做決策的流程：
  遇到問題 → 直接回答（不管知不知道，自信度都一樣）
```

AI 沒有「我不知道」這個狀態。記憶問題只是這個更大問題的一個切面。

元認知可以拆成三個子問題：

| 子問題 | 描述 | 現狀 |
|--------|------|------|
| 知識邊界 | 知道自己知道什麼、不知道什麼 | 完全沒有 |
| 知識深度 | 知道某個主題研究得多深 | 沒有 |
| 知識時效 | 知道某個記憶是否還可靠 | frontmatter 有 date，但 AI 不會主動判斷 |

---

## 記憶分類：人腦 vs AI

```
人腦                          AI 對應                    目前 Claude Code
─────────────────────────────────────────────────────────────────────
程序記憶（怎麼做）           Hooks + Skills              有，但沒被當作「記憶」
語義記憶（知道什麼）          知識檔案                    有，但全塞進 context
情節記憶（經歷過什麼）        Session 歷史                compact 後就沒了
工作記憶（正在想什麼）        Context window              有，但被記憶檔案佔滿
元認知（知道自己知道什麼）     Index / 目錄                MEMORY.md 勉強算
```

最大空缺：情節記憶和元認知。

我的判斷：情節記憶「某種程度上可以靠某些機制來滿足」（hooks + session 摘要），但元認知是更根本的難題。

---

## 已討論的解法方向

### 方向 1：分層記憶架構

```
Layer 0 ─ 身份層（Identity）     → CLAUDE.md，< 2K tokens，永遠載入
Layer 1 ─ 程序層（Procedural）   → Hooks + Skills，不佔 token
Layer 2 ─ 索引層（Index）        → 輕量 index，啟動時載入，< 1K tokens
Layer 3 ─ 知識層（Semantic）     → topic 檔案，按需讀取
Layer 4 ─ 情節層（Episodic）     → session 摘要，按需查閱
Layer 5 ─ 工作層（Working）      → context window，自動管理
```

核心改進：只載入 Layer 0-2（身份 + 程序 + 索引），按需讀 Layer 3-4，context 留給工作。

### 方向 2：行為化記憶（記憶即 Hooks）

不記「事實」，記「反應模式」。把學到的行為寫成 hook script，零 token 成本。
- 優勢：不佔 context
- 限制：只能記「模式」，不能記「事實」

### 方向 3：分層壓縮 + 遺忘曲線

模仿人類記憶——近期記憶保留細節，遠期記憶只保留摘要。
- Day 0: 完整 transcript（10,000 tokens）
- Day 7: AI 壓縮成重點摘要（2,000 tokens）
- Day 30: 再壓成一行結論（200 tokens）

### 方向 4：Git 時間旅行記憶

Git 本身就是天然的記憶層（git log = 時間線，git diff = 變化，git blame = 歸因）。

### 方向 5：多 AI 共享記憶層

Claude Code + Codex + Gemini 共享同一個記憶庫（超越 obsidian-mind 的三份設定檔，做真正的記憶共享）。

### 方向 6：記憶分離（我最感興趣）

把記憶拆成三種完全不同的儲存方式，不混在一起：
- 身份記憶 → System prompt / CLAUDE.md（永遠載入，極小）
- 反應記憶 → Hooks（事件觸發，零 token）
- 知識記憶 → 外部檔案 + index（按需查詢）

### 方向 7：元認知系統

三個子方案（從容易到困難）：

**A. 結構化 Index**：MEMORY.md 改成帶 metadata 的 index（depth / confidence / last_touched）。AI 讀完就有粗略的自我認知地圖。
- 可行性：現有架構就能做
- 限制：靠 AI 自律

**B. Hook 驅動的主動元認知**：UserPromptSubmit hook 做即時比對，主動提醒 AI「你之前研究過這個」或「這個主題不在你的記憶中，不要猜」。
- 可行性：需要進階 hook
- 優勢：強制機制，不靠自律

**C. 記憶自我模型（Memory Self-Model）**：AI 維護一份自己的知識狀態文件，包含「擅長什麼」「不確定什麼」「不知道什麼」「偏見和盲點」。
- 可行性：Stop hook 觸發自我評估，品質難保證
- 突破性：如果做好，是真正的 AI 元認知

---

## 討論收斂：混合方案方向（2026-04-13 結論）

### 核心矛盾（所有 markdown-based 記憶方案的共同瓶頸）

```
記得多 → 檔案多 → 每次載入佔滿 context → 沒空間工作
記得少 → 檔案少 → context 有空間 → 但什麼都不記得
```

我的實際痛點：之前用跨 session 交接文件搭配 Serena MCP 做記憶，累積大量 markdown 文件，每次讀取浪費大量 context window。現有進度存檔機制、跨 session 交接文件、obsidian-mind 的 SessionStart 都會撞上這面牆——差別只是撞牆的速度。

### 突破方向：hooks 驅動的按需記憶注入

```
現在：Session 開始 → 讀 N 個 markdown → 佔掉大量 tokens → 開始工作
目標：Session 開始 → 零記憶載入（0 tokens）
     使用者說話 → hook 比對記憶庫 → 只注入最相關的片段（< 300 tokens）
     用完被 compact 掉也沒關係 → 下次需要時 hook 再注入
```

記憶不在 AI 腦裡，在 hook 的後端。AI 永遠只拿到「此刻需要的那一小片」。

### 下一步：深入研究兩個範本，設計混合方案

| 來源 | 要研究什麼 | 提供什麼 |
|------|-----------|---------|
| **obsidian-mind** | 5 個 hooks 的完整實作、classify-message.py 的比對邏輯、session-start.sh 的注入策略 | 「hooks 怎麼寫」的工程範本 |
| **Karpathy Index** | index 的結構設計、摘要粒度、AI 如何用 index 導航 | 「index 怎麼設計」的知識架構 |
| **混合** | hooks 驅動 + index 導航 = 按需注入系統 | 新的記憶架構 |

具體研究項目：
1. 拆解 obsidian-mind 的 `classify-message.py`，理解它的語義比對邏輯（已有原始碼）
2. 拆解 `session-start.sh` 的注入策略，找出哪些可以改成按需（已有原始碼）
3. 研究 Karpathy 的 index 結構——摘要粒度、更新頻率、導航效率
4. 設計一個 PoC：UserPromptSubmit hook + 輕量記憶庫 + 精準注入
5. 評估是否需要外部搜尋引擎（QMD / SQLite / 簡單 grep）

---

## 未解決的問題（下次討論的起點）

1. **混合方案的 PoC**：最小可行的 hook + index 記憶系統長什麼樣？
2. **元認知的實作路徑**：結構化 Index（方向 A）+ Hook 主動提醒（方向 B）能否結合？
3. ~~**情節記憶**：PreCompact hook 的摘要品質怎麼保證？壓縮策略怎麼設計？~~
   → **2026-04-14 部分解決**：Claude Code 2.1.105 正式發布 PreCompact hook，支援阻擋 compaction。已實作階段 A（auto-compact 安全閥），架構文件已更新階段 B/C 設計（`/session/checkpoint` 增量存檔 + 知識地圖觸發點）。摘要品質問題待 Memory Service Phase 2 實作時驗證。
4. **取代現有存檔機制**：新系統設計出來後，現有進度存檔機制的哪些功能保留、哪些被新機制取代？
5. **AI 的根本限制**：「AI 不會承認自己不知道」——只能靠 hooks 強制？還是有其他路？
6. **我的歷史方案**：跨 session 交接文件搭配 Serena MCP 的具體實作方式值得回顧，作為新方案的 baseline

---

## 相關研究

- Karpathy autoresearch: https://github.com/karpathy/autoresearch
- Karpathy Index 法 / LLM Wiki: AI 編譯知識 + 維護 index
- obsidian-mind: https://github.com/breferrari/obsidian-mind （分層載入 + hooks）
- obsidian-mind 原始碼已分析：session-start.sh、classify-message.py、validate-write.py、settings.json
- 詳細技術分析見同目錄 `obsidian-ai-deep-memory.md`
- 我的歷史方案：跨 session 交接文件搭配 Serena MCP（待回顧）

---

*這份文件本身就是「元認知」的實踐——記錄的不只是結論，還有推理路徑和未解決的問題，讓下一個 session 能接續思考而不是重新開始。*
