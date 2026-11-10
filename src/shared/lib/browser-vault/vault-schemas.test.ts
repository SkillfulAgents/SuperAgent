import { describe, expect, it } from 'vitest'
import { sessionBundleSchema as containerBundleSchema } from '../../../../agent-container/src/browser-session-schema'
import { sessionBundleSchema } from './vault-schemas'

/** A bundle with every field either side may write. */
const FULL_BUNDLE = {
  version: 1,
  site: 'acme.okta.com',
  capturedAt: '2026-10-26T00:00:00.000Z',
  cookies: [
    { name: 'sid', value: 'v', domain: 'acme.okta.com', path: '/', httpOnly: true, secure: true },
    {
      name: 'DT', value: 'd', domain: '.okta.com', path: '/', expires: 2_000_000_000, httpOnly: false, secure: true,
      sameSite: 'None', priority: 'High', sourceScheme: 'Secure', sourcePort: 443,
      partitionKey: { topLevelSite: 'https://okta.com', hasCrossSiteAncestor: false },
    },
  ],
  origins: [{
    origin: 'https://acme.okta.com',
    localStorage: [['token', 't']],
    indexedDB: [{
      name: 'auth',
      version: 2,
      stores: [{ name: 'kv', keyPath: null, autoIncrement: false, indexes: [{ name: 'by', keyPath: ['a', 'b'], unique: false, multiEntry: true }], records: [{ key: 'k', value: { $t: 'date', v: 5 } }] }],
    }],
  }],
  leftOut: 1,
}

describe('the saved session bundle', () => {
  it('is the same shape on the host as the container writes and restores', () => {
    expect(sessionBundleSchema.parse(FULL_BUNDLE)).toEqual(FULL_BUNDLE)
    expect(containerBundleSchema.parse(FULL_BUNDLE)).toEqual(FULL_BUNDLE)
    for (const extra of [{ ...FULL_BUNDLE, extra: 1 }, { ...FULL_BUNDLE, origins: [{ ...FULL_BUNDLE.origins[0], sessionStorage: [] }] }]) {
      expect(sessionBundleSchema.safeParse(extra).success).toBe(false)
      expect(containerBundleSchema.safeParse(extra).success).toBe(false)
    }
  })
})
