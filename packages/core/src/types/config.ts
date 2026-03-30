import type { TokenBudget } from './budget.js'

/**
 * Weight configuration for ImportanceScore factors.
 */
export interface ScoringWeights {
  /** Relevance factor weight. */
  relevance: number
  /** Recency factor weight. */
  recency: number
  /** Frequency factor weight. */
  frequency: number
  /** Anchoring factor weight. */
  anchoring: number
}

/**
 * Core compiler configuration.
 */
export interface CompilerConfig {
  /** Token budget used during context build. */
  budget: TokenBudget
  /** Weights used by scoring logic. */
  scoringWeights: ScoringWeights
  /** Utilization threshold that triggers eviction. */
  evictionThreshold: number
}
