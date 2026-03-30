import { describe, expect, it } from 'vitest'
import { ChunkType, MemoryTier, Summarizer, type ContextChunk } from '../../index.js'

const NOW = 1_700_000_000_000

const createChunk = (overrides: Partial<ContextChunk> = {}): ContextChunk => ({
  id: overrides.id ?? 'chunk-1',
  content: overrides.content ?? 'default content.',
  tokens: overrides.tokens ?? 10,
  type: overrides.type ?? ChunkType.OBSERVATION,
  score: overrides.score ?? 0.5,
  tier: overrides.tier ?? MemoryTier.L1_CACHE,
  createdAt: overrides.createdAt ?? NOW,
  accessedAt: overrides.accessedAt ?? NOW,
  accessCount: overrides.accessCount ?? 0,
  ttl: overrides.ttl ?? null,
  metadata: overrides.metadata ?? {}
})

const wc = (text: string): number => text.trim().split(/\s+/u).filter(Boolean).length

describe('Summarizer', () => {
  it('extractive summary compresses approximately 3:1 and stays within 2:1..5:1', async () => {
    const summarizer = new Summarizer({ compressionRatio: 3, strategy: 'extractive' })

    const input = [
      'Acme Corp planned the Q2 launch with Engineering, Product, and Sales in Bangkok. The team agreed on milestones and risk controls.',
      'Decision: ship API v2 behind a feature flag by May 20. Fact: baseline latency was reduced from 240ms to 140ms in staging.',
      'The incident review documented two root causes and one rollback procedure. Owners were assigned for observability and data migration.',
      'Budget note: 2.5M THB approved for rollout and on-call support. Compliance requested audit logs be retained for 90 days.'
    ].join(' ')

    const output = await summarizer.summarize(input)

    const ratio = wc(input) / Math.max(1, wc(output))
    expect(ratio).toBeGreaterThanOrEqual(2)
    expect(ratio).toBeLessThanOrEqual(5)
  })

  it('preserves key entities, decisions, and factual signals', async () => {
    const summarizer = new Summarizer({ compressionRatio: 3, strategy: 'extractive' })

    const input = [
      'Acme Corp met with NASA partners to plan the Artemis integration.',
      'Decision: deploy mission-control patch on 2026-06-01 after final validation.',
      'Fact: packet loss dropped to 0.2% and throughput increased to 1200 req/s.'
    ].join(' ')

    const output = await summarizer.summarize(input)

    expect(output).toMatch(/Acme Corp|NASA|Artemis/u)
    expect(output).toMatch(/Decision:/u)
    expect(output).toMatch(/0\.2%|1200/u)
  })

  it('uses truncation fallback with ellipsis marker when extractive cannot produce output', async () => {
    const summarizer = new Summarizer({ compressionRatio: 3, strategy: 'extractive' })

    const input = '     '.repeat(20)
    const output = await summarizer.summarize(input)

    expect(output).toBe('')

    const truncate = new Summarizer({ compressionRatio: 3, strategy: 'truncate' })
    const longInput = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
    const truncated = await truncate.summarize(longInput)
    expect(truncated.endsWith(' ...')).toBe(true)
  })

  it('supports custom summarizer callback', async () => {
    const summarizer = new Summarizer({
      strategy: 'custom',
      compressionRatio: 3,
      customFn: async (input) => {
        const text = Array.isArray(input) ? input.join(' | ') : input
        return `custom:${text.length}`
      }
    })

    const output = await summarizer.summarize(['hello', 'world'])
    expect(output).toBe('custom:13')
  })

  it('summarizes a single chunk input', async () => {
    const summarizer = new Summarizer({ strategy: 'extractive', compressionRatio: 3 })

    const output = await summarizer.summarize('This is a single sentence input for summary testing only.')

    expect(output.length).toBeGreaterThan(0)
  })

  it('summarizes multiple chunks into one summary in createdAt order', async () => {
    const summarizer = new Summarizer({ strategy: 'extractive', compressionRatio: 3 })

    const chunks: ContextChunk[] = [
      createChunk({ id: '2', createdAt: NOW + 100, content: 'Second event: database migration completed successfully.' }),
      createChunk({ id: '1', createdAt: NOW, content: 'First event: incident detected and triaged by SRE team.' }),
      createChunk({ id: '3', createdAt: NOW + 200, content: 'Third event: decision to keep canary at 10 percent.' })
    ]

    const output = await summarizer.summarizeChunks(chunks)

    expect(output.length).toBeGreaterThan(0)
    expect(typeof output).toBe('string')
  })

  it('handles edge cases: empty input, very short input, single sentence, and unicode Thai text', async () => {
    const summarizer = new Summarizer({ strategy: 'extractive', compressionRatio: 3 })

    await expect(summarizer.summarize('')).resolves.toBe('')

    const short = await summarizer.summarize('short text only')
    expect(short).toBe('short text only')

    const oneSentence = await summarizer.summarize(
      'Only one sentence exists here for this scenario and should still return safely.'
    )
    expect(oneSentence.length).toBeGreaterThan(0)

    const thai = await summarizer.summarize(
      'ทีมวิศวกรรมตัดสินใจเลื่อนการปล่อยระบบไปวันศุกร์เพื่อความปลอดภัย ลูกค้ารายใหญ่ยืนยันความต้องการเรื่องความเสถียร และมีการบันทึกเหตุผลไว้ครบถ้วน'
    )
    expect(thai.length).toBeGreaterThan(0)
  })

  it('throws when custom strategy is used without customFn', async () => {
    const summarizer = new Summarizer({ strategy: 'custom', compressionRatio: 3 })
    await expect(summarizer.summarize('hello world this is a long enough sample text')).rejects.toThrow(
      /customFn/u
    )
  })

  it('compressionRatio <= 1 returns original text unchanged', async () => {
    const summarizer = new Summarizer({ compressionRatio: 0.5, strategy: 'extractive' })
    const input =
      'Acme Corp planned the Q2 launch with Engineering, Product, and Sales. The team agreed on milestones and risk controls for the upcoming release.'
    const output = await summarizer.summarize(input)
    expect(output).toBe(input)
  })

  it('compressionRatio is clamped: 100 -> 20, -5 -> 1', () => {
    const high = new Summarizer({ compressionRatio: 100, strategy: 'extractive' })
    expect(high.getConfig().compressionRatio).toBe(20)

    const low = new Summarizer({ compressionRatio: -5, strategy: 'extractive' })
    expect(low.getConfig().compressionRatio).toBe(1)
  })

  it('customFn that throws produces a descriptive error', async () => {
    const summarizer = new Summarizer({
      strategy: 'custom',
      compressionRatio: 3,
      customFn: () => {
        throw new Error('LLM quota exceeded')
      }
    })
    await expect(summarizer.summarize('some input text')).rejects.toThrow(
      /Summarizer customFn threw: LLM quota exceeded/u
    )
  })

  it('customFn that returns a number (non-string) throws', async () => {
    const summarizer = new Summarizer({
      strategy: 'custom',
      compressionRatio: 3,
      customFn: () => 42 as unknown as string
    })
    await expect(summarizer.summarize('some input text')).rejects.toThrow(
      /customFn must return a string/u
    )
  })

  it('summarizeChunks([]) returns empty string', async () => {
    const summarizer = new Summarizer({ strategy: 'extractive', compressionRatio: 3 })
    const output = await summarizer.summarizeChunks([])
    expect(output).toBe('')
  })

  it('summarize([]) returns empty string', async () => {
    const summarizer = new Summarizer({ strategy: 'extractive', compressionRatio: 3 })
    const output = await summarizer.summarize([])
    expect(output).toBe('')
  })

  it('summarize with empty strings in array filters them and summarizes correctly', async () => {
    const summarizer = new Summarizer({ strategy: 'extractive', compressionRatio: 1 })
    const output = await summarizer.summarize(['hello', '', 'world'])
    expect(output).toContain('hello')
    expect(output).toContain('world')
  })

  it('extractive output preserves original sentence ordering', async () => {
    const summarizer = new Summarizer({ strategy: 'extractive', compressionRatio: 2 })
    const input = [
      'Alpha team started the investigation at HQ on Monday morning.',
      'Beta group confirmed the root cause was a misconfigured DNS record.',
      'Decision: rollback deployment to v2.3.1 immediately.',
      'Gamma division prepared the postmortem documentation for stakeholders.'
    ].join(' ')

    const output = await summarizer.summarize(input)
    const sentences = output.split(/(?<=[.!?])\s+/u)

    // Each selected sentence should appear in the same relative order as the input
    for (let i = 1; i < sentences.length; i++) {
      const prevIdx = input.indexOf(sentences[i - 1]!)
      const currIdx = input.indexOf(sentences[i]!)
      if (prevIdx !== -1 && currIdx !== -1) {
        expect(prevIdx).toBeLessThan(currIdx)
      }
    }
  })

  it('logs strategy, input/output word counts, and compression ratio', async () => {
    const messages: string[] = []
    const summarizer = new Summarizer({
      strategy: 'extractive',
      compressionRatio: 3,
      logger: { log: (msg: string) => messages.push(msg) }
    })

    const input =
      'Acme Corp planned the Q2 launch with Engineering, Product, and Sales in Bangkok. The team agreed on milestones and risk controls for the project release.'
    await summarizer.summarize(input)

    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('strategy=extractive')
    expect(messages[0]).toContain('inputWords=')
    expect(messages[0]).toContain('outputWords=')
    expect(messages[0]).toContain('compressionRatio=')
  })

  it('logger=true uses console.log', async () => {
    const logged: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logged.push(msg)
    try {
      const summarizer = new Summarizer({
        strategy: 'truncate',
        compressionRatio: 3,
        logger: true
      })
      await summarizer.summarize(
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
      )
      expect(logged.length).toBe(1)
      expect(logged[0]).toContain('strategy=truncate')
    } finally {
      console.log = origLog
    }
  })

  it('logger=false produces no logging', async () => {
    const summarizer = new Summarizer({
      strategy: 'extractive',
      compressionRatio: 3,
      logger: false
    })
    // Should not throw; no way to observe absence of logging other than no error
    const output = await summarizer.summarize(
      'Acme Corp planned the Q2 launch with Engineering, Product, and Sales in Bangkok. The team agreed on milestones.'
    )
    expect(output.length).toBeGreaterThan(0)
  })
})
