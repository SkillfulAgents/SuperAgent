import { describe, expect, it } from 'vitest'
import { SIGN_IN_PROVIDER_IDS } from '../../../../agent-container/src/login-schema'
import { providerName, providerOf, SIGN_IN_PROVIDERS } from './providers'

describe('sign-in providers', () => {
  it('knows every provider request_login lets the agent name', () => {
    const known = new Set(SIGN_IN_PROVIDERS.map((provider) => provider.id))
    expect(SIGN_IN_PROVIDER_IDS.filter((id) => !known.has(id))).toEqual([])
  })

  it('tells a provider by the domain of its sign-in site', () => {
    expect(providerOf('accounts.google.com')?.id).toBe('google')
    expect(providerOf('google.com')?.id).toBe('google')
    expect(providerOf('login.microsoftonline.com')?.id).toBe('microsoft-work')
    expect(providerOf('acme.okta.com')).toBeNull()
    expect(providerName('login.live.com')).toBe('Microsoft')
    expect(providerName('acme.okta.com')).toBe('acme.okta.com')
  })
})
