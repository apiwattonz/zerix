import type { ContextChunk } from '../types/chunk.js'
import { ChunkType, MemoryTier } from '../types/enums.js'
import { countTokens } from './tokenizer.js'
import type { IntakeParserConfig, Message, SplitMetadata } from './types.js'

const DECISION_REGEX = /\b(decided?|decision|decisions)\b|ตัดสินใจ/iu
const ERROR_FIX_REGEX = /\b(error|errors|fix|fixed|fixes|correction|corrected|bug|bugs)\b/iu
const REASONING_REGEX = /\b(reasoning|think(?:ing)?|analysis|step-by-step|chain of thought)\b|คิด|วิเคราะห์/iu

/**
 * Parse raw string input or chat messages into normalized context chunks.
 */
export function parseRawInput(
  input: string | Message[],
  config: IntakeParserConfig = {}
): ContextChunk[] {
  const now = Date.now()
  const maxChunkTokens = config.maxChunkTokens

  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      return []
    }

    const chunk = createChunk({
      content: input,
      type: detectChunkType(input),
      timestamp: now,
      metadata: { source: 'raw_text' }
    })

    if (!maxChunkTokens) {
      return [chunk]
    }

    return splitChunk(chunk, maxChunkTokens)
  }

  if (input.length === 0) {
    return []
  }

  const chunks: ContextChunk[] = []
  for (const message of input) {
    if (!message.content || message.content.trim().length === 0) {
      continue
    }

    const detectedType = detectChunkType(message.content, message)
    const createdAt = message.timestamp ?? now
    const chunk = createChunk({
      content: message.content,
      type: detectedType,
      timestamp: createdAt,
      metadata: {
        source: 'message',
        role: message.role,
        ...(message.name ? { name: message.name } : {})
      }
    })

    if (maxChunkTokens) {
      chunks.push(...splitChunk(chunk, maxChunkTokens))
    } else {
      chunks.push(chunk)
    }
  }

  return chunks
}

/**
 * Split a chunk into smaller chunks using paragraph and sentence boundaries.
 */
export function splitChunk(chunk: ContextChunk, maxTokens: number): ContextChunk[] {
  if (maxTokens <= 0) {
    throw new Error('maxTokens must be greater than 0')
  }

  if (chunk.tokens <= maxTokens) {
    return [chunk]
  }

  const units = splitIntoUnits(chunk.content)
  const parts: string[] = []
  let buffer = ''

  const flush = () => {
    if (buffer.trim().length > 0) {
      parts.push(buffer.trim())
      buffer = ''
    }
  }

  for (const unit of units) {
    const candidate = buffer ? `${buffer} ${unit}` : unit
    if (countTokens(candidate) <= maxTokens) {
      buffer = candidate
      continue
    }

    flush()

    if (countTokens(unit) <= maxTokens) {
      buffer = unit
      continue
    }

    const wordPieces = splitLongUnit(unit, maxTokens)
    for (const piece of wordPieces) {
      parts.push(piece)
    }
  }

  flush()

  return parts.map((content, index) => {
    const metadata: SplitMetadata & Record<string, unknown> = {
      ...(chunk.metadata ?? {}),
      parentId: chunk.id,
      partIndex: index,
      partCount: parts.length
    }

    return {
      ...chunk,
      id: generateChunkId(),
      content,
      tokens: countTokens(content),
      metadata
    }
  })
}

function createChunk(params: {
  content: string
  type: ChunkType
  timestamp: number
  metadata: Record<string, unknown>
}): ContextChunk {
  return {
    id: generateChunkId(),
    content: params.content,
    tokens: countTokens(params.content),
    type: params.type,
    score: 0,
    tier: MemoryTier.L1_CACHE,
    createdAt: params.timestamp,
    accessedAt: params.timestamp,
    accessCount: 0,
    ttl: null,
    metadata: params.metadata
  }
}

function splitIntoUnits(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean)

  const units: string[] = []
  for (const paragraph of paragraphs) {
    const sentences = paragraph
      .split(/(?<=[.!?。！？])\s+|(?<=\n)/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean)

    if (sentences.length === 0) {
      units.push(paragraph)
    } else {
      units.push(...sentences)
    }
  }

  if (units.length === 0) {
    return [text]
  }

  return units
}

function splitLongUnit(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= 1) {
    return hardSplitByChars(text, maxTokens)
  }

  const parts: string[] = []
  let buffer = ''

  for (const word of words) {
    const candidate = buffer ? `${buffer} ${word}` : word
    if (countTokens(candidate) <= maxTokens) {
      buffer = candidate
    } else {
      if (buffer) {
        parts.push(buffer)
      }
      buffer = word
    }
  }

  if (buffer) {
    parts.push(buffer)
  }

  return parts
}

function hardSplitByChars(text: string, maxTokens: number): string[] {
  const approxChars = Math.max(8, maxTokens * 3)
  const chars = Array.from(text)
  const parts: string[] = []

  for (let i = 0; i < chars.length; i += approxChars) {
    parts.push(chars.slice(i, i + approxChars).join(''))
  }

  return parts
}

function generateChunkId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof globalCrypto?.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }

  const random = Math.random().toString(36).slice(2, 10)
  const now = Date.now().toString(36)
  return `chunk-${now}-${random}`
}

function detectChunkType(content: string, message?: Message): ChunkType {
  const normalized = content.trim()

  if (message?.role === 'system') {
    return ChunkType.USER_CONSTRAINT
  }

  if (message?.role === 'tool' || isToolOutput(normalized)) {
    return ChunkType.TOOL_RESULT
  }

  if (DECISION_REGEX.test(normalized)) {
    return ChunkType.DECISION
  }

  if (ERROR_FIX_REGEX.test(normalized)) {
    return ChunkType.ERROR_CORRECTION
  }

  if (message?.role === 'user') {
    return ChunkType.FACT
  }

  if (REASONING_REGEX.test(normalized)) {
    return ChunkType.REASONING_STEP
  }

  return ChunkType.OBSERVATION
}

function isToolOutput(content: string): boolean {
  if (content.startsWith('```')) {
    return true
  }

  if (content.startsWith('{') || content.startsWith('[')) {
    try {
      JSON.parse(content)
      return true
    } catch {
      return false
    }
  }

  return false
}
