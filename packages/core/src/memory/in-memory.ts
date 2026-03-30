import type { ContextChunk, MemoryTier } from '../types/index.js'
import type { MemoryTierStore, TierStats } from './types.js'

/**
 * Lightweight in-process tier backend used for L0/L1 memory.
 */
export class InMemoryTier implements MemoryTierStore {
  private readonly chunks = new Map<string, ContextChunk>()

  public constructor(
    private readonly tier: MemoryTier,
    private readonly maxTokens: number,
    private readonly rejectOnOverflow: boolean
  ) {}

  public read(): ContextChunk[] {
    return Array.from(this.chunks.values())
  }

  public write(chunk: ContextChunk): void {
    const ok = this.tryWrite(chunk)
    if (!ok) {
      throw new Error(
        `Cannot write chunk ${chunk.id} to ${this.tier}: token budget exceeded (${this.totalTokens()} + ${chunk.tokens} > ${this.maxTokens})`
      )
    }
  }

  public tryWrite(chunk: ContextChunk): boolean {
    const existing = this.chunks.get(chunk.id)
    const existingTokens = existing?.tokens ?? 0
    const nextTotal = this.totalTokens() - existingTokens + chunk.tokens

    if (nextTotal > this.maxTokens && this.rejectOnOverflow) {
      return false
    }

    this.chunks.set(chunk.id, { ...chunk, tier: this.tier })
    return true
  }

  public search(query: string, limit = 10): ContextChunk[] {
    const normalized = query.trim().toLowerCase()
    if (!normalized) {
      return []
    }

    return this.read()
      .filter((chunk) => chunk.content.toLowerCase().includes(normalized))
      .slice(0, Math.max(0, limit))
  }

  public delete(chunkId: string): boolean {
    return this.chunks.delete(chunkId)
  }

  public clear(): void {
    this.chunks.clear()
  }

  public stats(): TierStats {
    const totalTokens = this.totalTokens()
    return {
      chunkCount: this.chunks.size,
      totalTokens,
      maxTokens: this.maxTokens,
      utilization: this.maxTokens > 0 ? totalTokens / this.maxTokens : 0
    }
  }

  private totalTokens(): number {
    let total = 0
    for (const chunk of this.chunks.values()) {
      total += chunk.tokens
    }
    return total
  }
}
