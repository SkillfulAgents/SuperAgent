import { describe, it, expect } from 'vitest'
import { SCOPE_DESCRIPTIONS } from './scope-descriptions'
import { SCOPE_MAPS } from './scope-maps'

describe('SCOPE_DESCRIPTIONS', () => {
  it('covers every provider in SCOPE_MAPS', () => {
    const mapProviders = Object.keys(SCOPE_MAPS).sort()
    const descProviders = Object.keys(SCOPE_DESCRIPTIONS).sort()
    expect(descProviders).toEqual(mapProviders)
  })

  it.each(Object.keys(SCOPE_MAPS))(
    '%s: every scope in allScopes has a curated description',
    (provider) => {
      const allScopes = SCOPE_MAPS[provider].allScopes
      const flat = Array.isArray(allScopes)
        ? allScopes
        : Object.values(allScopes).flat()
      const descs = SCOPE_DESCRIPTIONS[provider] ?? {}
      const missing = flat.filter((s) => !descs[s])
      expect(missing).toEqual([])
    },
  )

  it.each(Object.keys(SCOPE_MAPS))(
    '%s: no description keys reference scopes outside allScopes',
    (provider) => {
      const allScopes = SCOPE_MAPS[provider].allScopes
      const flat = new Set(
        Array.isArray(allScopes) ? allScopes : Object.values(allScopes).flat(),
      )
      const descs = SCOPE_DESCRIPTIONS[provider] ?? {}
      const fabricated = Object.keys(descs).filter((s) => !flat.has(s))
      expect(fabricated).toEqual([])
    },
  )

  it('every description is a non-empty, plausible string', () => {
    for (const [provider, descs] of Object.entries(SCOPE_DESCRIPTIONS)) {
      for (const [scope, desc] of Object.entries(descs)) {
        expect(desc, `${provider}.${scope}`).toBeTruthy()
        expect(typeof desc).toBe('string')
        expect(desc.length).toBeGreaterThan(3)
      }
    }
  })
})
