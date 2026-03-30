/**
 * Supported message shape for intake parsing.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  timestamp?: number
}

/**
 * Config options for intake parser behavior.
 */
export interface IntakeParserConfig {
  /** Maximum tokens allowed per chunk before splitting. */
  maxChunkTokens?: number
}

/**
 * Internal split metadata attached to generated child chunks.
 */
export interface SplitMetadata {
  parentId: string
  partIndex: number
  partCount: number
}

/**
 * Type guard for message arrays.
 */
export function isMessageArray(value: unknown): value is Message[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        'role' in item &&
        'content' in item
    )
  )
}
