// SPDX-License-Identifier: Apache-2.0

// Hook auto-harvest 在 session end 把 first user prompt 當記憶寫入；其中一大類是
// 對話操控指令、進度查詢殼、自我反思——這些 prompts 不是知識，再次 recall 也沒用，
// 反而稀釋 facet（top topic 命中率超過 80% 的根因之一）。此檔集中存放 noise pattern，
// 由 buildMemoryFromSession 在組記憶體前判斷並 skip。

const SHORT_NOISE_LEN = 30

const SLASH_COMMAND_RE = /^\s*\/[a-zA-Z][\w-]*\s*$/

// 反思開頭：assistant 視角的對話流回顧，不限長度都該擋
const REFLECTION_RES: ReadonlyArray<RegExp> = [
  /^我們剛(剛|是不是)?/,
  /^(我|你)剛剛?/,
]

// 進度查詢殼用 vocabulary-only 檢測比 alternation 穩——任何超出 vocab 的字元
// （API name、metric、技術名詞）都會讓字串不全 match，自動保留具體 audit query
const PROGRESS_VOCAB_RE = /^[\s我們這個專案目前現在的工作進度如何怎樣看一下繼續確認更新?？!！。.,，]+$/

export function isHarvestNoise(intent: string | null, summary: string): boolean {
  const probe = pickProbeText(intent, summary)
  if (!probe) return false
  if (REFLECTION_RES.some(p => p.test(probe))) return true
  if (probe.length > SHORT_NOISE_LEN) return false
  if (SLASH_COMMAND_RE.test(probe)) return true
  if (isProgressShell(probe)) return true
  return false
}

function isProgressShell(text: string): boolean {
  if (!text.includes('進度')) return false
  return PROGRESS_VOCAB_RE.test(text)
}

function pickProbeText(intent: string | null, summary: string): string {
  const t = intent?.trim()
  if (t) return t
  // summary 形如 "繼續我們的進度 | Edit×33, Write×4, Bash×83, 15 files"
  // 取第一個 `|` 前的 segment 作為 prompt 探針
  return summary.split('|', 1)[0].trim()
}
