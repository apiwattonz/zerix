import { MemoryTier, type ContextChunk } from '../types/index.js'

/**
 * Runtime statistics for a single memory tier.
 */
export interface TierStats {
  /** Number of chunks stored in this tier. */
  chunkCount: number
  /** Total token count across chunks in this tier. */
  totalTokens: number
  /** Maximum token capacity for this tier. */
  maxTokens: number
  /** Utilization percentage in range [0, 1]. */
  utilization: number
}

/**
 * Aggregate runtime statistics for all managed memory tiers.
 */
export interface MemoryStats {
  /** Per-tier statistics. */
  tiers: Record<MemoryTier, TierStats>
  /** Total chunk count across all tiers. */
  totalChunks: number
  /** Total token count across all tiers. */
  totalTokens: number
}

/**
 * Configurable capacity and persistence settings for tiered memory.
 */
export interface MemoryConfig {
  /** Max token budget for L0 register tier. */
  l0MaxTokens?: number
  /** Max token budget for L1 cache tier. */
  l1MaxTokens?: number
  /** Max token budget for L2 RAM tier. */
  l2MaxTokens?: number
  /** SQLite file path for L2 RAM persistence. */
  dbPath?: string
}

/**
 * Unified interface exposed by the tiered memory subsystem.
 */
export interface MemoryStore {
  /** Read all chunks from a tier. */
  read(tier: MemoryTier): ContextChunk[]
  /** Write a chunk into a tier. */
  write(tier: MemoryTier, chunk: ContextChunk): void
  /** Search chunks in a tier. */
  search(tier: MemoryTier, query: string, limit?: number): ContextChunk[]
  /** Delete one chunk from a tier by id. */
  delete(tier: MemoryTier, chunkId: string): boolean
  /** Remove all chunks from a tier. */
  clear(tier: MemoryTier): void
  /** Get aggregate statistics for all managed tiers. */
  stats(): MemoryStats
  /** Move a chunk from one tier to another (upward). */
  promote(chunkId: string, fromTier: MemoryTier, toTier: MemoryTier): boolean
  /** Move a chunk from one tier to another (downward). */
  demote(chunkId: string, fromTier: MemoryTier, toTier: MemoryTier): boolean
}

/**
 * Internal interface for one concrete tier backend.
 */
export interface MemoryTierStore {
  read(): ContextChunk[]
  write(chunk: ContextChunk): void
  /**
   * Attempt write without throwing for capacity-related overflow.
   * Returns true on success and false when capacity constraints block insertion.
   */
  tryWrite(chunk: ContextChunk): boolean
  search(query: string, limit?: number): ContextChunk[]
  delete(chunkId: string): boolean
  clear(): void
  stats(): TierStats
}

/**
 * Default max token capacities for active tiers in phase 1.
 */
export const DEFAULT_MEMORY_CONFIG: Required<MemoryConfig> = {
  l0MaxTokens: 500,
  l1MaxTokens: 4_000,
  l2MaxTokens: 16_000,
  dbPath: '.zerix/memory.db'
}

/**
 * Active phase-1 tiers (L0-L2).
 */
export const ACTIVE_MEMORY_TIERS: MemoryTier[] = [
  MemoryTier.L0_REGISTER,
  MemoryTier.L1_CACHE,
  MemoryTier.L2_RAM
]

/**
 * Create an empty stats object for all known enum tiers.
 */
export const createEmptyMemoryStats = (): MemoryStats => ({
  tiers: {
    L0_REGISTER: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
    L1_CACHE: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
    L2_RAM: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
    L3_SSD: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
    L4_ARCHIVE: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 }
  },
  totalChunks: 0,
  totalTokens: 0
})
