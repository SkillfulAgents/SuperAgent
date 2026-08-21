import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mocks = vi.hoisted(() => ({
  getEnrichedPlatformAuthStatus: vi.fn(),
  getPlatformAuthStatus: vi.fn(),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => 'ba-user',
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => true,
}))

vi.mock('@shared/lib/auth/auth-settings', () => ({
  isPlatformControlledAuth: () => true,
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  buildPlatformLoginUrl: () => 'https://platform.example/login',
  getPlatformBaseUrl: () => 'https://platform.example',
}))

vi.mock('@shared/lib/services/platform-device-service', () => ({
  getOrCreatePlatformClientInstanceId: () => 'client-instance',
  getPlatformDeviceName: () => 'Test Device',
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getEnrichedPlatformAuthStatus: (...args: unknown[]) =>
    mocks.getEnrichedPlatformAuthStatus(...args),
  getPlatformAuthStatus: (...args: unknown[]) => mocks.getPlatformAuthStatus(...args),
  savePlatformAuth: vi.fn(),
  revokePlatformToken: vi.fn(),
}))

vi.mock('@shared/lib/services/download-nonce-service', () => ({
  dismissDownloadNonceOffer: vi.fn(),
  getDownloadNonceOffer: vi.fn(),
  redeemDownloadNonce: vi.fn(),
  DownloadNonceUnavailableError: class DownloadNonceUnavailableError extends Error {},
}))

vi.mock('@shared/lib/services/platform-service', () => ({
  platformService: {
    refreshBilling: vi.fn(),
    getCachedBilling: vi.fn(),
    getLastRefreshedAt: vi.fn(),
  },
}))

vi.mock('@shared/lib/services/cloud-workspace-service', () => ({
  getCloudWorkspace: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  setErrorReportingUser: vi.fn(),
}))

import platformAuth from './platform-auth'

const CONNECTED_STATUS = {
  connected: true,
  tokenPreview: 'plat_s...cdef',
  email: 'owner@example.com',
  label: 'Managed by organization',
  orgId: 'org_acme',
  orgName: 'Acme Inc',
  role: 'owner',
  userId: 'user_1',
  memberId: 'sub_1',
  createdAt: null,
  updatedAt: null,
  source: 'env',
}

const DISCONNECTED_STATUS = {
  connected: false,
  tokenPreview: null,
  email: null,
  label: null,
  orgId: null,
  orgName: null,
  role: null,
  userId: null,
  memberId: null,
  createdAt: null,
  updatedAt: null,
  source: null,
}

function makeApp() {
  const app = new Hono()
  app.route('/api/platform-auth', platformAuth)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getPlatformAuthStatus.mockReturnValue(CONNECTED_STATUS)
})

describe('GET /api/platform-auth/deployments', () => {
  it('never includes cookie lines or signed session values', async () => {
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    vi.mocked(getCloudWorkspace).mockResolvedValue({
      available: true,
      found: true,
      deploymentUrl: 'https://ws.example.com',
      orgId: 'org_acme',
      hasValidToken: true,
      discoveryFailed: false,
    })

    const response = await makeApp().request('/api/platform-auth/deployments')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).not.toHaveProperty('setCookies')
    expect(JSON.stringify(body)).not.toMatch(/set-cookie/i)
    expect(JSON.stringify(body)).not.toMatch(/session_token/)
  })
})

describe('GET /api/platform-auth workspace icon contract (SUP-625)', () => {
  it('returns the configured Platform workspace icon with existing fields intact', async () => {
    mocks.getEnrichedPlatformAuthStatus.mockResolvedValue({
      ...CONNECTED_STATUS,
      orgIconUrl: 'https://cdn.example.com/workspaces/acme.png',
    })

    const response = await makeApp().request('/api/platform-auth')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...CONNECTED_STATUS,
      orgIconUrl: 'https://cdn.example.com/workspaces/acme.png',
      platformBaseUrl: 'https://platform.example',
      platformControlled: true,
    })
    expect(mocks.getEnrichedPlatformAuthStatus).toHaveBeenCalledWith('ba-user')
  })

  it('returns null when the connected organization has no icon', async () => {
    mocks.getEnrichedPlatformAuthStatus.mockResolvedValue({
      ...CONNECTED_STATUS,
      orgIconUrl: null,
    })

    const response = await makeApp().request('/api/platform-auth')

    expect(await response.json()).toMatchObject({
      connected: true,
      orgName: 'Acme Inc',
      orgIconUrl: null,
    })
  })

  it('does not add the field to the disconnected response', async () => {
    mocks.getEnrichedPlatformAuthStatus.mockResolvedValue(DISCONNECTED_STATUS)

    const response = await makeApp().request('/api/platform-auth')
    const body = await response.json()

    expect(body.connected).toBe(false)
    expect(body).not.toHaveProperty('orgIconUrl')
  })

  it('does not add the field to a settings-backed self-hosted response', async () => {
    mocks.getEnrichedPlatformAuthStatus.mockResolvedValue({
      ...CONNECTED_STATUS,
      source: 'settings',
    })

    const response = await makeApp().request('/api/platform-auth')
    const body = await response.json()

    expect(body).toMatchObject({ connected: true, source: 'settings' })
    expect(body).not.toHaveProperty('orgIconUrl')
  })
})
