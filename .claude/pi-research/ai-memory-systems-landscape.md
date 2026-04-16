# Research: AI 長期記憶系統全景（非 Obsidian 生態）
- **Date**: 2026-04-14
- **Providers**: gemini + websearch + claude
- **Topic**: AI 長期記憶系統的工程/學術方案、AI 元認知研究、hooks 驅動按需注入

---

## Overview

2026 年 AI 長期記憶已經從「暴力塞 context」演化成多層分級架構。業界公認的核心矛盾叫做 **Context Paradox**——載入記憶佔 token，不載入就失憶。前沿方向有三：OS 式記憶分頁（Letta）、hooks 驅動按需注入（claude-mem）、以及仍在學術階段的元認知狀態向量（MSV）。

---

## 五大方案比較

| 方案 | 架構風格 | Token 成本 | 持久化方式 | 元認知支援 | 成熟度 |
|------|---------|-----------|-----------|-----------|--------|
| **Letta (MemGPT)** | OS 式分頁（RAM vs Disk） | 中 | Core Memory + Archival DB + Recall DB | 低（靠 tool call，不靠自我意識） | 高（production-ready） |
| **Generative Agents** | 連續記憶流 + Reflection | 高 | 自然語言事件流 | 低（合成事實，但無知識邊界意識） | 高（標準行為框架） |
| **Reflexion** | 語言強化學習 | 高 | 文字式情節緩衝 | 中（事後偵測錯誤，但無法預防） | 中 |
| **Hooks 按需注入** | 同步攔截器 | **低** | 外部 DB/檔案 | 低（系統規則驅動，非 AI 自評） | 高（claude-mem, obsidian-mind） |
| **元認知狀態向量 (MSV)** | 持續自我監控 | 不定 | 多維狀態向量 | **高**（主動監控知識邊界） | 低（學術前沿） |

---

## 1. Letta（MemGPT）— OS 式記憶分頁

**論文**：MemGPT: Towards LLMs as Operating Systems（2023）
**現狀**：2024 年 9 月 MemGPT 正式納入 Letta 框架，已 production-ready

### 三層記憶架構

```
Core Memory（RAM）     → 永遠 in-context，AI 可直接讀寫
Archival Memory（SSD） → 向量存儲，AI 用 tool call 查詢
Recall Memory（Log）   → 對話歷史，可搜尋
```

### 核心設計

- AI agent **自己決定**什麼載入 Core、什麼歸檔到 Archival
- 不是人決定，是 AI 自己管理記憶分頁
- Core Memory 有嚴格大小限制（模擬 RAM 容量）
- 超出時 AI 必須選擇歸檔或丟棄

### 限制

- 元認知支援低——AI 靠 tool call 管理記憶，但不真正「知道自己知道什麼」
- 是獨立框架，不直接整合 Claude Code

### Sources

- [MemGPT 論文](https://arxiv.org/abs/2310.08560)
- [Letta Docs](https://docs.letta.com/concepts/memgpt/)
- [Mem0 vs Letta 比較](https://vectorize.io/articles/mem0-vs-letta)
- [LLMs as Operating Systems Agent Memory](https://github.com/ksm26/LLMs-as-Operating-Systems-Agent-Memory)
- [Stateful AI Agents: Deep Dive into Letta](https://medium.com/@piyush.jhamb4u/stateful-ai-agents-a-deep-dive-into-letta-memgpt-memory-models-a2ffc01a7ea1)

---

## 2. Generative Agents（Stanford）— 記憶流 + Reflection

**論文**：Generative Agents: Interactive Simulacra of Human Behavior（Park et al., Stanford/Google）

### 核心設計

- 連續記憶流（Memory Stream）：所有經歷以自然語言事件流儲存
- 定期 Reflection：AI 合成記憶，提取高層次觀察
- **關鍵實驗**：拿掉 Reflection 後，agent 行為在 48 小時內退化成重複、無上下文的回應

### 啟示

Reflection 不是可選的，是必需的。沒有 Reflection 的記憶系統會退化。

---

## 3. Reflexion — 語言強化學習

**論文**：Reflexion: Language Agents with Verbal Reinforcement Learning（Shinn et al.）

### 核心設計

- AI 在行動後自我反思、批評自己的輸出
- 以文字形式存儲反思結果（episodic buffer）
- 下次遇到類似情境時，注入之前的反思

### 元認知支援

- **中等**：能事後偵測錯誤，但不能預防初始幻覺
- 比 Letta 和 Generative Agents 更接近元認知，但仍有限

---

## 4. claude-mem — Hooks 驅動按需注入（46.1K stars）

**最接近我們想做的方向。**

### 架構

```
Session 中 → hooks 觀察 tool usage
          → AI 自動壓縮成 semantic summary
          → 存入 SQLite + Chroma（混合搜尋）

下一個 Session → UserPromptSubmit hook
              → 查詢 SQLite/Chroma
              → 只注入最相關的記憶片段
```

### 5 個 Lifecycle Hooks

| Hook | 做什麼 |
|------|--------|
| SessionStart | 重載 context |
| UserPromptSubmit | 查詢記憶庫，注入相關 context |
| PostToolUse | 觀察 tool usage，記錄到記憶庫 |
| Stop | Session 結束處理 |
| SessionEnd | 最終存檔 |

### 技術棧

- SQLite：結構化記憶存儲
- Chroma：向量搜尋（語義比對）
- Bun HTTP Worker：背景服務（localhost:37777）
- Claude agent-sdk：壓縮觀察結果

### 優勢

- Token 成本低（只注入相關片段）
- 自動化（不需手動觸發）
- 已有大量社群驗證（46.1K stars）

### 限制

- 元認知支援低——系統規則驅動，不是 AI 自評
- Memory Poisoning 風險（自動注入可能引入惡意 prompt）

### Sources

- [claude-mem hooks architecture](https://docs.claude-mem.ai/hooks-architecture)
- [claude-mem 46.1K stars](https://www.augmentcode.com/learn/claude-mem-46k-stars-persistent-memory-claude-code)
- [DIY lightweight alternative](https://dev.to/kanta13jp1/adding-persistent-memory-to-claude-code-with-claude-mem-plus-a-diy-lightweight-alternative-4gha)
- [Claude Code hooks for context injection](https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg)
- [Hooks that fixed compaction](https://dev.to/mikeadolan/claude-code-compaction-kept-destroying-my-work-i-built-hooks-that-fixed-it-2dgp)
- [Claude Code hooks mastery](https://github.com/disler/claude-code-hooks-mastery)
- [Persistent Memory setup guide](https://agentnativedev.medium.com/persistent-memory-for-claude-code-never-lose-context-setup-guide-2cb6c7f92c58)

---

## 5. 元認知（Metacognition）— 學術前沿，無成熟工程實現

### 核心問題

AI 沒有「我不知道」的狀態。所有成熟方案的元認知支援都是 Low。

### 三個研究方向

| 方向 | 做法 | 成熟度 |
|------|------|--------|
| **Metacognitive Prompting** | 強制 AI 進入 System 2 反思迴圈，回答前先評估自信度 | 中（可用但不穩定） |
| **Metacognitive State Vectors (MSV)** | 五維度自我監控（uncertainty, conflict detection, correctness evaluation, experience matching, problem importance） | 低（學術） |
| **Memory Self-Model** | AI 維護「我擅長什麼 / 不確定什麼 / 不知道什麼」的文件 | 低（我們的構想） |

### 子超的核心觀察

「AI 一定不會承認自己不知道」——這在學術研究中也被證實：LLM 的元認知很弱，有時說知道但答錯，有時說不知道但其實能答對。自信度和正確率的相關性很低。

### Sources

- [AI Metacognition Explained](https://medium.com/@evolutionmlmail/can-language-models-know-what-they-know-ai-metacognition-explained-d000dd68a925)
- [Artificial Metacognition](https://theconversation.com/artificial-metacognition-giving-an-ai-the-ability-to-think-about-its-thinking-270026)
- [Microsoft AI Agents Metacognition](https://techcommunity.microsoft.com/blog/educatordeveloperblog/ai-agents-metacognition-for-self-aware-intelligence---part-9/4402253)
- [Metacognition in Nature](https://www.nature.com/articles/s44387-025-00027-5)
- [Metacognition and Metamemory Concepts for AI Systems](https://www.researchgate.net/publication/235219069_Metacognition_and_Metamemory_Concepts_for_AI_Systems)

---

## 6. 其他新興方案（2026 前沿）

| 方案 | 核心概念 | Source |
|------|---------|--------|
| **A-Mem** | Agentic Memory，記憶演化三階段：Storage → Reflection → Experience | [arxiv](https://arxiv.org/pdf/2502.12110) |
| **MAGMA** | Multi-Graph based Agentic Memory Architecture | (2026 early) |
| **EverMemOS** | Self-Organizing Memory Operating System | (2026 early) |
| **MemMachine** | Ground-Truth-Preserving Memory System | [arxiv](https://arxiv.org/html/2604.04853) |
| **ACT-R Inspired** | 模擬人類遺忘曲線的記憶架構 | [ACM](https://dl.acm.org/doi/10.1145/3765766.3765803) |

### 記憶演化三階段（A-Mem 框架）

```
Stage 1: Storage    → 保存原始軌跡（對話 transcript）
Stage 2: Reflection → 精煉軌跡（壓縮、提取規律）
Stage 3: Experience → 抽象軌跡（形成可遷移的經驗）
```

---

## 7. 常見陷阱與根本限制

| 陷阱 | 描述 |
|------|------|
| **Context Paradox** | 記憶載入太多佔滿 context，沒空間推理 |
| **Hallucination Gap** | AI 能事後偵測錯誤，但無法預防初始幻覺 |
| **Overthinking** | 過度反思反而引入錯誤抽象，降低簡單任務表現 |
| **Memory Poisoning (InjecMEM)** | hooks 自動注入的記憶可能包含惡意 prompt |
| **Session Amnesia** | 所有方案都依賴外部重建，沒有真正的思維連續性 |

---

## 8. 對我們的啟示

| 我們想做的 | 已有方案 | 差距 |
|-----------|---------|------|
| Hooks 按需注入 | **claude-mem** 已做到（46.1K stars） | 可直接用或借鏡 |
| 分層記憶 | **Letta** 最成熟 | 獨立框架，不直接整合 Claude Code |
| 元認知（核心問題） | **無成熟工程方案** | 這是真正的創新空間 |
| 遺忘曲線 | Generative Agents Reflection + ACT-R | 可借鏡，需工程化 |
| 記憶演化 | A-Mem 三階段 | 學術框架，需實作 |

**結論**：hooks 按需注入已有現成方案（claude-mem），不需要重新發明。真正該投入的是**元認知層**——所有成熟方案都缺這個，也是子超認為最重要的問題。

---

## 完整 Sources

| # | Source | URL |
|---|--------|-----|
| 1 | MemGPT 論文 | https://arxiv.org/abs/2310.08560 |
| 2 | Letta Docs | https://docs.letta.com/concepts/memgpt/ |
| 3 | Mem0 vs Letta | https://vectorize.io/articles/mem0-vs-letta |
| 4 | Top 6 AI Agent Memory Frameworks | https://dev.to/nebulagg/top-6-ai-agent-memory-frameworks-for-devs-2026-1fef |
| 5 | Best AI Agent Memory Frameworks 2026 | https://atlan.com/know/best-ai-agent-memory-frameworks-2026/ |
| 6 | claude-mem hooks architecture | https://docs.claude-mem.ai/hooks-architecture |
| 7 | claude-mem 46.1K stars | https://www.augmentcode.com/learn/claude-mem-46k-stars-persistent-memory-claude-code |
| 8 | DIY Claude Code memory | https://dev.to/kanta13jp1/adding-persistent-memory-to-claude-code-with-claude-mem-plus-a-diy-lightweight-alternative-4gha |
| 9 | Claude Code hooks for context injection | https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg |
| 10 | Hooks that fixed compaction | https://dev.to/mikeadolan/claude-code-compaction-kept-destroying-my-work-i-built-hooks-that-fixed-it-2dgp |
| 11 | Claude Code hooks mastery | https://github.com/disler/claude-code-hooks-mastery |
| 12 | Persistent Memory setup guide | https://agentnativedev.medium.com/persistent-memory-for-claude-code-never-lose-context-setup-guide-2cb6c7f92c58 |
| 13 | AI Metacognition Explained | https://medium.com/@evolutionmlmail/can-language-models-know-what-they-know-ai-metacognition-explained-d000dd68a925 |
| 14 | Artificial Metacognition | https://theconversation.com/artificial-metacognition-giving-an-ai-the-ability-to-think-about-its-thinking-270026 |
| 15 | Microsoft AI Agents Metacognition | https://techcommunity.microsoft.com/blog/educatordeveloperblog/ai-agents-metacognition-for-self-aware-intelligence---part-9/4402253 |
| 16 | Metacognition in Nature | https://www.nature.com/articles/s44387-025-00027-5 |
| 17 | A-Mem: Agentic Memory | https://arxiv.org/pdf/2502.12110 |
| 18 | Memory for Autonomous LLM Agents | https://arxiv.org/html/2603.07670 |
| 19 | Design Patterns for Long-Term Memory | https://serokell.io/blog/design-patterns-for-long-term-memory-in-llm-powered-architectures |
| 20 | Agent Memory Paper List | https://github.com/Shichun-Liu/Agent-Memory-Paper-List |
| 21 | Post-Compaction Hooks for Context Renewal | https://medium.com/@porter.nicholas/claude-code-post-compaction-hooks-for-context-renewal-7b616dcaa204 |

---

## 相關文件

- 同目錄 `obsidian-ai-deep-memory.md` — Obsidian 生態的 AI 記憶方案（Karpathy / obsidian-mind / RAG）
- 同目錄 `ai-long-term-memory-design.md` — 我們自己的記憶系統設計研究（元認知為核心）
