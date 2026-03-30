import { ChunkType, MemoryTier } from '../types/enums.js'
import type { ContextChunk } from '../types/chunk.js'
import { clamp } from '../utils/math.js'
import { Summarizer } from './summarizer.js'

export interface EvictorConfig {
  /** Eviction runs only when utilization is strictly greater than this value. */
  triggerUtilization: number
  /** Fraction of current tokens to evict when triggered. */
  evictFraction: number
}

export interface EvictionEvent {
  timestamp: number
  triggerUtilization: number
  utilizationBefore: number
  utilizationAfter: number
  evictFraction: number
  targetEvictTokens: number
  evictedTokens: number
  evictedChunkIds: string[]
  summaryChunkId: string | null
}

export interface EvictionResult {
  triggered: boolean
  utilizationBefore: number
  utilizationAfter: number
  targetEvictTokens: number
  evictedTokens: number
  evictedChunks: ContextChunk[]
  summaryChunk: ContextChunk | null
  chunks: ContextChunk[]
}

const DEFAULT_CONFIG: EvictorConfig = {
  triggerUtilization: 0.8,
  evictFraction: 0.2
}

export class Evictor {
  private readonly config: EvictorConfig
  private readonly evictionLog: EvictionEvent[] = []
  private readonly summarizer = new Summarizer({ compressionRatio: 3, strategy: 'extractive' })

  constructor(config: Partial<EvictorConfig> = {}) {
    this.config = {
      triggerUtilization: clamp(config.triggerUtilization ?? DEFAULT_CONFIG.triggerUtilization, 0, 1),
      evictFraction: clamp(config.evictFraction ?? DEFAULT_CONFIG.evictFraction, 0, 1)
    }
  }

  getConfig(): EvictorConfig {
    return { ...this.config }
  }

  getEvictionLog(): EvictionEvent[] {
    return [...this.evictionLog]
  }

  async run(chunks: ContextChunk[], capacityTokens: number): Promise<EvictionResult> {
    const safeCapacity = Math.max(0, capacityTokens)
    const current = [...chunks]
    const totalTokens = current.reduce((sum, chunk) => sum + Math.max(0, chunk.tokens), 0)

    const utilizationBefore = safeCapacity > 0 ? totalTokens / safeCapacity : 0

    if (utilizationBefore <= this.config.triggerUtilization || current.length === 0) {
      return {
        triggered: false,
        utilizationBefore,
        utilizationAfter: utilizationBefore,
        targetEvictTokens: 0,
        evictedTokens: 0,
        evictedChunks: [],
        summaryChunk: null,
        chunks: current
      }
    }

    const targetEvictTokens = Math.ceil(totalTokens * this.config.evictFraction)

    const evictable = current
      .filter((chunk) => chunk.type !== ChunkType.USER_CONSTRAINT)
      .sort((a, b) => {
        if (a.score === b.score) {
          return a.createdAt - b.createdAt
        }
        return a.score - b.score
      })

    const selected: ContextChunk[] = []
    let selectedTokens = 0

    for (const chunk of evictable) {
      if (selectedTokens >= targetEvictTokens) {
        break
      }
      selected.push(chunk)
      selectedTokens += Math.max(0, chunk.tokens)
    }

    if (selected.length === 0) {
      return {
        triggered: true,
        utilizationBefore,
        utilizationAfter: utilizationBefore,
        targetEvictTokens,
        evictedTokens: 0,
        evictedChunks: [],
        summaryChunk: null,
        chunks: current
      }
    }

    const summaryContent = await this.summarizer.summarizeChunks(selected)

    const summaryChunk: ContextChunk = {
      id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: summaryContent,
      tokens: summaryContent.trim().length === 0 ? 0 : summaryContent.trim().split(/\s+/).length,
      type: ChunkType.OBSERVATION,
      score: 1,
      tier: MemoryTier.L2_RAM,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      accessCount: 0,
      ttl: null,
      metadata: {
        kind: 'eviction_summary',
        sourceChunkIds: selected.map((chunk) => chunk.id)
      }
    }

    const selectedIds = new Set(selected.map((chunk) => chunk.id))
    const next: ContextChunk[] = []

    for (const chunk of current) {
      if (!selectedIds.has(chunk.id)) {
        next.push(chunk)
        continue
      }

      if (chunk.tier === MemoryTier.L1_CACHE) {
        next.push({ ...chunk, tier: MemoryTier.L2_RAM })
      }
      // L2 and above are replaced by summary only
    }

    next.push(summaryChunk)

    const tokensAfter = next.reduce((sum, chunk) => sum + Math.max(0, chunk.tokens), 0)
    const utilizationAfter = safeCapacity > 0 ? tokensAfter / safeCapacity : 0

    const event: EvictionEvent = {
      timestamp: Date.now(),
      triggerUtilization: this.config.triggerUtilization,
      utilizationBefore,
      utilizationAfter,
      evictFraction: this.config.evictFraction,
      targetEvictTokens,
      evictedTokens: selectedTokens,
      evictedChunkIds: selected.map((chunk) => chunk.id),
      summaryChunkId: summaryChunk.id
    }

    this.evictionLog.push(event)

    return {
      triggered: true,
      utilizationBefore,
      utilizationAfter,
      targetEvictTokens,
      evictedTokens: selectedTokens,
      evictedChunks: selected,
      summaryChunk,
      chunks: next
    }
  }
}
