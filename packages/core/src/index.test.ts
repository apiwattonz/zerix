import { describe, expect, it } from 'vitest'
import { ChunkType, MemoryTier } from './index.js'

describe('core package exports', () => {
  it('re-exports core enums', () => {
    expect(ChunkType.FACT).toBe('FACT')
    expect(MemoryTier.L1_CACHE).toBe('L1_CACHE')
  })
})
