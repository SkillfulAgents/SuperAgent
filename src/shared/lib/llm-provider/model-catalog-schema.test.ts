import { describe, it, expect } from 'vitest'
import { modelDefinitionSchema, modelCatalogSchema } from './model-catalog-schema'

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

  it('validates a catalog array', () => {
    expect(modelCatalogSchema.parse([base])).toHaveLength(1)
  })
})
