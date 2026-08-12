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
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: expect.objectContaining({
        area: 'auth',
        op: 'platform-sso-start',
        phase: 'oauth-start',
        sessionCookiePresent: 'false',
      }),
      fingerprint: ['platform-sso-start', 'oauth-start'],
    })
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain('provider down')
  })

  it('warm session redirect carries validated prompt and model', async () => {
    mockGetSession.mockResolvedValue({ session: { id: 's1' }, user: { id: 'u1' } })
    const prompt = encodeURIComponent('build & ship https://x.com')
    const res = await createApp().request(
      `/auth/platform/start?return_to=%2F&prompt=${prompt}&model=claude-opus-5&template_slug=my-template`,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!, 'http://internal')
    expect(location.pathname).toBe('/')
    expect(location.searchParams.get('prompt')).toBe('build & ship https://x.com')
    expect(location.searchParams.get('model')).toBe('claude-opus-5')
    expect(location.searchParams.get('template_slug')).toBe('my-template')
  })

  it('cold path passes decorated return_to as callbackURL', async () => {
    mockGetSession.mockResolvedValue(null)
    mockSignInWithOAuth2.mockResolvedValue({
      headers: new Headers(),
      response: { url: 'https://auth.example.com/authorize?state=1', redirect: true },
    })
    await createApp().request(
      '/auth/platform/start?return_to=%2F&prompt=hello&model=gpt-5.6-luna&template_slug=research-bot',
    )
    expect(mockSignInWithOAuth2).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          callbackURL: '/?prompt=hello&model=gpt-5.6-luna&template_slug=research-bot',
          errorCallbackURL: '/',
        }),
      }),
    )
  })

  it('drops a junk model and truncates an overlong prompt', async () => {
    mockGetSession.mockResolvedValue({ session: { id: 's1' }, user: { id: 'u1' } })
    const longPrompt = 'x'.repeat(500)
    const res = await createApp().request(
      `/auth/platform/start?return_to=%2F&prompt=${encodeURIComponent(longPrompt)}&model=not%20valid&template_slug=${encodeURIComponent('bad slug')}`,
    )
    const location = new URL(res.headers.get('location')!, 'http://internal')
    expect(location.searchParams.get('prompt')).toHaveLength(400)
    expect(location.searchParams.get('model')).toBeNull()
    expect(location.searchParams.get('template_slug')).toBeNull()
  })

  it('drops a junk template_slug while a valid prompt survives', async () => {
    mockGetSession.mockResolvedValue({ session: { id: 's1' }, user: { id: 'u1' } })
    const res = await createApp().request(
      `/auth/platform/start?return_to=%2F&prompt=hello&model=opus&template_slug=${encodeURIComponent('bad slug')}`,
    )
    const location = new URL(res.headers.get('location')!, 'http://internal')
    expect(location.searchParams.get('prompt')).toBe('hello')
    expect(location.searchParams.get('model')).toBe('opus')
    expect(location.searchParams.get('template_slug')).toBeNull()
  })

  it('preserves existing return_to query and fragment when appending handoff', async () => {
    mockGetSession.mockResolvedValue({ session: { id: 's1' }, user: { id: 'u1' } })
    const res = await createApp().request(
      `/auth/platform/start?return_to=${encodeURIComponent('/agents?tab=1#panel')}&prompt=hi&model=opus&template_slug=foo.bar`,
    )
    const location = res.headers.get('location')!
    expect(location.startsWith('/agents?')).toBe(true)
    const url = new URL(location, 'http://internal')
    expect(url.searchParams.get('tab')).toBe('1')
    expect(url.searchParams.get('prompt')).toBe('hi')
    expect(url.searchParams.get('model')).toBe('opus')
    expect(url.searchParams.get('template_slug')).toBe('foo.bar')
    expect(url.hash).toBe('#panel')
  })

  it('keeps return_to sanitizing behavior unchanged for open redirects', async () => {
    mockGetSession.mockResolvedValue({ session: { id: 's1' }, user: { id: 'u1' } })
    const res = await createApp().request(
      '/auth/platform/start?return_to=https://evil.example&prompt=hello&model=opus&template_slug=valid-slug',
    )
    const location = new URL(res.headers.get('location')!, 'http://internal')
    expect(location.pathname).toBe('/')
    expect(location.searchParams.get('prompt')).toBe('hello')
    expect(location.searchParams.get('model')).toBe('opus')
    expect(location.searchParams.get('template_slug')).toBe('valid-slug')
  })
})
