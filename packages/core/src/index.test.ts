import { describe, it, expect } from 'vitest'
import { corePlaceholder } from './index.js'

describe('core', () => {
  it('placeholder', () => {
    expect(corePlaceholder().message).toBe('core placeholder')
  })
})
