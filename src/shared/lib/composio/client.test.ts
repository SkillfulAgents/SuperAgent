import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock settings before importing client
const mockGetEffectiveComposioApiKey = vi.fn()
const mockGetComposioUserId = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveComposioApiKey: () => mockGetEffectiveComposioApiKey(),
  getComposioUserId: () => mockGetComposioUserId(),
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => null,
}))

const mockAddErrorBreadcrumb = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  addErrorBreadcrumb: (...args: unknown[]) => mockAddErrorBreadcrumb(...args),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import {
  getConnectionToken,
  proxyExecute,
  getAccountDisplayName,
  initiateConnection,
  ComposioApiError,
  ComposioRedactedTokenError,
} from './client'

function makeComposioResponse(
  state: { authScheme: string; val: Record<string, unknown> },
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 'conn-1',
    status: 'ACTIVE',
    toolkit: { slug: 'gmail' },
    auth_config: { id: 'ac-1', auth_scheme: 'OAUTH2', is_composio_managed: true },
    state,
    ...overrides,
  }
}

describe('getConnectionToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEffectiveComposioApiKey.mockReturnValue('test-api-key')
    mockGetComposioUserId.mockReturnValue('test-user')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetchOk(body: unknown) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => body,
    })
  }

  function mockFetchError(status: number, body: unknown) {
    mockFetch.mockResolvedValue({
      ok: false,
      status,
      json: async () => body,
    })
  }

  it('extracts access_token for OAUTH2 scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'ya29.oauth2-token' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('ya29.oauth2-token')
  })

  it('extracts oauth_token for OAUTH1 scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH1',
      val: { status: 'ACTIVE', oauth_token: 'oauth1-token-value' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('oauth1-token-value')
  })

  it('extracts api_key for API_KEY scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'API_KEY',
      val: { status: 'ACTIVE', api_key: 'my-api-key-123' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('my-api-key-123')
  })

  it('falls back to generic_api_key for API_KEY scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'API_KEY',
      val: { status: 'ACTIVE', generic_api_key: 'generic-key-456' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('generic-key-456')
  })

  it('extracts token for BEARER_TOKEN scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'BEARER_TOKEN',
      val: { status: 'ACTIVE', token: 'bearer-tok-789' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('bearer-tok-789')
  })

  it('falls back to access_token for unknown scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'CUSTOM_SCHEME',
      val: { status: 'ACTIVE', access_token: 'fallback-token' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('fallback-token')
  })

  it('throws when state.val is missing', async () => {
    mockFetchOk({
      id: 'conn-1',
      status: 'ACTIVE',
      toolkit: { slug: 'gmail' },
      auth_config: { id: 'ac-1', auth_scheme: 'OAUTH2', is_composio_managed: true },
      state: { authScheme: 'OAUTH2' },
      // no val
    })

    await expect(getConnectionToken('conn-1')).rejects.toThrow('No state data found')
  })

  it('throws when no token found for scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE' }, // no access_token
    }))

    await expect(getConnectionToken('conn-1')).rejects.toThrow('No access token found')
  })

  it('detects redacted tokens (short + ends with ...)', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'ya29.abc...' },
    }))

    await expect(getConnectionToken('conn-1')).rejects.toThrow('redacted')
    try {
      await getConnectionToken('conn-1')
    } catch (e) {
      expect((e as ComposioApiError).statusCode).toBe(403)
    }
  })

  it('accepts long tokens that happen to end with ...', async () => {
    const longToken = 'a'.repeat(25) + '...'
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: longToken },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe(longToken)
  })

  it('detects literal "REDACTED" tokens (composio-managed auth configs, 2026-04-22 change)', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'REDACTED' },
    }))

    await expect(getConnectionToken('conn-1')).rejects.toThrow('redacted')
    try {
      await getConnectionToken('conn-1')
    } catch (e) {
      expect((e as ComposioApiError).statusCode).toBe(403)
    }
  })

  it('emits a breadcrumb with toolkit and pattern when a redacted token is detected', async () => {
    mockFetchOk(makeComposioResponse(
      { authScheme: 'OAUTH2', val: { status: 'ACTIVE', access_token: 'REDACTED' } },
      { toolkit: { slug: 'slack' }, auth_config: { id: 'ac_rNLPL7-eRjv2', auth_scheme: 'OAUTH2', is_composio_managed: true } },
    ))

    await expect(getConnectionToken('ca_enPiGqqyyQJl')).rejects.toThrow('redacted')

    expect(mockAddErrorBreadcrumb).toHaveBeenCalledTimes(1)
    const breadcrumb = mockAddErrorBreadcrumb.mock.calls[0][0]
    expect(breadcrumb.category).toBe('composio')
    expect(breadcrumb.message).toMatch(/redacted/i)
    expect(breadcrumb.level).toBe('warning')
    expect(breadcrumb.data).toMatchObject({
      toolkit: 'slack',
      auth_scheme: 'OAUTH2',
      is_composio_managed: 'true',
      redaction_pattern: 'literal-redacted',
      connectionId: 'ca_enPiGqqyyQJl',
    })
  })

  it('does not emit a breadcrumb for valid tokens', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'fake-valid-token-1234567890abcdef' },
    }))
    await getConnectionToken('conn-1')
    expect(mockAddErrorBreadcrumb).not.toHaveBeenCalled()
  })

  it.each([
    ['REDACTED', 'exact literal'],
    [' REDACTED ', 'literal with whitespace'],
    ['********', 'asterisks'],
    ['<redacted>', 'angle-bracket placeholder'],
    ['<REDACTED>', 'angle-bracket placeholder uppercase'],
  ])('rejects placeholder token %j (%s)', async (token) => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: token },
    }))
    await expect(getConnectionToken('conn-1')).rejects.toThrow('redacted')
  })

  it.each([
    ['fake-slack-style-token-0000000000000000000000', 'slack-length token'],
    ['fake-github-style-token-0000000000000000', 'github-length token'],
    ['fake-notion-style-token-0000000000000000000000', 'notion-length token'],
    ['redacted_something_longer_123456', 'token containing the word redacted but not a placeholder'],
  ])('accepts real token %j (%s)', async (token) => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: token },
    }))
    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe(token)
  })

  it('calculates expiresAt from expires_in', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'token-123', expires_in: 3600 },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.expiresAt).toBeDefined()
    const expectedExpiry = new Date(now + 3600 * 1000).toISOString()
    expect(result.expiresAt).toBe(expectedExpiry)
  })

  it('omits expiresAt when expires_in is absent', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'token-no-expiry' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.expiresAt).toBeUndefined()
  })

  it('throws ComposioApiError on non-ok API response', async () => {
    mockFetchError(500, { error: 'Internal server error', message: 'Something broke' })

    await expect(getConnectionToken('conn-1')).rejects.toThrow(ComposioApiError)
    try {
      await getConnectionToken('conn-1')
    } catch (e) {
      expect(e).toBeInstanceOf(ComposioApiError)
      expect((e as ComposioApiError).statusCode).toBe(500)
    }
  })

  it('throws 401 when API key is not configured', async () => {
    mockGetEffectiveComposioApiKey.mockReturnValue(null)

    await expect(getConnectionToken('conn-1')).rejects.toThrow('not configured')
    try {
      await getConnectionToken('conn-1')
    } catch (e) {
      expect((e as ComposioApiError).statusCode).toBe(401)
    }
  })

  it('redaction throws ComposioRedactedTokenError (typed sentinel for proxy fallback)', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'REDACTED' },
    }))

    try {
      await getConnectionToken('conn-1')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ComposioRedactedTokenError)
      expect(e).toBeInstanceOf(ComposioApiError) // inheritance preserved
      expect((e as ComposioApiError).statusCode).toBe(403)
    }
  })
})

describe('proxyExecute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEffectiveComposioApiKey.mockReturnValue('test-api-key')
    mockGetComposioUserId.mockReturnValue('test-user')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs to /api/v3.1/tools/execute/proxy with the expected body shape', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        data: { login: 'octocat' },
        headers: { 'x-ratelimit-remaining': '4999' },
      }),
    })

    const result = await proxyExecute({
      endpoint: 'https://api.github.com/user',
      method: 'GET',
      connectedAccountId: 'ca_abc',
      parameters: [{ name: 'Accept', value: 'application/vnd.github+json', type: 'header' }],
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://backend.composio.dev/api/v3.1/tools/execute/proxy')
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({
      endpoint: 'https://api.github.com/user',
      method: 'GET',
      connected_account_id: 'ca_abc',
      parameters: [{ name: 'Accept', value: 'application/vnd.github+json', type: 'header' }],
    })

    expect(result.status).toBe(200)
    expect(result.data).toEqual({ login: 'octocat' })
    expect(result.headers).toEqual({ 'x-ratelimit-remaining': '4999' })
  })

  it('forwards body and binary_body when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 201, data: { id: 1 }, headers: {} }),
    })

    await proxyExecute({
      endpoint: '/repos/x/y/issues',
      method: 'POST',
      connectedAccountId: 'ca_abc',
      body: { title: 'test' },
    })

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(sent.body).toEqual({ title: 'test' })
    expect(sent.binary_body).toBeUndefined()

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 200, data: {}, headers: {} }),
    })
    await proxyExecute({
      endpoint: '/upload',
      method: 'PUT',
      connectedAccountId: 'ca_abc',
      binaryBody: { base64: 'AAA=', content_type: 'image/png' },
    })
    const sent2 = JSON.parse(mockFetch.mock.calls[1][1].body as string)
    expect(sent2.binary_body).toEqual({ base64: 'AAA=', content_type: 'image/png' })
    expect(sent2.body).toBeUndefined()
  })

  it('returns parsed binaryData when envelope includes binary_data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        data: null,
        headers: {},
        binary_data: {
          url: 'https://cdn.example/x',
          content_type: 'application/pdf',
          size: 100,
          expires_at: '2099-01-01T00:00:00Z',
        },
      }),
    })

    const result = await proxyExecute({
      endpoint: '/file.pdf',
      method: 'GET',
      connectedAccountId: 'ca_abc',
    })

    expect(result.binaryData).toEqual({
      url: 'https://cdn.example/x',
      content_type: 'application/pdf',
      size: 100,
      expires_at: '2099-01-01T00:00:00Z',
    })
  })

  it('throws ComposioApiError on non-ok response from Composio', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Bad endpoint', slug: 'ExternalProxy_OriginMismatch' } }),
    })

    await expect(
      proxyExecute({
        endpoint: 'https://www.google.com',
        method: 'GET',
        connectedAccountId: 'ca_abc',
      })
    ).rejects.toBeInstanceOf(ComposioApiError)
  })
})

describe('getAccountDisplayName proxy fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEffectiveComposioApiKey.mockReturnValue('test-api-key')
    mockGetComposioUserId.mockReturnValue('test-user')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Dispatch fetch by URL so we can stub each Composio endpoint independently
  function dispatchFetch(handlers: {
    connectedAccount?: () => unknown
    proxyExecute?: () => unknown
  }) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connected_accounts/') && handlers.connectedAccount) {
        return { ok: true, json: async () => handlers.connectedAccount!() }
      }
      if (url.includes('/tools/execute/proxy') && handlers.proxyExecute) {
        return { ok: true, json: async () => handlers.proxyExecute!() }
      }
      throw new Error('Unexpected fetch URL: ' + url)
    })
  }

  it('Google toolkit: redacted token → falls back to proxyExecute and returns email', async () => {
    dispatchFetch({
      connectedAccount: () => makeComposioResponse({
        authScheme: 'OAUTH2',
        val: { status: 'ACTIVE', access_token: 'REDACTED' },
      }),
      proxyExecute: () => ({
        status: 200,
        data: { email: 'mreid4358@gmail.com', name: 'Mike Reid' },
        headers: {},
      }),
    })

    const display = await getAccountDisplayName('conn-1', 'gmail', 'Gmail')
    expect(display).toBe('mreid4358@gmail.com')

    // Both Composio endpoints were hit
    const urls = mockFetch.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.endsWith('/connected_accounts/conn-1'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/tools/execute/proxy'))).toBe(true)

    // Verify the proxy envelope targeted googleapis userinfo for this connection
    const proxyCall = mockFetch.mock.calls.find((c) =>
      (c[0] as string).endsWith('/tools/execute/proxy')
    )
    const sent = JSON.parse((proxyCall![1] as { body: string }).body)
    expect(sent).toMatchObject({
      endpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
      method: 'GET',
      connected_account_id: 'conn-1',
    })
  })

  it('Google toolkit: returns fallback when proxy fallback also fails', async () => {
    dispatchFetch({
      connectedAccount: () => makeComposioResponse({
        authScheme: 'OAUTH2',
        val: { status: 'ACTIVE', access_token: 'REDACTED' },
      }),
    })
    // Proxy URL hits the throw branch in dispatchFetch; getAccountDisplayName
    // should swallow the error and return the fallback.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connected_accounts/')) {
        return {
          ok: true,
          json: async () => makeComposioResponse({
            authScheme: 'OAUTH2',
            val: { status: 'ACTIVE', access_token: 'REDACTED' },
          }),
        }
      }
      // Composio proxy returned an error envelope
      return {
        ok: false,
        status: 502,
        json: async () => ({ error: 'upstream failed' }),
      }
    })

    const display = await getAccountDisplayName('conn-2', 'gmail', 'Gmail')
    expect(display).toBe('Gmail')
  })

  it('Google toolkit with non-redacted token: uses direct path (no proxy call)', async () => {
    // Dispatch: connected_accounts returns a real token; userinfo via direct googleapis fetch
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connected_accounts/')) {
        return {
          ok: true,
          json: async () => makeComposioResponse({
            authScheme: 'OAUTH2',
            val: { status: 'ACTIVE', access_token: 'real-google-token-1234567890abcdef' },
          }),
        }
      }
      if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
        return { ok: true, json: async () => ({ email: 'user@example.com' }) }
      }
      throw new Error('Unexpected fetch URL: ' + url)
    })

    const display = await getAccountDisplayName('conn-3', 'gmail', 'Gmail')
    expect(display).toBe('user@example.com')

    const urls = mockFetch.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.endsWith('/tools/execute/proxy'))).toBe(false)
  })

  it.each([
    ['googledrive'],
    ['googlesheets'],
    ['googledocs'],
    ['googleslides'],
  ])(
    '%s: redacted token → proxy hits /oauth2/v2/userinfo and returns email',
    async (slug) => {
      dispatchFetch({
        connectedAccount: () =>
          makeComposioResponse(
            {
              authScheme: 'OAUTH2',
              val: { status: 'ACTIVE', access_token: 'REDACTED' },
            },
            { toolkit: { slug } }
          ),
        proxyExecute: () => ({
          status: 200,
          data: { email: 'user@example.com' },
          headers: {},
        }),
      })

      const display = await getAccountDisplayName(`conn-${slug}`, slug, slug)
      expect(display).toBe('user@example.com')

      const proxyCall = mockFetch.mock.calls.find((c) =>
        (c[0] as string).endsWith('/tools/execute/proxy')
      )
      const sent = JSON.parse((proxyCall![1] as { body: string }).body)
      expect(sent.endpoint).toBe(
        'https://www.googleapis.com/oauth2/v2/userinfo'
      )
    }
  )

  it('googlecalendar: redacted token → proxy hits calendarList/primary and returns email from `id`', async () => {
    dispatchFetch({
      connectedAccount: () =>
        makeComposioResponse(
          {
            authScheme: 'OAUTH2',
            val: { status: 'ACTIVE', access_token: 'REDACTED' },
          },
          { toolkit: { slug: 'googlecalendar' } }
        ),
      proxyExecute: () => ({
        status: 200,
        data: {
          id: 'cal-user@gmail.com',
          summary: 'cal-user@gmail.com',
          primary: true,
        },
        headers: {},
      }),
    })

    const display = await getAccountDisplayName(
      'conn-cal',
      'googlecalendar',
      'Google Calendar'
    )
    expect(display).toBe('cal-user@gmail.com')

    const proxyCall = mockFetch.mock.calls.find((c) =>
      (c[0] as string).endsWith('/tools/execute/proxy')
    )
    const sent = JSON.parse((proxyCall![1] as { body: string }).body)
    expect(sent.endpoint).toBe(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary'
    )
  })

  it('googlecalendar with non-redacted token: direct fetch hits calendarList/primary', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connected_accounts/')) {
        return {
          ok: true,
          json: async () =>
            makeComposioResponse(
              {
                authScheme: 'OAUTH2',
                val: {
                  status: 'ACTIVE',
                  access_token: 'real-google-token-1234567890abcdef',
                },
              },
              { toolkit: { slug: 'googlecalendar' } }
            ),
        }
      }
      if (url.includes('calendar/v3/users/me/calendarList/primary')) {
        return {
          ok: true,
          json: async () => ({ id: 'cal@example.com', primary: true }),
        }
      }
      throw new Error('Unexpected fetch URL: ' + url)
    })

    const display = await getAccountDisplayName(
      'conn-cal-direct',
      'googlecalendar',
      'Google Calendar'
    )
    expect(display).toBe('cal@example.com')

    const urls = mockFetch.mock.calls.map((c) => c[0] as string)
    // userinfo endpoint must NOT be hit for googlecalendar
    expect(urls.some((u) => u.includes('/oauth2/v2/userinfo'))).toBe(false)
    expect(urls.some((u) => u.endsWith('/tools/execute/proxy'))).toBe(false)
  })

  it('Microsoft toolkit: redacted token → falls back to proxyExecute against graph.microsoft.com', async () => {
    dispatchFetch({
      connectedAccount: () => makeComposioResponse(
        {
          authScheme: 'OAUTH2',
          val: { status: 'ACTIVE', access_token: 'REDACTED' },
        },
        { toolkit: { slug: 'outlook' } }
      ),
      proxyExecute: () => ({
        status: 200,
        data: { mail: 'user@contoso.com', userPrincipalName: 'user@contoso.com' },
        headers: {},
      }),
    })

    const display = await getAccountDisplayName('conn-ms', 'outlook', 'Outlook')
    expect(display).toBe('user@contoso.com')

    const proxyCall = mockFetch.mock.calls.find((c) =>
      (c[0] as string).endsWith('/tools/execute/proxy')
    )
    const sent = JSON.parse((proxyCall![1] as { body: string }).body)
    expect(sent.endpoint).toBe('https://graph.microsoft.com/v1.0/me')
  })

  it('Microsoft toolkit: redacted + only userPrincipalName (no mail) returns UPN', async () => {
    dispatchFetch({
      connectedAccount: () => makeComposioResponse(
        {
          authScheme: 'OAUTH2',
          val: { status: 'ACTIVE', access_token: 'REDACTED' },
        },
        { toolkit: { slug: 'outlook' } }
      ),
      proxyExecute: () => ({
        status: 200,
        data: { userPrincipalName: 'upn@contoso.com' },
        headers: {},
      }),
    })

    const display = await getAccountDisplayName('conn-ms-upn', 'outlook', 'Outlook')
    expect(display).toBe('upn@contoso.com')
  })
})

describe('initiateConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEffectiveComposioApiKey.mockReturnValue('test-api-key')
    mockGetComposioUserId.mockReturnValue('test-user')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockLinkOk(body: unknown) {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }

  it('POSTs to /connected_accounts/link with flat body', async () => {
    mockLinkOk({
      link_token: 'lk_abc',
      redirect_url: 'https://connect.composio.dev/link/lk_abc',
      expires_at: '2026-05-06T21:36:56.811Z',
      connected_account_id: 'ca_new',
    })

    const result = await initiateConnection(
      'ac_xyz',
      'superagent://oauth-callback?toolkit=github',
      'user-42'
    )

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe(
      'https://backend.composio.dev/api/v3/connected_accounts/link'
    )
    expect((init as RequestInit).method).toBe('POST')
    const sent = JSON.parse((init as { body: string }).body)
    expect(sent).toEqual({
      auth_config_id: 'ac_xyz',
      user_id: 'user-42',
      callback_url: 'superagent://oauth-callback?toolkit=github',
    })

    expect(result).toEqual({
      connectionId: 'ca_new',
      redirectUrl: 'https://connect.composio.dev/link/lk_abc',
    })
  })

  it('falls back to getComposioUserId() when no override is given', async () => {
    mockGetComposioUserId.mockReturnValue('settings-user')
    mockLinkOk({
      link_token: 'lk_x',
      redirect_url: 'https://connect.composio.dev/link/lk_x',
      expires_at: '2026-05-06T21:36:56.811Z',
      connected_account_id: 'ca_x',
    })

    await initiateConnection('ac_x', 'cb://done')

    const sent = JSON.parse(
      (mockFetch.mock.calls[0][1] as { body: string }).body
    )
    expect(sent.user_id).toBe('settings-user')
  })

  it('throws ComposioApiError(401) when no user id is available', async () => {
    mockGetComposioUserId.mockReturnValue(undefined)

    await expect(
      initiateConnection('ac_x', 'cb://done')
    ).rejects.toBeInstanceOf(ComposioApiError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws via Zod when response is missing connected_account_id', async () => {
    mockLinkOk({
      link_token: 'lk_x',
      redirect_url: 'https://connect.composio.dev/link/lk_x',
      expires_at: '2026-05-06T21:36:56.811Z',
      // connected_account_id missing
    })

    await expect(
      initiateConnection('ac_x', 'cb://done', 'user-1')
    ).rejects.toThrow()
  })

  it('throws via Zod when response is missing redirect_url', async () => {
    mockLinkOk({
      link_token: 'lk_x',
      // redirect_url missing
      expires_at: '2026-05-06T21:36:56.811Z',
      connected_account_id: 'ca_x',
    })

    await expect(
      initiateConnection('ac_x', 'cb://done', 'user-1')
    ).rejects.toThrow()
  })
})
