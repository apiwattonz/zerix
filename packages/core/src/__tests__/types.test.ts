import { describe, expect, it } from 'vitest'
import {
  ChunkType,
  MemoryTier,
  type ContextChunk,
  type TokenBudget,
  DEFAULT_SCORING_WEIGHTS,
  calculateImportanceScore,
  type BuildResult
} from '../index.js'

describe('core types and enums', () => {
  it('has expected ChunkType enum values', () => {
    expect(ChunkType.USER_CONSTRAINT).toBe('USER_CONSTRAINT')
    expect(ChunkType.DECISION).toBe('DECISION')
    expect(ChunkType.ERROR_CORRECTION).toBe('ERROR_CORRECTION')
    expect(ChunkType.FACT).toBe('FACT')
    expect(ChunkType.TOOL_RESULT).toBe('TOOL_RESULT')
    expect(ChunkType.REASONING_STEP).toBe('REASONING_STEP')
    expect(ChunkType.OBSERVATION).toBe('OBSERVATION')
  })

  it('has expected MemoryTier enum values', () => {
    expect(MemoryTier.L0_REGISTER).toBe('L0_REGISTER')
    expect(MemoryTier.L1_CACHE).toBe('L1_CACHE')
    expect(MemoryTier.L2_RAM).toBe('L2_RAM')
    expect(MemoryTier.L3_SSD).toBe('L3_SSD')
    expect(MemoryTier.L4_ARCHIVE).toBe('L4_ARCHIVE')
  })

  it('creates a valid ContextChunk and validates key fields', () => {
    const chunk: ContextChunk = {
      id: 'chunk-1',
      content: 'User prefers concise answers.',
      tokens: 5,
      type: ChunkType.USER_CONSTRAINT,
      score: 0.95,
      tier: MemoryTier.L0_REGISTER,
      createdAt: 1711800000000,
      accessedAt: 1711800000000,
      accessCount: 1,
      ttl: null,
      metadata: { source: 'conversation' }
    }

    expect(chunk.ttl).toBeNull()
    expect(chunk.accessCount).toBeGreaterThan(0)
    expect(chunk.type).toBe(ChunkType.USER_CONSTRAINT)
  })

  it('accepts token budget zone definitions', () => {
    const budget: TokenBudget = {
      total: 4000,
      stableZone: {
        systemPrompt: 300,
        userProfile: 150,
        taskDef: 150
      },
      dynamicZone: {
        currentTurn: 800,
        recentHistory: 600,
        sessionSummary: 600,
        toolResults: 800,
        longTermMemory: 400,
        sharedContext: 200
      }
    }

    expect(budget.total).toBe(4000)
    expect(budget.stableZone.systemPrompt + budget.dynamicZone.currentTurn).toBe(1100)
  })

  it('computes importance score total with default weights', () => {
    const score = calculateImportanceScore({
      relevance: 1,
      recency: 0.5,
      frequency: 0.5,
      anchoring: 1
    })

    expect(DEFAULT_SCORING_WEIGHTS).toEqual({
      relevance: 0.4,
      recency: 0.2,
      frequency: 0.2,
      anchoring: 0.2
    })
    expect(score.total).toBeCloseTo(0.8, 8)
  })

  it('supports BuildResult stats typing', () => {
    const result: BuildResult = {
      context: 'compiled context',
      stats: {
        tokensSaved: 1200,
        costSaved: 0.018,
        memoryHits: 12,
        latencyMs: 31,
        compressionRatio: 2.1,
        tierUtilization: {
          [MemoryTier.L0_REGISTER]: 0.1,
          [MemoryTier.L1_CACHE]: 0.2,
          [MemoryTier.L2_RAM]: 0.3,
          [MemoryTier.L3_SSD]: 0.25,
          [MemoryTier.L4_ARCHIVE]: 0.15
        }
      }
    }

    expect(result.stats.tokensSaved).toBe(1200)
    expect(result.stats.tierUtilization[MemoryTier.L2_RAM]).toBe(0.3)
  })
})
