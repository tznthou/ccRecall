// SPDX-License-Identifier: Apache-2.0
//
// Guards the post-session-extract wrapper's second stdout marker (#75).
//
// Background: Haiku sometimes prints `recall_save(...)` as text instead of
// invoking the MCP tool. The run then exits 0 with an empty stderr and zero
// writes — indistinguishable in telemetry from a session that genuinely had
// nothing worth saving. This marker makes that failure mode visible.
//
// The pattern is extracted from the wrapper source rather than duplicated here,
// so the test cannot silently drift away from what actually ships.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')

/** Pull the live grep pattern out of the wrapper so there is one source of truth. */
async function extractPattern(): Promise<string> {
  const src = await readFile(WRAPPER, 'utf8')
  const m = src.match(/recall_save_text_count=\$\(grep -cE '([^']+)'/)
  if (!m) throw new Error('recall_save text-shape grep not found in wrapper')
  return m[1]
}

/** Run the real grep the wrapper runs, returning the count it would record. */
function countMatches(pattern: string, file: string): number {
  try {
    const out = execFileSync('grep', ['-cE', pattern, file], { encoding: 'utf8' })
    return Number(out.trim())
  } catch {
    // grep exits 1 on no match — the wrapper normalises that to 0.
    return 0
  }
}

describe('extract wrapper: recall_save text-shape marker (#75)', () => {
  let dir: string
  let pattern: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-marker-'))
    pattern = await extractPattern()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function fixture(name: string, body: string): Promise<string> {
    const p = path.join(dir, name)
    await writeFile(p, body, 'utf8')
    return p
  }

  describe('true positives — the shapes that mean a silent miss', () => {
    it('matches the exact shape captured from the reproduced failure', async () => {
      // Verbatim structure of the 2026-07-27 replay capture, values redacted.
      const f = await fixture(
        'repro.txt',
        '```\nrecall_save(\n  { "key": "a", "content": "x" },\n  { "key": "b", "content": "y" }\n)\n```\n',
      )
      expect(countMatches(pattern, f)).toBe(1)
    })

    it('matches when indented inside a code fence', async () => {
      const f = await fixture('indented.txt', '```\n    recall_save(\n      {}\n    )\n```\n')
      expect(countMatches(pattern, f)).toBe(1)
    })

    it('matches with whitespace between name and paren', async () => {
      const f = await fixture('spaced.txt', 'recall_save (\n  {}\n)\n')
      expect(countMatches(pattern, f)).toBe(1)
    })

    it('counts each printed call separately', async () => {
      const f = await fixture(
        'multi.txt',
        'recall_save(\n  {}\n)\nrecall_save(\n  {}\n)\nrecall_save(\n  {}\n)\n',
      )
      expect(countMatches(pattern, f)).toBe(3)
    })
  })

  describe('true negatives — prose that merely mentions the tool', () => {
    it('does not match a mid-sentence mention', async () => {
      const f = await fixture(
        'prose.txt',
        'I used the recall_save tool to store two memories.\nThe recall_save( call above is only an example.\n',
      )
      expect(countMatches(pattern, f)).toBe(0)
    })

    it('does not match the tool name without a call', async () => {
      const f = await fixture('name-only.txt', 'recall_save\nrecall_save is an MCP tool.\n')
      expect(countMatches(pattern, f)).toBe(0)
    })

    it('does not match a different tool with a similar suffix', async () => {
      const f = await fixture('other-tool.txt', 'my_recall_save(\n)\nnot_recall_save(\n)\n')
      expect(countMatches(pattern, f)).toBe(0)
    })

    it('returns 0 for the empty stdout of a healthy run', async () => {
      const f = await fixture('healthy.txt', '')
      expect(countMatches(pattern, f)).toBe(0)
    })
  })

  describe('safety — the marker must never carry session content', () => {
    it('grep -c emits only a count, never the matched line', async () => {
      const secret = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      const f = await fixture('secret.txt', `recall_save(\n  { "content": "${secret}" }\n)\n`)
      const out = execFileSync('grep', ['-cE', pattern, f], { encoding: 'utf8' })
      expect(out.trim()).toBe('1')
      expect(out).not.toContain(secret)
      expect(out).not.toContain('content')
    })
  })

  describe('telemetry row', () => {
    it('wrapper declares recallSaveTextCount as a number in the JSONL row', async () => {
      const src = await readFile(WRAPPER, 'utf8')
      // --argjson (not --arg) keeps it a JSON number, so jq/SQL can compare it.
      expect(src).toMatch(/--argjson\s+textSaves\s+"\$recall_save_text_count"/)
      expect(src).toMatch(/recallSaveTextCount:\$textSaves/)
    })

    it('count is normalised to a bare integer before it reaches jq', async () => {
      // grep -c on a missing/empty file, or a no-match exit 1, must not leak a
      // non-numeric value into --argjson (which would abort the telemetry write).
      const src = await readFile(WRAPPER, 'utf8')
      expect(src).toMatch(/\[\[ "\$recall_save_text_count" =~ \^\[0-9\]\+\$ \]\] \|\| recall_save_text_count=0/)
    })
  })
})
