import { describe, it, expect } from 'vitest'
import type { CatalogOverrideEntry, ModelDefinition } from '@shared/lib/llm-provider'
import {
  cleanOverride,
  formatTokenWindow,
  groupModelsByFamily,
  imageInputLabel,
  isEmptyOverride,
  modelFromOverride,
  parseOptionalPrice,
  priceLabel,
  providerOverrides,
  replaceOverride,
  searchResultMeta,
  setProviderOverrides,
} from './catalog-overrides'

const model = (over: Partial<ModelDefinition> & { id: string }): ModelDefinition => ({
  label: over.id,
  supportedEfforts: ['medium'],
  ...over,
})

describe('priceLabel', () => {
  it('appends the /MTok unit', () => {
    expect(priceLabel({ inputPerMtok: 2.5, outputPerMtok: 15 })).toBe('$2.5/$15/MTok')
  })
  it('handles missing pricing', () => {
    expect(priceLabel(undefined)).toBe('No pricing')
  })
})

describe('formatTokenWindow', () => {
  it('formats K and M windows, and omits when unset', () => {
    expect(formatTokenWindow(200_000)).toBe('200K context')
    expect(formatTokenWindow(1_500_000)).toBe('1.5M context')
    expect(formatTokenWindow(undefined)).toBeUndefined()
    expect(formatTokenWindow(0)).toBeUndefined()
  })
})

describe('imageInputLabel', () => {
  it('renders Yes/No, and nothing when support is unknown', () => {
    expect(imageInputLabel(true)).toBe('Image input: Yes')
    expect(imageInputLabel(false)).toBe('Image input: No')
    expect(imageInputLabel(undefined)).toBeUndefined()
  })
})

describe('searchResultMeta', () => {
  it('joins context window and price, omitting image input when unknown', () => {
    expect(
      searchResultMeta({
        id: 'x',
        label: 'X',
        supportedEfforts: ['medium'],
        contextWindow: 262_144,
        pricing: { inputPerMtok: 0.4, outputPerMtok: 1.2 },
      }),
    ).toBe('262K context · $0.4/$1.2/MTok')
  })

  it('appends image-input support when known', () => {
    expect(
      searchResultMeta({
        id: 'x',
        label: 'X',
        supportedEfforts: ['medium'],
        contextWindow: 262_144,
        pricing: { inputPerMtok: 0.4, outputPerMtok: 1.2 },
        supportsImageInput: true,
      }),
    ).toBe('262K context · $0.4/$1.2/MTok · Image input: Yes')
  })
})

describe('parseOptionalPrice', () => {
  it('parses, blanks to undefined, and rejects negatives/NaN', () => {
    expect(parseOptionalPrice('2.5')).toBe(2.5)
    expect(parseOptionalPrice('  ')).toBeUndefined()
    expect(parseOptionalPrice('-1')).toBeUndefined()
    expect(parseOptionalPrice('abc')).toBeUndefined()
    expect(parseOptionalPrice('0')).toBe(0)
  })
})

describe('isEmptyOverride / cleanOverride', () => {
  it('treats an id-only override as empty', () => {
    expect(isEmptyOverride({ id: 'x' })).toBe(true)
    expect(isEmptyOverride({ id: 'x', disabled: true })).toBe(false)
  })
  it('drops undefined fields and nulls out id-only results', () => {
    expect(cleanOverride({ id: 'x', label: undefined })).toBeNull()
    expect(cleanOverride({ id: 'x', disabled: true })).toEqual({ id: 'x', disabled: true })
  })
})

describe('replaceOverride', () => {
  const overrides: CatalogOverrideEntry[] = [
    { id: 'a', disabled: true },
    { id: 'b', label: 'B' },
  ]
  it('replaces an existing entry by id', () => {
    expect(replaceOverride(overrides, { id: 'a', label: 'A2' }, 'a')).toEqual([
      { id: 'b', label: 'B' },
      { id: 'a', label: 'A2' },
    ])
  })
  it('removes the entry when passed null', () => {
    expect(replaceOverride(overrides, null, 'a')).toEqual([{ id: 'b', label: 'B' }])
  })
})

describe('providerOverrides / setProviderOverrides', () => {
  it('reads overrides, defaulting to empty', () => {
    expect(providerOverrides(undefined, 'anthropic')).toEqual([])
    expect(
      providerOverrides({ anthropic: { overrides: [{ id: 'a' }] } }, 'anthropic'),
    ).toEqual([{ id: 'a' }])
  })
  it('writes overrides and prunes the provider key when empty', () => {
    const next = setProviderOverrides({}, 'anthropic', [{ id: 'a', disabled: true }])
    expect(next).toEqual({ anthropic: { overrides: [{ id: 'a', disabled: true }] } })
    expect(setProviderOverrides(next, 'anthropic', [])).toEqual({})
  })
})

describe('groupModelsByFamily', () => {
  it('groups by family in first-seen order, bucketing unfamilied as other', () => {
    const grouped = groupModelsByFamily([
      model({ id: 'a', family: 'gpt' }),
      model({ id: 'b' }),
      model({ id: 'c', family: 'gpt' }),
    ])
    expect(grouped.map((g) => g.family)).toEqual(['gpt', 'other'])
    expect(grouped[0].models.map((m) => m.id)).toEqual(['a', 'c'])
    expect(grouped[1].models.map((m) => m.id)).toEqual(['b'])
  })
})

describe('modelFromOverride', () => {
  it('parses a complete override into a model, dropping disabled', () => {
    const parsed = modelFromOverride({
      id: 'x',
      label: 'X',
      supportedEfforts: ['low'],
      disabled: true,
    })
    expect(parsed).toEqual({ id: 'x', label: 'X', supportedEfforts: ['low'] })
  })
  it('returns null for an incomplete override', () => {
    expect(modelFromOverride({ id: 'x' })).toBeNull()
  })
})
