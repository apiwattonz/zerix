import type { ChunkType, MemoryTier } from './enums.js'

/**
 * Canonical unit of context handled by the compiler and memory tiers.
 */
export interface ContextChunk {
  /** Unique chunk identifier. */
  id: string
  /** Chunk content payload. */
  content: string
  /** Token count for this chunk. */
  tokens: number
  /** Semantic category of the chunk. */
  type: ChunkType
  /** Computed ranking/importance score. */
  score: number
  /** Current memory tier location. */
  tier: MemoryTier
  /** Creation timestamp (unix ms). */
  createdAt: number
  /** Last access timestamp (unix ms). */
  accessedAt: number
  /** Number of times this chunk was accessed. */
  accessCount: number
  /** Time to live in ms, or null for no expiry. */
  ttl: number | null
  /** Additional extensible metadata. */
  metadata: Record<string, unknown>
}
