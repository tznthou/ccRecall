// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { isHarvestNoise } from '../src/core/harvester-filter'

describe('isHarvestNoise — slash commands', () => {
  it('flags bare /clear, /model, /compact, /save-t', () => {
    expect(isHarvestNoise('/clear', 's')).toBe(true)
    expect(isHarvestNoise('/model', 's')).toBe(true)
    expect(isHarvestNoise('/compact', 's')).toBe(true)
    expect(isHarvestNoise('/save-t', 's')).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isHarvestNoise('  /clear  ', 's')).toBe(true)
  })

  it('does NOT flag slash command followed by real text', () => {
    expect(isHarvestNoise('/clear and start fresh on auth', 's')).toBe(false)
  })
})

describe('isHarvestNoise — progress shells', () => {
  it('flags pure progress queries', () => {
    expect(isHarvestNoise('確認一下我們的進度', 's')).toBe(true)
    expect(isHarvestNoise('確認我們現在的進度', 's')).toBe(true)
    expect(isHarvestNoise('繼續我們的進度', 's')).toBe(true)
    expect(isHarvestNoise('看一下進度', 's')).toBe(true)
    expect(isHarvestNoise('我們這個專案現在的進度如何?', 's')).toBe(true)
    expect(isHarvestNoise('進度如何?', 's')).toBe(true)
  })

  it('does NOT flag progress query carrying a concrete technical question', () => {
    // 真實 case：id 13 的「進度 + ccRecall MCP 容量具體問句」應該被保留
    const intent = '確認一下工作進度,以及目前我們在CCRecall的MCP裡面,現在存了多少筆記憶,容量又是多少?'
    expect(isHarvestNoise(intent, 's')).toBe(false)
  })
})

describe('isHarvestNoise — reflections', () => {
  it('flags pure speculative reflection (我們剛是不是 ...)', () => {
    expect(isHarvestNoise('我們剛是不是討論到要測試 pi-plan', 's')).toBe(true)
  })

  it('does NOT flag concrete inquiry opening with weak reflection prefix', () => {
    // 真實 case：id 86「我們剛剛 github 沒有發 tag ？」是具體 issue 詢問，
    // 帶具名技術詞（github、tag），不該被當對話流回顧丟掉
    expect(isHarvestNoise('我們剛剛 github 沒有發 tag ？', 's')).toBe(false)
    expect(isHarvestNoise('我剛剛說錯了', 's')).toBe(false)
    expect(isHarvestNoise('你剛說的那個', 's')).toBe(false)
  })

  it('reflection prefix wins even for long text', () => {
    // 推測式反思即使長度過 short-text cap 也應視為噪音
    const long = '我們剛是不是討論到要測試 pi-plan，但好像 hook 那邊沒接好，然後就跳到別的話題了'
    expect(isHarvestNoise(long, 's')).toBe(true)
  })
})

describe('isHarvestNoise — fallbacks and edges', () => {
  it('uses summary head when intent is null', () => {
    // summary 形如 "繼續我們的進度 | Edit×33, Write×4 ..."
    expect(isHarvestNoise(null, '繼續我們的進度 | Edit×33, Write×4, Bash×83, 15 files')).toBe(true)
  })

  it('does not flag ordinary technical prompts', () => {
    expect(isHarvestNoise('幫我查一下 Renovate 跟 Dependabot 差在哪', 's')).toBe(false)
    expect(isHarvestNoise('Apache-2.0 license 適合 ccRecall 嗎', 's')).toBe(false)
    expect(isHarvestNoise('FTS5 trigram tokenizer 怎麼處理 CJK', 's')).toBe(false)
  })

  it('does not flag empty intent + empty summary', () => {
    expect(isHarvestNoise(null, '')).toBe(false)
    expect(isHarvestNoise('', '')).toBe(false)
  })

  it('does not flag a long prompt that happens to contain noise pattern mid-text', () => {
    // 起始錨點 ^ 確保 noise pattern 必須出現在開頭，避免誤殺
    expect(isHarvestNoise('解釋一下 /clear 指令做什麼', 's')).toBe(false)
  })
})
