# Research: Claude Code Hooks Context 注入機制可行性分析

- **Date**: 2026-04-16
- **Providers**: websearch + ct7 + gemini + claude
- **Topic**: Claude Code hooks 的 UserPromptSubmit hook 能不能把 stdout 注入到 Claude 的 context 中？驗證 ccRecall 的架構前提

---

## 核心結論

**hooks 注入 context 是官方支持的功能，不是 hack。** UserPromptSubmit hook 的 stdout 設計上會被 prepend 到使用者的 prompt，Claude 看得到但使用者在 CLI 看不到。目前有實作 bug 但屬於會被修復的問題。

---

## 一、Hooks 注入 Context 的三種方式

### 方式 1：純文字 stdout

```bash
#!/bin/bash
echo "這段文字會被 prepend 到 context"
exit 0
```

- exit code 0 → stdout 靜默 prepend 到 prompt
- exit code 2 → 阻止 prompt，stderr 顯示為 error
- 上限 10,000 字元

### 方式 2：systemMessage 欄位

```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "Claude 會看到這段訊息"
}
```

### 方式 3：hookSpecificOutput.additionalContext

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "注入到 context 的內容"
  }
}
```

---

## 二、各 Hook 事件的注入支援

| Hook 事件 | 注入 context | 穩定性 | 適用場景 |
|-----------|-------------|--------|---------|
| **SessionStart** | ✅ stdout / additionalContext | 穩定 | session 開始注入記憶底 |
| **UserPromptSubmit** | ⚠️ 設計上支持 | 有 bug | 每次提問動態注入相關記憶 |
| PreToolUse | permissionDecision 為主 | 穩定 | 工具權限控制 |
| PostToolUse | 觀察用途 | 穩定 | 副作用 |
| PreCompact / Stop | 副作用（寫檔） | 穩定 | 存檔、清理 |

---

## 三、Hooks vs MCP 架構比較

| 維度 | Hooks（UserPromptSubmit） | MCP Server（Tools） |
|------|--------------------------|---------------------|
| 範式 | **Push-based**：每次都推送 | **Pull-based**：model 決定何時拉取 |
| 執行 | **同步阻塞**：LLM 啟動前執行 | **非同步**：model 推理過程中呼叫 |
| Context 效率 | 高風險膨脹（每次都注入） | 高效（需要時才取） |
| 延遲要求 | **<100ms**（blocking，使用者會卡住） | 無嚴格限制 |
| 可見性 | 使用者不可見（除錯困難） | 使用者可見（tool call 顯示在 transcript） |
| 最適場景 | 必要 context（規則、狀態、核心記憶） | 大型資料集查詢（長期記憶庫、搜尋） |

---

## 四、UserPromptSubmit 的已知 Bug

| Issue | 問題 | 狀態 |
|-------|------|------|
| [#13912](https://github.com/anthropics/claude-code/issues/13912) | stdout 輸出導致 "hook error" 顯示 | 已關閉（duplicate） |
| [#17550](https://github.com/anthropics/claude-code/issues/17550) | hookSpecificOutput 第一次 message 報 error | open |
| [#20659](https://github.com/anthropics/claude-code/issues/20659) | plugin hooks 不注入 context（settings.json 的可以） | open |
| [#34713](https://github.com/anthropics/claude-code/issues/34713) | 所有 hook 都顯示 "hook error"（即使成功） | open |
| [#27365](https://github.com/anthropics/claude-code/issues/27365) | Feature request：要 updatedPrompt 支持（修改 prompt） | open |

**關鍵：#27365 確認 UserPromptSubmit 可以 additionalContext 附加 context，但不能修改 prompt 本身。** 對 ccRecall 而言附加 context 已足夠。

---

## 五、業界記憶系統架構參考

| 專案 | 架構 | 注入方式 |
|------|------|---------|
| [claude-mem](https://github.com/thedotmack/claude-mem) | MCP server | 4 個 MCP tools（search → timeline → get_observations），~10x token 節省 |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | Hooks + MCP 並行 | SessionStart hook 注入記憶底 + MCP tools 中途查詢 |
| [memory-mcp](https://github.com/yuvalsuede/memory-mcp) | MCP server | Claude 主動呼叫 MCP tools |
| [mem0](https://mem0.ai/) | MCP server | Chroma 向量 DB + MCP 整合 |

**業界共識：MCP server 為主（最穩定），hooks 為輔（自動化邊界注入）。**

---

## 六、對 ccRecall 架構的影響

### 原始假設驗證結果

| 假設 | 結果 |
|------|------|
| hooks 能注入 context | ✅ 設計上支持，stdout prepend 到 prompt |
| UserPromptSubmit 可用於動態記憶注入 | ⚠️ 可行但有 bug，需等修復或用 workaround |
| MCP 是備用方案 | ❌ **MCP 應該是主要方案**，hooks 是補充 |

### 建議架構（修正後）

```
SessionStart hook ──→ ccRecall 掃描歷史 ──→ 預注入記憶底（穩定）
                          │
UserPromptSubmit hook ──→ ccRecall FTS5 查詢 ──→ prepend <300 tokens（等 bug 修復）
                          │
MCP Server tools ──→ Claude 主動查詢 ──→ 按需取得細節（最穩定）
                          │
PreCompact hook ──→ ccRecall 存檔 ──→ 純寫入，不需注入
Stop hook ──→ ccRecall 最終存檔 ──→ 純寫入，不需注入
```

### 延遲要求

UserPromptSubmit 是 blocking 的，FTS5 查詢必須 <100ms。SQLite 本地查詢應可達成，但需要：
- 索引預建（不在查詢時建）
- 查詢結果快取
- 嚴格限制回傳大小（<300 tokens）

### 三個陷阱需注意

1. **隱藏幻覺**：注入的內容使用者看不到，錯誤記憶會導致 Claude 自信地給錯答案
2. **Token 膨脹**：每次 prompt 都注入，需要嚴格控制注入量
3. **除錯困難**：需要提供機制讓使用者查看注入了什麼（如 /health 端點顯示最近注入）

---

## 七、Sources

| # | Source | URL |
|---|--------|-----|
| 1 | Claude Code Hooks 官方文件 | https://code.claude.com/docs/en/hooks |
| 2 | Issue #13912：UserPromptSubmit stdout error | https://github.com/anthropics/claude-code/issues/13912 |
| 3 | Issue #27365：updatedPrompt feature request | https://github.com/anthropics/claude-code/issues/27365 |
| 4 | Issue #20659：plugin hooks 不注入 context | https://github.com/anthropics/claude-code/issues/20659 |
| 5 | Issue #34713：False hook error labels | https://github.com/anthropics/claude-code/issues/34713 |
| 6 | claude-mem 架構 | https://github.com/thedotmack/claude-mem |
| 7 | mcp-memory-service + Claude Code hooks | https://github.com/doobidoo/mcp-memory-service |
| 8 | Claude Code Hooks 完整指南 | https://smartscope.blog/en/generative-ai/claude/claude-code-hooks-guide/ |
| 9 | Claude Code 架構深度解析 | https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/ |
| 10 | Plugins vs Skills vs MCP 決策指南 | https://skiln.co/blog/claude-code-plugins-vs-skills-vs-mcp-decision-guide |
