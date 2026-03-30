import { describe, expect, it } from 'vitest'
import { ContextAssembler, type AssemblerConfig } from '../assembler.js'
import { createBudget } from '../budget.js'
import { MemoryTier } from '../../types/enums.js'
import { ChunkType } from '../../types/enums.js'
import type { ContextChunk } from '../../types/chunk.js'
import type { MemoryStore } from '../../memory/types.js'

const NOW = 1_700_000_000_000

const createChunk = (overrides: Partial<ContextChunk> = {}): ContextChunk => ({
  id: overrides.id ?? 'chunk-1',
  content: overrides.content ?? 'default content',
  tokens: overrides.tokens ?? 10,
  type: overrides.type ?? ChunkType.OBSERVATION,
  score: overrides.score ?? 0,
  tier: overrides.tier ?? MemoryTier.L2_RAM,
  createdAt: overrides.createdAt ?? NOW,
  accessedAt: overrides.accessedAt ?? NOW,
  accessCount: overrides.accessCount ?? 1,
  ttl: overrides.ttl ?? null,
  metadata: overrides.metadata ?? {}
})

/** Helper: create a minimal assembler config with deterministic clock */
const makeConfig = (totalTokens: number, overrides?: Partial<AssemblerConfig>): AssemblerConfig => ({
  budget: createBudget(totalTokens),
  now: () => NOW,
  ...overrides
})

describe('ContextAssembler', () => {
  // ---------------------------------------------------------------
  // 1. Basic assembly with L0 + L1 + dynamic chunks
  // ---------------------------------------------------------------
  it('assembles L0 + L1 + dynamic chunks into sectioned output', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks(
      {
        l0: [createChunk({ id: 'r1', content: 'system prompt', tokens: 20, tier: MemoryTier.L0_REGISTER })],
        l1: [createChunk({ id: 'c1', content: 'cached fact', tokens: 20, tier: MemoryTier.L1_CACHE })],
        dynamic: [createChunk({ id: 'd1', content: 'recent observation', tokens: 30, tier: MemoryTier.L2_RAM })]
      },
      'observation'
    )

    expect(result.context).toContain('--- REGISTERS ---')
    expect(result.context).toContain('system prompt')
    expect(result.context).toContain('--- CACHE ---')
    expect(result.context).toContain('cached fact')
    expect(result.context).toContain('--- DYNAMIC ---')
    expect(result.context).toContain('recent observation')
    expect(result.stats.memoryHits).toBe(3)
  })

  // ---------------------------------------------------------------
  // 2. Assembly order: L0 first, then L1, then scored dynamic
  // ---------------------------------------------------------------
  it('outputs sections in order: REGISTERS, CACHE, DYNAMIC', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks(
      {
        l0: [createChunk({ id: 'r1', content: 'register', tokens: 10, tier: MemoryTier.L0_REGISTER })],
        l1: [createChunk({ id: 'c1', content: 'cache', tokens: 10, tier: MemoryTier.L1_CACHE })],
        dynamic: [createChunk({ id: 'd1', content: 'dynamic', tokens: 10, tier: MemoryTier.L2_RAM })]
      },
      'test'
    )

    const regIdx = result.context.indexOf('--- REGISTERS ---')
    const cacheIdx = result.context.indexOf('--- CACHE ---')
    const dynIdx = result.context.indexOf('--- DYNAMIC ---')
    expect(regIdx).toBeLessThan(cacheIdx)
    expect(cacheIdx).toBeLessThan(dynIdx)
  })

  // ---------------------------------------------------------------
  // 3. Budget enforcement: output never exceeds token budget
  // ---------------------------------------------------------------
  it('does not include chunks that would exceed stable zone budget', () => {
    // With 100 total tokens, stable zone = 15 tokens (15%)
    const assembler = new ContextAssembler(makeConfig(100))
    const result = assembler.buildFromChunks(
      {
        l0: [
          createChunk({ id: 'r1', content: 'a', tokens: 10, tier: MemoryTier.L0_REGISTER }),
          createChunk({ id: 'r2', content: 'b', tokens: 10, tier: MemoryTier.L0_REGISTER })
        ]
      },
      ''
    )

    // Only 15 tokens in stable zone, so only one 10-token chunk fits
    expect(result.context).toContain('a')
    expect(result.context).not.toContain('b')
  })

  it('does not include dynamic chunks that exceed dynamic zone budget', () => {
    // 100 total → dynamic zone = 85 tokens
    const assembler = new ContextAssembler(makeConfig(100))
    const bigChunks = Array.from({ length: 5 }, (_, i) =>
      createChunk({ id: `d${i}`, content: `chunk-${i}`, tokens: 30, tier: MemoryTier.L2_RAM })
    )
    const result = assembler.buildFromChunks({ dynamic: bigChunks }, 'chunk')

    // 85 tokens → at most 2 chunks of 30 tokens each (60 tokens)
    expect(result.stats.memoryHits).toBeLessThanOrEqual(2)
  })

  // ---------------------------------------------------------------
  // 4. Stable vs dynamic zone boundaries respected
  // ---------------------------------------------------------------
  it('respects zone boundary: L1 fills remaining stable budget after L0', () => {
    // 200 total → stable = 30 tokens
    const assembler = new ContextAssembler(makeConfig(200))
    const result = assembler.buildFromChunks(
      {
        l0: [createChunk({ id: 'r1', content: 'reg', tokens: 20, tier: MemoryTier.L0_REGISTER })],
        l1: [
          createChunk({ id: 'c1', content: 'fits', tokens: 10, tier: MemoryTier.L1_CACHE }),
          createChunk({ id: 'c2', content: 'no-fit', tokens: 15, tier: MemoryTier.L1_CACHE })
        ]
      },
      ''
    )

    // L0 uses 20, leaving 10 for L1. Only c1 (10 tokens) fits.
    expect(result.context).toContain('fits')
    expect(result.context).not.toContain('no-fit')
  })

  // ---------------------------------------------------------------
  // 5. Section markers in output
  // ---------------------------------------------------------------
  it('omits section markers for empty tiers', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks(
      { dynamic: [createChunk({ id: 'd1', content: 'only dynamic', tokens: 10, tier: MemoryTier.L2_RAM })] },
      'test'
    )

    expect(result.context).not.toContain('--- REGISTERS ---')
    expect(result.context).not.toContain('--- CACHE ---')
    expect(result.context).toContain('--- DYNAMIC ---')
  })

  // ---------------------------------------------------------------
  // 6. BuildResult stats (tokensSaved, latencyMs etc)
  // ---------------------------------------------------------------
  it('computes correct stats including tokensSaved and compressionRatio', () => {
    let tick = NOW
    const assembler = new ContextAssembler({
      budget: createBudget(100),
      costPerToken: 0.001,
      now: () => tick++
    })

    const result = assembler.buildFromChunks(
      {
        dynamic: [
          createChunk({ id: 'd1', content: 'kept', tokens: 20, tier: MemoryTier.L2_RAM }),
          createChunk({ id: 'd2', content: 'dropped', tokens: 80, tier: MemoryTier.L2_RAM })
        ]
      },
      'kept'
    )

    // d1 is more relevant to "kept" query so should be prioritized
    expect(result.stats.memoryHits).toBeGreaterThanOrEqual(1)
    expect(result.stats.tokensSaved).toBeGreaterThanOrEqual(0)
    expect(result.stats.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.stats.compressionRatio).toBeGreaterThan(0)
    expect(result.stats.costSaved).toBe(result.stats.tokensSaved * 0.001)
  })

  it('latencyMs reflects elapsed time from deterministic clock', () => {
    let tick = 1000
    const assembler = new ContextAssembler({
      budget: createBudget(500),
      now: () => tick++
    })

    const result = assembler.buildFromChunks(
      { l0: [createChunk({ id: 'r', content: 'x', tokens: 5, tier: MemoryTier.L0_REGISTER })] },
      ''
    )

    expect(result.stats.latencyMs).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------
  // 7. Query parameter affects dynamic content scoring/ordering
  // ---------------------------------------------------------------
  it('query relevance affects which dynamic chunks are selected', () => {
    const assembler = new ContextAssembler(makeConfig(100))
    const result = assembler.buildFromChunks(
      {
        dynamic: [
          createChunk({ id: 'd1', content: 'deploy redis cache in production environment', tokens: 40, tier: MemoryTier.L2_RAM }),
          createChunk({ id: 'd2', content: 'unrelated random noise about weather', tokens: 40, tier: MemoryTier.L2_RAM })
        ]
      },
      'deploy redis production'
    )

    // Only ~85 tokens available for dynamic zone, both chunks are 40 tokens each
    // The more relevant chunk to "deploy redis production" should appear
    expect(result.context).toContain('deploy redis cache')
  })

  // ---------------------------------------------------------------
  // 8. Empty memory -> empty or minimal result
  // ---------------------------------------------------------------
  it('returns empty context with zero hits when memory is empty', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks({}, '')

    expect(result.context).toBe('')
    expect(result.stats.memoryHits).toBe(0)
    expect(result.stats.tokensSaved).toBe(0)
    expect(result.stats.compressionRatio).toBe(0)
  })

  // ---------------------------------------------------------------
  // 9. Budget too small -> graceful handling
  // ---------------------------------------------------------------
  it('returns empty result when budget is below minimum usable tokens', () => {
    const assembler = new ContextAssembler(makeConfig(5))
    const result = assembler.buildFromChunks(
      { l0: [createChunk({ id: 'r1', content: 'something', tokens: 3, tier: MemoryTier.L0_REGISTER })] },
      ''
    )

    expect(result.context).toBe('')
    expect(result.stats.memoryHits).toBe(0)
  })

  // ---------------------------------------------------------------
  // 10. No relevant chunks -> appropriate result
  // ---------------------------------------------------------------
  it('includes chunks even when query has zero relevance (other signals still score)', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks(
      {
        dynamic: [
          createChunk({
            id: 'd1',
            content: 'completely unrelated content about zebras',
            tokens: 20,
            tier: MemoryTier.L2_RAM,
            accessCount: 50
          })
        ]
      },
      'quantum physics black holes'
    )

    // Even with zero relevance, recency/frequency/anchoring still give a non-zero score
    expect(result.stats.memoryHits).toBe(1)
  })

  // ---------------------------------------------------------------
  // 11. Single chunk scenarios
  // ---------------------------------------------------------------
  it('handles single L0 chunk correctly', () => {
    const assembler = new ContextAssembler(makeConfig(500))
    const result = assembler.buildFromChunks(
      { l0: [createChunk({ id: 'r1', content: 'only register', tokens: 10, tier: MemoryTier.L0_REGISTER })] },
      ''
    )

    expect(result.context).toContain('--- REGISTERS ---')
    expect(result.context).toContain('only register')
    expect(result.stats.memoryHits).toBe(1)
  })

  it('handles single dynamic chunk correctly', () => {
    const assembler = new ContextAssembler(makeConfig(500))
    const result = assembler.buildFromChunks(
      { dynamic: [createChunk({ id: 'd1', content: 'sole dynamic', tokens: 10, tier: MemoryTier.L2_RAM })] },
      'dynamic'
    )

    expect(result.context).toContain('--- DYNAMIC ---')
    expect(result.context).toContain('sole dynamic')
    expect(result.stats.memoryHits).toBe(1)
  })

  // ---------------------------------------------------------------
  // 12. Large number of chunks (100+)
  // ---------------------------------------------------------------
  it('handles 100+ dynamic chunks without error', () => {
    const assembler = new ContextAssembler(makeConfig(10000))
    const chunks = Array.from({ length: 150 }, (_, i) =>
      createChunk({
        id: `d${i}`,
        content: `chunk number ${i} with some data`,
        tokens: 10,
        tier: MemoryTier.L2_RAM,
        accessCount: i
      })
    )

    const result = assembler.buildFromChunks({ dynamic: chunks }, 'chunk data')

    expect(result.stats.memoryHits).toBeGreaterThan(0)
    expect(result.stats.memoryHits).toBeLessThanOrEqual(150)
    expect(result.context).toContain('--- DYNAMIC ---')
  })

  // ---------------------------------------------------------------
  // 13. Chunks with same score (tie-breaking)
  // ---------------------------------------------------------------
  it('produces deterministic output for chunks with same properties', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const chunks = Array.from({ length: 5 }, (_, i) =>
      createChunk({
        id: `d${i}`,
        content: `identical content`,
        tokens: 10,
        tier: MemoryTier.L2_RAM,
        createdAt: NOW - i * 1000, // slightly different creation times for tie-breaking
        accessCount: 5
      })
    )

    const r1 = assembler.buildFromChunks({ dynamic: chunks }, 'identical content')
    const r2 = assembler.buildFromChunks({ dynamic: chunks }, 'identical content')

    expect(r1.stats.memoryHits).toBe(r2.stats.memoryHits)
    expect(r1.context).toBe(r2.context)
  })

  // ---------------------------------------------------------------
  // 14. Unicode/Thai text content
  // ---------------------------------------------------------------
  it('handles Thai and Unicode text content correctly', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks(
      {
        l0: [createChunk({
          id: 'thai',
          content: 'สวัสดีครับ ระบบทำงานปกติ',
          tokens: 15,
          tier: MemoryTier.L0_REGISTER
        })],
        dynamic: [createChunk({
          id: 'emoji',
          content: 'status: operational 🟢 all systems go',
          tokens: 12,
          tier: MemoryTier.L2_RAM
        })]
      },
      'สวัสดี status'
    )

    expect(result.context).toContain('สวัสดีครับ')
    expect(result.context).toContain('🟢')
    expect(result.stats.memoryHits).toBe(2)
  })

  // ---------------------------------------------------------------
  // 15. Zero budget
  // ---------------------------------------------------------------
  it('returns empty result for zero total budget', () => {
    const assembler = new ContextAssembler(makeConfig(0))
    const result = assembler.buildFromChunks(
      { l0: [createChunk({ id: 'r1', content: 'anything', tokens: 5, tier: MemoryTier.L0_REGISTER })] },
      ''
    )

    expect(result.context).toBe('')
    expect(result.stats.memoryHits).toBe(0)
  })

  // ---------------------------------------------------------------
  // 16. Logger integration
  // ---------------------------------------------------------------
  it('logger receives assembly messages when enabled', () => {
    const logs: string[] = []
    const assembler = new ContextAssembler({
      budget: createBudget(500),
      logger: { log: (msg: string) => logs.push(msg) },
      now: () => NOW
    })

    assembler.buildFromChunks(
      { l0: [createChunk({ id: 'r1', content: 'test', tokens: 5, tier: MemoryTier.L0_REGISTER })] },
      ''
    )

    expect(logs.length).toBeGreaterThan(0)
    expect(logs.some((l) => l.includes('starting assembly'))).toBe(true)
    expect(logs.some((l) => l.includes('assembly complete'))).toBe(true)
  })

  // ---------------------------------------------------------------
  // 17. MemoryStore interface via build()
  // ---------------------------------------------------------------
  it('build() reads from MemoryStore interface correctly', () => {
    const store: MemoryStore = {
      read: (tier: MemoryTier) => {
        if (tier === MemoryTier.L0_REGISTER) return [createChunk({ id: 'r1', content: 'from store', tokens: 10, tier: MemoryTier.L0_REGISTER })]
        if (tier === MemoryTier.L2_RAM) return [createChunk({ id: 'd1', content: 'dynamic store', tokens: 10, tier: MemoryTier.L2_RAM })]
        return []
      },
      write: () => {},
      search: () => [],
      delete: () => false,
      clear: () => {},
      stats: () => ({
        tiers: {
          [MemoryTier.L0_REGISTER]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L1_CACHE]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L2_RAM]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L3_SSD]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L4_ARCHIVE]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 }
        },
        totalChunks: 0,
        totalTokens: 0
      }),
      promote: () => false,
      demote: () => false
    }

    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.build(store, 'store')

    expect(result.context).toContain('from store')
    expect(result.context).toContain('dynamic store')
    expect(result.stats.memoryHits).toBe(2)
  })

  // ---------------------------------------------------------------
  // 18. Tier utilization stats
  // ---------------------------------------------------------------
  it('tierUtilization reflects proportional token share per tier', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks(
      {
        l0: [createChunk({ id: 'r1', content: 'register', tokens: 50, tier: MemoryTier.L0_REGISTER })],
        dynamic: [createChunk({ id: 'd1', content: 'dynamic data', tokens: 50, tier: MemoryTier.L2_RAM })]
      },
      'data'
    )

    const { tierUtilization } = result.stats
    expect(tierUtilization[MemoryTier.L0_REGISTER]).toBeCloseTo(0.5, 1)
    expect(tierUtilization[MemoryTier.L2_RAM]).toBeCloseTo(0.5, 1)
    expect(tierUtilization[MemoryTier.L1_CACHE]).toBe(0)
  })

  // ---------------------------------------------------------------
  // 19. Chunks with zero tokens are skipped
  // ---------------------------------------------------------------
  it('skips chunks with zero or negative tokens', () => {
    const assembler = new ContextAssembler(makeConfig(500))
    const result = assembler.buildFromChunks(
      {
        l0: [
          createChunk({ id: 'z1', content: 'zero', tokens: 0, tier: MemoryTier.L0_REGISTER }),
          createChunk({ id: 'n1', content: 'negative', tokens: -5, tier: MemoryTier.L0_REGISTER }),
          createChunk({ id: 'v1', content: 'valid', tokens: 10, tier: MemoryTier.L0_REGISTER })
        ]
      },
      ''
    )

    expect(result.context).toContain('valid')
    expect(result.context).not.toContain('zero')
    expect(result.context).not.toContain('negative')
  })

  // ---------------------------------------------------------------
  // 20. costSaved defaults to 0 when costPerToken not set
  // ---------------------------------------------------------------
  it('costSaved is 0 when costPerToken is not configured', () => {
    const assembler = new ContextAssembler(makeConfig(1000))
    const result = assembler.buildFromChunks(
      { dynamic: [createChunk({ id: 'd1', content: 'data', tokens: 10, tier: MemoryTier.L2_RAM })] },
      'data'
    )

    expect(result.stats.costSaved).toBe(0)
  })
})
