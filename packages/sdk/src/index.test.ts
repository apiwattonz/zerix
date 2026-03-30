import { describe, it, expect } from 'vitest'
import { sdkPlaceholder } from './index.js'

describe('sdk', () => {
  it('placeholder', () => {
    expect(sdkPlaceholder().message).toBe('sdk placeholder')
  })
})
