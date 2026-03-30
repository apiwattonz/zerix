import type { ContextChunk } from '../types/chunk.js'
import type {
  BudgetConfig,
  BudgetReport,
  DynamicBudgetZone,
  StableBudgetZone,
  TokenBudget
} from '../types/budget.js'

const DEFAULT_STABLE_PERCENT = 0.15
const DEFAULT_DYNAMIC_PERCENT = 0.85

const DEFAULT_STABLE_BREAKDOWN: StableBudgetZone = {
  systemPrompt: 0.5,
  userProfile: 0.3,
  taskDef: 0.2
}

const DEFAULT_DYNAMIC_BREAKDOWN: DynamicBudgetZone = {
  currentTurn: 0.2,
  recentHistory: 0.15,
  sessionSummary: 0.15,
  toolResults: 0.2,
  longTermMemory: 0.1,
  sharedContext: 0.05,
  reserved: 0.15
}

const EPSILON = 1e-9

const sumValues = (values: number[]): number => values.reduce((acc, value) => acc + value, 0)

const assertPercentTotal = (label: string, total: number): void => {
  if (Math.abs(total - 1) > EPSILON) {
    throw new Error(`${label} percentages must total 1.0`) 
  }
}

const validatePercentages = (config: Required<BudgetConfig>): void => {
  assertPercentTotal('Stable and dynamic', config.stablePercent + config.dynamicPercent)
  assertPercentTotal('Stable breakdown', sumValues(Object.values(config.stableBreakdown)))
  assertPercentTotal('Dynamic breakdown', sumValues(Object.values(config.dynamicBreakdown)))
}

const clampTotal = (totalTokens: number): number => {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return 0
  }

  return Math.floor(totalTokens)
}

const resolveConfig = (config?: BudgetConfig): Required<BudgetConfig> => ({
  stablePercent: config?.stablePercent ?? DEFAULT_STABLE_PERCENT,
  dynamicPercent: config?.dynamicPercent ?? DEFAULT_DYNAMIC_PERCENT,
  stableBreakdown: {
    ...DEFAULT_STABLE_BREAKDOWN,
    ...config?.stableBreakdown
  },
  dynamicBreakdown: {
    ...DEFAULT_DYNAMIC_BREAKDOWN,
    ...config?.dynamicBreakdown
  }
})

/**
 * Create a token budget allocation for stable and dynamic zones.
 */
export const createBudget = (
  totalTokens: number,
  config?: BudgetConfig
): TokenBudget => {
  const resolved = resolveConfig(config)
  validatePercentages(resolved)

  const total = clampTotal(totalTokens)
  const stableTotal = Math.floor(total * resolved.stablePercent)
  const dynamicTotal = total - stableTotal

  const stableZone = {
    systemPrompt: Math.floor(stableTotal * resolved.stableBreakdown.systemPrompt),
    userProfile: Math.floor(stableTotal * resolved.stableBreakdown.userProfile),
    taskDef: stableTotal -
      Math.floor(stableTotal * resolved.stableBreakdown.systemPrompt) -
      Math.floor(stableTotal * resolved.stableBreakdown.userProfile)
  }

  const currentTurn = Math.floor(dynamicTotal * resolved.dynamicBreakdown.currentTurn)
  const recentHistory = Math.floor(dynamicTotal * resolved.dynamicBreakdown.recentHistory)
  const sessionSummary = Math.floor(dynamicTotal * resolved.dynamicBreakdown.sessionSummary)
  const toolResults = Math.floor(dynamicTotal * resolved.dynamicBreakdown.toolResults)
  const longTermMemory = Math.floor(dynamicTotal * resolved.dynamicBreakdown.longTermMemory)
  const sharedContext = Math.floor(dynamicTotal * resolved.dynamicBreakdown.sharedContext)

  const dynamicZone = {
    currentTurn,
    recentHistory,
    sessionSummary,
    toolResults,
    longTermMemory,
    sharedContext,
    reserved:
      dynamicTotal -
      currentTurn -
      recentHistory -
      sessionSummary -
      toolResults -
      longTermMemory -
      sharedContext
  }

  return {
    total,
    stableZone,
    dynamicZone
  }
}

const flattenBudgetCategories = (budget: TokenBudget): Record<string, number> => ({
  systemPrompt: budget.stableZone.systemPrompt,
  userProfile: budget.stableZone.userProfile,
  taskDef: budget.stableZone.taskDef,
  currentTurn: budget.dynamicZone.currentTurn,
  recentHistory: budget.dynamicZone.recentHistory,
  sessionSummary: budget.dynamicZone.sessionSummary,
  toolResults: budget.dynamicZone.toolResults,
  longTermMemory: budget.dynamicZone.longTermMemory,
  sharedContext: budget.dynamicZone.sharedContext,
  reserved: budget.dynamicZone.reserved
})

/**
 * Allocate chunks for a category, selecting highest-scored chunks that fit.
 */
export const allocate = (
  budget: TokenBudget,
  category: string,
  chunks: ContextChunk[]
): ContextChunk[] => {
  const allocation = flattenBudgetCategories(budget)[category] ?? 0

  if (allocation <= 0 || chunks.length === 0) {
    return []
  }

  const sorted = [...chunks].sort((a, b) => b.score - a.score)
  const selected: ContextChunk[] = []
  let used = 0

  for (const chunk of sorted) {
    if (used + chunk.tokens > allocation) {
      continue
    }

    selected.push(chunk)
    used += chunk.tokens

    if (used === allocation) {
      break
    }
  }

  return selected
}

/**
 * Build a per-category and total usage report for a token budget.
 */
export const getBudgetReport = (
  budget: TokenBudget,
  used: Record<string, number>
): BudgetReport => {
  const allocations = flattenBudgetCategories(budget)
  const categories: BudgetReport['categories'] = {}
  const overBudget: string[] = []

  for (const [category, allocated] of Object.entries(allocations)) {
    const usedTokens = Math.max(0, used[category] ?? 0)
    const remaining = allocated - usedTokens
    categories[category] = {
      allocated,
      used: usedTokens,
      remaining
    }

    if (remaining < 0) {
      overBudget.push(category)
    }
  }

  const totalAllocated = sumValues(Object.values(allocations))
  const totalUsed = sumValues(Object.values(categories).map((entry) => entry.used))
  const totalRemaining = totalAllocated - totalUsed

  return {
    categories,
    total: {
      allocated: totalAllocated,
      used: totalUsed,
      remaining: totalRemaining,
      utilization: totalAllocated > 0 ? totalUsed / totalAllocated : 0
    },
    overBudget
  }
}

/**
 * Adjust an existing budget with percentage overrides.
 */
export const adjustBudget = (
  budget: TokenBudget,
  overrides: Partial<BudgetConfig>
): TokenBudget => {
  return createBudget(budget.total, {
    stablePercent: overrides.stablePercent,
    dynamicPercent: overrides.dynamicPercent,
    stableBreakdown: overrides.stableBreakdown,
    dynamicBreakdown: overrides.dynamicBreakdown
  })
}

export type { BudgetConfig, BudgetReport }
