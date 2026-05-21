import { describe, it, expect } from 'vitest'
import { RuntimeOptionsSchema, parseRuntimeOptions } from './runtime-options'

describe('RuntimeOptionsSchema', () => {
  it('accepts an empty object', () => {
    expect(RuntimeOptionsSchema.parse({})).toEqual({})
  })

  it('accepts a valid effort', () => {
    expect(RuntimeOptionsSchema.parse({ effort: 'high' })).toEqual({ effort: 'high' })
  })

  it('accepts a valid model', () => {
    expect(RuntimeOptionsSchema.parse({ model: 'claude-opus-4-7' })).toEqual({ model: 'claude-opus-4-7' })
  })

  it('accepts both effort and model', () => {
    expect(RuntimeOptionsSchema.parse({ effort: 'low', model: 'claude-haiku-4-5' })).toEqual({
      effort: 'low',
      model: 'claude-haiku-4-5',
    })
  })

  it('rejects unknown effort values', () => {
    expect(() => RuntimeOptionsSchema.parse({ effort: 'turbo' })).toThrow()
  })

  it('rejects non-string model', () => {
    expect(() => RuntimeOptionsSchema.parse({ model: 123 })).toThrow()
  })

  it('rejects unknown keys', () => {
    expect(() => RuntimeOptionsSchema.parse({ effort: 'high', extra: 'x' })).toThrow()
  })
})

describe('parseRuntimeOptions', () => {
  it('returns parsed options for valid input', () => {
    expect(parseRuntimeOptions({ effort: 'medium', model: 'claude-sonnet-4-6' })).toEqual({
      effort: 'medium',
      model: 'claude-sonnet-4-6',
    })
  })

  it('returns empty object for missing fields', () => {
    expect(parseRuntimeOptions({})).toEqual({})
  })

  it('strips invalid fields and returns empty when nothing valid', () => {
    expect(parseRuntimeOptions({ effort: 'turbo' })).toEqual({})
  })

  it('preserves valid fields when others are invalid', () => {
    expect(parseRuntimeOptions({ effort: 'turbo', model: 'claude-opus-4-7' })).toEqual({
      model: 'claude-opus-4-7',
    })
  })

  it('returns empty object for non-object input', () => {
    expect(parseRuntimeOptions(null)).toEqual({})
    expect(parseRuntimeOptions(undefined)).toEqual({})
    expect(parseRuntimeOptions('foo')).toEqual({})
  })
})
