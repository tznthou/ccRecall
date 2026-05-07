// SPDX-License-Identifier: Apache-2.0

// 對 assistant text 做 knowledge-bearing scoring。設計意圖(Codex)：require either one
// strong structural signal or multiple weak semantic signals — categories 多樣性才能體現
// asymmetry,砍 categories 等於退化為 boolean × N。
//
// 5 categories(decision-language / impl-facts / constraints / cause-effect / validation),
// 每類起手 1-3 個 high-signal patterns(保守先發);threshold >= 2 hardcoded。
// 每類的 patterns 數量會在 commit 1 corpus(線上 89 筆 + 10 outcome session)實測後決定擴增,
// 避免上線一發就靠拍腦袋。
//
// 內部 noise short-circuit:assistant 端短 ack token(done / 完成 / ok)單獨命中時直接歸 0,
// 避免被下面的 weak-signal 累計湊到 threshold。Pattern 採 anchored-only 設計,長文本不誤殺。

const NOISE_MAX_LEN = 50
// Process-report headers are short (save-t reports are <2KB in practice).
// Length gate prevents regex linear-scan on megabyte-scale assistant text.
const PROCESS_REPORT_MAX_LEN = 5000

const NOISE_RES: ReadonlyArray<RegExp> = [
  /^\s*(?:done|完成|處理好了|實作好了|搞定|fixed|implemented|ok|okay)\s*[.!。!]*\s*$/i,
  /^\s*(?:對|不對|是的|沒錯|好的|yes|no|yep|nope)\s*[.!。!]*\s*$/i,
]

// dogfood corpus 實證(2026-05-06): 39 筆 v=2 committed/tested sessions 全部 sub-threshold,
// 因為 last substantial assistant 抓到 save-t 收尾報告(process meta)而非真實 outcome。
// Anchor 在開頭(^),長文本 mid-text 提及 save-t 不誤殺。
const PROCESS_REPORT_RES: ReadonlyArray<RegExp> = [
  /^[#\s💾🟢✅_*-]*\/?save[\s-]?t(?:\s*[:：]\s*|\s+)(?:完成|流程完整|完整|done|finished|completed?)/iu,
  // #27: save-t skill output may open with CJK verb form 「存檔完成」 instead of /save-t literal.
  // Lookahead requires save-t process-report signal within 80 chars OR 「## 更新摘要/清單」 heading,
  // narrow enough to let real outcome openers (e.g. 「存檔完成,但 root cause 是 ...」) pass through.
  /^[#\s💾🟢✅_*-]*存檔完成\s*[—,，.。:：!！](?=(?:[^\n]{0,80}(?:\/compact|結束 session|雙寫同步)|\s*\n\s*##\s*(?:更新摘要|更新清單)))/u,
]

interface SignalCategory {
  readonly name: string
  readonly patterns: ReadonlyArray<RegExp>
}

const DECISION_LANGUAGE: SignalCategory = {
  name: 'decision-language',
  patterns: [
    /(?:我們|本案)?(?:決議|決定|拍板|定案)/,
    /\b(?:we|i)\s+(?:decided|chose|opted)\b/i,
    /(?:採|改|換)成\b/,
  ],
}

const IMPL_FACTS: SignalCategory = {
  name: 'impl-facts',
  patterns: [
    /[`\w./_-]+\.(?:tsx|ts|jsx|js|py|go|rs|sql|md):\d+/,
    /\b(?:added|created|wrote|implemented)\s+[`\w./_-]+\.(?:tsx|ts|jsx|js|py|go|rs|sql|md)\b/i,
    /\bcommit\s+[a-f0-9]{6,}\b/i,
  ],
}

const CONSTRAINTS: SignalCategory = {
  name: 'constraints',
  patterns: [
    /(?:不可|禁止|必須|絕不|不能)\S/,
    /\b(?:must not|never|cannot|forbidden|invariant)\b/i,
  ],
}

const CAUSE_EFFECT: SignalCategory = {
  name: 'cause-effect',
  patterns: [
    /(?:因為|是因為|根本原因|root cause|原因是)/,
    /\b(?:because|due to|root cause|caused by)\b/i,
  ],
}

const VALIDATION: SignalCategory = {
  name: 'validation',
  patterns: [
    /\d+\/\d+\s+(?:tests?|綠|passing|pass)/i,
    /\b(?:verified|all tests pass|all green)\b/i,
    /(?:驗證(?:過|完|通過)|測試(?:過|完|通過|綠))/,
  ],
}

const ALL_CATEGORIES: ReadonlyArray<SignalCategory> = [
  DECISION_LANGUAGE,
  IMPL_FACTS,
  CONSTRAINTS,
  CAUSE_EFFECT,
  VALIDATION,
]

export const KNOWLEDGE_THRESHOLD = 2

export interface ScoreResult {
  score: number
  reasons: string[]
}

export function scoreKnowledgeBearing(text: string): ScoreResult {
  const trimmed = text.trim()
  if (isAssistantNoise(trimmed)) return { score: 0, reasons: ['noise'] }
  if (isProcessReport(trimmed)) return { score: 0, reasons: ['process-report'] }

  const reasons: string[] = []
  let score = 0
  for (const cat of ALL_CATEGORIES) {
    if (cat.patterns.some(p => p.test(trimmed))) {
      score++
      reasons.push(cat.name)
    }
  }
  return { score, reasons }
}

function isAssistantNoise(text: string): boolean {
  if (text.length > NOISE_MAX_LEN) return false
  return NOISE_RES.some(p => p.test(text))
}

export function isProcessReport(text: string): boolean {
  if (text.length > PROCESS_REPORT_MAX_LEN) return false
  return PROCESS_REPORT_RES.some(p => p.test(text))
}
