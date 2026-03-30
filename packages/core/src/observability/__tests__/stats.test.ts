import { describe, it, expect, vi } from 'vitest'
import {
  StatsCollector,
  defaultCostConfig,
  defaultStatsConfig,
} from '../stats.js'
import { MemoryTier } from '../../types/enums.js'

// ── Helpers ──────────────────────────────────────────────────────

const NOW = 1_700_000_000_000

function makeCollector(
  overrides?: Partial<ConstructorParameters<typeof StatsCollector>[0]>,
): StatsCollector {
  return new StatsCollector({
    cost: defaultCostConfig,
    now: () => NOW,
    ...overrides,
  })
}

// ── Tests ────────────────────────────────────────────────────────

describe('StatsCollector', () => {
  // ── Construction & defaults ──────────────────────────────────

  describe('defaults', () => {
    it('uses default cost config when none provided', () => {
      const stats = new StatsCollector()
      const cfg = stats.getCostConfig()
      expect(cfg.inputCostPer1k).toBe(defaultCostConfig.inputCostPer1k)
      expect(cfg.outputCostPer1k).toBe(defaultCostConfig.outputCostPer1k)
    })

    it('defaultStatsConfig has expected shape', () => {
      expect(defaultStatsConfig.cost).toEqual(defaultCostConfig)
    })
  })

  // ── recordBuild ──────────────────────────────────────────────

  describe('recordBuild', () => {
    it('records a build and returns computed metrics', () => {
      const stats = makeCollector()
      const m = stats.recordBuild({
        tokensInput: 2000,
        tokensOutput: 1000,
        latencyMs: 24,
      })

      expect(m.tokensInput).toBe(2000)
      expect(m.tokensOutput).toBe(1000)
      expect(m.tokensSaved).toBe(1000)
      expect(m.compressionRatio).toBe(2)
      expect(m.latencyMs).toBe(24)
      expect(m.timestamp).toBe(NOW)
    })

    it('computes cost correctly', () => {
      const stats = makeCollector()
      const m = stats.recordBuild({
        tokensInput: 1000,
        tokensOutput: 1000,
        latencyMs: 10,
      })

      const expectedCost =
        (1000 / 1000) * defaultCostConfig.inputCostPer1k +
        (1000 / 1000) * defaultCostConfig.outputCostPer1k
      expect(m.estimatedCost).toBeCloseTo(expectedCost)
    })

    it('computes savings correctly', () => {
      const stats = makeCollector()
      const m = stats.recordBuild({
        tokensInput: 2000,
        tokensOutput: 500,
        latencyMs: 10,
      })

      const expectedSavings =
        (1500 / 1000) * defaultCostConfig.inputCostPer1k
      expect(m.estimatedSavings).toBeCloseTo(expectedSavings)
    })

    it('handles zero output tokens (compressionRatio = 0)', () => {
      const stats = makeCollector()
      const m = stats.recordBuild({
        tokensInput: 1000,
        tokensOutput: 0,
        latencyMs: 5,
      })

      expect(m.compressionRatio).toBe(0)
      expect(m.tokensSaved).toBe(1000)
    })

    it('uses custom timestamp when provided', () => {
      const stats = makeCollector()
      const m = stats.recordBuild({
        tokensInput: 100,
        tokensOutput: 50,
        latencyMs: 1,
        timestamp: 999,
      })
      expect(m.timestamp).toBe(999)
    })
  })

  // ── getCumulative ────────────────────────────────────────────

  describe('getCumulative', () => {
    it('returns zeroes when no builds recorded', () => {
      const stats = makeCollector()
      const c = stats.getCumulative()

      expect(c.totalBuilds).toBe(0)
      expect(c.totalSaved).toBe(0)
      expect(c.avgCompressionRatio).toBe(0)
      expect(c.avgLatencyMs).toBe(0)
      expect(c.minLatencyMs).toBe(0)
      expect(c.maxLatencyMs).toBe(0)
    })

    it('aggregates multiple builds correctly', () => {
      const stats = makeCollector()
      stats.recordBuild({ tokensInput: 2000, tokensOutput: 1000, latencyMs: 20 })
      stats.recordBuild({ tokensInput: 4000, tokensOutput: 1000, latencyMs: 40 })

      const c = stats.getCumulative()
      expect(c.totalBuilds).toBe(2)
      expect(c.totalInputTokens).toBe(6000)
      expect(c.totalOutputTokens).toBe(2000)
      expect(c.totalSaved).toBe(4000)
      expect(c.avgLatencyMs).toBe(30)
      expect(c.minLatencyMs).toBe(20)
      expect(c.maxLatencyMs).toBe(40)
    })
  })

  // ── getBuilds / getRecentBuilds ──────────────────────────────

  describe('build queries', () => {
    it('getBuilds returns defensive copy', () => {
      const stats = makeCollector()
      stats.recordBuild({ tokensInput: 100, tokensOutput: 50, latencyMs: 1 })
      const a = stats.getBuilds()
      const b = stats.getBuilds()
      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })

    it('getRecentBuilds returns last N builds', () => {
      const stats = makeCollector()
      for (let i = 0; i < 5; i++) {
        stats.recordBuild({ tokensInput: (i + 1) * 100, tokensOutput: 50, latencyMs: 1 })
      }
      const recent = stats.getRecentBuilds(2)
      expect(recent).toHaveLength(2)
      expect(recent[0].tokensInput).toBe(400)
      expect(recent[1].tokensInput).toBe(500)
    })

    it('getBuildCount tracks total builds', () => {
      const stats = makeCollector()
      expect(stats.getBuildCount()).toBe(0)
      stats.recordBuild({ tokensInput: 100, tokensOutput: 50, latencyMs: 1 })
      stats.recordBuild({ tokensInput: 200, tokensOutput: 100, latencyMs: 2 })
      expect(stats.getBuildCount()).toBe(2)
    })
  })

  // ── Tier utilization ─────────────────────────────────────────

  describe('tier utilization', () => {
    it('records and retrieves tier snapshots', () => {
      const stats = makeCollector()
      stats.recordTierUtilization(MemoryTier.L0_REGISTER, 450, 0.9, 5)
      stats.recordTierUtilization(MemoryTier.L1_CACHE, 800, 0.6, 10)

      const snaps = stats.getTierSnapshots()
      expect(snaps).toHaveLength(2)
      expect(snaps[0].tier).toBe(MemoryTier.L0_REGISTER)
      expect(snaps[1].tokens).toBe(800)
    })

    it('getLatestTierUtilization deduplicates by tier', () => {
      const stats = makeCollector()
      stats.recordTierUtilization(MemoryTier.L0_REGISTER, 200, 0.4, 3)
      stats.recordTierUtilization(MemoryTier.L0_REGISTER, 450, 0.9, 5)
      stats.recordTierUtilization(MemoryTier.L1_CACHE, 800, 0.6, 10)

      const latest = stats.getLatestTierUtilization()
      expect(latest).toHaveLength(2)
      const l0 = latest.find((s) => s.tier === MemoryTier.L0_REGISTER)
      expect(l0?.tokens).toBe(450) // latest snapshot wins
    })
  })

  // ── estimateCost ─────────────────────────────────────────────

  describe('estimateCost', () => {
    it('estimates cost without recording a build', () => {
      const stats = makeCollector()
      const cost = stats.estimateCost(1000, 1000)
      const expected =
        (1000 / 1000) * defaultCostConfig.inputCostPer1k +
        (1000 / 1000) * defaultCostConfig.outputCostPer1k
      expect(cost).toBeCloseTo(expected)
      expect(stats.getBuildCount()).toBe(0)
    })
  })

  // ── Export ───────────────────────────────────────────────────

  describe('export', () => {
    it('exportJSON returns complete snapshot', () => {
      const stats = makeCollector()
      stats.recordBuild({ tokensInput: 1000, tokensOutput: 500, latencyMs: 10 })
      stats.recordTierUtilization(MemoryTier.L0_REGISTER, 300, 0.6, 4)

      const exported = stats.exportJSON()
      expect(exported.builds).toHaveLength(1)
      expect(exported.cumulative.totalBuilds).toBe(1)
      expect(exported.tierSnapshots).toHaveLength(1)
      expect(exported.exportedAt).toBe(NOW)
    })

    it('exportString returns valid JSON', () => {
      const stats = makeCollector()
      stats.recordBuild({ tokensInput: 500, tokensOutput: 250, latencyMs: 5 })
      const str = stats.exportString()
      const parsed = JSON.parse(str)
      expect(parsed.builds).toHaveLength(1)
      expect(parsed.cumulative).toBeDefined()
    })
  })

  // ── Reset ────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all data and resets accumulators', () => {
      const stats = makeCollector()
      stats.recordBuild({ tokensInput: 2000, tokensOutput: 1000, latencyMs: 20 })
      stats.recordTierUtilization(MemoryTier.L0_REGISTER, 300, 0.6, 4)

      stats.reset()

      expect(stats.getBuildCount()).toBe(0)
      expect(stats.getBuilds()).toHaveLength(0)
      expect(stats.getTierSnapshots()).toHaveLength(0)
      const c = stats.getCumulative()
      expect(c.totalBuilds).toBe(0)
      expect(c.totalSaved).toBe(0)
      expect(c.totalCost).toBe(0)
      expect(c.avgLatencyMs).toBe(0)
    })
  })

  // ── Logging ──────────────────────────────────────────────────

  describe('logging', () => {
    it('logs via custom logger on recordBuild', () => {
      const log = vi.fn()
      const stats = makeCollector({ logger: { log } })
      stats.recordBuild({ tokensInput: 1000, tokensOutput: 500, latencyMs: 10 })
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Build recorded'))
    })

    it('logs via console when logger=true', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const stats = makeCollector({ logger: true })
      stats.recordBuild({ tokensInput: 1000, tokensOutput: 500, latencyMs: 10 })
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[zerix:stats]'))
      spy.mockRestore()
    })

    it('no logging when logger is undefined', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const stats = makeCollector({ logger: undefined })
      stats.recordBuild({ tokensInput: 1000, tokensOutput: 500, latencyMs: 10 })
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('logs on reset', () => {
      const log = vi.fn()
      const stats = makeCollector({ logger: { log } })
      stats.reset()
      expect(log).toHaveBeenCalledWith('Stats reset')
    })
  })
})
