import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('@shared/lib/analytics/server-analytics')
vi.unmock('./server-analytics')

const { getSettingsMock, getTenantIdMock, getPlatformAuthStatusMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  getTenantIdMock: vi.fn(() => 'tenant-test'),
  getPlatformAuthStatusMock: vi.fn(),
}))

vi.mock('../config/settings', () => ({
  getSettings: getSettingsMock,
}))

vi.mock('./tenant-id', () => ({
  getTenantId: getTenantIdMock,
}))

vi.mock('./constants', () => ({
  DEFAULT_AMPLITUDE_KEY: 'default-amplitude-key',
}))

vi.mock('../services/platform-auth-service', () => ({
  getPlatformAuthStatus: getPlatformAuthStatusMock,
}))

import { trackServerEvent, resolveAnalyticsUserId } from './server-analytics'

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

  it('resolveAnalyticsUserId prefers the platform id, else tenant:user', () => {
    vi.stubEnv('E2E_MOCK', '')
    getPlatformAuthStatusMock.mockReturnValueOnce({ connected: true, userId: 'plat-1' } as never)
    expect(resolveAnalyticsUserId('u1')).toBe('plat-1')
    getPlatformAuthStatusMock.mockReturnValueOnce({ connected: false } as never)
    getTenantIdMock.mockReturnValueOnce('tenant-x')
    expect(resolveAnalyticsUserId('u1')).toBe('tenant-x:u1')
  })

  it('trackServerEvent sends the explicit user id in the amplitude payload', async () => {
    vi.stubEnv('E2E_MOCK', '')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    getSettingsMock.mockReturnValue({ shareAnalytics: true, analyticsTargets: [] } as never)
    trackServerEvent('tagged_in_session', { agentSlug: 'billing' }, 'plat-2')
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
    expect(body.events[0].user_id).toBe('plat-2')
  })

  it('trackServerEvent $sets user properties on the amplitude payload', async () => {
    vi.stubEnv('E2E_MOCK', '')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    getSettingsMock.mockReturnValue({ shareAnalytics: true, analyticsTargets: [] } as never)
    trackServerEvent('tagged_in_session', { agentSlug: 'billing' }, 'plat-2', { email: 'i@x' })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
    expect(body.events[0].user_properties).toEqual({ $set: { email: 'i@x' } })
  })
})
