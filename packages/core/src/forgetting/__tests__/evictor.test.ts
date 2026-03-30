import { describe, expect, it } from 'vitest'
import {
  ChunkType,
  Evictor,
  MemoryTier,
  Summarizer,
  type ContextChunk
} from '../../index.js'

const NOW = 1_700_000_000_000

const createChunk = (overrides: Partial<ContextChunk> = {}): ContextChunk => ({
  id: overrides.id ?? 'chunk-1',
  content: overrides.content ?? 'default content.',
  tokens: overrides.tokens ?? 10,
  type: overrides.type ?? ChunkType.OBSERVATION,
  score: overrides.score ?? 0.5,
  tier: overrides.tier ?? MemoryTier.L1_CACHE,
  createdAt: overrides.createdAt ?? NOW,
  accessedAt: overrides.accessedAt ?? NOW,
  accessCount: overrides.accessCount ?? 0,
  ttl: overrides.ttl ?? null,
  metadata: overrides.metadata ?? {}
})

describe('Evictor', () => {
  it('triggers only when utilization is greater than threshold (not equal)', async () => {
    const evictor = new Evictor({ triggerUtilization: 0.8, evictFraction: 0.2 })
    const chunks = [
      createChunk({ id: 'a', tokens: 40, score: 0.2 }),
      createChunk({ id: 'b', tokens: 40, score: 0.3 })
    ]

    const equalThreshold = await evictor.run(chunks, 100)
    expect(equalThreshold.triggered).toBe(false)

    const aboveThreshold = await evictor.run([...chunks, createChunk({ id: 'c', tokens: 1, score: 0.1 })], 100)
    expect(aboveThreshold.triggered).toBe(true)
  })

  it('evicts lowest-score chunks first and targets bottom fraction by token count', async () => {
    const evictor = new Evictor({ triggerUtilization: 0.5, evictFraction: 0.2 })
    const chunks = [
      createChunk({ id: 'low-1', tokens: 10, score: 0.05 }),
      createChunk({ id: 'mid', tokens: 20, score: 0.4 }),
      createChunk({ id: 'low-2', tokens: 15, score: 0.1 }),
      createChunk({ id: 'high', tokens: 55, score: 0.9 })
    ]

    const result = await evictor.run(chunks, 80)

    expect(result.triggered).toBe(true)
    // total=100, evictFraction=20% => target >= 20 tokens
    expect(result.targetEvictTokens).toBe(20)
    // picks low-1 (10) then low-2 (15) => 25
    expect(result.evictedChunks.map((chunk) => chunk.id)).toEqual(['low-1', 'low-2'])
    expect(result.evictedTokens).toBe(25)
  })

  it('never evicts USER_CONSTRAINT chunks', async () => {
    const evictor = new Evictor({ triggerUtilization: 0.5, evictFraction: 0.4 })
    const chunks = [
      createChunk({
        id: 'constraint',
        tokens: 60,
        score: 0,
        type: ChunkType.USER_CONSTRAINT,
        tier: MemoryTier.L1_CACHE
      }),
      createChunk({ id: 'evictable', tokens: 40, score: 0.1, tier: MemoryTier.L1_CACHE })
    ]

    const result = await evictor.run(chunks, 90)

    expect(result.evictedChunks.map((chunk) => chunk.id)).toEqual(['evictable'])
    expect(result.chunks.find((chunk) => chunk.id === 'constraint')).toBeDefined()
    expect(result.chunks.find((chunk) => chunk.id === 'constraint')?.tier).toBe(MemoryTier.L1_CACHE)
  })

  it('creates summary chunk from evicted chunks using Summarizer', async () => {
    const evictor = new Evictor({ triggerUtilization: 0.3, evictFraction: 0.5 })
    const chunks = [
      createChunk({
        id: 'x',
        score: 0.1,
        tokens: 15,
        content: 'First from x. second sentence from x.',
        tier: MemoryTier.L2_RAM
      }),
      createChunk({
        id: 'y',
        score: 0.2,
        tokens: 15,
        content: 'First from y! and more.',
        tier: MemoryTier.L2_RAM
      }),
      createChunk({ id: 'z', score: 0.9, tokens: 10, content: 'Keep z.', tier: MemoryTier.L1_CACHE })
    ]

    const result = await evictor.run(chunks, 30)

    expect(result.summaryChunk).not.toBeNull()
    expect(result.summaryChunk?.tier).toBe(MemoryTier.L2_RAM)
    expect(result.summaryChunk?.content.length).toBeGreaterThan(0)
    expect(result.summaryChunk?.metadata).toMatchObject({
      kind: 'eviction_summary',
      sourceChunkIds: ['x', 'y']
    })
  })

  it('moves evicted L1 chunks to L2 while L2 chunks are compacted into summary', async () => {
    const evictor = new Evictor({ triggerUtilization: 0.4, evictFraction: 0.5 })
    const chunks = [
      createChunk({ id: 'l1', score: 0.1, tokens: 20, tier: MemoryTier.L1_CACHE }),
      createChunk({ id: 'l2', score: 0.2, tokens: 20, tier: MemoryTier.L2_RAM }),
      createChunk({ id: 'h', score: 0.9, tokens: 20, tier: MemoryTier.L1_CACHE })
    ]

    const result = await evictor.run(chunks, 50)

    const l1After = result.chunks.find((chunk) => chunk.id === 'l1')
    const l2After = result.chunks.find((chunk) => chunk.id === 'l2')

    expect(l1After?.tier).toBe(MemoryTier.L2_RAM)
    expect(l2After).toBeUndefined()
    expect(result.summaryChunk).not.toBeNull()
  })

  it('records eviction events in eviction log', async () => {
    const evictor = new Evictor({ triggerUtilization: 0.4, evictFraction: 0.2 })
    const chunks = [
      createChunk({ id: 'a', score: 0.1, tokens: 50 }),
      createChunk({ id: 'b', score: 0.2, tokens: 50 })
    ]

    await evictor.run(chunks, 80)
    const log = evictor.getEvictionLog()

    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      triggerUtilization: 0.4,
      evictFraction: 0.2,
      evictedChunkIds: ['a']
    })
    expect(log[0]?.summaryChunkId).toBeTruthy()
  })

  it('supports configurable thresholds', async () => {
    const strict = new Evictor({ triggerUtilization: 0.95, evictFraction: 0.1 })
    const aggressive = new Evictor({ triggerUtilization: 0.5, evictFraction: 0.5 })

    const chunks = [
      createChunk({ id: 'a', score: 0.1, tokens: 30 }),
      createChunk({ id: 'b', score: 0.2, tokens: 30 }),
      createChunk({ id: 'c', score: 0.3, tokens: 40 })
    ]

    const strictResult = await strict.run(chunks, 100)
    const aggressiveResult = await aggressive.run(chunks, 100)

    expect(strictResult.triggered).toBe(true)
    expect(strictResult.targetEvictTokens).toBe(10)
    expect(aggressiveResult.targetEvictTokens).toBe(50)
    expect(aggressiveResult.evictedTokens).toBeGreaterThan(strictResult.evictedTokens)
  })

  it('uses injectable now() for deterministic timestamps', async () => {
    const fixedTime = 1_600_000_000_000
    const evictor = new Evictor({
      triggerUtilization: 0.3,
      evictFraction: 0.5,
      now: () => fixedTime
    })
    const chunks = [
      createChunk({ id: 'a', score: 0.1, tokens: 30, content: 'Some evictable content here.' }),
      createChunk({ id: 'b', score: 0.9, tokens: 30, content: 'Keep this.' })
    ]

    const result = await evictor.run(chunks, 50)

    expect(result.summaryChunk?.createdAt).toBe(fixedTime)
    expect(result.summaryChunk?.accessedAt).toBe(fixedTime)
    expect(result.summaryChunk?.id).toMatch(new RegExp(`^summary-${fixedTime}-`))
    const log = evictor.getEvictionLog()
    expect(log[0]?.timestamp).toBe(fixedTime)
  })

  it('accepts a custom Summarizer instance', async () => {
    const customSummarizer = new Summarizer({ compressionRatio: 5, strategy: 'truncate' })
    const evictor = new Evictor({
      triggerUtilization: 0.3,
      evictFraction: 0.5,
      summarizer: customSummarizer
    })
    const chunks = [
      createChunk({ id: 'a', score: 0.1, tokens: 30, content: 'First chunk content for custom summarizer test.' }),
      createChunk({ id: 'b', score: 0.9, tokens: 30, content: 'Keep this chunk.' })
    ]

    const result = await evictor.run(chunks, 50)

    expect(result.summaryChunk).not.toBeNull()
    expect(result.summaryChunk!.content.length).toBeGreaterThan(0)
  })

  it('handles edge cases: empty memory and all protected chunks', async () => {
    const evictor = new Evictor({ triggerUtilization: 0.1, evictFraction: 0.5 })

    const empty = await evictor.run([], 100)
    expect(empty.triggered).toBe(false)
    expect(empty.evictedChunks).toEqual([])

    const protectedOnly = await evictor.run(
      [
        createChunk({
          id: 'constraint-1',
          type: ChunkType.USER_CONSTRAINT,
          score: 1,
          tokens: 60
        })
      ],
      50
    )

    expect(protectedOnly.triggered).toBe(true)
    expect(protectedOnly.evictedChunks).toEqual([])
    expect(protectedOnly.summaryChunk).toBeNull()
  })
})
