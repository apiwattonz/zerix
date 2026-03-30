/**
 * Stable token budget zone reserved for persistent context.
 */
export interface StableBudgetZone {
  /** System prompt token allocation. */
  systemPrompt: number
  /** User profile token allocation. */
  userProfile: number
  /** Task definition token allocation. */
  taskDef: number
}

/**
 * Dynamic token budget zone for volatile/turn-based context.
 */
export interface DynamicBudgetZone {
  /** Current turn token allocation. */
  currentTurn: number
  /** Recent history token allocation. */
  recentHistory: number
  /** Session summary token allocation. */
  sessionSummary: number
  /** Tool result token allocation. */
  toolResults: number
  /** Long-term memory token allocation. */
  longTermMemory: number
  /** Shared cross-agent context allocation. */
  sharedContext: number
  /** Reserved dynamic headroom allocation. */
  reserved: number
}

/**
 * Complete budget zoning used by the compiler.
 */
export interface BudgetZone {
  /** Stable (persistent) zone allocation. */
  stableZone: StableBudgetZone
  /** Dynamic (volatile) zone allocation. */
  dynamicZone: DynamicBudgetZone
}

/**
 * Total token budget definition and zone breakdown.
 */
export interface TokenBudget extends BudgetZone {
  /** Total available tokens. */
  total: number
}

/**
 * Percentage-based configuration for token budget allocation.
 */
export interface BudgetConfig {
  /** Stable zone share of total tokens (default 0.15). */
  stablePercent?: number
  /** Dynamic zone share of total tokens (default 0.85). */
  dynamicPercent?: number
  /** Stable-zone internal percentage split, total must equal 1. */
  stableBreakdown?: StableBudgetZone
  /** Dynamic-zone internal percentage split, total must equal 1. */
  dynamicBreakdown?: DynamicBudgetZone
}

/**
 * Usage report per category and in aggregate.
 */
export interface BudgetReport {
  categories: Record<
    string,
    {
      allocated: number
      used: number
      remaining: number
    }
  >
  total: {
    allocated: number
    used: number
    remaining: number
    utilization: number
  }
  /** Categories with usage that exceeds allocated budget. */
  overBudget: string[]
}
