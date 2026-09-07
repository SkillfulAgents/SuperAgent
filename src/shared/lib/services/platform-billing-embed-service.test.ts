import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  isPlatformControlledAuth: vi.fn(),
  getPlatformBaseUrl: vi.fn(),
  getPlatformAuthStatus: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('@shared/lib/auth', () => ({
  getAuth: () => ({ api: { getAccessToken: mocks.getAccessToken } }),
}))
vi.mock('@shared/lib/auth/auth-settings', () => ({
  isPlatformControlledAuth: () => mocks.isPlatformControlledAuth(),
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformBaseUrl: () => mocks.getPlatformBaseUrl(),
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  PLATFORM_AUTH_PROVIDER_ID: 'platform',
  getPlatformAuthStatus: () => mocks.getPlatformAuthStatus(),
}))
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mocks.captureException(...args),
}))

import { BillingEmbedError, createBillingEmbedSession } from './platform-billing-embed-service'

const PLATFORM = 'https://platform.example.com'
const PARENT = 'https://acme.ongamut.so'
const EMBED_URL = `${PLATFORM}/embed/session?token_hash=abc&org_id=org_1&parent=${encodeURIComponent(PARENT)}`

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function expectError(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(BillingEmbedError)
  expect((error as BillingEmbedError).code).toBe(code)
  expect((error as BillingEmbedError).status).toBe(status)
}

describe('createBillingEmbedSession', () => {
  const fetchMock = vi.fn()
  const headers = new Headers({ cookie: 'better-auth.session=abc' })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    mocks.isPlatformControlledAuth.mockReturnValue(true)
    mocks.getPlatformBaseUrl.mockReturnValue(PLATFORM)
    mocks.getPlatformAuthStatus.mockReturnValue({ connected: true, orgId: 'org_1' })
    mocks.getAccessToken.mockResolvedValue({ accessToken: 'oidc-token' })
    fetchMock.mockResolvedValue(jsonResponse({ embed_url: EMBED_URL }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exchanges the user OIDC token for an embed URL on the platform origin', async () => {
    const session = await createBillingEmbedSession({ headers, parentOrigin: PARENT, intent: 'topup', view: 'topup' })
    expect(session).toEqual({ embedUrl: EMBED_URL, platformOrigin: PLATFORM })

    expect(mocks.getAccessToken).toHaveBeenCalledWith({ body: { providerId: 'platform' }, headers })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${PLATFORM}/api/embed/session`)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer oidc-token')
    expect(JSON.parse(init.body)).toEqual({ org_id: 'org_1', parent_origin: PARENT, intent: 'topup', view: 'topup' })
  })

  it('is unavailable outside platform-controlled (cloud) auth', async () => {
    mocks.isPlatformControlledAuth.mockReturnValue(false)
    await expectError(createBillingEmbedSession({ headers, parentOrigin: PARENT }), 'not_available', 400)
    expect(mocks.getAccessToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is unavailable when no org is connected', async () => {
    mocks.getPlatformAuthStatus.mockReturnValue({ connected: false, orgId: null })
    await expectError(createBillingEmbedSession({ headers, parentOrigin: PARENT }), 'not_available', 400)
  })

  it('asks the user to sign in again when no access token can be produced', async () => {
    mocks.getAccessToken.mockRejectedValue(new Error('ACCOUNT_NOT_FOUND'))
    await expectError(createBillingEmbedSession({ headers, parentOrigin: PARENT }), 'reconnect', 401)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.captureException).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'reconnect', 401],
    [403, 'forbidden', 403],
    [500, 'platform_error', 502],
  ])('maps platform HTTP %s to %s', async (upstream, code, status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'x' }, upstream))
    await expectError(createBillingEmbedSession({ headers, parentOrigin: PARENT }), code, status)
  })

  it('rejects an embed URL that is not on the platform origin', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ embed_url: 'https://evil.example/embed/session' }))
    await expectError(createBillingEmbedSession({ headers, parentOrigin: PARENT }), 'platform_error', 502)
  })

  it('rejects a malformed platform response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nope: true }))
    await expectError(createBillingEmbedSession({ headers, parentOrigin: PARENT }), 'platform_error', 502)
  })

  it('maps a network failure to platform_error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expectError(createBillingEmbedSession({ headers, parentOrigin: PARENT }), 'platform_error', 502)
  })
})
