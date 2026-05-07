// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { scoreKnowledgeBearing, KNOWLEDGE_THRESHOLD } from '../src/core/outcome-scorer'

describe('scoreKnowledgeBearing — noise short-circuit', () => {
  it('flags pure short ack tokens (CJK)', () => {
    expect(scoreKnowledgeBearing('完成').reasons).toEqual(['noise'])
    expect(scoreKnowledgeBearing('搞定。').reasons).toEqual(['noise'])
    expect(scoreKnowledgeBearing('好的').reasons).toEqual(['noise'])
  })

  it('flags pure short ack tokens (EN)', () => {
    expect(scoreKnowledgeBearing('done').reasons).toEqual(['noise'])
    expect(scoreKnowledgeBearing('Done.').reasons).toEqual(['noise'])
    expect(scoreKnowledgeBearing('OK').reasons).toEqual(['noise'])
  })

  it('does NOT flag long substantive text starting with "done"', () => {
    const text = 'done — but the migration left orphan rows we need to backfill before cutover'
    const result = scoreKnowledgeBearing(text)
    expect(result.reasons).not.toContain('noise')
  })

  it('does NOT flag short text that is not in the noise vocabulary', () => {
    expect(scoreKnowledgeBearing('我們改用 SQLite').reasons).not.toContain('noise')
  })
})

describe('scoreKnowledgeBearing — process-report short-circuit', () => {
  // dogfood corpus 實證：39 筆 v=2 committed/tested sessions 全部 sub-threshold,
  // last substantial assistant 抓到 save-t 收尾報告 (process-report) 而非真實 outcome。
  // 短路設計：開頭符合 save-t 樣式 → score 0，避免下游 scorer pattern 偶然湊分。
  it('flags save-t completion reports (CJK heading)', () => {
    expect(scoreKnowledgeBearing('## save-t 完成 ✓\n\n寫入摘要表格...').reasons).toEqual(['process-report'])
    expect(scoreKnowledgeBearing('Save-T 完成。\n\n## 輸出摘要').reasons).toEqual(['process-report'])
    expect(scoreKnowledgeBearing('Save-t 流程完整。').reasons).toEqual(['process-report'])
  })

  it('flags save-t completion reports with emoji prefix', () => {
    expect(scoreKnowledgeBearing('# 💾 Save-T 完成\n\n## 已更新檔案').reasons).toEqual(['process-report'])
  })

  it('flags save-t completion reports (EN)', () => {
    expect(scoreKnowledgeBearing('## Save-T done\n\nupdated files...').reasons).toEqual(['process-report'])
    expect(scoreKnowledgeBearing('Save-t finished. Updated 3 files.').reasons).toEqual(['process-report'])
  })

  it('flags slash-command save-t headings (Codex M1)', () => {
    // /save-t is the documented skill name — assistant may echo it verbatim
    expect(scoreKnowledgeBearing('## /save-t 完成 ✓\n\n寫入摘要').reasons).toEqual(['process-report'])
    expect(scoreKnowledgeBearing('/save-t finished. 3 files updated.').reasons).toEqual(['process-report'])
  })

  it('flags colon-separated save-t reports (Codex M1)', () => {
    expect(scoreKnowledgeBearing('Save-T: done\n\nupdated 3 files').reasons).toEqual(['process-report'])
    expect(scoreKnowledgeBearing('save-t：完成\n\n摘要表格').reasons).toEqual(['process-report'])
  })

  it('does NOT misfire on save-t with non-completion follow-up (Codex L1)', () => {
    // Bare 流程 was too broad — must be 流程完整, not 流程不完整 / 流程 root cause
    expect(scoreKnowledgeBearing('Save-t 流程不完整,還缺 RESUME.md').reasons).not.toContain('process-report')
    expect(scoreKnowledgeBearing('Save-t 流程 root cause: WAL truncate').reasons).not.toContain('process-report')
  })

  it('does NOT flag mid-text save-t mentions', () => {
    const text = 'After we ran save-t, the tests passed. Root cause: src/auth.ts:42.'
    expect(scoreKnowledgeBearing(text).reasons).not.toContain('process-report')
  })

  it('does NOT flag unrelated "save" verbs', () => {
    expect(scoreKnowledgeBearing('we save the result to disk').reasons).not.toContain('process-report')
    expect(scoreKnowledgeBearing('auto-save token expired').reasons).not.toContain('process-report')
  })

  it('skips process-report check on oversized input (security: prevent regex scan on megabyte text)', () => {
    // Length gate: inputs >5KB cannot be a save-t report (always short headers)
    const oversized = '## save-t 完成\n\n' + 'x'.repeat(6000)
    const result = scoreKnowledgeBearing(oversized)
    expect(result.reasons).not.toContain('process-report')
  })

  it('flags CJK verb-form 存檔完成 openers (#27)', () => {
    // 3 corroborating samples from v0.3.0 first-week dogfood (journal id=2/6/8)
    expect(scoreKnowledgeBearing('存檔完成 — 雙寫同步、diff 為空。').reasons).toEqual(['process-report'])
    expect(scoreKnowledgeBearing('存檔完成,可以安全 `/compact` 或結束 session。').reasons).toEqual(['process-report'])
    expect(scoreKnowledgeBearing('存檔完成。\n\n## 更新摘要').reasons).toEqual(['process-report'])
  })

  it('does NOT flag mid-sentence 存檔完成 mentions (#27 false-positive guard)', () => {
    // Trailing punctuation requirement keeps narrow — verb form embedded in real outcome text must pass through
    expect(scoreKnowledgeBearing('今天我把檔案存檔完成,然後修了 src/auth.ts:42 的 bug').reasons).not.toContain('process-report')
    expect(scoreKnowledgeBearing('用戶要求存檔完成後再 push').reasons).not.toContain('process-report')
  })
})

describe('scoreKnowledgeBearing — decision-language', () => {
  it('hits CJK decision verbs', () => {
    expect(scoreKnowledgeBearing('我們決定改用 SQLite 而非 LMDB').reasons).toContain('decision-language')
    expect(scoreKnowledgeBearing('拍板採用 OIDC trusted publishing').reasons).toContain('decision-language')
  })

  it('hits EN decision verbs', () => {
    expect(scoreKnowledgeBearing('We decided to drop the cache layer').reasons).toContain('decision-language')
    expect(scoreKnowledgeBearing('I chose Option B for migration').reasons).toContain('decision-language')
  })
})

describe('scoreKnowledgeBearing — impl-facts', () => {
  it('hits file:line references', () => {
    expect(scoreKnowledgeBearing('see src/core/database.ts:1552 for the dedup').reasons).toContain('impl-facts')
  })

  it('hits commit hash references', () => {
    expect(scoreKnowledgeBearing('shipped in commit a845338').reasons).toContain('impl-facts')
  })

  it('hits "wrote/added X.ts" patterns', () => {
    expect(scoreKnowledgeBearing('Added src/core/outcome-extractor.ts').reasons).toContain('impl-facts')
  })
})

describe('scoreKnowledgeBearing — constraints', () => {
  it('hits CJK constraint verbs', () => {
    expect(scoreKnowledgeBearing('絕不允許 mock DB').reasons).toContain('constraints')
    expect(scoreKnowledgeBearing('必須走 OIDC,不可用 token').reasons).toContain('constraints')
  })

  it('hits EN invariants', () => {
    expect(scoreKnowledgeBearing('Must not commit .env files').reasons).toContain('constraints')
    expect(scoreKnowledgeBearing('Never bypass --no-verify').reasons).toContain('constraints')
  })
})

describe('scoreKnowledgeBearing — cause-effect', () => {
  it('hits CJK because/root-cause', () => {
    expect(scoreKnowledgeBearing('根本原因是 epoch ms 套 TEXT 欄位').reasons).toContain('cause-effect')
    expect(scoreKnowledgeBearing('因為 ranking 在短文本不穩').reasons).toContain('cause-effect')
  })

  it('hits EN root cause', () => {
    expect(scoreKnowledgeBearing('Root cause: WAL never truncates').reasons).toContain('cause-effect')
    expect(scoreKnowledgeBearing('failed because the FK was broken').reasons).toContain('cause-effect')
  })
})

describe('scoreKnowledgeBearing — validation', () => {
  it('hits CJK 驗證 / 測試 patterns', () => {
    expect(scoreKnowledgeBearing('已驗證通過,/health 回 ok').reasons).toContain('validation')
    expect(scoreKnowledgeBearing('測試完成,沒問題').reasons).toContain('validation')
  })

  it('hits EN test count + verified phrases', () => {
    expect(scoreKnowledgeBearing('495/495 tests pass').reasons).toContain('validation')
    expect(scoreKnowledgeBearing('all tests pass after rebase').reasons).toContain('validation')
    expect(scoreKnowledgeBearing('Verified: WAL stays at 0 bytes').reasons).toContain('validation')
  })
})

describe('scoreKnowledgeBearing — threshold + accumulation', () => {
  it('exposes threshold constant >= 2', () => {
    expect(KNOWLEDGE_THRESHOLD).toBe(2)
  })

  it('returns score 0 for plain narrative (no signals)', () => {
    const text = 'I read three files and looked at the schema migration history.'
    const result = scoreKnowledgeBearing(text)
    expect(result.score).toBe(0)
    expect(result.reasons).toEqual([])
  })

  it('accumulates score across multiple categories', () => {
    const text =
      'We decided to use SQLite. Root cause of the previous failure: WAL never truncates. ' +
      'Verified: 495/495 tests pass after the change to src/core/database.ts:1552.'
    const result = scoreKnowledgeBearing(text)
    expect(result.score).toBeGreaterThanOrEqual(KNOWLEDGE_THRESHOLD)
    expect(result.reasons).toContain('decision-language')
    expect(result.reasons).toContain('cause-effect')
    expect(result.reasons).toContain('validation')
    expect(result.reasons).toContain('impl-facts')
  })

  it('scores 1 when only a single category fires (sub-threshold)', () => {
    const text = '因為這個原因我們才停下來想一下下一步該怎麼走。'
    const result = scoreKnowledgeBearing(text)
    expect(result.score).toBe(1)
    expect(result.reasons).toEqual(['cause-effect'])
  })

  it('reasons stay unique per category (no double-fire from same category)', () => {
    const text = '我們決定 + 拍板 + we decided + I chose all in one paragraph'
    const result = scoreKnowledgeBearing(text)
    const uniq = new Set(result.reasons)
    expect(uniq.size).toBe(result.reasons.length)
  })
})
