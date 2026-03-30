import { describe, expect, it } from 'vitest'
import {
  ChunkType,
  MemoryTier,
  adjustBudget,
  allocate,
  createBudget,
  getBudgetReport,
  type ContextChunk,
  type TokenBudget
} from '../index.js'

const createChunk = (overrides: Partial<ContextChunk> = {}): ContextChunk => ({
  id: overrides.id ?? 'chunk-1',
  content: overrides.content ?? 'default',
  tokens: overrides.tokens ?? 10,
  type: overrides.type ?? ChunkType.OBSERVATION,
  score: overrides.score ?? 0,
  tier: overrides.tier ?? MemoryTier.L1_CACHE,
  createdAt: overrides.createdAt ?? 1_700_000_000_000,
  accessedAt: overrides.accessedAt ?? 1_700_000_000_000,
  accessCount: overrides.accessCount ?? 0,
  ttl: overrides.ttl ?? null,
  metadata: overrides.metadata ?? {}
})

describe('budget manager', () => {
  it('createBudget: 4000 tokens uses default stable/dynamic split', () => {
    const budget = createBudget(4000)

    expect(budget.total).toBe(4000)
    expect(budget.stableZone.systemPrompt + budget.stableZone.userProfile + budget.stableZone.taskDef).toBe(600)
    expect(
      budget.dynamicZone.currentTurn +
        budget.dynamicZone.recentHistory +
        budget.dynamicZone.sessionSummary +
        budget.dynamicZone.toolResults +
        budget.dynamicZone.longTermMemory +
        budget.dynamicZone.sharedContext +
        budget.dynamicZone.reserved
    ).toBe(3400)

    expect(budget.stableZone.systemPrompt).toBe(300)
    expect(budget.stableZone.userProfile).toBe(180)
    expect(budget.stableZone.taskDef).toBe(120)
  })

  it('createBudget: custom percentages work', () => {
    const budget = createBudget(1000, {
      stablePercent: 0.2,
      dynamicPercent: 0.8
    })

    expect(
      budget.stableZone.systemPrompt + budget.stableZone.userProfile + budget.stableZone.taskDef
    ).toBe(200)
    expect(
      budget.dynamicZone.currentTurn +
        budget.dynamicZone.recentHistory +
        budget.dynamicZone.sessionSummary +
        budget.dynamicZone.toolResults +
        budget.dynamicZone.longTermMemory +
        budget.dynamicZone.sharedContext +
        budget.dynamicZone.reserved
    ).toBe(800)
  })

  it('allocate: selects highest-scored chunks within budget', () => {
    const budget: TokenBudget = {
      total: 100,
      stableZone: { systemPrompt: 10, userProfile: 10, taskDef: 10 },
      dynamicZone: {
        currentTurn: 40,
        recentHistory: 10,
        sessionSummary: 10,
        toolResults: 10,
        longTermMemory: 5,
        sharedContext: 5,
        reserved: 0
      }
    }

    const chunks = [
      createChunk({ id: 'a', score: 0.4, tokens: 10 }),
      createChunk({ id: 'b', score: 0.9, tokens: 15 }),
      createChunk({ id: 'c', score: 0.7, tokens: 20 }),
      createChunk({ id: 'd', score: 0.6, tokens: 10 })
    ]

    const selected = allocate(budget, 'currentTurn', chunks)

    expect(selected.map((chunk) => chunk.id)).toEqual(['b', 'c'])
    expect(selected.reduce((sum, chunk) => sum + chunk.tokens, 0)).toBeLessThanOrEqual(40)
  })

  it("allocate: stops when budget exhausted (doesn't overflow)", () => {
    const budget: TokenBudget = {
      total: 50,
      stableZone: { systemPrompt: 5, userProfile: 5, taskDef: 5 },
      dynamicZone: {
        currentTurn: 15,
        recentHistory: 10,
        sessionSummary: 5,
        toolResults: 3,
        longTermMemory: 1,
        sharedContext: 1,
        reserved: 0
      }
    }

    const chunks = [
      createChunk({ id: 'x', score: 0.95, tokens: 11 }),
      createChunk({ id: 'y', score: 0.9, tokens: 10 }),
      createChunk({ id: 'z', score: 0.8, tokens: 6 })
    ]

    const selected = allocate(budget, 'currentTurn', chunks)

    expect(selected.map((chunk) => chunk.id)).toEqual(['x'])
    expect(selected.reduce((sum, chunk) => sum + chunk.tokens, 0)).toBe(11)
  })

  it('allocate: empty chunks returns empty result', () => {
    const budget = createBudget(1000)
    expect(allocate(budget, 'currentTurn', [])).toEqual([])
  })

  it('getBudgetReport: calculates utilization correctly', () => {
    const budget = createBudget(1000)
    const report = getBudgetReport(budget, {
      systemPrompt: 50,
      userProfile: 20,
      taskDef: 10,
      currentTurn: 100,
      recentHistory: 50
    })

    expect(report.total.allocated).toBe(1000)
    expect(report.total.used).toBe(230)
    expect(report.total.remaining).toBe(770)
    expect(report.total.utilization).toBeCloseTo(0.23, 6)
  })

  it('getBudgetReport: flags over-budget categories', () => {
    const budget = createBudget(1000)
    const report = getBudgetReport(budget, {
      systemPrompt: 1000,
      currentTurn: 1000
    })

    expect(report.overBudget).toContain('systemPrompt')
    expect(report.overBudget).toContain('currentTurn')
  })

  it('adjustBudget: override stable percent', () => {
    const original = createBudget(1000)
    const adjusted = adjustBudget(original, {
      stablePercent: 0.25,
      dynamicPercent: 0.75
    })

    expect(
      adjusted.stableZone.systemPrompt + adjusted.stableZone.userProfile + adjusted.stableZone.taskDef
    ).toBe(250)
    expect(
      adjusted.dynamicZone.currentTurn +
        adjusted.dynamicZone.recentHistory +
        adjusted.dynamicZone.sessionSummary +
        adjusted.dynamicZone.toolResults +
        adjusted.dynamicZone.longTermMemory +
        adjusted.dynamicZone.sharedContext +
        adjusted.dynamicZone.reserved
    ).toBe(750)
  })

  it('adjustBudget: validates total = 100%', () => {
    const budget = createBudget(1000)

    expect(() =>
      adjustBudget(budget, {
        stablePercent: 0.3,
        dynamicPercent: 0.6
      })
    ).toThrowError('Stable and dynamic percentages must total 1.0')
  })

  it('edge: budget = 0 produces all zeros', () => {
    const budget = createBudget(0)

    expect(budget.total).toBe(0)
    expect(budget.stableZone.systemPrompt).toBe(0)
    expect(budget.stableZone.userProfile).toBe(0)
    expect(budget.stableZone.taskDef).toBe(0)
    expect(budget.dynamicZone.currentTurn).toBe(0)
    expect(budget.dynamicZone.reserved).toBe(0)
  })

  it('edge: very small budget (100 tokens)', () => {
    const budget = createBudget(100)

    expect(budget.total).toBe(100)
    expect(
      budget.stableZone.systemPrompt + budget.stableZone.userProfile + budget.stableZone.taskDef
    ).toBe(15)
    expect(
      budget.dynamicZone.currentTurn +
        budget.dynamicZone.recentHistory +
        budget.dynamicZone.sessionSummary +
        budget.dynamicZone.toolResults +
        budget.dynamicZone.longTermMemory +
        budget.dynamicZone.sharedContext +
        budget.dynamicZone.reserved
    ).toBe(85)
  })
})
