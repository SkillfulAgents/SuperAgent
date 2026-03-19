import { describe, it, expect } from 'vitest'
import { userSettingsSchema } from './user-settings-service'

describe('userSettingsSchema agentOrder', () => {
  it('defaults to undefined when not provided', () => {
    const result = userSettingsSchema.parse({})
    expect(result.agentOrder).toBeUndefined()
  })

  it('accepts a valid array of slugs', () => {
    const result = userSettingsSchema.parse({ agentOrder: ['a', 'b', 'c'] })
    expect(result.agentOrder).toEqual(['a', 'b', 'c'])
  })

  it('accepts an empty array', () => {
    const result = userSettingsSchema.parse({ agentOrder: [] })
    expect(result.agentOrder).toEqual([])
  })

  it('rejects non-string array elements', () => {
    expect(() => userSettingsSchema.parse({ agentOrder: [1, 2] })).toThrow()
  })

  it('rejects non-array values', () => {
    expect(() => userSettingsSchema.parse({ agentOrder: 'not-array' })).toThrow()
  })

  it('survives a round-trip through JSON', () => {
    const original = userSettingsSchema.parse({ agentOrder: ['x', 'y'] })
    const roundTripped = userSettingsSchema.parse(JSON.parse(JSON.stringify(original)))
    expect(roundTripped.agentOrder).toEqual(['x', 'y'])
  })

  it('replaces agentOrder on spread merge (not deep-merged)', () => {
    const current = userSettingsSchema.parse({ agentOrder: ['a', 'b', 'c'] })
    const partial = { agentOrder: ['c', 'a'] }
    const merged = { ...current, ...partial }
    const result = userSettingsSchema.parse(merged)
    expect(result.agentOrder).toEqual(['c', 'a'])
  })
})
