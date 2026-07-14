import { describe, it, expect } from 'vitest'
import {
  catalogOverrideEntrySchema,
  modelCatalogSchema,
  modelCatalogSettingsSchema,
  modelDefinitionSchema,
} from './model-catalog-schema'

const base = {
  id: 'claude-opus-4-8',
  label: 'Opus 4.8',
  supportedEfforts: ['low', 'medium', 'high'],
}

describe('modelDefinitionSchema', () => {
  it('accepts a minimal valid definition (family/icon/pricing optional)', () => {
    expect(modelDefinitionSchema.parse(base)).toMatchObject({ id: 'claude-opus-4-8' })
  })

  it('accepts a full definition', () => {
    const full = {
      ...base,
      blurb: 'Most capable',
      icon: 'anthropic',
      family: 'opus',
      isLatest: true,
      pricing: { inputPerMtok: 5, outputPerMtok: 25 },
    }
    expect(modelDefinitionSchema.parse(full)).toMatchObject({ family: 'opus', isLatest: true })
  })

  it('rejects an empty id or label', () => {
    expect(() => modelDefinitionSchema.parse({ ...base, id: '' })).toThrow()
    expect(() => modelDefinitionSchema.parse({ ...base, label: '' })).toThrow()
  })

  it('enforces the effort enum and a non-empty list', () => {
    expect(() => modelDefinitionSchema.parse({ ...base, supportedEfforts: [] })).toThrow()
    expect(() => modelDefinitionSchema.parse({ ...base, supportedEfforts: ['turbo'] })).toThrow()
  })

  it('rejects negative pricing', () => {
    expect(() =>
      modelDefinitionSchema.parse({ ...base, pricing: { inputPerMtok: -1, outputPerMtok: 25 } }),
    ).toThrow()
  })

  it('accepts an optional positive-int contextWindow and omits cleanly', () => {
    expect(modelDefinitionSchema.parse({ ...base, contextWindow: 1_050_000 })).toMatchObject({
      contextWindow: 1_050_000,
    })
    expect(modelDefinitionSchema.parse(base).contextWindow).toBeUndefined()
  })

  it('rejects a non-positive or non-integer contextWindow', () => {
    expect(() => modelDefinitionSchema.parse({ ...base, contextWindow: 0 })).toThrow()
    expect(() => modelDefinitionSchema.parse({ ...base, contextWindow: -1 })).toThrow()
    expect(() => modelDefinitionSchema.parse({ ...base, contextWindow: 1.5 })).toThrow()
  })

  it('accepts an optional longContextPriceCliff and omits cleanly', () => {
    const cliff = { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
    expect(modelDefinitionSchema.parse({ ...base, longContextPriceCliff: cliff })).toMatchObject({
      longContextPriceCliff: cliff,
    })
    expect(modelDefinitionSchema.parse(base).longContextPriceCliff).toBeUndefined()
  })

  it('rejects a longContextPriceCliff with a non-positive threshold or multiplier', () => {
    expect(() =>
      modelDefinitionSchema.parse({
        ...base,
        longContextPriceCliff: { thresholdTokens: 0, inputMultiplier: 2, outputMultiplier: 1.5 },
      }),
    ).toThrow()
    expect(() =>
      modelDefinitionSchema.parse({
        ...base,
        longContextPriceCliff: { thresholdTokens: 272_000, inputMultiplier: 0, outputMultiplier: 1.5 },
      }),
    ).toThrow()
  })

  it('accepts non-empty prompt hints and rejects empty hints', () => {
    expect(modelDefinitionSchema.parse({ ...base, promptHints: ['Use exact tool names.'] })).toMatchObject({
      promptHints: ['Use exact tool names.'],
    })
    expect(() => modelDefinitionSchema.parse({ ...base, promptHints: [''] })).toThrow()
  })

  it('accepts supportsWebFetch independently of supportsWebSearch', () => {
    expect(
      modelDefinitionSchema.parse({
        ...base,
        supportsWebSearch: true,
        supportsWebFetch: false,
      }),
    ).toMatchObject({ supportsWebSearch: true, supportsWebFetch: false })
  })

  it('validates a catalog array', () => {
    expect(modelCatalogSchema.parse([base])).toHaveLength(1)
  })
})

describe('catalogOverrideEntrySchema', () => {
  it('accepts id-only, disabled, and partial patch entries', () => {
    expect(catalogOverrideEntrySchema.parse({ id: 'claude-opus-4-8' })).toEqual({ id: 'claude-opus-4-8' })
    expect(catalogOverrideEntrySchema.parse({ id: 'claude-opus-4-8', disabled: true })).toMatchObject({
      id: 'claude-opus-4-8',
      disabled: true,
    })
    expect(catalogOverrideEntrySchema.parse({
      id: 'claude-opus-4-8',
      label: 'Patched label',
      supportedEfforts: ['low'],
    })).toMatchObject({ label: 'Patched label' })
  })

  it('rejects missing or empty ids', () => {
    expect(() => catalogOverrideEntrySchema.parse({ label: 'No id' })).toThrow()
    expect(() => catalogOverrideEntrySchema.parse({ id: '' })).toThrow()
  })

  it('rejects wrong-typed fields and invalid effort values', () => {
    expect(() => catalogOverrideEntrySchema.parse({ id: 'x', pricing: 'cheap' })).toThrow()
    expect(() => catalogOverrideEntrySchema.parse({ id: 'x', supportedEfforts: ['turbo'] })).toThrow()
  })
})

describe('modelCatalogSettingsSchema', () => {
  it('accepts an empty provider-keyed map and unknown provider keys', () => {
    expect(modelCatalogSettingsSchema.parse({})).toEqual({})
    expect(modelCatalogSettingsSchema.parse({
      futureProvider: { overrides: [{ id: 'future-model', disabled: true }] },
    })).toEqual({
      futureProvider: { overrides: [{ id: 'future-model', disabled: true }] },
    })
  })

  it('defaults missing per-provider overrides to an empty list', () => {
    expect(modelCatalogSettingsSchema.parse({ anthropic: {} })).toEqual({
      anthropic: { overrides: [] },
    })
  })
})
