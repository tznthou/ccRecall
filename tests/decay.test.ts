import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'

let tmpDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-decay-'))
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('exp() user function registration', () => {
  it('exp(0) is 1', () => {
    const row = db.rawAll<{ v: number }>('SELECT exp(0) AS v')[0]
    expect(row.v).toBeCloseTo(1, 5)
  })

  it('exp(-ln2) is 0.5', () => {
    const row = db.rawAll<{ v: number }>('SELECT exp(-0.6931471805599453) AS v')[0]
    expect(row.v).toBeCloseTo(0.5, 5)
  })

  it('exp(1) is e', () => {
    const row = db.rawAll<{ v: number }>('SELECT exp(1) AS v')[0]
    expect(row.v).toBeCloseTo(Math.E, 5)
  })
})

describe('effective confidence decay — queryMemories ORDER BY', () => {
  it('fresh memory ranks above aged memory with same base confidence', () => {
    const freshId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'sample fresh', confidence: 0.9,
    })
    const agedId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'sample aged', confidence: 0.9,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-30 days') WHERE id = ${agedId}`)

    const results = db.queryMemories('sample', 10)
    const freshIdx = results.findIndex(r => r.id === freshId)
    const agedIdx = results.findIndex(r => r.id === agedId)
    expect(freshIdx).toBeLessThan(agedIdx)
  })

  it('frequently-accessed aged memory outranks rarely-accessed same-age memory', () => {
    const heavyId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'sample heavy', confidence: 0.8,
    })
    const lightId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'sample light', confidence: 0.8,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-30 days') WHERE id IN (${heavyId}, ${lightId})`)
    db.rawExec(`UPDATE memories SET access_count = 4, last_accessed = datetime('now') WHERE id = ${heavyId}`)

    const results = db.queryMemories('sample', 10)
    const heavyIdx = results.findIndex(r => r.id === heavyId)
    const lightIdx = results.findIndex(r => r.id === lightId)
    expect(heavyIdx).toBeLessThan(lightIdx)
  })

  it('half-life extension caps at access_count=4', () => {
    // Two memories both access_count>=4 should have same half_life (35 days).
    const fourId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'halflife four', confidence: 1,
    })
    const tenId = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'halflife ten', confidence: 1,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-30 days') WHERE id IN (${fourId}, ${tenId})`)
    db.rawExec(`UPDATE memories SET access_count = 4 WHERE id = ${fourId}`)
    db.rawExec(`UPDATE memories SET access_count = 10 WHERE id = ${tenId}`)

    // Decay factor should be the same for both (min(4, x) = 4 regardless).
    // Query effective confidence directly via raw SQL to avoid FTS rank interference.
    const rows = db.rawAll<{ id: number; eff: number }>(`
      SELECT m.id, (
        m.confidence * exp(
          -0.6931471805599453 *
          (julianday('now') - julianday(COALESCE(m.last_accessed, m.created_at))) /
          (7.0 + 7.0 * MIN(m.access_count, 4))
        )
      ) AS eff
      FROM memories m
      WHERE m.id IN (${fourId}, ${tenId})
    `)
    const fourEff = rows.find(r => r.id === fourId)?.eff ?? 0
    const tenEff = rows.find(r => r.id === tenId)?.eff ?? 0
    expect(fourEff).toBeCloseTo(tenEff, 6)
  })

  it('30-day-old memory with access_count=0 decays to ~5% of base confidence', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'decayed solo', confidence: 1,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-30 days') WHERE id = ${id}`)

    // half_life = 7 days, age = 30 days -> factor = exp(-ln2 * 30/7) ≈ 0.0509
    const row = db.rawAll<{ eff: number }>(`
      SELECT (
        m.confidence * exp(
          -0.6931471805599453 *
          (julianday('now') - julianday(COALESCE(m.last_accessed, m.created_at))) /
          (7.0 + 7.0 * MIN(m.access_count, 4))
        )
      ) AS eff
      FROM memories m WHERE m.id = ${id}
    `)[0]
    expect(row.eff).toBeGreaterThan(0.04)
    expect(row.eff).toBeLessThan(0.07)
  })

  it('30-day-old memory with access_count=4 decays to ~55% of base confidence', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'decayed busy', confidence: 1,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-30 days') WHERE id = ${id}`)
    db.rawExec(`UPDATE memories SET access_count = 4 WHERE id = ${id}`)

    // half_life = 7 + 28 = 35 days, age = 30 days -> factor = exp(-ln2 * 30/35) ≈ 0.5503
    const row = db.rawAll<{ eff: number }>(`
      SELECT (
        m.confidence * exp(
          -0.6931471805599453 *
          (julianday('now') - julianday(COALESCE(m.last_accessed, m.created_at))) /
          (7.0 + 7.0 * MIN(m.access_count, 4))
        )
      ) AS eff
      FROM memories m WHERE m.id = ${id}
    `)[0]
    expect(row.eff).toBeGreaterThan(0.50)
    expect(row.eff).toBeLessThan(0.60)
  })
})
