# Research: Karpathy LLM Wiki 範式與 ccRecall 的關聯分析

- **Date**: 2026-04-16
- **Providers**: websearch + claude
- **Source**: https://gist.github.com/SkyJourney/bcfc2e3f14e5030004d75b7e85ad6f9b
- **Original**: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

---

## 核心命題

Karpathy 2026-04 提出的範式轉換：**從「查詢時編譯」（RAG）到「攝入時編譯」（Wiki）**。

- RAG = 每次查詢時重新檢索、拼入 prompt、回答後消失。**無積累。**
- Wiki = 文件進入時 LLM 閱讀、理解、結構化、交叉引用。**知識複利。**

> 停止讓 LLM 在每次提問時重新發現知識，改為讓 LLM 在攝入文件時就把知識編譯成一個持久化的、不斷增長的 Wiki。

---

## 三層架構

| 層 | 所有者 | 可變性 | 類比 |
|----|--------|--------|------|
| Raw Sources | 人類 | 不可變（只增不改） | 事務日誌 |
| Wiki | LLM | 持續演化 | 物化視圖 |
| Schema | 人類 + LLM | 緩慢迭代 | DDL |

## 三大操作範式

| 操作 | 做什麼 | 影響 |
|------|--------|------|
| **Ingest** | 一篇文件觸發 10-15 頁更新 | 知識結構化 + 交叉引用 |
| **Query** | 探索即積累，好的回答歸檔回 Wiki | 複利效應 |
| **Lint** | 矛盾檢測、過時資訊、孤兒頁面、缺失引用 | 健康維護 |

---

## 與 ccRecall 的對照

| | ccRecall（目前設計） | LLM Wiki |
|---|---|---|
| 知識處理時機 | **查詢時**搜索（FTS5） | **攝入時**編譯 |
| 知識結構 | 扁平記憶條目 + knowledge_map | 互相引用的 Wiki 頁面 |
| 編譯者 | 規則式引擎（零 API 成本） | LLM（要花錢） |
| Raw Sources | JSONL 自動產生 | 人工策展 |
| 介面 | API（給 AI 用） | 文件系統（給人 + AI 用） |
| 元認知 | knowledge_map（depth/confidence） | Epistemic Map（信念狀態） |

### ccRecall 偏向 RAG 模式

目前設計：session 結束存原始摘要 → 查詢時 FTS5 搜索。knowledge_map 有「攝入時編譯」雛形但不夠深。

---

## 值得借鏡

1. **Ingest 階段做更多事**：session 結束時不只存摘要，還要主動更新 knowledge_map 的交叉引用——「這次學到的 X 跟之前 session 學到的 Y 有什麼關係？」
2. **Lint 機制**：定期健康檢查——矛盾記憶、過時資訊、孤立記憶
3. **複利效應**：好的查詢結果也該歸檔回 memories，不只是原始 session 摘要
4. **Epistemic Map**：不僅存「我們認為是真的」，還要存「什麼是不確定的、什麼有矛盾、什麼過時」——這正是 knowledge_map 的設計方向

## 不應跟隨

1. **用 LLM 做編譯**：ccRecall 面對大量自動產生的 JSONL，LLM token 成本爆炸。規則式引擎是正確選擇
2. **純 Markdown + index.md 導航**：個人研究場景優雅，但 ccRecall 是 API 服務，SQLite + FTS5 更適合
3. **人類策展角色**：LLM Wiki 需要人選素材、引導分析。ccRecall 要全自動

---

## 社區關鍵洞見

### 持久錯誤 vs 短暫幻覺（Shagun0402）

> 我們正在用**持久錯誤**交換**短暫幻覺**。

RAG 的錯誤只影響當次對話。Wiki/記憶系統的錯誤會持久化並複利。
→ ccRecall 的 confidence 衰減 + 遺忘曲線是對此問題的回應。

### 認知地圖（dangleh）

> LLM Wiki 的下一步是 Epistemic Map——存儲什麼是不確定的、什麼有矛盾、什麼過時。
→ 這正是 ccRecall 的 knowledge_map 設計目標。

### 規模邊界

500 篇文章以下，樸素 Markdown + 關鍵詞搜索已足夠。
→ 支持 ccRecall 用 FTS5 而非向量資料庫的決定。

### 編譯版認知結構（Byebai13）

> 系統從「檢索片段然後回答」變成「進入我的思維路徑，然後從那裡繼續生長」。
→ ccRecall 的理想狀態：不是給 Claude 一堆碎片，而是讓它進入使用者的思維脈絡。

---

## 反應數據

Karpathy 原文：5000+ Stars / 3200+ Forks
SkyJourney 解讀：體系化 770 行深度分析

核心共鳴點：「明明之前問過類似問題，LLM 卻每次都從零開始。」
→ 這正是 ccRecall 要解決的問題。
