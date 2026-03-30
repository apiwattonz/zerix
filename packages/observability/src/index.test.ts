import { describe, it, expect } from 'vitest'
import { observabilityPlaceholder } from './index.js'

describe('observability', () => {
  it('placeholder', () => {
    expect(observabilityPlaceholder().ok).toBe(true)
  })
})
