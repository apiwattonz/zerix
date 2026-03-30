import { describe, expect, it } from 'vitest'
import type { TelemetryEvent } from '../telemetry/types.js'
import { defaultTelemetryConfig } from '../telemetry/config.js'

describe('telemetry', () => {
  it('has expected default OSS config', () => {
    expect(defaultTelemetryConfig.enabled).toBe(false)
    expect(defaultTelemetryConfig.endpointUrl).toBe('')
    expect(defaultTelemetryConfig.batchSize).toBe(100)
  })

  it('accepts valid telemetry event shape', () => {
    const event: TelemetryEvent = {
      eventType: 'build',
      inputTokens: 2000,
      outputTokens: 1000,
      tokensSaved: 1000,
      compressionRatio: 2,
      chunkCount: 15,
      evictedCount: 2,
      avgImportanceScore: 0.72,
      scoreDistribution: [0.1, 0.3, 0.6],
      tierUtilization: { L0: 0.1, L1: 0.5, L2: 0.4 },
      searchHitRate: 0.85,
      buildLatencyMs: 24,
      chunkTypes: { FACT: 8, DECISION: 4, TOOL_RESULT: 3 },
      sessionLength: 10,
      timestamp: Date.now()
    }

    expect(event.tokensSaved).toBe(1000)
    expect(event.eventType).toBe('build')
  })
})
