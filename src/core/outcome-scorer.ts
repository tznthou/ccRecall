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
// 內部 noise short-circuit 取代獨立 isAssistantNoise 檔——避免 routes 層 isHarvestNoise 跟
// 此處 noise filter 邏輯重疊。Pattern 仿 harvester-filter.ts(先中後英、明確 anchor)。

const NOISE_MAX_LEN = 50

const NOISE_RES: ReadonlyArray<RegExp> = [
  /^\s*(?:done|完成|處理好了|實作好了|搞定|fixed|implemented|ok|okay)\s*[.!。!]*\s*$/i,
  /^\s*(?:對|不對|是的|沒錯|好的|yes|no|yep|nope)\s*[.!。!]*\s*$/i,
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
    /[`\w./_-]+\.(?:ts|tsx|js|jsx|py|go|rs|sql|md):\d+/,
    /\b(?:added|created|wrote|implemented)\s+[`\w./_-]+\.(?:ts|tsx|js|py|go|rs)/i,
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
