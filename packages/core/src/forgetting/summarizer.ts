import type { ContextChunk } from '../types/chunk.js'

export type SummarizationStrategy = 'extractive' | 'truncate' | 'custom'

export interface SummarizerConfig {
  /**
   * Desired input:output compression ratio. Example: 3 means ~3:1 compression.
   * Values <= 1 effectively disable compression.
   */
  compressionRatio: number
  /** Summarization strategy. */
  strategy: SummarizationStrategy
  /** Optional custom summarization callback for strategy='custom'. */
  customFn?: (input: string | string[]) => string | Promise<string>
}

const DEFAULT_CONFIG: SummarizerConfig = {
  compressionRatio: 3,
  strategy: 'extractive'
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that', 'this', 'it', 'its', 'we',
  'you', 'they', 'he', 'she', 'i', 'our', 'their', 'his', 'her', 'them', 'us', 'not', 'no', 'yes'
])

interface SentenceCandidate {
  text: string
  position: number
  words: string[]
  score: number
}

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value) || Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

const countWords = (text: string): number => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/u).filter(Boolean).length
}

const tokenize = (text: string): string[] => {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()

  if (normalized.length === 0) return []

  return normalized
    .split(/\s+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

const splitSentences = (text: string): string[] => {
  const cleaned = text.replace(/\s+/gu, ' ').trim()
  if (cleaned.length === 0) return []

  const pieces = cleaned
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (pieces.length > 0) return pieces

  return [cleaned]
}

const hasEntitySignals = (text: string): boolean => {
  const hasCapitalized = /\b[A-Z][a-zA-Z]{2,}\b/u.test(text)
  const hasAcronym = /\b[A-Z]{2,}\b/u.test(text)
  const hasNumber = /\b\d+[\d,.:/-]*\b/u.test(text)
  return hasCapitalized || hasAcronym || hasNumber
}

export class Summarizer {
  private readonly config: SummarizerConfig

  constructor(config: Partial<SummarizerConfig> = {}) {
    const compressionRatio = clamp(config.compressionRatio ?? DEFAULT_CONFIG.compressionRatio, 1, 20)
    const strategy = config.strategy ?? DEFAULT_CONFIG.strategy

    this.config = {
      compressionRatio,
      strategy,
      customFn: config.customFn
    }
  }

  getConfig(): SummarizerConfig {
    return { ...this.config }
  }

  async summarize(input: string | string[]): Promise<string> {
    const normalized = this.normalizeInput(input)
    if (normalized.length === 0) return ''

    if (this.config.strategy === 'custom') {
      if (!this.config.customFn) {
        throw new Error('Summarizer custom strategy requires customFn')
      }
      const customOutput = await this.config.customFn(input)
      return this.ensureString(customOutput)
    }

    const source = normalized.join('\n')
    const sourceWordCount = countWords(source)

    if (sourceWordCount <= 12 || this.config.compressionRatio <= 1) {
      return source
    }

    const targetWords = Math.max(1, Math.floor(sourceWordCount / this.config.compressionRatio))

    if (this.config.strategy === 'truncate') {
      return this.truncate(source, targetWords)
    }

    const extractive = this.extractiveSummary(source, targetWords)
    if (extractive.trim().length > 0) {
      return extractive
    }

    return this.truncate(source, targetWords)
  }

  async summarizeChunks(chunks: ContextChunk[]): Promise<string> {
    if (chunks.length === 0) return ''

    const sorted = [...chunks].sort((a, b) => a.createdAt - b.createdAt)
    const chunkContents = sorted
      .map((chunk) => chunk.content.trim())
      .filter((text) => text.length > 0)

    return this.summarize(chunkContents)
  }

  private normalizeInput(input: string | string[]): string[] {
    if (typeof input === 'string') {
      const trimmed = input.trim()
      return trimmed.length > 0 ? [trimmed] : []
    }

    return input
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  }

  private ensureString(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error('customFn must return a string summary')
    }
    return value
  }

  private truncate(text: string, targetWords: number): string {
    const words = text.trim().split(/\s+/u).filter(Boolean)
    if (words.length <= targetWords) return text.trim()
    const head = words.slice(0, targetWords).join(' ').trim()
    return `${head} ...`
  }

  private extractiveSummary(text: string, targetWords: number): string {
    const sentences = splitSentences(text)

    if (sentences.length === 0) return ''
    if (sentences.length === 1) {
      return this.truncate(sentences[0] ?? '', targetWords)
    }

    const freq = new Map<string, number>()

    for (const sentence of sentences) {
      for (const token of tokenize(sentence)) {
        freq.set(token, (freq.get(token) ?? 0) + 1)
      }
    }

    const candidates: SentenceCandidate[] = sentences.map((sentence, index) => {
      const words = sentence.split(/\s+/u).filter(Boolean)
      const tokens = tokenize(sentence)
      const keywordScore = tokens.reduce((sum, token) => sum + (freq.get(token) ?? 0), 0) / Math.max(1, words.length)
      const denominator = Math.max(1, sentences.length - 1)
      const positionScore = 1 - index / denominator
      const lengthScore = clamp(1 - Math.abs(words.length - 18) / 18, 0, 1)
      const entityScore = hasEntitySignals(sentence) ? 1 : 0

      const score =
        0.45 * positionScore +
        0.35 * keywordScore +
        0.15 * lengthScore +
        0.05 * entityScore

      return {
        text: sentence,
        position: index,
        words,
        score
      }
    })

    const ranked = [...candidates].sort((a, b) => {
      if (b.score === a.score) return a.position - b.position
      return b.score - a.score
    })

    const selected: SentenceCandidate[] = []
    let selectedWords = 0

    const mustInclude = new Set<number>()
    // Always preserve earliest sentence to retain primary context/entities.
    mustInclude.add(candidates[0]?.position ?? 0)

    const decisionSentence = candidates.find((candidate) => /\bdecision\b\s*:/iu.test(candidate.text))
    if (decisionSentence) {
      mustInclude.add(decisionSentence.position)
    }

    const factSentence =
      candidates.find((candidate) => /\bfact\b\s*:/iu.test(candidate.text)) ??
      candidates.find(
        (candidate) => /\d/.test(candidate.text) && !/\bdecision\b\s*:/iu.test(candidate.text)
      )
    if (factSentence) {
      mustInclude.add(factSentence.position)
    }

    const preselected = ranked.filter((candidate) => mustInclude.has(candidate.position))
    for (const candidate of preselected) {
      if (selected.some((item) => item.position === candidate.position)) continue
      selected.push(candidate)
      selectedWords += candidate.words.length
    }

    for (const candidate of ranked) {
      if (selected.some((item) => item.position === candidate.position)) continue
      if (selectedWords >= targetWords) break
      selected.push(candidate)
      selectedWords += candidate.words.length
    }

    if (selected.length === 0) return ''

    const ordered = selected.sort((a, b) => a.position - b.position)
    return ordered.map((item) => item.text).join(' ').trim()
  }
}
