import type { MemoryTier } from './enums.js'

/**
 * Build statistics returned after context assembly.
 */
export interface Stats {
  /** Number of tokens saved by optimization. */
  tokensSaved: number
  /** Estimated cost savings for this build. */
  costSaved: number
  /** Number of memory retrieval hits. */
  memoryHits: number
  /** End-to-end build latency in ms. */
  latencyMs: number
  /** Compression ratio for input/output context. */
  compressionRatio: number
  /** Utilization share by memory tier. */
  tierUtilization: Record<MemoryTier, number>
}

/**
 * Final output from a context build cycle.
 */
export interface BuildResult {
  /** Compiled context payload. */
  context: string
  /** Build metrics and optimization stats. */
  stats: Stats
}
