import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockGetSession = vi.fn()
const mockSignInWithOAuth2 = vi.fn()
const mockGetGenericOAuthProviderConfigs = vi.fn()
const mockCaptureException = vi.fn()

vi.mock('@shared/lib/auth/index', () => ({
  getAuth: () => ({
    api: {
      getSession: mockGetSession,
      signInWithOAuth2: mockSignInWithOAuth2,
    },
  }),
}))

vi.mock('@shared/lib/auth/provider-config', () => ({
  getGenericOAuthProviderConfigs: () => mockGetGenericOAuthProviderConfigs(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import platformSsoStart from './platform-sso-start'

function createApp() {
  const app = new Hono()
  app.route('/auth', platformSsoStart)
  return app
}

describe('GET /auth/platform/start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGenericOAuthProviderConfigs.mockReturnValue([
      { providerId: 'platform', clientId: 'superagent-org-org_x', pkce: true },
    ])
  })

  it('redirects to return_to when a deployment session already exists', async () => {
    mockGetSession.mockResolvedValue({ session: { id: 's1' }, user: { id: 'u1' } })
    const res = await createApp().request('/auth/platform/start?return_to=%2Fagents')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/agents')
    expect(mockSignInWithOAuth2).not.toHaveBeenCalled()
  })

  it('starts Platform OIDC with PKCE cookies and sanitized return_to', async () => {
    mockGetSession.mockResolvedValue(null)
    const headers = new Headers()
    headers.append('set-cookie', 'better-auth.state=abc; Path=/; HttpOnly')
    mockSignInWithOAuth2.mockResolvedValue({
      headers,
      response: { url: 'https://auth.example.com/authorize?state=1', redirect: true },
    })

    const res = await createApp().request('/auth/platform/start?return_to=https://evil.example')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://auth.example.com/authorize?state=1')
    expect(res.headers.get('set-cookie')).toContain('better-auth.state=abc')
    expect(mockSignInWithOAuth2).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          providerId: 'platform',
          callbackURL: '/',
          errorCallbackURL: '/',
        }),
        returnHeaders: true,
      }),
    )
  })

  it('falls back to / when no OIDC provider is configured', async () => {
    mockGetGenericOAuthProviderConfigs.mockReturnValue([])
    const res = await createApp().request('/auth/platform/start')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(mockSignInWithOAuth2).not.toHaveBeenCalled()
  })

  it('fails closed when platform is absent even if another OIDC provider exists', async () => {
    mockGetGenericOAuthProviderConfigs.mockReturnValue([
      { providerId: 'company-sso', clientId: 'company', pkce: true },
    ])
    const res = await createApp().request('/auth/platform/start')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(mockSignInWithOAuth2).not.toHaveBeenCalled()
  })

  it('falls back to / and reports when OIDC start throws', async () => {
    mockGetSession.mockResolvedValue(null)
    mockSignInWithOAuth2.mockRejectedValue(new Error('provider down'))
    const res = await createApp().request('/auth/platform/start')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(mockCaptureException).toHaveBeenCalled()
  })
})
