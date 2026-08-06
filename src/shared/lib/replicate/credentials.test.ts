import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ apiKeys: {} })),
}))

import { getSettings } from '@shared/lib/config/settings'
import {
  getEffectiveReplicateKey,
  getReplicateKeyStatus,
  validateReplicateKey,
} from './credentials'

function mockSettings(apiKeys: { replicateApiKey?: string }) {
  vi.mocked(getSettings).mockReturnValue({ apiKeys } as unknown as ReturnType<typeof getSettings>)
}

function mockFetch(ok: boolean, status: number) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.REPLICATE_API_TOKEN
  mockSettings({})
})

describe('getEffectiveReplicateKey / getReplicateKeyStatus', () => {
  it('settings key wins over env', () => {
    process.env.REPLICATE_API_TOKEN = 'env-key'
    mockSettings({ replicateApiKey: 'settings-key' })
    expect(getEffectiveReplicateKey()).toBe('settings-key')
    expect(getReplicateKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
  })

  it('falls back to REPLICATE_API_TOKEN env', () => {
    process.env.REPLICATE_API_TOKEN = 'env-key'
    mockSettings({})
    expect(getEffectiveReplicateKey()).toBe('env-key')
    expect(getReplicateKeyStatus()).toEqual({ isConfigured: true, source: 'env' })
  })

  it('reports none when neither is set', () => {
    mockSettings({})
    expect(getEffectiveReplicateKey()).toBeUndefined()
    expect(getReplicateKeyStatus()).toEqual({ isConfigured: false, source: 'none' })
  })
})

describe('validateReplicateKey', () => {
  it('maps 200 to valid', async () => {
    mockFetch(true, 200)
    await expect(validateReplicateKey('r8_good')).resolves.toEqual({ valid: true })
  })

  it('maps 401/403 to Invalid API key', async () => {
    mockFetch(false, 401)
    await expect(validateReplicateKey('r8_bad')).resolves.toEqual({
      valid: false,
      error: 'Invalid API key',
    })
    mockFetch(false, 403)
    await expect(validateReplicateKey('r8_bad')).resolves.toEqual({
      valid: false,
      error: 'Invalid API key',
    })
  })

  it('maps other status to API error', async () => {
    mockFetch(false, 500)
    await expect(validateReplicateKey('r8_x')).resolves.toEqual({
      valid: false,
      error: 'Replicate API error: 500',
    })
  })

  it('maps network throw to Network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    await expect(validateReplicateKey('r8_x')).resolves.toEqual({
      valid: false,
      error: 'Network error: ECONNRESET',
    })
  })
})
