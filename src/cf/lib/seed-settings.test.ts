import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/lib/config/settings'
import { SESSION_COOKIE_CACHE_SECONDS, seedSettings } from './seed-settings'

const ORIGIN = 'https://org.example.com'
const SEED = JSON.stringify({
  llmProvider: 'platform',
  app: { setupCompleted: true, hostBrowserProvider: 'platform' },
  auth: { allowLocalAuth: false, allowSocialAuth: true },
})

describe('seedSettings', () => {
  it("starts a new org from its deployment's seed, with the origin this runtime needs", () => {
    const settings = { app: { theme: 'dark' } } as unknown as AppSettings

    expect(seedSettings(settings, SEED, ORIGIN)).toBe(true)

    expect(settings).toMatchObject({
      llmProvider: 'platform',
      app: { theme: 'dark', setupCompleted: true, hostBrowserProvider: 'platform' },
      auth: { allowLocalAuth: false, allowSocialAuth: true, trustedOrigins: [ORIGIN], sessionCookieCacheSeconds: 60 },
    })
  })

  it('leaves the settings of an org that finished setup as they are', () => {
    const settings = {
      llmProvider: 'anthropic',
      app: { setupCompleted: true },
      auth: { allowLocalAuth: true, trustedOrigins: [ORIGIN], sessionCookieCacheSeconds: 0 },
    } as unknown as AppSettings

    expect(seedSettings(settings, SEED, ORIGIN)).toBe(false)
    expect(settings.llmProvider).toBe('anthropic')
    expect(settings.auth?.allowLocalAuth).toBe(true)
  })

  it('sets no policy when the deployment gives no seed', () => {
    const settings = {} as AppSettings

    expect(seedSettings(settings, undefined, ORIGIN)).toBe(true)

    expect(settings).toEqual({ auth: { trustedOrigins: [ORIGIN], sessionCookieCacheSeconds: 60 } })
  })

  it('reads sessions from the signed cookie for a minute, so a request does not pay two D1 round trips for one', () => {
    const settings = {} as AppSettings

    seedSettings(settings, undefined, ORIGIN)

    // A minute, written out: a longer window is a longer life for a revoked session, so changing it is a decision.
    expect(SESSION_COOKIE_CACHE_SECONDS).toBe(60)
    expect(settings.auth?.sessionCookieCacheSeconds).toBe(60)
  })

  it('turns the session cookie cache on for an org that finished setup without one', () => {
    const settings = { app: { setupCompleted: true }, auth: { trustedOrigins: [ORIGIN] } } as unknown as AppSettings

    expect(seedSettings(settings, SEED, ORIGIN)).toBe(true)
    expect(settings.auth?.sessionCookieCacheSeconds).toBe(60)
    expect(seedSettings(settings, SEED, ORIGIN)).toBe(false)
  })

  it.each([0, 300])("keeps an org's own session cookie cache window of %s seconds, from its seed or set later", (seconds) => {
    const seeded = {} as AppSettings
    seedSettings(seeded, JSON.stringify({ auth: { sessionCookieCacheSeconds: seconds } }), ORIGIN)
    expect(seeded.auth?.sessionCookieCacheSeconds).toBe(seconds)

    const existing = { app: { setupCompleted: true }, auth: { trustedOrigins: [ORIGIN], sessionCookieCacheSeconds: seconds } } as unknown as AppSettings
    expect(seedSettings(existing, SEED, ORIGIN)).toBe(false)
    expect(existing.auth?.sessionCookieCacheSeconds).toBe(seconds)
  })

  it('keeps the origins an admin already trusts and adds its own', () => {
    const settings = { app: { setupCompleted: true }, auth: { trustedOrigins: ['https://old.example.com'] } } as unknown as AppSettings

    seedSettings(settings, SEED, ORIGIN)

    expect(settings.auth?.trustedOrigins).toEqual(['https://old.example.com', ORIGIN])
  })

  it('trusts no origin when the deployment names none and no request has reached it yet', () => {
    const settings = {} as AppSettings
    seedSettings(settings, undefined, undefined)
    expect(settings.auth?.trustedOrigins).toBeUndefined()
  })

  it('refuses a seed that is not a JSON object, so the deploy step fails', () => {
    expect(() => seedSettings({} as AppSettings, '{"app":', ORIGIN)).toThrow('SEED_SETTINGS is not valid JSON')
    expect(() => seedSettings({} as AppSettings, '["platform"]', ORIGIN)).toThrow('SEED_SETTINGS must be a JSON object')
  })
})
