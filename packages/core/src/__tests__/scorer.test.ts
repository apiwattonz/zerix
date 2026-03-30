import { describe, expect, it } from 'vitest'
import {
  ChunkType,
  MemoryTier,
  calculateAnchoring,
  calculateFrequency,
  calculateRecency,
  calculateRelevance,
  scoreChunk,
  scoreChunks,
  type ContextChunk,
  type ScoringConfig
} from '../index.js'

const NOW = 1_700_000_000_000

const createChunk = (overrides: Partial<ContextChunk> = {}): ContextChunk => ({
  id: overrides.id ?? 'chunk-1',
  content: overrides.content ?? 'default content',
  tokens: overrides.tokens ?? 5,
  type: overrides.type ?? ChunkType.OBSERVATION,
  score: overrides.score ?? 0,
  tier: overrides.tier ?? MemoryTier.L1_CACHE,
  createdAt: overrides.createdAt ?? NOW,
  accessedAt: overrides.accessedAt ?? NOW,
  accessCount: overrides.accessCount ?? 0,
  ttl: overrides.ttl ?? null,
  metadata: overrides.metadata ?? {}
})

describe('relevance scorer', () => {
  it('scoreChunk computes 0-1 score and mutates chunk.score', () => {
    const chunk = createChunk({
      content: 'deploy redis cache in production',
      type: ChunkType.DECISION,
      createdAt: NOW - 2 * 60 * 60 * 1000,
      accessCount: 25
    })

    const originalNow = Date.now
    Date.now = () => NOW

    const score = scoreChunk(chunk, 'deploy redis in prod')

    Date.now = originalNow

    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
    expect(chunk.score).toBe(score)
    expect(score).toBeGreaterThan(0.4)
  })

  it('scoreChunks returns sorted chunks by score descending and mutates each score', () => {
    const chunks = [
      createChunk({ id: 'a', content: 'cat', type: ChunkType.OBSERVATION, accessCount: 1 }),
      createChunk({
        id: 'b',
        content: 'cat cat cat',
        type: ChunkType.USER_CONSTRAINT,
        accessCount: 0
      }),
      createChunk({ id: 'c', content: 'dog', type: ChunkType.FACT, accessCount: 50 })
    ]

    const originalNow = Date.now
    Date.now = () => NOW

    const sorted = scoreChunks(chunks, 'cat')

    Date.now = originalNow

    expect(sorted[0]?.id).toBe('b')
    expect(sorted[0]!.score).toBeGreaterThanOrEqual(sorted[1]!.score)
    expect(sorted[1]!.score).toBeGreaterThanOrEqual(sorted[2]!.score)
    expect(chunks.every((chunk) => chunk.score >= 0 && chunk.score <= 1)).toBe(true)
  })

  it('calculateRelevance gives ~1.0 for identical text', () => {
    const chunk = createChunk({ content: 'optimize memory usage in compiler pipeline' })
    const score = calculateRelevance(chunk, 'optimize memory usage in compiler pipeline')

    expect(score).toBeGreaterThan(0.99)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('calculateRelevance gives ~0.0 for unrelated text', () => {
    const chunk = createChunk({ content: 'banana orange kiwi mango' })
    const score = calculateRelevance(chunk, 'kernel panic segmentation fault crash')

    expect(score).toBe(0)
  })

  it('calculateRelevance gives medium score for partial overlap', () => {
    const chunk = createChunk({ content: 'refactor parser and improve token counting logic' })
    const score = calculateRelevance(chunk, 'improve parser performance')

    expect(score).toBeGreaterThanOrEqual(0.3)
    expect(score).toBeLessThanOrEqual(0.7)
  })

  it('calculateRelevance works with Thai text', () => {
    const chunk = createChunk({ content: 'ระบบ แคช ช่วย ลด เวลา ตอบสนอง' })
    const score = calculateRelevance(chunk, 'ลด เวลา ตอบสนอง ระบบ')

    expect(score).toBeGreaterThan(0.5)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('calculateRecency returns ~1.0 when just created', () => {
    const score = calculateRecency(NOW, NOW)
    expect(score).toBeGreaterThan(0.99)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('calculateRecency is lower at 24h old', () => {
    const oneDayAgo = NOW - 24 * 60 * 60 * 1000
    const score = calculateRecency(oneDayAgo, NOW)
    expect(score).toBeLessThan(0.2)
    expect(score).toBeGreaterThan(0)
  })

  it('calculateRecency approaches 0 for very old chunks', () => {
    const veryOld = NOW - 30 * 24 * 60 * 60 * 1000
    const score = calculateRecency(veryOld, NOW)
    expect(score).toBeLessThan(0.001)
  })

  it('calculateFrequency returns 0 with zero accesses', () => {
    expect(calculateFrequency(0, 100)).toBe(0)
  })

  it('calculateFrequency returns 1.0 at max accesses', () => {
    expect(calculateFrequency(100, 100)).toBe(1)
    expect(calculateFrequency(999, 100)).toBe(1)
  })

  it('calculateAnchoring returns USER_CONSTRAINT=1.0 and OBSERVATION=0.2', () => {
    expect(calculateAnchoring(ChunkType.USER_CONSTRAINT)).toBe(1)
    expect(calculateAnchoring(ChunkType.OBSERVATION)).toBe(0.2)
  })

  it('supports custom weights correctly', () => {
    const chunk = createChunk({
      content: 'token budget optimization strategy',
      type: ChunkType.OBSERVATION,
      accessCount: 10,
      createdAt: NOW - 10 * 60 * 60 * 1000
    })

    const config: ScoringConfig = {
      weights: {
        relevance: 1,
        recency: 0,
        frequency: 0,
        anchoring: 0
      }
    }

    const score = scoreChunk(chunk, 'optimization strategy', config)
    const relevance = calculateRelevance(chunk, 'optimization strategy')

    expect(score).toBeCloseTo(relevance, 6)
  })

  it('USER_CONSTRAINT chunks score highest regardless of other factors', () => {
    const originalNow = Date.now
    Date.now = () => NOW

    const config: ScoringConfig = {
      weights: {
        relevance: 0,
        recency: 0,
        frequency: 0,
        anchoring: 1
      }
    }

    const chunks = [
      createChunk({ id: 'obs', type: ChunkType.OBSERVATION, content: 'x', accessCount: 100 }),
      createChunk({ id: 'fact', type: ChunkType.FACT, content: 'x', accessCount: 100 }),
      createChunk({
        id: 'constraint',
        type: ChunkType.USER_CONSTRAINT,
        content: 'x',
        accessCount: 0,
        createdAt: NOW - 365 * 24 * 60 * 60 * 1000
      })
    ]

    const ranked = scoreChunks(chunks, 'irrelevant', config)

    Date.now = originalNow

    expect(ranked[0]?.id).toBe('constraint')
    expect(ranked[0]?.score).toBe(1)
  })
})
