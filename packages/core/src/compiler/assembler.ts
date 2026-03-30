import type { ContextChunk } from '../types/chunk.js'
import type { TokenBudget } from '../types/budget.js'
import type { BuildResult, Stats } from '../types/result.js'
import { MemoryTier } from '../types/enums.js'
import type { MemoryStore } from '../memory/types.js'
import { scoreChunks, type ScoringConfig } from './scorer.js'
import { countTokens } from './tokenizer.js'

/**
 * Logger interface accepted by the assembler.
 */
export interface AssemblerLogFn {
  log: (msg: string) => void
}

/**
 * Configuration for the context assembler.
 */
export interface AssemblerConfig {
  /** Token budget governing zone allocations. */
  budget: TokenBudget
  /** Optional scoring configuration forwarded to the scorer. */
  scoringConfig?: ScoringConfig
  /** Cost per token in dollars used for costSaved stat. Defaults to 0. */
  costPerToken?: number
  /**
   * Optional logger.
   * - `true`: use console.log
   * - object with `log` method: use that
   * - `false` / `undefined`: no logging
   */
  logger?: AssemblerLogFn | boolean
  /** Clock function for timestamps. Defaults to Date.now. Override in tests for determinism. */
  now?: () => number
}

const SECTION_REGISTERS = '--- REGISTERS ---'
const SECTION_CACHE = '--- CACHE ---'
const SECTION_DYNAMIC = '--- DYNAMIC ---'

const MINIMUM_USABLE_TOKENS = 10

/**
 * Resolves the logger from config into a callable or undefined.
 */
function resolveLogger(logger: AssemblerLogFn | boolean | undefined): AssemblerLogFn | undefined {
  if (logger === true) {
    return { log: (msg: string) => console.log(`[assembler] ${msg}`) }
  }
  if (logger && typeof logger === 'object' && 'log' in logger) {
    return logger
  }
  return undefined
}

/**
 * Selects chunks that fit within a token limit, preserving input order.
 * Assumes chunks are already sorted by priority (highest first).
 */
function selectWithinBudget(chunks: ReadonlyArray<ContextChunk>, maxTokens: number): ContextChunk[] {
  const selected: ContextChunk[] = []
  let used = 0

  for (const chunk of chunks) {
    if (chunk.tokens <= 0) {
      continue
    }
    if (used + chunk.tokens > maxTokens) {
      continue
    }
    selected.push(chunk)
    used += chunk.tokens
  }

  return selected
}

/**
 * Computes total tokens for a set of chunks.
 */
function sumTokens(chunks: ReadonlyArray<ContextChunk>): number {
  let total = 0
  for (const chunk of chunks) {
    total += chunk.tokens
  }
  return total
}

/**
 * Formats a section with a marker header and chunk contents.
 */
function formatSection(marker: string, chunks: ReadonlyArray<ContextChunk>): string {
  if (chunks.length === 0) {
    return ''
  }
  const body = chunks.map((c) => c.content).join('\n')
  return `${marker}\n${body}`
}

/**
 * Builds tier utilization stats from selected chunks.
 */
function buildTierUtilization(
  selectedChunks: ReadonlyArray<ContextChunk>,
  totalSelectedTokens: number
): Record<MemoryTier, number> {
  const utilization: Record<MemoryTier, number> = {
    [MemoryTier.L0_REGISTER]: 0,
    [MemoryTier.L1_CACHE]: 0,
    [MemoryTier.L2_RAM]: 0,
    [MemoryTier.L3_SSD]: 0,
    [MemoryTier.L4_ARCHIVE]: 0
  }

  if (totalSelectedTokens === 0) {
    return utilization
  }

  for (const chunk of selectedChunks) {
    utilization[chunk.tier] += chunk.tokens
  }

  for (const tier of Object.values(MemoryTier)) {
    utilization[tier] = utilization[tier] / totalSelectedTokens
  }

  return utilization
}

/**
 * Context assembler — the final compilation step that combines all sources
 * into optimized context within a token budget.
 *
 * Assembly order:
 * 1. L0 (registers) — always included first in the stable zone
 * 2. L1 (cache) — included next in the stable zone
 * 3. Scored dynamic content — ranked by the Scorer, packed into the dynamic zone
 *
 * Zone boundaries default to stable 15% / dynamic 85% as defined by the TokenBudget.
 */
export class ContextAssembler {
  private readonly config: AssemblerConfig
  private readonly logger: AssemblerLogFn | undefined
  private readonly now: () => number

  public constructor(config: AssemblerConfig) {
    this.config = config
    this.logger = resolveLogger(config.logger)
    this.now = config.now ?? Date.now
  }

  /**
   * Assemble context from a memory store, scoring dynamic content against a query.
   *
   * @param memory - The tiered memory store to read chunks from.
   * @param query - Query string for relevance scoring of dynamic content.
   * @returns A BuildResult with the assembled context and build statistics.
   */
  public build(memory: MemoryStore, query: string): BuildResult {
    const startMs = this.now()
    const budget = this.config.budget

    if (budget.total < MINIMUM_USABLE_TOKENS) {
      this.logger?.log(`budget too small (${budget.total} tokens), returning empty context`)
      return this.emptyResult(startMs)
    }

    this.logger?.log(`starting assembly with ${budget.total} total tokens`)

    // --- Phase 1: Stable zone (L0 registers + L1 cache) ---
    const stableMax = budget.stableZone.systemPrompt + budget.stableZone.userProfile + budget.stableZone.taskDef
    this.logger?.log(`stable zone budget: ${stableMax} tokens`)

    const l0Chunks = memory.read(MemoryTier.L0_REGISTER)
    const l0Selected = selectWithinBudget(l0Chunks, stableMax)
    const l0Tokens = sumTokens(l0Selected)
    this.logger?.log(`L0 registers: ${l0Selected.length} chunks, ${l0Tokens} tokens`)

    const l1Budget = stableMax - l0Tokens
    const l1Chunks = memory.read(MemoryTier.L1_CACHE)
    const l1Selected = selectWithinBudget(l1Chunks, l1Budget)
    const l1Tokens = sumTokens(l1Selected)
    this.logger?.log(`L1 cache: ${l1Selected.length} chunks, ${l1Tokens} tokens`)

    // --- Phase 2: Dynamic zone (scored L2+ content) ---
    const dynamicMax =
      budget.dynamicZone.currentTurn +
      budget.dynamicZone.recentHistory +
      budget.dynamicZone.sessionSummary +
      budget.dynamicZone.toolResults +
      budget.dynamicZone.longTermMemory +
      budget.dynamicZone.sharedContext +
      budget.dynamicZone.reserved
    this.logger?.log(`dynamic zone budget: ${dynamicMax} tokens`)

    const l2Chunks = memory.read(MemoryTier.L2_RAM)
    const allDynamic = [...l2Chunks]

    // Score and rank dynamic content
    const scored = scoreChunks(allDynamic, query, this.config.scoringConfig)
    const dynamicSelected = selectWithinBudget(scored, dynamicMax)
    const dynamicTokens = sumTokens(dynamicSelected)
    this.logger?.log(`dynamic content: ${dynamicSelected.length}/${scored.length} chunks, ${dynamicTokens} tokens`)

    // --- Phase 3: Format output ---
    const sections: string[] = []

    const registerSection = formatSection(SECTION_REGISTERS, l0Selected)
    if (registerSection) {
      sections.push(registerSection)
    }

    const cacheSection = formatSection(SECTION_CACHE, l1Selected)
    if (cacheSection) {
      sections.push(cacheSection)
    }

    const dynamicSection = formatSection(SECTION_DYNAMIC, dynamicSelected)
    if (dynamicSection) {
      sections.push(dynamicSection)
    }

    const context = sections.join('\n\n')
    const contextTokens = context.length > 0 ? countTokens(context) : 0

    // --- Phase 4: Compute stats ---
    const allSelected = [...l0Selected, ...l1Selected, ...dynamicSelected]
    const inputTokens = sumTokens(l0Chunks) + sumTokens(l1Chunks) + sumTokens(l2Chunks)
    const outputTokens = l0Tokens + l1Tokens + dynamicTokens
    const tokensSaved = Math.max(0, inputTokens - outputTokens)
    const costPerToken = this.config.costPerToken ?? 0
    const compressionRatio = outputTokens > 0 ? inputTokens / outputTokens : 0

    const memoryHits = l0Selected.length + l1Selected.length + dynamicSelected.length
    const latencyMs = this.now() - startMs

    const tierUtilization = buildTierUtilization(allSelected, outputTokens)

    const stats: Stats = {
      tokensSaved,
      costSaved: tokensSaved * costPerToken,
      memoryHits,
      latencyMs,
      compressionRatio,
      tierUtilization
    }

    this.logger?.log(
      `assembly complete: ${contextTokens} context tokens, ${memoryHits} hits, ${tokensSaved} saved, ${latencyMs}ms`
    )

    return { context, stats }
  }

  /**
   * Assemble context directly from pre-built chunk arrays instead of a MemoryStore.
   * Useful when chunks are already available without a full memory backend.
   *
   * @param sources - Object with optional l0, l1, and dynamic chunk arrays.
   * @param query - Query string for relevance scoring of dynamic content.
   * @returns A BuildResult with the assembled context and build statistics.
   */
  public buildFromChunks(
    sources: {
      l0?: ReadonlyArray<ContextChunk>
      l1?: ReadonlyArray<ContextChunk>
      dynamic?: ReadonlyArray<ContextChunk>
    },
    query: string
  ): BuildResult {
    const adapter: MemoryStore = {
      read: (tier: MemoryTier): ContextChunk[] => {
        if (tier === MemoryTier.L0_REGISTER) return [...(sources.l0 ?? [])]
        if (tier === MemoryTier.L1_CACHE) return [...(sources.l1 ?? [])]
        if (tier === MemoryTier.L2_RAM) return [...(sources.dynamic ?? [])]
        return []
      },
      write: () => {},
      search: () => [],
      delete: () => false,
      clear: () => {},
      stats: () => ({
        tiers: {
          [MemoryTier.L0_REGISTER]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L1_CACHE]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L2_RAM]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L3_SSD]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 },
          [MemoryTier.L4_ARCHIVE]: { chunkCount: 0, totalTokens: 0, maxTokens: 0, utilization: 0 }
        },
        totalChunks: 0,
        totalTokens: 0
      }),
      promote: () => false,
      demote: () => false
    }

    return this.build(adapter, query)
  }

  /**
   * Returns an empty BuildResult when assembly cannot proceed.
   */
  private emptyResult(startMs: number): BuildResult {
    return {
      context: '',
      stats: {
        tokensSaved: 0,
        costSaved: 0,
        memoryHits: 0,
        latencyMs: this.now() - startMs,
        compressionRatio: 0,
        tierUtilization: {
          [MemoryTier.L0_REGISTER]: 0,
          [MemoryTier.L1_CACHE]: 0,
          [MemoryTier.L2_RAM]: 0,
          [MemoryTier.L3_SSD]: 0,
          [MemoryTier.L4_ARCHIVE]: 0
        }
      }
    }
  }
}
