import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TelemetryCollector,
  detectContentLeakage,
  defaultCollectorConfig,
} from '../collector.js'
import type { TelemetryEvent } from '../types.js'

// ── Helpers ──────────────────────────────────────────────────────

const NOW = 1_700_000_000_000

function createEvent(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    eventType: 'build',
    inputTokens: 2000,
    outputTokens: 1000,
    tokensSaved: 1000,
    compressionRatio: 2,
    chunkCount: 15,
    evictedCount: 0,
    avgImportanceScore: 0.72,
    scoreDistribution: [0.1, 0.3, 0.6],
    tierUtilization: { L0: 0.1, L1: 0.5, L2: 0.4 },
    searchHitRate: 0.85,
    buildLatencyMs: 24,
    chunkTypes: { FACT: 8, DECISION: 4, TOOL_RESULT: 3 },
    sessionLength: 10,
    timestamp: NOW,
    ...overrides,
  }
}

function makeCollector(
  overrides?: Partial<ConstructorParameters<typeof TelemetryCollector>[0]>,
): TelemetryCollector {
  return new TelemetryCollector({
    enabled: true,
    flushIntervalMs: 0, // disable interval in tests
    now: () => NOW,
    ...overrides,
  })
}

// ── Tests ────────────────────────────────────────────────────────

describe('TelemetryCollector', () => {
  let collector: TelemetryCollector

  beforeEach(() => {
    collector = makeCollector()
  })

  afterEach(async () => {
    if (collector.isRunning()) {
      await collector.stop()
    }
  })

  // ── Lifecycle ────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      expect(collector.isRunning()).toBe(false)
      collector.start()
      expect(collector.isRunning()).toBe(true)
      await collector.stop()
      expect(collector.isRunning()).toBe(false)
    })

    it('start is idempotent', () => {
      collector.start()
      collector.start()
      expect(collector.isRunning()).toBe(true)
    })

    it('stop is idempotent', async () => {
      await collector.stop()
      await collector.stop()
      expect(collector.isRunning()).toBe(false)
    })

    it('flushes remaining events on stop', async () => {
      collector.start()
      collector.record(createEvent())
      collector.record(createEvent({ eventType: 'evict' }))
      expect(collector.getBufferSize()).toBe(2)
      await collector.stop()
      expect(collector.getBufferSize()).toBe(0)
      expect(collector.export()).toHaveLength(2)
    })

    it('sets up interval flush when flushIntervalMs > 0', async () => {
      vi.useFakeTimers()
      const onFlush = vi.fn()
      const c = new TelemetryCollector({
        enabled: true,
        flushIntervalMs: 100,
        now: () => NOW,
        onFlush,
      })
      c.start()
      c.record(createEvent())
      vi.advanceTimersByTime(100)
      // Give the async flush a tick
      await vi.runAllTimersAsync()
      expect(onFlush).toHaveBeenCalled()
      await c.stop()
      vi.useRealTimers()
    })
  })

  // ── Recording ────────────────────────────────────────────────

  describe('recording', () => {
    it('records valid events into buffer', () => {
      const accepted = collector.record(createEvent())
      expect(accepted).toBe(true)
      expect(collector.getBufferSize()).toBe(1)
    })

    it('records multiple event types', () => {
      collector.record(createEvent({ eventType: 'build' }))
      collector.record(createEvent({ eventType: 'evict' }))
      collector.record(createEvent({ eventType: 'search' }))
      collector.record(createEvent({ eventType: 'heal' }))
      expect(collector.getBufferSize()).toBe(4)
    })

    it('drops events when disabled', () => {
      const c = makeCollector({ enabled: false })
      const accepted = c.record(createEvent())
      expect(accepted).toBe(false)
      expect(c.getBufferSize()).toBe(0)
    })

    it('drops events after opt-out', () => {
      collector.record(createEvent())
      collector.optOutOfTelemetry()
      const accepted = collector.record(createEvent())
      expect(accepted).toBe(false)
      // Buffer cleared on opt-out
      expect(collector.getBufferSize()).toBe(0)
    })

    it('auto-flushes when buffer reaches maxBufferSize', async () => {
      const onFlush = vi.fn()
      const c = makeCollector({ maxBufferSize: 3, onFlush })
      for (let i = 0; i < 3; i++) {
        c.record(createEvent())
      }
      // Allow async flush to complete
      await new Promise((r) => setTimeout(r, 10))
      expect(onFlush).toHaveBeenCalled()
    })
  })

  // ── Flush ────────────────────────────────────────────────────

  describe('flush', () => {
    it('returns 0 for empty buffer', async () => {
      const count = await collector.flush()
      expect(count).toBe(0)
    })

    it('flushes all buffered events', async () => {
      collector.record(createEvent())
      collector.record(createEvent({ eventType: 'evict' }))
      const count = await collector.flush()
      expect(count).toBe(2)
      expect(collector.getBufferSize()).toBe(0)
    })

    it('calls onFlush handler with events', async () => {
      const onFlush = vi.fn()
      const c = makeCollector({ onFlush })
      c.record(createEvent())
      await c.flush()
      expect(onFlush).toHaveBeenCalledTimes(1)
      expect(onFlush.mock.calls[0][0]).toHaveLength(1)
    })

    it('processes in batches respecting batchSize', async () => {
      const onFlush = vi.fn()
      const c = makeCollector({ batchSize: 2, onFlush })
      for (let i = 0; i < 5; i++) {
        c.record(createEvent())
      }
      await c.flush()
      // 5 events / 2 batch = 3 batches
      expect(onFlush).toHaveBeenCalledTimes(3)
      expect(onFlush.mock.calls[0][0]).toHaveLength(2)
      expect(onFlush.mock.calls[1][0]).toHaveLength(2)
      expect(onFlush.mock.calls[2][0]).toHaveLength(1)
    })

    it('handles onFlush errors gracefully', async () => {
      const onFlush = vi.fn().mockRejectedValue(new Error('network error'))
      const c = makeCollector({ onFlush })
      c.record(createEvent())
      const count = await c.flush()
      // Events are lost (intentional)
      expect(count).toBe(0)
      expect(c.getStats().totalDropped).toBe(1)
    })

    it('allows concurrent recording during flush', async () => {
      const onFlush = vi.fn().mockImplementation(async () => {
        // Simulate slow flush
        await new Promise((r) => setTimeout(r, 10))
      })
      const c = makeCollector({ onFlush })
      c.record(createEvent())
      const flushPromise = c.flush()
      // Record during flush
      c.record(createEvent({ eventType: 'evict' }))
      await flushPromise
      expect(c.getBufferSize()).toBe(1) // new event still in buffer
      expect(c.export()).toHaveLength(1) // first event flushed
    })
  })

  // ── Opt-in / Opt-out ─────────────────────────────────────────

  describe('opt-in/opt-out', () => {
    it('starts in pending state when no enabled flag', () => {
      const c = new TelemetryCollector({ now: () => NOW })
      expect(c.getOptInStatus()).toBe('pending')
    })

    it('opts in when enabled=true', () => {
      expect(collector.getOptInStatus()).toBe('opted-in')
    })

    it('opts out when enabled=false', () => {
      const c = makeCollector({ enabled: false })
      expect(c.getOptInStatus()).toBe('opted-out')
    })

    it('optInToTelemetry enables collection', () => {
      const c = makeCollector({ enabled: false })
      c.optInToTelemetry()
      expect(c.getOptInStatus()).toBe('opted-in')
      const accepted = c.record(createEvent())
      expect(accepted).toBe(true)
    })

    it('optOutOfTelemetry disables collection and clears buffer', () => {
      collector.record(createEvent())
      expect(collector.getBufferSize()).toBe(1)
      collector.optOutOfTelemetry()
      expect(collector.getOptInStatus()).toBe('opted-out')
      expect(collector.getBufferSize()).toBe(0)
    })
  })

  // ── Export / Delete ──────────────────────────────────────────

  describe('export and delete', () => {
    it('export returns flushed events', async () => {
      collector.record(createEvent())
      await collector.flush()
      const exported = collector.export()
      expect(exported).toHaveLength(1)
      expect(exported[0].eventType).toBe('build')
    })

    it('export returns defensive copy', async () => {
      collector.record(createEvent())
      await collector.flush()
      const a = collector.export()
      const b = collector.export()
      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })

    it('exportAll includes buffered + flushed + stats', async () => {
      collector.record(createEvent())
      await collector.flush()
      collector.record(createEvent({ eventType: 'search' }))
      const json = collector.exportAll()
      const data = JSON.parse(json)
      expect(data.flushed).toHaveLength(1)
      expect(data.buffered).toHaveLength(1)
      expect(data.stats.totalRecorded).toBe(2)
      expect(typeof data.exportedAt).toBe('number')
    })

    it('delete clears all data and resets counters', async () => {
      collector.record(createEvent())
      await collector.flush()
      collector.record(createEvent())
      collector.delete()
      expect(collector.getBufferSize()).toBe(0)
      expect(collector.export()).toHaveLength(0)
      const stats = collector.getStats()
      expect(stats.totalRecorded).toBe(0)
      expect(stats.totalFlushed).toBe(0)
      expect(stats.flushCount).toBe(0)
    })
  })

  // ── Stats ────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns accurate aggregate stats', async () => {
      collector.start()
      collector.record(createEvent())
      collector.record(createEvent())
      await collector.flush()
      collector.record(createEvent())

      const stats = collector.getStats()
      expect(stats.running).toBe(true)
      expect(stats.totalRecorded).toBe(3)
      expect(stats.totalFlushed).toBe(2)
      expect(stats.bufferSize).toBe(1)
      expect(stats.flushCount).toBe(1)
      expect(stats.totalDropped).toBe(0)
    })
  })

  // ── Event filtering ──────────────────────────────────────────

  describe('getEventsByType', () => {
    it('filters flushed events by type', async () => {
      collector.record(createEvent({ eventType: 'build' }))
      collector.record(createEvent({ eventType: 'evict' }))
      collector.record(createEvent({ eventType: 'build' }))
      await collector.flush()

      expect(collector.getEventsByType('build')).toHaveLength(2)
      expect(collector.getEventsByType('evict')).toHaveLength(1)
      expect(collector.getEventsByType('search')).toHaveLength(0)
    })
  })

  // ── Logger ───────────────────────────────────────────────────

  describe('logging', () => {
    it('logs via custom logger', () => {
      const log = vi.fn()
      const c = makeCollector({ logger: { log } })
      c.start()
      expect(log).toHaveBeenCalledWith('Collector started')
    })

    it('logs via console when logger=true', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const c = makeCollector({ logger: true })
      c.start()
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('[zerix:telemetry]'),
      )
      spy.mockRestore()
    })

    it('no logging when logger is undefined', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const c = makeCollector({ logger: undefined })
      c.start()
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  // ── Default config ───────────────────────────────────────────

  describe('defaultCollectorConfig', () => {
    it('has sane defaults', () => {
      expect(defaultCollectorConfig.enabled).toBe(false)
      expect(defaultCollectorConfig.flushIntervalMs).toBe(30_000)
      expect(defaultCollectorConfig.maxBufferSize).toBe(500)
      expect(defaultCollectorConfig.batchSize).toBe(100)
    })
  })
})

// ── Privacy (content leakage detection) ────────────────────────

describe('detectContentLeakage', () => {
  it('accepts a valid event', () => {
    expect(detectContentLeakage(createEvent())).toBeUndefined()
  })

  it('rejects unknown eventType', () => {
    const event = createEvent()
    ;(event as unknown as Record<string, unknown>).eventType = 'unknown'
    expect(detectContentLeakage(event)).toMatch(/Unknown eventType/)
  })

  it('rejects non-number in numeric fields', () => {
    const event = createEvent()
    ;(event as unknown as Record<string, unknown>).inputTokens = 'should be number'
    expect(detectContentLeakage(event)).toMatch(/must be a number/)
  })

  it('rejects non-array scoreDistribution', () => {
    const event = createEvent()
    ;(event as unknown as Record<string, unknown>).scoreDistribution = 'not an array'
    expect(detectContentLeakage(event)).toMatch(/must be an array/)
  })

  it('rejects string in scoreDistribution', () => {
    const event = createEvent()
    ;(event as unknown as Record<string, unknown>).scoreDistribution = [0.1, 'oops']
    expect(detectContentLeakage(event)).toMatch(/non-number/)
  })

  it('rejects non-number values in record fields', () => {
    const event = createEvent()
    ;(event as unknown as Record<string, unknown>).tierUtilization = { L0: 'leaked content' }
    expect(detectContentLeakage(event)).toMatch(/must be a number/)
  })

  it('rejects unknown fields as potential content leakage', () => {
    const event = createEvent()
    ;(event as unknown as Record<string, unknown>).rawContent = 'user secret data'
    expect(detectContentLeakage(event)).toMatch(/Unknown field/)
  })

  it('rejects all four event types correctly', () => {
    for (const t of ['build', 'evict', 'search', 'heal'] as const) {
      expect(detectContentLeakage(createEvent({ eventType: t }))).toBeUndefined()
    }
  })

  it('validates every numeric field individually', () => {
    const numericFields = [
      'inputTokens', 'outputTokens', 'tokensSaved', 'compressionRatio',
      'chunkCount', 'evictedCount', 'avgImportanceScore', 'searchHitRate',
      'buildLatencyMs', 'sessionLength', 'timestamp',
    ]
    for (const field of numericFields) {
      const event = createEvent()
      ;(event as unknown as Record<string, unknown>)[field] = 'string_value'
      const result = detectContentLeakage(event)
      expect(result).toBeDefined()
      expect(result).toMatch(/must be a number/)
    }
  })
})
