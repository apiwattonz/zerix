import { describe, expect, it } from 'vitest'
import {
  ChunkType,
  MemoryTier,
  countTokens,
  parseRawInput,
  splitChunk,
  type ContextChunk,
  type Message
} from '../index.js'

describe('intake parser', () => {
  it('parses a single raw text into one context chunk', () => {
    const chunks = parseRawInput('The sky is blue and the grass is green.')

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.content).toContain('The sky is blue')
    expect(chunks[0]?.tier).toBe(MemoryTier.L1_CACHE)
    expect(chunks[0]?.score).toBe(0)
    expect(chunks[0]?.type).toBe(ChunkType.OBSERVATION)
  })

  it('parses message arrays with auto-detected chunk types', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You must never expose API keys.' },
      { role: 'user', content: 'My favorite editor is Neovim.' },
      { role: 'assistant', content: 'We decided to move forward with plan B.' },
      { role: 'assistant', content: 'There was an error; fixed with a correction patch.' },
      { role: 'tool', content: '{"status":"ok","items":2}' },
      { role: 'assistant', content: 'Thinking step-by-step before answering.' }
    ]

    const chunks = parseRawInput(messages)
    expect(chunks).toHaveLength(6)

    expect(chunks[0]?.type).toBe(ChunkType.USER_CONSTRAINT)
    expect(chunks[1]?.type).toBe(ChunkType.FACT)
    expect(chunks[2]?.type).toBe(ChunkType.DECISION)
    expect(chunks[3]?.type).toBe(ChunkType.ERROR_CORRECTION)
    expect(chunks[4]?.type).toBe(ChunkType.TOOL_RESULT)
    expect(chunks[5]?.type).toBe(ChunkType.REASONING_STEP)
  })

  it('detects tool output from fenced blocks and json text', () => {
    const fenced = parseRawInput('```json\n{"ok":true}\n```')
    const json = parseRawInput('{"foo":"bar"}')

    expect(fenced[0]?.type).toBe(ChunkType.TOOL_RESULT)
    expect(json[0]?.type).toBe(ChunkType.TOOL_RESULT)
  })

  it('detects decision text including Thai keyword', () => {
    const decision = parseRawInput('ทีมตัดสินใจใช้ PostgreSQL สำหรับ production')
    expect(decision[0]?.type).toBe(ChunkType.DECISION)
  })

  it('returns empty array for empty input', () => {
    expect(parseRawInput('')).toEqual([])
    expect(parseRawInput('   ')).toEqual([])
    expect(parseRawInput([])).toEqual([])
  })

  it('handles very long input with configurable max chunk tokens', () => {
    const longText = Array.from({ length: 200 })
      .map((_, i) => `Sentence ${i + 1}.`)
      .join(' ')

    const chunks = parseRawInput(longText, { maxChunkTokens: 40 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.tokens <= 40)).toBe(true)
  })

  it('keeps unicode and emoji content intact', () => {
    const input = 'Hello 👋 โลก 🌏 こんにちは'
    const chunks = parseRawInput(input)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.content).toBe(input)
    expect(chunks[0]?.tokens).toBeGreaterThan(0)
  })
})

describe('tokenizer', () => {
  it('counts english text within acceptable range', () => {
    const text = 'This is a fairly normal English sentence with multiple words.'
    const tokens = countTokens(text)
    const expected = text.length / 4

    expect(tokens).toBeGreaterThan(0)
    expect(Math.abs(tokens - expected) / expected).toBeLessThanOrEqual(0.1)
  })

  it('counts thai text within acceptable range', () => {
    const text = 'ภาษาไทยทดสอบการนับโทเคนให้ใกล้เคียงความเป็นจริง'
    const tokens = countTokens(text)
    const expected = Array.from(text).length / 2

    expect(tokens).toBeGreaterThan(0)
    expect(Math.abs(tokens - expected) / expected).toBeLessThanOrEqual(0.1)
  })

  it('counts mixed language text and empty string', () => {
    const mixed = 'Deploy เสร็จแล้ว in production 🚀 with no errors.'
    expect(countTokens(mixed)).toBeGreaterThan(0)
    expect(countTokens('')).toBe(0)
  })
})

describe('chunk splitting', () => {
  it('splits large chunks into multiple smaller chunks', () => {
    const content = Array.from({ length: 80 })
      .map((_, i) => `Paragraph ${i + 1} has useful detail.`)
      .join(' ')

    const chunk: ContextChunk = {
      id: 'parent-1',
      content,
      tokens: countTokens(content),
      type: ChunkType.OBSERVATION,
      score: 0,
      tier: MemoryTier.L1_CACHE,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      accessCount: 0,
      ttl: null,
      metadata: { source: 'test' }
    }

    const parts = splitChunk(chunk, 30)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => part.tokens <= 30)).toBe(true)
    expect(parts.every((part) => part.metadata.parentId === chunk.id)).toBe(true)
  })

  it('respects sentence boundaries when splitting', () => {
    const content = 'First sentence is short. Second sentence is also short. Third sentence remains whole.'

    const chunk: ContextChunk = {
      id: 'parent-2',
      content,
      tokens: countTokens(content),
      type: ChunkType.OBSERVATION,
      score: 0,
      tier: MemoryTier.L1_CACHE,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      accessCount: 0,
      ttl: null,
      metadata: {}
    }

    const parts = splitChunk(chunk, 8)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => /[.!?]$/.test(part.content))).toBe(true)
  })
})
