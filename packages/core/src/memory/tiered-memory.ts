import { MemoryTier, type ContextChunk } from '../types/index.js'
import { InMemoryTier } from './in-memory.js'
import { SQLiteTier } from './sqlite.js'
import {
  ACTIVE_MEMORY_TIERS,
  createEmptyMemoryStats,
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
  type MemoryStats,
  type MemoryStore,
  type MemoryTierStore
} from './types.js'

/**
 * Main memory orchestrator for phase-1 tiers (L0, L1, L2).
 */
export class TieredMemory implements MemoryStore {
  private readonly stores: Map<MemoryTier, MemoryTierStore>
  private readonly sqliteTier: SQLiteTier

  public constructor(config: MemoryConfig = {}) {
    const merged = { ...DEFAULT_MEMORY_CONFIG, ...config }

    const l0 = new InMemoryTier(MemoryTier.L0_REGISTER, merged.l0MaxTokens, true)
    const l1 = new InMemoryTier(MemoryTier.L1_CACHE, merged.l1MaxTokens, false)
    this.sqliteTier = new SQLiteTier(MemoryTier.L2_RAM, merged.l2MaxTokens, merged.dbPath)

    this.stores = new Map<MemoryTier, MemoryTierStore>([
      [MemoryTier.L0_REGISTER, l0],
      [MemoryTier.L1_CACHE, l1],
      [MemoryTier.L2_RAM, this.sqliteTier]
    ])
  }

  public read(tier: MemoryTier): ContextChunk[] {
    return this.getStore(tier).read()
  }

  public write(tier: MemoryTier, chunk: ContextChunk): void {
    this.getStore(tier).write({ ...chunk, tier })
  }

  public search(tier: MemoryTier, query: string, limit = 10): ContextChunk[] {
    return this.getStore(tier).search(query, limit)
  }

  public delete(tier: MemoryTier, chunkId: string): boolean {
    return this.getStore(tier).delete(chunkId)
  }

  public clear(tier: MemoryTier): void {
    this.getStore(tier).clear()
  }

  public stats(): MemoryStats {
    const stats = createEmptyMemoryStats()

    for (const tier of ACTIVE_MEMORY_TIERS) {
      const storeStats = this.getStore(tier).stats()
      stats.tiers[tier] = storeStats
      stats.totalChunks += storeStats.chunkCount
      stats.totalTokens += storeStats.totalTokens
    }

    return stats
  }

  public promote(chunkId: string, fromTier: MemoryTier, toTier: MemoryTier): boolean {
    return this.moveChunk(chunkId, fromTier, toTier)
  }

  public demote(chunkId: string, fromTier: MemoryTier, toTier: MemoryTier): boolean {
    return this.moveChunk(chunkId, fromTier, toTier)
  }

  public close(): void {
    this.sqliteTier.close()
  }

  private moveChunk(chunkId: string, fromTier: MemoryTier, toTier: MemoryTier): boolean {
    const source = this.getStore(fromTier)
    const target = this.getStore(toTier)

    const chunk = source.read().find((entry) => entry.id === chunkId)
    if (!chunk) {
      return false
    }

    const moved = target.tryWrite({ ...chunk, tier: toTier, accessedAt: Date.now(), accessCount: chunk.accessCount + 1 })
    if (!moved) {
      return false
    }

    source.delete(chunkId)
    return true
  }

  private getStore(tier: MemoryTier): MemoryTierStore {
    const store = this.stores.get(tier)
    if (!store) {
      throw new Error(`Unsupported memory tier for phase-1 implementation: ${tier}`)
    }
    return store
  }
}
