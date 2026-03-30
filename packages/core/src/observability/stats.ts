import type { MemoryTier } from '../types/enums.js'

/**
 * Logger interface accepted by the stats collector.
 */
export interface StatsLogFn {
  log: (msg: string) => void
}

/**
 * Cost estimation configuration.
 */
export interface CostConfig {
  /** Dollar cost per 1,000 input tokens. */
  inputCostPer1k: number
  /** Dollar cost per 1,000 output tokens. */
  outputCostPer1k: number
}

/**
 * Configuration for the StatsCollector.
 */
export interface StatsCollectorConfig {
  /** Cost estimation rates. */
  cost: CostConfig
  /** Injectable clock for deterministic testing. */
  now?: () => number
  /** Optional logger. */
  logger?: StatsLogFn | boolean
}

/**
 * Per-build metrics snapshot.
 */
export interface BuildMetrics {
  /** Input tokens before optimization. */
  tokensInput: number
  /** Output tokens after optimization. */
  tokensOutput: number
  /** Tokens saved by compression/eviction. */
  tokensSaved: number
  /** Build latency in milliseconds. */
  latencyMs: number
  /** Compression ratio (input/output). */
  compressionRatio: number
  /** Estimated cost of this build in dollars. */
  estimatedCost: number
  /** Estimated savings of this build in dollars. */
  estimatedSavings: number
  /** Timestamp of this build. */
  timestamp: number
}

/**
 * Cumulative metrics across all recorded builds.
 */
export interface CumulativeMetrics {
  /** Total tokens saved across all builds. */
  totalSaved: number
  /** Total number of builds recorded. */
  totalBuilds: number
  /** Average compression ratio across all builds. */
  avgCompressionRatio: number
  /** Total input tokens processed. */
  totalInputTokens: number
  /** Total output tokens produced. */
  totalOutputTokens: number
  /** Total estimated cost in dollars. */
  totalCost: number
  /** Total estimated savings in dollars. */
  totalSavings: number
  /** Average build latency in milliseconds. */
  avgLatencyMs: number
  /** Minimum build latency observed. */
  minLatencyMs: number
  /** Maximum build latency observed. */
  maxLatencyMs: number
}

/**
 * Memory utilization snapshot per tier.
 */
export interface TierUtilizationSnapshot {
  /** Tier identifier. */
  tier: MemoryTier
  /** Token count in this tier. */
  tokens: number
  /** Utilization ratio [0, 1]. */
  utilization: number
  /** Chunk count in this tier. */
  chunkCount: number
}

/**
 * Complete stats export structure.
 */
export interface StatsExport {
  builds: ReadonlyArray<BuildMetrics>
  cumulative: CumulativeMetrics
  tierSnapshots: ReadonlyArray<TierUtilizationSnapshot>
  exportedAt: number
}

/**
 * Default cost configuration based on typical LLM pricing.
 */
export const defaultCostConfig: CostConfig = {
  inputCostPer1k: 0.003,
  outputCostPer1k: 0.015,
}

/**
 * Default stats collector configuration.
 */
export const defaultStatsConfig: StatsCollectorConfig = {
  cost: defaultCostConfig,
}

/**
 * Resolves a logger config into a callable or undefined.
 */
function resolveLogger(
  logger: StatsLogFn | boolean | undefined,
): StatsLogFn | undefined {
  if (logger === true) {
    return { log: (msg: string) => console.log(`[zerix:stats] ${msg}`) }
  }
  if (logger && typeof logger === 'object' && typeof logger.log === 'function') {
    return logger
  }
  return undefined
}

/**
 * Collects per-build and cumulative stats for context compilation.
 *
 * Tracks token usage, cost estimation, latency, and memory utilization.
 * All data is exportable as JSON.
 *
 * @example
 * ```ts
 * const stats = new StatsCollector({ cost: { inputCostPer1k: 0.003, outputCostPer1k: 0.015 } })
 * stats.recordBuild({ tokensInput: 2000, tokensOutput: 1000, latencyMs: 24 })
 * stats.recordTierUtilization(MemoryTier.L0_REGISTER, 450, 0.9, 5)
 * console.log(stats.getCumulative())
 * ```
 */
export class StatsCollector {
  private readonly config: StatsCollectorConfig
  private readonly logger: StatsLogFn | undefined
  private readonly now: () => number
  private readonly builds: BuildMetrics[] = []
  private readonly tierSnapshots: TierUtilizationSnapshot[] = []

  // Cumulative accumulators
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalSaved = 0
  private totalCost = 0
  private totalSavings = 0
  private totalLatencyMs = 0
  private minLatencyMs = Infinity
  private maxLatencyMs = -Infinity

  constructor(config?: Partial<StatsCollectorConfig>) {
    this.config = {
      cost: config?.cost ?? defaultCostConfig,
      now: config?.now,
      logger: config?.logger,
    }
    this.logger = resolveLogger(this.config.logger)
    this.now = this.config.now ?? (() => Date.now())
  }

  // ── Recording ─────────────────────────────────────────────────

  /**
   * Records metrics from a single build.
   *
   * Accepts raw token counts and latency. Computes compression ratio,
   * cost estimate, and savings automatically.
   */
  recordBuild(input: {
    tokensInput: number
    tokensOutput: number
    latencyMs: number
    timestamp?: number
  }): BuildMetrics {
    const { tokensInput, tokensOutput, latencyMs } = input
    const tokensSaved = Math.max(0, tokensInput - tokensOutput)
    const compressionRatio = tokensOutput > 0 ? tokensInput / tokensOutput : 0
    const estimatedCost =
      (tokensInput / 1000) * this.config.cost.inputCostPer1k +
      (tokensOutput / 1000) * this.config.cost.outputCostPer1k
    const estimatedSavings =
      (tokensSaved / 1000) * this.config.cost.inputCostPer1k
    const ts = input.timestamp ?? this.now()

    const metrics: BuildMetrics = {
      tokensInput,
      tokensOutput,
      tokensSaved,
      latencyMs,
      compressionRatio,
      estimatedCost,
      estimatedSavings,
      timestamp: ts,
    }

    this.builds.push(metrics)

    // Update accumulators
    this.totalInputTokens += tokensInput
    this.totalOutputTokens += tokensOutput
    this.totalSaved += tokensSaved
    this.totalCost += estimatedCost
    this.totalSavings += estimatedSavings
    this.totalLatencyMs += latencyMs
    if (latencyMs < this.minLatencyMs) this.minLatencyMs = latencyMs
    if (latencyMs > this.maxLatencyMs) this.maxLatencyMs = latencyMs

    this.logger?.log(
      `Build recorded: ${tokensInput}→${tokensOutput} tokens, ${latencyMs}ms, $${estimatedCost.toFixed(4)}`,
    )

    return metrics
  }

  /**
   * Records a memory tier utilization snapshot.
   */
  recordTierUtilization(
    tier: MemoryTier,
    tokens: number,
    utilization: number,
    chunkCount: number,
  ): void {
    this.tierSnapshots.push({ tier, tokens, utilization, chunkCount })
  }

  // ── Querying ──────────────────────────────────────────────────

  /**
   * Returns cumulative metrics across all recorded builds.
   */
  getCumulative(): CumulativeMetrics {
    const n = this.builds.length
    return {
      totalSaved: this.totalSaved,
      totalBuilds: n,
      avgCompressionRatio:
        n > 0
          ? this.builds.reduce((s, b) => s + b.compressionRatio, 0) / n
          : 0,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCost: this.totalCost,
      totalSavings: this.totalSavings,
      avgLatencyMs: n > 0 ? this.totalLatencyMs / n : 0,
      minLatencyMs: n > 0 ? this.minLatencyMs : 0,
      maxLatencyMs: n > 0 ? this.maxLatencyMs : 0,
    }
  }

  /**
   * Returns per-build metrics (defensive copy).
   */
  getBuilds(): ReadonlyArray<BuildMetrics> {
    return [...this.builds]
  }

  /**
   * Returns the most recent N builds.
   */
  getRecentBuilds(n: number): ReadonlyArray<BuildMetrics> {
    return this.builds.slice(-Math.max(0, n))
  }

  /**
   * Returns the latest tier utilization snapshots (defensive copy).
   */
  getTierSnapshots(): ReadonlyArray<TierUtilizationSnapshot> {
    return [...this.tierSnapshots]
  }

  /**
   * Returns tier utilization grouped by tier, using only the latest snapshot per tier.
   */
  getLatestTierUtilization(): ReadonlyArray<TierUtilizationSnapshot> {
    const latest = new Map<MemoryTier, TierUtilizationSnapshot>()
    for (const snap of this.tierSnapshots) {
      latest.set(snap.tier, snap)
    }
    return [...latest.values()]
  }

  /** Total number of recorded builds. */
  getBuildCount(): number {
    return this.builds.length
  }

  // ── Cost Estimation ───────────────────────────────────────────

  /**
   * Estimates cost for a given token count without recording a build.
   */
  estimateCost(inputTokens: number, outputTokens: number): number {
    return (
      (inputTokens / 1000) * this.config.cost.inputCostPer1k +
      (outputTokens / 1000) * this.config.cost.outputCostPer1k
    )
  }

  /**
   * Returns the current cost configuration.
   */
  getCostConfig(): Readonly<CostConfig> {
    return { ...this.config.cost }
  }

  // ── Export ────────────────────────────────────────────────────

  /**
   * Exports all stats as a JSON-serializable structure.
   */
  exportJSON(): StatsExport {
    return {
      builds: [...this.builds],
      cumulative: this.getCumulative(),
      tierSnapshots: [...this.tierSnapshots],
      exportedAt: this.now(),
    }
  }

  /**
   * Exports all stats as a formatted JSON string.
   */
  exportString(): string {
    return JSON.stringify(this.exportJSON(), null, 2)
  }

  // ── Reset ─────────────────────────────────────────────────────

  /**
   * Clears all recorded data and resets accumulators.
   */
  reset(): void {
    this.builds.length = 0
    this.tierSnapshots.length = 0
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalSaved = 0
    this.totalCost = 0
    this.totalSavings = 0
    this.totalLatencyMs = 0
    this.minLatencyMs = Infinity
    this.maxLatencyMs = -Infinity
    this.logger?.log('Stats reset')
  }
}
