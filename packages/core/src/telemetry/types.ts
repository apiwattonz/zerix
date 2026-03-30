/**
 * Supported telemetry event kinds emitted by the core pipeline.
 */
export type TelemetryEventType = 'build' | 'evict' | 'search' | 'heal'

/**
 * Privacy-first telemetry payload.
 *
 * Important: this event stores only aggregate usage patterns/metrics,
 * never raw user content.
 */
export interface TelemetryEvent {
  /** Event category. */
  eventType: TelemetryEventType
  /** Input token count before processing. */
  inputTokens: number
  /** Output token count after compilation. */
  outputTokens: number
  /** Number of tokens saved by optimization. */
  tokensSaved: number
  /** inputTokens / outputTokens ratio. */
  compressionRatio: number
  /** Number of chunks considered in this operation. */
  chunkCount: number
  /** Number of chunks evicted during this operation. */
  evictedCount: number
  /** Mean importance score across involved chunks. */
  avgImportanceScore: number
  /** Score histogram/distribution buckets. */
  scoreDistribution: number[]
  /** Utilization percentage by memory tier key. */
  tierUtilization: Record<string, number>
  /** Retrieval hit-rate for search operations. */
  searchHitRate: number
  /** Build latency in milliseconds. */
  buildLatencyMs: number
  /** Count of chunk types touched in operation. */
  chunkTypes: Record<string, number>
  /** Session length in turn count. */
  sessionLength: number
  /** Unix timestamp in milliseconds. */
  timestamp: number
}
