import type { TelemetryEvent, TelemetryEventType } from './types.js'
import type { TelemetryConfig } from './config.js'
import { defaultTelemetryConfig } from './config.js'

/**
 * Logger interface accepted by the collector.
 * Pass `true` for default console logging, or an object with a `log` method.
 */
export interface CollectorLogFn {
  log: (msg: string) => void
}

/**
 * Configuration for the TelemetryCollector.
 */
export interface CollectorConfig extends TelemetryConfig {
  /** Flush interval in milliseconds. 0 disables interval-based flush. */
  flushIntervalMs: number
  /** Maximum buffer size before auto-flush. */
  maxBufferSize: number
  /** Local SQLite path for self-host persistence. Empty string disables local storage. */
  localDbPath: string
  /** Injectable clock for deterministic testing. */
  now?: () => number
  /** Optional logger. */
  logger?: CollectorLogFn | boolean
  /** Flush handler — receives a batch of events. Return promise for async sinks. */
  onFlush?: (events: ReadonlyArray<TelemetryEvent>) => void | Promise<void>
}

/**
 * Default collector configuration.
 */
export const defaultCollectorConfig: CollectorConfig = {
  ...defaultTelemetryConfig,
  flushIntervalMs: 30_000,
  maxBufferSize: 500,
  localDbPath: '',
}

/**
 * Telemetry opt-in status.
 */
export type OptInStatus = 'opted-in' | 'opted-out' | 'pending'

/** Internal event stored in the buffer. */
interface BufferedEvent {
  event: TelemetryEvent
  bufferedAt: number
}

/**
 * Resolves a logger config value into a callable or undefined.
 */
function resolveLogger(
  logger: CollectorLogFn | boolean | undefined,
): CollectorLogFn | undefined {
  if (logger === true) {
    return { log: (msg: string) => console.log(`[zerix:telemetry] ${msg}`) }
  }
  if (logger && typeof logger === 'object' && typeof logger.log === 'function') {
    return logger
  }
  return undefined
}

// ── Content leak detection ─────────────────────────────────────────

/** Fields that must never contain raw user content. */
const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  'inputTokens', 'outputTokens', 'tokensSaved', 'compressionRatio',
  'chunkCount', 'evictedCount', 'avgImportanceScore', 'searchHitRate',
  'buildLatencyMs', 'sessionLength', 'timestamp',
])

const ALLOWED_RECORD_FIELDS: ReadonlySet<string> = new Set([
  'tierUtilization', 'chunkTypes',
])

/**
 * Validates that a telemetry event contains ZERO raw content.
 * Returns an error message if content leakage is detected, otherwise undefined.
 */
export function detectContentLeakage(event: TelemetryEvent): string | undefined {
  for (const [key, value] of Object.entries(event)) {
    if (key === 'eventType') {
      // Must be a known event type string
      const allowed: ReadonlyArray<string> = ['build', 'evict', 'search', 'heal']
      if (!allowed.includes(value as string)) {
        return `Unknown eventType: ${String(value)}`
      }
      continue
    }
    if (key === 'scoreDistribution') {
      if (!Array.isArray(value)) return `scoreDistribution must be an array`
      for (const v of value) {
        if (typeof v !== 'number') return `scoreDistribution contains non-number: ${typeof v}`
      }
      continue
    }
    if (NUMERIC_FIELDS.has(key)) {
      if (typeof value !== 'number') {
        return `Field ${key} must be a number, got ${typeof value}`
      }
      continue
    }
    if (ALLOWED_RECORD_FIELDS.has(key)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `Field ${key} must be a record`
      }
      for (const [rk, rv] of Object.entries(value as Record<string, unknown>)) {
        if (typeof rv !== 'number') {
          return `Field ${key}.${rk} must be a number, got ${typeof rv}`
        }
      }
      continue
    }
    // Unknown field — potential content leakage
    return `Unknown field "${key}" may contain content`
  }
  return undefined
}

// ── TelemetryCollector ─────────────────────────────────────────────

/**
 * In-memory telemetry collector with batch flush, privacy enforcement,
 * and opt-in/out mechanism.
 *
 * @example
 * ```ts
 * const collector = new TelemetryCollector({ enabled: true, batchSize: 50 })
 * collector.start()
 * collector.record({ eventType: 'build', ... })
 * await collector.flush()
 * collector.stop()
 * ```
 */
export class TelemetryCollector {
  private readonly config: CollectorConfig
  private readonly logger: CollectorLogFn | undefined
  private readonly now: () => number

  private buffer: BufferedEvent[] = []
  private flushedEvents: TelemetryEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private optIn: OptInStatus = 'pending'
  private flushCount = 0
  private totalRecorded = 0
  private totalDropped = 0

  constructor(config?: Partial<CollectorConfig>) {
    this.config = { ...defaultCollectorConfig, ...config }
    this.logger = resolveLogger(this.config.logger)
    this.now = this.config.now ?? (() => Date.now())

    // If enabled is explicitly set, determine opt-in status
    if (this.config.enabled) {
      this.optIn = 'opted-in'
    } else if (config?.enabled === false) {
      this.optIn = 'opted-out'
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Starts the collector. Begins interval-based flush if configured.
   * No-op if already running.
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.logger?.log('Collector started')

    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush()
      }, this.config.flushIntervalMs)
      // Unref so the timer doesn't prevent process exit
      if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
        this.flushTimer.unref()
      }
    }
  }

  /**
   * Stops the collector. Flushes remaining buffer before stopping.
   * No-op if not running.
   */
  async stop(): Promise<void> {
    if (!this.running) return
    this.logger?.log('Collector stopping...')

    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Final flush on shutdown
    await this.flush()
    this.running = false
    this.logger?.log('Collector stopped')
  }

  /** Whether the collector is currently running. */
  isRunning(): boolean {
    return this.running
  }

  // ── Opt-in / Opt-out ──────────────────────────────────────────

  /**
   * Opts in to telemetry collection.
   */
  optInToTelemetry(): void {
    this.optIn = 'opted-in'
    this.config.enabled = true
    this.logger?.log('Opted in to telemetry')
  }

  /**
   * Opts out of telemetry collection. Clears existing buffer.
   */
  optOutOfTelemetry(): void {
    this.optIn = 'opted-out'
    this.config.enabled = false
    this.buffer = []
    this.logger?.log('Opted out of telemetry — buffer cleared')
  }

  /** Returns current opt-in status. */
  getOptInStatus(): OptInStatus {
    return this.optIn
  }

  // ── Recording ─────────────────────────────────────────────────

  /**
   * Records a telemetry event into the buffer.
   *
   * Privacy enforcement: rejects events that contain raw content.
   * Respects opt-out: silently drops events when telemetry is disabled.
   *
   * @returns `true` if the event was accepted, `false` if dropped.
   */
  record(event: TelemetryEvent): boolean {
    if (!this.config.enabled || this.optIn === 'opted-out') {
      return false
    }

    // Privacy gate
    const leakage = detectContentLeakage(event)
    if (leakage !== undefined) {
      this.totalDropped++
      this.logger?.log(`Event rejected — content leakage: ${leakage}`)
      return false
    }

    const buffered: BufferedEvent = {
      event,
      bufferedAt: this.now(),
    }
    this.buffer.push(buffered)
    this.totalRecorded++

    // Auto-flush on buffer overflow
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.logger?.log(`Buffer full (${this.buffer.length}), auto-flushing`)
      void this.flush()
    }

    return true
  }

  // ── Flush ─────────────────────────────────────────────────────

  /**
   * Flushes the current buffer in batches.
   *
   * Handles edge cases:
   * - Empty buffer: no-op
   * - Flush during shutdown: processes remaining events
   * - Buffer overflow: processes all accumulated events
   * - onFlush errors: logs and continues
   */
  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0

    // Swap buffer atomically to allow concurrent recording during flush
    const toFlush = this.buffer
    this.buffer = []

    const events = toFlush.map((b) => b.event)
    let flushed = 0

    // Process in batches
    const batchSize = Math.max(1, this.config.batchSize)
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize)
      try {
        if (this.config.onFlush) {
          await this.config.onFlush(batch)
        }
        this.flushedEvents.push(...batch)
        flushed += batch.length
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger?.log(`Flush error: ${msg}`)
        // Events are lost on flush error — intentional to prevent unbounded growth
        this.totalDropped += batch.length
      }
    }

    this.flushCount++
    this.logger?.log(`Flushed ${flushed} events (batch ${this.flushCount})`)
    return flushed
  }

  // ── Data Access ───────────────────────────────────────────────

  /** Returns the current buffer size (unflushed events). */
  getBufferSize(): number {
    return this.buffer.length
  }

  /**
   * Returns aggregate stats about the collector.
   */
  getStats(): {
    running: boolean
    optInStatus: OptInStatus
    bufferSize: number
    totalRecorded: number
    totalFlushed: number
    totalDropped: number
    flushCount: number
  } {
    return {
      running: this.running,
      optInStatus: this.optIn,
      bufferSize: this.buffer.length,
      totalRecorded: this.totalRecorded,
      totalFlushed: this.flushedEvents.length,
      totalDropped: this.totalDropped,
      flushCount: this.flushCount,
    }
  }

  // ── Export / Delete (GDPR-style) ──────────────────────────────

  /**
   * Exports all flushed telemetry events as a JSON-serializable array.
   * Does NOT include buffered (unflushed) events — call flush() first.
   */
  export(): ReadonlyArray<TelemetryEvent> {
    return [...this.flushedEvents]
  }

  /**
   * Exports all telemetry data (flushed + buffered) as JSON string.
   */
  exportAll(): string {
    const data = {
      flushed: this.flushedEvents,
      buffered: this.buffer.map((b) => b.event),
      stats: this.getStats(),
      exportedAt: this.now(),
    }
    return JSON.stringify(data, null, 2)
  }

  /**
   * Deletes all collected telemetry data (flushed and buffered).
   * Resets counters. Does NOT change opt-in status or stop the collector.
   */
  delete(): void {
    this.buffer = []
    this.flushedEvents = []
    this.totalRecorded = 0
    this.totalDropped = 0
    this.flushCount = 0
    this.logger?.log('All telemetry data deleted')
  }

  // ── Event filtering ───────────────────────────────────────────

  /**
   * Returns flushed events filtered by event type.
   */
  getEventsByType(eventType: TelemetryEventType): ReadonlyArray<TelemetryEvent> {
    return this.flushedEvents.filter((e) => e.eventType === eventType)
  }
}
