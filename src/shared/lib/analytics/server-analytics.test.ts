import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSettingsMock = vi.fn()
const getTenantIdMock = vi.fn(() => 'tenant-test')

vi.mock('../config/settings', () => ({
  getSettings: getSettingsMock,
}))

vi.mock('./tenant-id', () => ({
  getTenantId: getTenantIdMock,
}))

vi.mock('./constants', () => ({
  DEFAULT_AMPLITUDE_KEY: 'default-amplitude-key',
}))

import { trackServerEvent } from './server-analytics'

describe('trackServerEvent', () => {
  beforeEach(() => {
    getSettingsMock.mockReturnValue({
      shareAnalytics: true,
      analyticsTargets: [
        { type: 'amplitude', enabled: true, config: { apiKey: 'custom-amplitude-key' } },
      ],
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('does not send analytics while E2E mock mode is enabled', async () => {
    vi.stubEnv('E2E_MOCK', 'true')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    trackServerEvent('agent_created', { source: 'new' })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns before reading settings in E2E mock mode', async () => {
    vi.stubEnv('E2E_MOCK', 'true')
    trackServerEvent('agent_created', { source: 'new' })

    expect(getSettingsMock).not.toHaveBeenCalled()
    expect(getTenantIdMock).not.toHaveBeenCalled()
  })
})
