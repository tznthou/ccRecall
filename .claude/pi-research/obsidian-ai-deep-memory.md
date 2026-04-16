# Research: Obsidian 作為 AI 深度記憶工具
- **Date**: 2026-04-13
- **Providers**: gemini + websearch + claude
- **Topic**: Obsidian 作為 AI 持久記憶系統的方法論與框架，利用 index 機制讓 AI 記憶永不遺忘

---

## Overview

Obsidian 作為 AI 持久記憶的做法主要分三個流派：Karpathy Index 法、MCP Server 法、Embeddings RAG 法。其中 Karpathy 的 Index-based 方法最符合「用 index 讓 AI 永不遺忘」的描述。

---

## 三大流派比較

| 流派 | 核心做法 | 技術門檻 | 隱私 | 適合規模 | 代表 |
|------|---------|---------|------|---------|------|
| **Karpathy Index 法** | index 檔 + 文章摘要，LLM 先讀目錄再深入 | 低 | 完全本地 | ~100 篇 / 40 萬字免 RAG | Andrej Karpathy |
| **MCP Server 法** | MCP 連接 Claude ↔ Obsidian，雙向讀寫 | 中 | 本地（Claude API 除外） | 無上限 | obsidian-claude-code-mcp、obsidian-mind |
| **Embeddings RAG 法** | 向量嵌入 + 語義搜尋 | 高 | 可完全離線 | 大量筆記 | Smart Connections、ObsidianRAG |

---

## 1. Karpathy Index 法（LLM Wiki / LLM Knowledge Base）

**定義**：Vault 是「AI-owned territory」——人類提供原始資料，AI 當 "compiler" 編譯成結構化、重度互連的 wiki，自主維護 index 並解決矛盾。

**做法**：
- 跳過向量資料庫，不用 embeddings、不用 chunking
- 維護一個 index file，每篇文章一行簡短摘要
- LLM 先讀 index → 判斷哪些文章相關 → 再深入讀全文
- 純 markdown + 資料夾結構，沒有額外依賴

**實測規模**：~100 篇文章 / 40 萬字，不需要 RAG。

**三層記憶架構**（Three-Layer Memory Architecture）：

| 層級 | 內容 | 作用 |
|------|------|------|
| Working Memory | Session logs、未處理的原始資料 | 短期暫存 |
| Structured Wiki | AI 編譯的概念頁，互相 `[[wikilink]]` | 長期知識庫 |
| Reports / `MEMORY.md` | 頂層摘要，每次 session 開始時注入 | AI 的「記憶索引」 |

**跟 autoresearch 的關係**：同一個人（Karpathy）的方法論。autoresearch 讓 AI 自動做研究，index 法讓 AI 記住所有研究結果。兩者串起來形成完整迴圈。

---

## 2. MCP Server 法

**代表專案**：
- [obsidian-mind](https://github.com/breferrari/obsidian-mind) — 給 Claude Code / Codex / Gemini CLI 的 persistent memory vault
- [obsidian-claude-code-mcp](https://github.com/iansinnott/obsidian-claude-code-mcp) — MCP server 連接 Claude 到 Obsidian
- [obsidian-memory-for-ai](https://github.com/jrcruciani/obsidian-memory-for-ai) — 建立 persistent AI memory 的指南
- [obsidian-memory-mcp](https://github.com/YuNaga224/obsidian-memory-mcp) — 將 AI 記憶存為 graph-compatible Markdown

**做法**：AI 每次 session 開始自動注入 vault context（目標、慣例、歷史決策），結束時把新學到的寫回 vault。

### 重點研究：obsidian-mind（1851 stars，持續更新中）

**定位**：不是插件，是一個完整的 Vault 模板——下載就能用，直接給 AI coding agent 持久記憶。

**支援**：Claude Code、Codex CLI、Gemini CLI（各有對應設定檔 CLAUDE.md / AGENTS.md / GEMINI.md）

**分層記憶載入**（省 token 的關鍵設計）：
- Base layer (~2K tokens)：CLAUDE.md + SessionStart 自動注入
- On-demand：QMD semantic search，需要時才讀特定筆記
- Triggered hooks (~100-200 tokens)：分類路由 + 寫入驗證

**5 個 Lifecycle Hooks**：
| Hook | 做什麼 |
|------|--------|
| SessionStart | 注入 North Star、active work、recent changes |
| UserPromptSubmit | 自動分類內容類型、路由提示 |
| PostToolUse | 驗證 frontmatter、檢查 wikilinks |
| PreCompact | 備份 session transcript |
| Stop | 歸檔、更新 index、找孤兒筆記 |

**資料夾結構**：
```
Home.md / CLAUDE.md / AGENTS.md / GEMINI.md
├── work/       (active projects, archives, incidents, 1:1 notes)
├── org/        (people, teams, organizational context)
├── perf/       (brag doc, competencies, evidence, reviews)
├── brain/      (North Star goals, decisions, patterns, gotchas)
├── reference/  (architecture, codebase knowledge)
├── thinking/   (scratchpad for drafts)
├── templates/  (Obsidian templates with YAML frontmatter)
├── bases/      (dynamic database views)
└── .claude/    (commands, agents, scripts, skills)
```

**18 個 Commands + 9 個 Subagents**：涵蓋 standup → 日常 → wrap-up → 週回顧完整工作流。

**跟我們教學包的關聯**：
- ✅ 可借鏡：「下載就能用」的 vault 模板、分層載入不燒 token、多 AI 工具支援
- ⚠️ 差異：偏工程師個人效能管理（perf review、brag doc），我們是通用知識管理
- 📌 待深入研究：哪些 commands/hooks/subagents 的設計模式可以簡化後用在教學包

---

## 3. Embeddings RAG 法

**代表**：
- [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) — Obsidian 插件，內建 local embedding model，語義搜尋 + 聊天
- [ObsidianRAG](https://github.com/Vasallo94/ObsidianRAG) — LangGraph + Ollama，完全離線
- [obsidianGraphRAG](https://github.com/Jinstronda/obsidianGraphRAG) — Graph RAG，建知識圖譜
- [Copilot for Obsidian](https://github.com/logancyang/obsidian-copilot) — 所有 chat history、memory 都存成 .md
- [Ori-Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos) — GraphRAG 框架，AI 沿著 wikilink 走知識圖譜

---

## 常見陷阱

- AI 寫筆記時會「幻覺」不存在的 `[[wikilink]]`，需要 lint 腳本檢查
- 大量筆記灌進 context window 會燒 token
- MCP server 暴露檔案系統有安全風險
- 標準 vector search 常抓到斷裂的段落，失去上下文

---

## 對分享會的適用性

| 流派 | 適合教嗎？ | 原因 |
|------|-----------|------|
| **Karpathy Index 法** | ✅ 最適合 | 零依賴、純 markdown、概念直觀、跟 autoresearch 一脈相承 |
| MCP Server 法 | ⚠️ 進階 bonus | 需要設定 MCP，但學員已經用 Claude Code / Codex |
| Embeddings RAG 法 | ❌ 太複雜 | 需要理解向量、embeddings，超出 1.5 小時範圍 |

**建議**：第四步 AI 互動的 bonus 環節，教 autoresearch + Karpathy Index 法，形成「AI 自動研究 → 結果用 index 永久記憶」的完整迴圈。

---

## 深度分析：Karpathy vs obsidian-mind

### 根本差異一：知識流向

| | Karpathy | obsidian-mind |
|---|---------|---------------|
| **AI 的角色** | **Compiler**（編譯者） | **Consumer + Writer**（消費者 + 記錄者） |
| **知識來源** | 人餵原始資料 → AI 編譯成結構化 wiki | 人寫筆記 → AI 讀取 + 追加 |
| **index 誰維護** | AI 自主維護，解決矛盾、更新摘要 | 人 + hooks 共同維護 |

Karpathy 的 AI 是**主人**——它擁有 vault，決定怎麼組織知識。
obsidian-mind 的 AI 是**管家**——vault 是人的，AI 按規則幫忙整理。

### 根本差異二：導航方式

| | Karpathy | obsidian-mind |
|---|---------|---------------|
| **怎麼找筆記** | 讀 index file → 判斷相關性 → 讀全文 | QMD 語義搜尋 + hooks 路由提示 |
| **依賴** | 零依賴，純 markdown | QMD（語義索引）、Obsidian CLI |
| **精準度** | 靠 index 摘要品質 | 靠 embeddings + regex 分類 |

Karpathy：一個 index 檔打天下。
obsidian-mind：hooks 告訴你「寫去哪」，QMD 告訴你「從哪讀」，兩條路。

### 根本差異三：結構化程度

| | Karpathy | obsidian-mind |
|---|---------|---------------|
| **vault 結構** | 自由，wiki style | 高度預設（work/org/perf/brain，每個有規則） |
| **frontmatter** | 不強制 | 強制 schema（date, description, tags, quarter...） |
| **品質控管** | 無 | PostToolUse hook 自動驗證格式 + wikilinks |
| **模板** | 無 | 7+ 種筆記模板 |

### 一句話區分

> **Karpathy**：給 AI 一個空間，讓它自己建圖書館。
> **obsidian-mind**：給 AI 一本圖書館管理手冊，讓它幫你管。

### obsidian-mind 分層載入技術細節

```
Layer 0  CLAUDE.md ──────── 永遠載入（規則手冊，不含筆記內容）
Layer 1  SessionStart ───── 啟動時注入摘要（~2K tokens）
Layer 2  UserPromptSubmit ─ 每則訊息分類路由（~100-200 tokens）
Layer 3  On-demand search ─ AI 主動用 QMD 搜尋才讀全文（按需）
Layer 4  PostToolUse ────── 寫入後驗證格式 + wikilinks（~100 tokens）
Layer 5  PreCompact/Stop ── 收尾備份 + checklist 提醒（低 token）
```

**SessionStart hook 具體做法**（`session-start.sh`）：
- `qmd update` — 增量重新索引
- `cat brain/North Star.md | head -30` — 目標只讀前 30 行
- `git log --oneline --since="48 hours ago" | head -15` — 最近變更只列 15 筆
- `obsidian tasks daily todo | head -10` — 待辦只列 10 項
- `ls work/active/*.md` — active work 只列檔名不讀內容
- `find . -name "*.md"` — vault 檔案清單（路徑，不讀內容）

核心原則：**每個區塊都有 `head` 限制，只給 AI 看「目錄級別」的資訊。**

**UserPromptSubmit hook 具體做法**（`classify-message.py`）：
- 用 regex 掃描使用者每則訊息
- 7 種分類：DECISION / INCIDENT / 1:1 / WIN / ARCHITECTURE / PERSON CONTEXT / PROJECT UPDATE
- 命中 → 注入一行路由提示（例：`WIN detected — consider adding to perf/Brag Doc.md`）
- 支援英文、日文、韓文、中文關鍵詞
- AI 不需要讀 vault 就知道該往哪寫

**總結邏輯**：
| 傳統做法 | obsidian-mind 做法 |
|---------|-------------------|
| 把整個 vault 灌進 context | 只給目錄 + 摘要 |
| AI 自己判斷寫在哪 | Hook 自動路由告訴 AI 寫哪 |
| 每次 session 重新理解 vault | SessionStart 注入結構化 context |
| 需要時搜尋整個 vault | QMD 語義索引，精準命中 |

### 對分享會的教學意涵

兩種模式可以代表不同學習階段：
- **入門**：先用 obsidian-mind 模式（結構化 vault + 規則清楚，學員不會迷路）
- **進階**：再介紹 Karpathy 模式（讓 AI 自己編譯知識，適合已有大量筆記的人）

完整敘事線：
```
autoresearch（AI 自動研究）
       ↓ 產出
Karpathy Index 法（AI 編譯成 wiki + 維護 index）
       ↓ 存在
Obsidian Vault（永久記憶，跨 session 不遺忘）
```

---

## Sources

- [obsidian-memory-for-ai](https://github.com/jrcruciani/obsidian-memory-for-ai)
- [obsidian-mind](https://github.com/breferrari/obsidian-mind)
- [Karpathy's Obsidian RAG Killed My Vector Database](https://www.mejba.me/blog/karpathy-obsidian-rag-knowledge-base)
- [obsidian-claude-code-mcp](https://github.com/iansinnott/obsidian-claude-code-mcp)
- [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)
- [3 Ways to Use Obsidian with Claude Code](https://awesomeclaude.ai/how-to/use-obsidian-with-claude)
- [Obsidian AI Second Brain Complete Guide 2026](https://www.nxcode.io/resources/news/obsidian-ai-second-brain-complete-guide-2026)
- [Your Second Brain Has Amnesia](https://slyapustin.com/blog/obsidian-llm-memory-organizer.html)
- [obsidian-wiki (Karpathy pattern)](https://github.com/Ar9av/obsidian-wiki)
- [Copilot for Obsidian](https://github.com/logancyang/obsidian-copilot)
- [Ori-Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos)
- [obsidian-memory-mcp](https://github.com/YuNaga224/obsidian-memory-mcp)
