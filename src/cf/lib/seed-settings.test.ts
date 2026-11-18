import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/lib/config/settings'
import { seedSettings } from './seed-settings'

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
      auth: { allowLocalAuth: false, allowSocialAuth: true, trustedOrigins: [ORIGIN] },
    })
  })

  it('leaves the settings of an org that finished setup as they are', () => {
    const settings = {
      llmProvider: 'anthropic',
      app: { setupCompleted: true },
      auth: { allowLocalAuth: true, trustedOrigins: [ORIGIN] },
    } as unknown as AppSettings

    expect(seedSettings(settings, SEED, ORIGIN)).toBe(false)
    expect(settings.llmProvider).toBe('anthropic')
    expect(settings.auth?.allowLocalAuth).toBe(true)
  })

  it('sets no policy when the deployment gives no seed', () => {
    const settings = {} as AppSettings

    expect(seedSettings(settings, undefined, ORIGIN)).toBe(true)

    expect(settings).toEqual({ auth: { trustedOrigins: [ORIGIN] } })
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
