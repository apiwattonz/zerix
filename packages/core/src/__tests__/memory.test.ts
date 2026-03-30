import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChunkType,
  InMemoryTier,
  MemoryTier,
  SQLiteTier,
  TieredMemory,
  type ContextChunk
} from '../index.js'

const cleanupPaths = new Set<string>()

const registerCleanup = (dbFile: string): void => {
  cleanupPaths.add(dbFile)
  cleanupPaths.add(`${dbFile}-shm`)
  cleanupPaths.add(`${dbFile}-wal`)
}

afterEach(() => {
  for (const file of cleanupPaths) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
    }
  }
  cleanupPaths.clear()
})

const createChunk = (
  id: string,
  tier: MemoryTier,
  content = 'default content',
  tokens = 10
): ContextChunk => {
  const now = Date.now()
  return {
    id,
    content,
    tokens,
    type: ChunkType.OBSERVATION,
    score: 0.5,
    tier,
    createdAt: now,
    accessedAt: now,
    accessCount: 0,
    ttl: null,
    metadata: {}
  }
}

describe('InMemoryTier', () => {
  it('writes and reads chunks', () => {
    const tier = new InMemoryTier(MemoryTier.L1_CACHE, 4000, false)
    const chunk = createChunk('c1', MemoryTier.L1_CACHE, 'hello cache')

    tier.write(chunk)

    const data = tier.read()
    expect(data).toHaveLength(1)
    expect(data[0]?.id).toBe('c1')
  })

  it('L0 rejects writes over max tokens', () => {
    const tier = new InMemoryTier(MemoryTier.L0_REGISTER, 100, true)
    tier.write(createChunk('fit', MemoryTier.L0_REGISTER, 'fits', 60))

    expect(() => tier.write(createChunk('overflow', MemoryTier.L0_REGISTER, 'too big', 50))).toThrow(
      /token budget exceeded/
    )

    expect(tier.read()).toHaveLength(1)
  })

  it('searches by keyword', () => {
    const tier = new InMemoryTier(MemoryTier.L1_CACHE, 4000, false)
    tier.write(createChunk('a', MemoryTier.L1_CACHE, 'memory cache hit'))
    tier.write(createChunk('b', MemoryTier.L1_CACHE, 'other text'))

    const results = tier.search('cache')
    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe('a')
  })

  it('deletes chunk', () => {
    const tier = new InMemoryTier(MemoryTier.L1_CACHE, 4000, false)
    tier.write(createChunk('a', MemoryTier.L1_CACHE))

    expect(tier.delete('a')).toBe(true)
    expect(tier.delete('missing')).toBe(false)
  })

  it('clears all chunks', () => {
    const tier = new InMemoryTier(MemoryTier.L1_CACHE, 4000, false)
    tier.write(createChunk('a', MemoryTier.L1_CACHE))
    tier.write(createChunk('b', MemoryTier.L1_CACHE))

    tier.clear()

    expect(tier.read()).toHaveLength(0)
  })
})

describe('SQLiteTier', () => {
  it('writes and reads chunks (auto creates DB)', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-1.db`)
    registerCleanup(dbFile)

    const tier = new SQLiteTier(MemoryTier.L2_RAM, 16000, dbFile)
    tier.write(createChunk('db1', MemoryTier.L2_RAM, 'persist me', 20))

    const read = tier.read()
    expect(read).toHaveLength(1)
    expect(read[0]?.content).toBe('persist me')
    tier.close()
  })

  it('searches with LIKE', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-2.db`)
    registerCleanup(dbFile)

    const tier = new SQLiteTier(MemoryTier.L2_RAM, 16000, dbFile)
    tier.write(createChunk('db1', MemoryTier.L2_RAM, 'alpha beta gamma', 12))
    tier.write(createChunk('db2', MemoryTier.L2_RAM, 'delta epsilon', 12))

    const results = tier.search('beta')
    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe('db1')
    tier.close()
  })

  it('deletes and clears', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-3.db`)
    registerCleanup(dbFile)

    const tier = new SQLiteTier(MemoryTier.L2_RAM, 16000, dbFile)
    tier.write(createChunk('db1', MemoryTier.L2_RAM))
    tier.write(createChunk('db2', MemoryTier.L2_RAM))

    expect(tier.delete('db1')).toBe(true)
    tier.clear()
    expect(tier.read()).toHaveLength(0)
    tier.close()
  })

  it('persists across instances with same file', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-4.db`)
    registerCleanup(dbFile)

    const first = new SQLiteTier(MemoryTier.L2_RAM, 16000, dbFile)
    first.write(createChunk('db1', MemoryTier.L2_RAM, 'hello persistence', 18))
    first.close()

    const second = new SQLiteTier(MemoryTier.L2_RAM, 16000, dbFile)
    const rows = second.read()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('db1')
    second.close()
  })
})

describe('TieredMemory', () => {
  it('writes to L0, L1, L2', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-5.db`)
    registerCleanup(dbFile)

    const memory = new TieredMemory({ dbPath: dbFile })
    memory.write(MemoryTier.L0_REGISTER, createChunk('l0', MemoryTier.L0_REGISTER, 'l0', 20))
    memory.write(MemoryTier.L1_CACHE, createChunk('l1', MemoryTier.L1_CACHE, 'l1', 20))
    memory.write(MemoryTier.L2_RAM, createChunk('l2', MemoryTier.L2_RAM, 'l2', 20))

    expect(memory.read(MemoryTier.L0_REGISTER)).toHaveLength(1)
    expect(memory.read(MemoryTier.L1_CACHE)).toHaveLength(1)
    expect(memory.read(MemoryTier.L2_RAM)).toHaveLength(1)
    memory.close()
  })

  it('promotes L1 to L0', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-6.db`)
    registerCleanup(dbFile)

    const memory = new TieredMemory({ dbPath: dbFile })
    memory.write(MemoryTier.L1_CACHE, createChunk('move-up', MemoryTier.L1_CACHE, 'move me', 20))

    expect(memory.promote('move-up', MemoryTier.L1_CACHE, MemoryTier.L0_REGISTER)).toBe(true)
    expect(memory.read(MemoryTier.L1_CACHE)).toHaveLength(0)
    expect(memory.read(MemoryTier.L0_REGISTER)).toHaveLength(1)
    memory.close()
  })

  it('demotes L1 to L2', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-7.db`)
    registerCleanup(dbFile)

    const memory = new TieredMemory({ dbPath: dbFile })
    memory.write(MemoryTier.L1_CACHE, createChunk('move-down', MemoryTier.L1_CACHE, 'to ram', 20))

    expect(memory.demote('move-down', MemoryTier.L1_CACHE, MemoryTier.L2_RAM)).toBe(true)
    expect(memory.read(MemoryTier.L1_CACHE)).toHaveLength(0)
    expect(memory.read(MemoryTier.L2_RAM)).toHaveLength(1)
    memory.close()
  })

  it('returns correct stats utilization per tier', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-8.db`)
    registerCleanup(dbFile)

    const memory = new TieredMemory({
      dbPath: dbFile,
      l0MaxTokens: 100,
      l1MaxTokens: 200,
      l2MaxTokens: 400
    })

    memory.write(MemoryTier.L0_REGISTER, createChunk('a', MemoryTier.L0_REGISTER, 'a', 50))
    memory.write(MemoryTier.L1_CACHE, createChunk('b', MemoryTier.L1_CACHE, 'b', 40))
    memory.write(MemoryTier.L2_RAM, createChunk('c', MemoryTier.L2_RAM, 'c', 80))

    const stats = memory.stats()
    expect(stats.tiers[MemoryTier.L0_REGISTER].utilization).toBe(0.5)
    expect(stats.tiers[MemoryTier.L1_CACHE].utilization).toBe(0.2)
    expect(stats.tiers[MemoryTier.L2_RAM].utilization).toBe(0.2)
    expect(stats.totalChunks).toBe(3)
    expect(stats.totalTokens).toBe(170)
    memory.close()
  })

  it('handles write to full tier gracefully', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-9.db`)
    registerCleanup(dbFile)

    const memory = new TieredMemory({ dbPath: dbFile, l0MaxTokens: 100 })
    memory.write(MemoryTier.L0_REGISTER, createChunk('ok', MemoryTier.L0_REGISTER, 'ok', 80))

    expect(() =>
      memory.write(MemoryTier.L0_REGISTER, createChunk('overflow', MemoryTier.L0_REGISTER, 'overflow', 30))
    ).toThrow(/token budget exceeded/)
    memory.close()
  })

  it('returns false when promoting non-existent chunk', () => {
    const dbFile = path.join(os.tmpdir(), `zerix-memory-${Date.now()}-10.db`)
    registerCleanup(dbFile)

    const memory = new TieredMemory({ dbPath: dbFile })
    expect(memory.promote('missing', MemoryTier.L1_CACHE, MemoryTier.L0_REGISTER)).toBe(false)
    memory.close()
  })
})
