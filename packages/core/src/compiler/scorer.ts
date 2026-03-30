import { ChunkType } from '../types/enums.js'
import type { ContextChunk } from '../types/chunk.js'
import type { ScoringWeights } from '../types/config.js'

/**
 * Configuration for chunk scoring behavior.
 */
export interface ScoringConfig {
  /**
   * Optional weights used in the importance score weighted sum.
   */
  weights?: ScoringWeights
  /**
   * Exponential decay lambda for recency in hours^-1.
   * Defaults to 0.1.
   */
  recencyDecayLambda?: number
  /**
   * Maximum access count used for frequency normalization.
   * Defaults to 100.
   */
  maxAccessCount?: number
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  relevance: 0.4,
  recency: 0.2,
  frequency: 0.2,
  anchoring: 0.2
}

const DEFAULT_RECENCY_DECAY_LAMBDA = 0.1
const DEFAULT_MAX_ACCESS_COUNT = 100

const ANCHORING_BY_TYPE: Record<ChunkType, number> = {
  [ChunkType.USER_CONSTRAINT]: 1.0,
  [ChunkType.DECISION]: 0.9,
  [ChunkType.ERROR_CORRECTION]: 0.85,
  [ChunkType.FACT]: 0.7,
  [ChunkType.TOOL_RESULT]: 0.5,
  [ChunkType.REASONING_STEP]: 0.3,
  [ChunkType.OBSERVATION]: 0.2
}

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu

const clamp01 = (value: number): number => {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 0
  }

  if (value < 0) {
    return 0
  }

  if (value > 1) {
    return 1
  }

  return value
}

const tokenize = (text: string): string[] => {
  const normalized = text.toLowerCase().trim()
  if (normalized.length === 0) {
    return []
  }

  const matches = normalized.match(TOKEN_PATTERN)
  return matches?.filter(Boolean) ?? []
}

/**
 * Calculates a normalized (0-1) weighted ImportanceScore for a single chunk.
 * The computed score is also written back to `chunk.score`.
 */
export const scoreChunk = (
  chunk: ContextChunk,
  query: string,
  config: ScoringConfig = {}
): number => {
  const weights = config.weights ?? DEFAULT_WEIGHTS
  const relevance = calculateRelevance(chunk, query)
  const recency = calculateRecency(
    chunk.createdAt,
    Date.now(),
    config.recencyDecayLambda
  )
  const frequency = calculateFrequency(
    chunk.accessCount,
    config.maxAccessCount ?? DEFAULT_MAX_ACCESS_COUNT
  )
  const anchoring = calculateAnchoring(chunk.type)

  const total =
    relevance * weights.relevance +
    recency * weights.recency +
    frequency * weights.frequency +
    anchoring * weights.anchoring

  const normalized = clamp01(total)
  chunk.score = normalized
  return normalized
}

/**
 * Scores all chunks against a query, mutates each chunk's score,
 * and returns the chunks sorted by score (descending).
 */
export const scoreChunks = (
  chunks: ContextChunk[],
  query: string,
  config: ScoringConfig = {}
): ContextChunk[] => {
  for (const chunk of chunks) {
    scoreChunk(chunk, query, config)
  }

  return [...chunks].sort((a, b) => {
    if (b.score === a.score) {
      if (a.type === ChunkType.USER_CONSTRAINT && b.type !== ChunkType.USER_CONSTRAINT) {
        return -1
      }
      if (b.type === ChunkType.USER_CONSTRAINT && a.type !== ChunkType.USER_CONSTRAINT) {
        return 1
      }
      return b.createdAt - a.createdAt
    }

    if (a.type === ChunkType.USER_CONSTRAINT && b.type !== ChunkType.USER_CONSTRAINT) {
      return -1
    }

    if (b.type === ChunkType.USER_CONSTRAINT && a.type !== ChunkType.USER_CONSTRAINT) {
      return 1
    }

    return b.score - a.score
  })
}

/**
 * Calculates lightweight text relevance (0-1) between chunk content and query
 * using weighted token-overlap and Jaccard similarity.
 */
export const calculateRelevance = (chunk: ContextChunk, query: string): number => {
  const contentTokens = tokenize(chunk.content)
  const queryTokens = tokenize(query)

  if (contentTokens.length === 0 || queryTokens.length === 0) {
    return 0
  }

  const contentCounts = new Map<string, number>()
  for (const token of contentTokens) {
    contentCounts.set(token, (contentCounts.get(token) ?? 0) + 1)
  }

  const queryCounts = new Map<string, number>()
  for (const token of queryTokens) {
    queryCounts.set(token, (queryCounts.get(token) ?? 0) + 1)
  }

  const contentSet = new Set(contentTokens)
  const querySet = new Set(queryTokens)

  let intersection = 0
  for (const token of querySet) {
    if (contentSet.has(token)) {
      intersection += 1
    }
  }

  const union = new Set([...contentSet, ...querySet]).size
  const jaccard = union > 0 ? intersection / union : 0

  let weightedOverlapNumerator = 0
  let weightedOverlapDenominator = 0
  for (const [token, queryCount] of queryCounts) {
    weightedOverlapDenominator += queryCount
    const contentCount = contentCounts.get(token) ?? 0
    weightedOverlapNumerator += Math.min(queryCount, contentCount)
  }

  const weightedOverlap =
    weightedOverlapDenominator > 0
      ? weightedOverlapNumerator / weightedOverlapDenominator
      : 0

  return clamp01(weightedOverlap * 0.7 + jaccard * 0.3)
}

/**
 * Calculates recency score (0-1) with exponential decay by age in hours.
 */
export const calculateRecency = (
  createdAt: number,
  now: number = Date.now(),
  lambda: number = DEFAULT_RECENCY_DECAY_LAMBDA
): number => {
  const safeLambda = lambda > 0 ? lambda : DEFAULT_RECENCY_DECAY_LAMBDA
  const ageMs = Math.max(0, now - createdAt)
  const ageHours = ageMs / (1000 * 60 * 60)
  return clamp01(Math.exp(-safeLambda * ageHours))
}

/**
 * Calculates frequency score (0-1) from access count normalized by maxAccess.
 */
export const calculateFrequency = (
  accessCount: number,
  maxAccess: number = DEFAULT_MAX_ACCESS_COUNT
): number => {
  const safeMax = Math.max(maxAccess, 1)
  const safeAccess = Math.max(accessCount, 0)
  return clamp01(safeAccess / safeMax)
}

/**
 * Returns fixed anchoring score (0-1) for a chunk type.
 */
export const calculateAnchoring = (chunkType: ChunkType): number => {
  return ANCHORING_BY_TYPE[chunkType] ?? 0
}

export const DEFAULT_SCORING_CONFIG: Required<ScoringConfig> = {
  weights: DEFAULT_WEIGHTS,
  recencyDecayLambda: DEFAULT_RECENCY_DECAY_LAMBDA,
  maxAccessCount: DEFAULT_MAX_ACCESS_COUNT
}
