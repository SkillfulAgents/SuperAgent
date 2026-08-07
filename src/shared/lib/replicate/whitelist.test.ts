import { describe, expect, it } from 'vitest'
import { WHITELIST_ENTRIES } from './whitelist-data'
import { getWhitelistCatalog, isWhitelistedModel } from './whitelist'

describe('isWhitelistedModel', () => {
  it('returns true for a pinned model', () => {
    expect(isWhitelistedModel('meta', 'musicgen')).toBe(true)
  })

  it('returns false for an unknown model', () => {
    expect(isWhitelistedModel('acme', 'not-a-real-model')).toBe(false)
  })
})

describe('getWhitelistCatalog', () => {
  it('groups by category and includes every pinned model exactly once', () => {
    const catalog = getWhitelistCatalog()
    const seen = new Map<string, string>()
    for (const group of catalog) {
      expect(group.category.length).toBeGreaterThan(0)
      for (const m of group.models) {
        seen.set(m.model, group.category)
      }
    }
    expect(seen.size).toBe(WHITELIST_ENTRIES.length)
    for (const entry of WHITELIST_ENTRIES) {
      expect(seen.get(entry.model)).toBe(entry.category)
    }
  })

  // The catalog is the agent's only discovery surface, so a model it names that the gate
  // then refuses is a dishonest affordance.
  it('advertises only models the runtime gate admits', () => {
    for (const group of getWhitelistCatalog()) {
      for (const { model } of group.models) {
        const [owner, name] = model.split('/')
        expect(isWhitelistedModel(owner, name), model).toBe(true)
      }
    }
  })
})
