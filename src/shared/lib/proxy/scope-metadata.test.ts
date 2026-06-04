import { describe, it, expect } from 'vitest'
import { SCOPE_METADATA, getScopeDescription, getScopeLabel } from './scope-metadata'
import { SCOPE_MAPS } from './scope-maps'

const VALID_LABELS = ['read', 'write', 'destructive']

function flatScopes(provider: string): string[] {
  const allScopes = SCOPE_MAPS[provider].allScopes
  return Array.isArray(allScopes) ? allScopes : Object.values(allScopes).flat()
}

describe('SCOPE_METADATA', () => {
  it('covers every provider in SCOPE_MAPS', () => {
    const mapProviders = Object.keys(SCOPE_MAPS).sort()
    const metaProviders = Object.keys(SCOPE_METADATA).sort()
    expect(metaProviders).toEqual(mapProviders)
  })

  it.each(Object.keys(SCOPE_MAPS))(
    '%s: every scope in allScopes has a curated description',
    (provider) => {
      const meta = SCOPE_METADATA[provider] ?? {}
      const missing = flatScopes(provider).filter((s) => !meta[s]?.description)
      expect(missing).toEqual([])
    },
  )

  it.each(Object.keys(SCOPE_MAPS))(
    '%s: every scope in allScopes has a valid risk label',
    (provider) => {
      const meta = SCOPE_METADATA[provider] ?? {}
      const unlabeled = flatScopes(provider).filter(
        (s) => !VALID_LABELS.includes(meta[s]?.label as string),
      )
      expect(unlabeled).toEqual([])
    },
  )

  it.each(Object.keys(SCOPE_MAPS))(
    '%s: no metadata keys reference scopes outside allScopes',
    (provider) => {
      const flat = new Set(flatScopes(provider))
      const meta = SCOPE_METADATA[provider] ?? {}
      const fabricated = Object.keys(meta).filter((s) => !flat.has(s))
      expect(fabricated).toEqual([])
    },
  )

  it('every description is a non-empty, plausible string', () => {
    for (const [provider, scopes] of Object.entries(SCOPE_METADATA)) {
      for (const [scope, meta] of Object.entries(scopes)) {
        expect(meta.description, `${provider}.${scope}`).toBeTruthy()
        expect(typeof meta.description).toBe('string')
        expect(meta.description.length).toBeGreaterThan(3)
      }
    }
  })

  it('accessors return the stored description and label', () => {
    const [provider, scopes] = Object.entries(SCOPE_METADATA)[0]
    const [scope, meta] = Object.entries(scopes)[0]
    expect(getScopeDescription(provider, scope)).toBe(meta.description)
    expect(getScopeLabel(provider, scope)).toBe(meta.label)
    // unknown lookups are undefined, never throw
    expect(getScopeDescription('__nope__', '__nope__')).toBeUndefined()
    expect(getScopeLabel(provider, '__nope__')).toBeUndefined()
  })
})
