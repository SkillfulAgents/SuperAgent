import { describe, it, expect } from 'vitest'
import { RuntimeOptionsSchema, clampEffortForDisplay, clampSpeedForDisplay, parseRuntimeOptions, resolveRuntimeInherit } from './runtime-options'

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

describe('resolveRuntimeInherit', () => {
  const models = { agentModel: 'claude-opus-4-8', agentEffort: 'medium' as const }

  it('uses the app default when neither surface nor agent set one, and omits speed', () => {
    const resolved = resolveRuntimeInherit({ model: null, effort: null, speed: null }, {}, models)
    expect(resolved).toEqual({ model: 'claude-opus-4-8', effort: 'medium' })
    expect('speed' in resolved).toBe(false)
  })

  it('prefers the agent default over the app default', () => {
    expect(resolveRuntimeInherit({}, {
      defaultModel: 'opus',
      defaultEffort: 'high',
      defaultSpeed: 'slow',
    }, models)).toEqual({
      model: 'opus',
      effort: 'high',
      speed: 'slow',
    })
  })

  it('prefers the surface override over the agent default', () => {
    expect(resolveRuntimeInherit(
      { model: 'claude-haiku-4-5', effort: 'low', speed: 'fast' },
      { defaultModel: 'opus', defaultEffort: 'high', defaultSpeed: 'slow' },
      models,
    )).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
      speed: 'fast',
    })
  })

  it('treats an empty surface model as unset', () => {
    expect(resolveRuntimeInherit({ model: '' }, { defaultModel: 'sonnet' }, models).model).toBe('sonnet')
  })

  it.each([
    [{ effort: 'turbo' }, {}],
    [{}, { defaultEffort: 'turbo' }],
  ])('treats junk effort as unset and falls through to the app default (%j)', (surface, agent) => {
    expect(resolveRuntimeInherit(surface, agent, models)).toEqual({
      model: 'claude-opus-4-8',
      effort: 'medium',
    })
  })

  it('omits effort when no rung has one, including junk app effort', () => {
    expect(resolveRuntimeInherit({}, {}, { agentModel: 'claude-opus-4-8' })).toEqual({
      model: 'claude-opus-4-8',
    })
    expect(resolveRuntimeInherit({}, {}, { agentModel: 'claude-opus-4-8', agentEffort: 'turbo' })).toEqual({
      model: 'claude-opus-4-8',
    })
  })
})

describe('clampEffortForDisplay', () => {
  it('keeps an allowed effort and snaps an illegal one to medium', () => {
    expect(clampEffortForDisplay('high', ['low', 'medium', 'high'])).toBe('high')
    expect(clampEffortForDisplay('max', ['low', 'medium', 'high'])).toBe('medium')
  })
})

describe('clampSpeedForDisplay', () => {
  it('snaps to normal when the model does not allow the inherited speed', () => {
    expect(clampSpeedForDisplay('fast', ['slow'])).toBe('normal')
  })
})
