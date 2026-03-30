import type { ScoringWeights } from './config.js'

/**
 * Raw scoring factors used to compute an importance score.
 */
export interface ScoringFactors {
  /** Query relevance factor. */
  relevance: number
  /** Time-decay/recency factor. */
  recency: number
  /** Access-frequency factor. */
  frequency: number
  /** Anchoring factor by chunk type/role. */
  anchoring: number
}

/**
 * Computed importance score with factor breakdown and final total.
 */
export interface ImportanceScore extends ScoringFactors {
  /** Weighted sum of all factors. */
  total: number
}

/**
 * Default scoring weights from architecture spec.
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  relevance: 0.4,
  recency: 0.2,
  frequency: 0.2,
  anchoring: 0.2
}

/**
 * Calculates a weighted importance score from factors and weights.
 */
export const calculateImportanceScore = (
  factors: ScoringFactors,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ImportanceScore => {
  const total =
    factors.relevance * weights.relevance +
    factors.recency * weights.recency +
    factors.frequency * weights.frequency +
    factors.anchoring * weights.anchoring

  return {
    ...factors,
    total
  }
}
