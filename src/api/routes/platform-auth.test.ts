import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mocks = vi.hoisted(() => ({
  getEnrichedPlatformAuthStatus: vi.fn(),
  getPlatformAuthStatus: vi.fn(),
  createBillingEmbedSession: vi.fn(),
}))

const { BillingEmbedError } = vi.hoisted(() => ({
  BillingEmbedError: class BillingEmbedError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number,
    ) {
      super(message)
    }
  },
}))
vi.mock('@shared/lib/services/platform-billing-embed-service', () => ({
  BillingEmbedError,
  createBillingEmbedSession: (...args: unknown[]) => mocks.createBillingEmbedSession(...args),
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

describe('POST /api/platform-auth/billing-embed', () => {
  const SESSION = {
    embedUrl: 'https://platform.example/embed/session?token_hash=abc',
    platformOrigin: 'https://platform.example',
  }

  function post(headers: Record<string, string>, body: unknown = { intent: 'topup', view: 'topup' }) {
    return makeApp().request('/api/platform-auth/billing-embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('uses the browser Origin as the parent origin and forwards the request headers', async () => {
    mocks.createBillingEmbedSession.mockResolvedValue(SESSION)

    const response = await post({ origin: 'https://acme.ongamut.so', cookie: 'sid=1' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(SESSION)
    const [input] = mocks.createBillingEmbedSession.mock.calls[0] as [
      { headers: Headers; parentOrigin: string; intent?: string; view?: string },
    ]
    expect(input.parentOrigin).toBe('https://acme.ongamut.so')
    expect(input.intent).toBe('topup')
    expect(input.view).toBe('topup')
    expect(input.headers.get('cookie')).toBe('sid=1')
  })

  it('falls back to the forwarded host and proto when Origin is absent', async () => {
    mocks.createBillingEmbedSession.mockResolvedValue(SESSION)

    await post({ 'x-forwarded-host': 'acme.ongamut.so', 'x-forwarded-proto': 'https' }, {})

    const [input] = mocks.createBillingEmbedSession.mock.calls[0] as [
      { parentOrigin: string; intent?: string; view?: string },
    ]
    expect(input.parentOrigin).toBe('https://acme.ongamut.so')
    expect(input.intent).toBeUndefined()
    expect(input.view).toBeUndefined()
  })

  it('rejects an Origin that is not a bare origin', async () => {
    const response = await post({ origin: 'not a url' })
    expect(response.status).toBe(400)
    expect(mocks.createBillingEmbedSession).not.toHaveBeenCalled()
  })

  it('maps service errors to their status and code', async () => {
    mocks.createBillingEmbedSession.mockRejectedValue(new BillingEmbedError('nope', 'forbidden', 403))

    const response = await post({ origin: 'https://acme.ongamut.so' })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'nope', code: 'forbidden' })
  })
})
