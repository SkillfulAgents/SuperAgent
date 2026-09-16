// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RemoteMcpRequestItem } from './remote-mcp-request-item'
import { renderWithProviders } from '@renderer/test/test-utils'

const mockApiFetch = vi.fn()
const mockInitiateOAuthMutateAsync = vi.hoisted(() => vi.fn())
const mockUseMcpOAuthListener = vi.hoisted(() => vi.fn())

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@renderer/lib/oauth-popup', () => ({
  prepareOAuthPopup: () => ({
    navigate: vi.fn(),
    close: vi.fn(),
  }),
}))

vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useInitiateMcpOAuth: () => ({
    mutateAsync: mockInitiateOAuthMutateAsync,
    isPending: false,
  }),
  useMcpOAuthRedirectUris: () => ({
    data: {
      candidates: ['https://app.example.com/api/remote-mcps/oauth-callback'],
      preferred: 'https://app.example.com/api/remote-mcps/oauth-callback',
    },
  }),
}))

vi.mock('@renderer/hooks/use-mcp-oauth-listener', () => ({
  useMcpOAuthListener: (...args: unknown[]) => mockUseMcpOAuthListener(...args),
}))

vi.mock('./pending-request-stack', () => ({
  usePagination: () => null,
}))

const defaultProps = {
  toolUseId: 'tu-1',
  url: 'https://mcp.example.com/sse',
  name: 'Example MCP',
  reason: 'Need weather data tools',
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

function mockServerListResponse(servers: Array<Record<string, unknown>> = []) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/api/remote-mcps') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ servers }),
      })
    }
    // Tool policies endpoint used by ToolPolicySummaryPill
    if (path.startsWith('/api/policies/tool/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ policies: [] }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

const defaultServer = {
  id: 'mcp-1',
  name: 'Example MCP',
  url: 'https://mcp.example.com/sse',
  authType: 'none',
  status: 'active',
  tools: [{ name: 'get_weather', description: 'Get weather data' }],
}

describe('RemoteMcpRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseMcpOAuthListener.mockReset()
    mockInitiateOAuthMutateAsync.mockReset()
    mockServerListResponse([defaultServer])
  })

  it('renders pending state with server name and reason', async () => {
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)
    expect(screen.getByText('Need weather data tools')).toBeInTheDocument()
  })

  it('loads and displays matching server card', async () => {
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)
    await waitFor(() => {
      expect(screen.getByText('Example MCP')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText('https://mcp.example.com/sse')).toBeInTheDocument()
    })
  })

  it('grants access to selected server', async () => {
    const user = userEvent.setup()

    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

    // Wait for the server card to load (the McpServerCard renders the server name and URL)
    await waitFor(() => {
      expect(screen.getByText('Example MCP')).toBeInTheDocument()
    })

    // Click Allow Access
    const allowButton = await screen.findByRole('button', { name: /Allow Access/i })
    await user.click(allowButton)

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/my-agent/sessions/s-1/provide-remote-mcp',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('mcp-1'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Access Granted')).toBeInTheDocument()
    })
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('provides a replacement through the agent-scoped endpoint without a session', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} sessionId={undefined}
      replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />)
    await user.click(await screen.findByRole('button', { name: 'Replace connection' }))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/my-agent/reauth-request/reauth-1/replace-mcp',
      expect.objectContaining({ body: JSON.stringify({ toolUseId: 'tu-1', remoteMcpIds: ['mcp-1'] }) }))
    await waitFor(() => expect(defaultProps.onComplete).toHaveBeenCalledOnce())
  })

  it('cancels replacement without declining the pending MCP request', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps}
      replacement={{ requestId: 'reauth-1', onCancel }} />)
    await screen.findByRole('button', { name: 'Replace connection' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    expect(defaultProps.onComplete).not.toHaveBeenCalled()
  })

  it('uses the exact new OAuth connection when replacing with a sibling at the same URL', async () => {
    const user = userEvent.setup()
    mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://oauth.example' })
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} authHint="oauth"
      replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />)
    await screen.findByRole('button', { name: 'Replace connection' })
    await user.click(screen.getByRole('button', { name: /Connect Another|Add New/i }))
    await waitFor(() => expect(mockUseMcpOAuthListener).toHaveBeenCalledWith(true, expect.any(Function), 'flow-state'))
    mockServerListResponse([defaultServer, { ...defaultServer, id: 'new-mcp', name: 'New connection' }])
    const callback = mockUseMcpOAuthListener.mock.calls.find(([active]) => active)?.[1]
    act(() => callback({ success: true, mcpId: 'new-mcp' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace connection' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Replace connection' }))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/my-agent/reauth-request/reauth-1/replace-mcp',
      expect.objectContaining({ body: JSON.stringify({ toolUseId: 'tu-1', remoteMcpIds: ['new-mcp'] }) }))
  })

  it('connects a custom replacement using an entered URL when safe prefill is unavailable', async () => {
    mockServerListResponse([])
    mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://oauth.example' })
    const user = userEvent.setup()
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} url="" authHint="oauth"
      replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />)
    const input = await screen.findByRole('textbox', { name: 'MCP server URL' })
    const connect = await screen.findByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()
    await user.type(input, 'not-a-url')
    expect(connect).toBeDisabled()
    await user.clear(input)
    await user.type(input, defaultProps.url)
    await user.click(connect)
    expect(mockInitiateOAuthMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ url: defaultProps.url }))
    mockServerListResponse([{ ...defaultServer, id: 'custom-new' }])
    const callback = mockUseMcpOAuthListener.mock.calls.find(([active]) => active)?.[1]
    await act(async () => callback({ success: true, mcpId: 'custom-new' }))
    await user.click(await screen.findByRole('button', { name: 'Replace connection' }))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/my-agent/reauth-request/reauth-1/replace-mcp',
      expect.objectContaining({ body: JSON.stringify({ toolUseId: 'tu-1', remoteMcpIds: ['custom-new'] }) }))
  })

  it.each(['bearer', undefined] as const)('registers an entered replacement URL with %s authentication', async (authHint) => {
    let created = false
    mockApiFetch.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/api/remote-mcps' && options?.method === 'POST') {
        created = true
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ server: defaultServer }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ servers: created ? [defaultServer] : [], policies: [] }) })
    })
    const user = userEvent.setup()
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} url="" authHint={authHint}
      replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />)
    await user.type(await screen.findByRole('textbox', { name: 'MCP server URL' }), defaultProps.url)
    if (authHint) await user.type(screen.getByPlaceholderText('Bearer token'), 'member-token')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/remote-mcps', expect.objectContaining({
      body: JSON.stringify({ name: defaultProps.name, url: defaultProps.url, authType: authHint ?? 'none', ...(authHint ? { accessToken: 'member-token' } : {}) }),
    }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace connection' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Replace connection' }))
    expect(defaultProps.onComplete).toHaveBeenCalledOnce()
    expect(mockInitiateOAuthMutateAsync).not.toHaveBeenCalled()
  })

  it.each([
    'https://mcp.example.com/another-service',
    'https://mcp.example.com:8443/sse',
    'http://mcp.example.com/sse',
    'https://another.example/sse',
  ])('excludes incompatible replacement %s from auto-selection and the picker', async (url) => {
    mockServerListResponse([
      { ...defaultServer, status: 'auth_required', authType: 'oauth' },
      { ...defaultServer, id: 'incompatible', name: 'Wrong endpoint', url },
    ])
    const user = userEvent.setup()
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps}
      replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />)
    expect(await screen.findByRole('button', { name: 'Replace connection' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Select a different one' }))
    expect(screen.queryByText('Wrong endpoint')).not.toBeInTheDocument()
    expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })

  it('shows compatible replacement accounts across query and trailing-slash variants', async () => {
    mockServerListResponse([
      { ...defaultServer, name: 'First account', url: 'https://mcp.facebook.com/ads/?token=first' },
      { ...defaultServer, id: 'second', name: 'Second account', url: 'https://mcp.facebook.com/ads' },
    ])
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} url="https://mcp.facebook.com/ads?token=member"
      replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />)
    expect(await screen.findByText('First account')).toBeInTheDocument()
    expect(screen.getByText('Second account')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace connection' })).toBeEnabled()
  })

  it.each([defaultProps.url, 'https://unrelated.example/mcp'])('ignores another OAuth flow at %s and still accepts its own callback', async (otherUrl) => {
    const actual = await vi.importActual<typeof import('@renderer/hooks/use-mcp-oauth-listener')>('@renderer/hooks/use-mcp-oauth-listener')
    mockUseMcpOAuthListener.mockImplementation(actual.useMcpOAuthListener)
    mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://oauth.example' })
    const user = userEvent.setup()
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} authHint="oauth"
      replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />)
    await screen.findByRole('button', { name: 'Replace connection' })
    await user.click(screen.getByRole('button', { name: /Add New Account/ }))
    await screen.findByText('Waiting for authorization...')
    mockServerListResponse([defaultServer,
      { ...defaultServer, id: 'other-flow-mcp', url: otherUrl },
      { ...defaultServer, id: 'own-flow-mcp' },
    ])
    const callback = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin, data: { type: 'mcp-oauth-callback', ...data },
    }))
    await act(async () => {
      callback({ success: true, state: 'other-flow', mcpId: 'other-flow-mcp' })
      callback({ success: false, state: 'other-flow', error: 'Other flow failed' })
      callback({ success: true, mcpId: 'other-flow-mcp' })
    })
    expect(screen.getByText('Waiting for authorization...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace connection' })).toBeDisabled()
    await act(async () => callback({ success: true, state: 'flow-state', mcpId: 'own-flow-mcp' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace connection' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Replace connection' }))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/my-agent/reauth-request/reauth-1/replace-mcp',
      expect.objectContaining({ body: JSON.stringify({ toolUseId: 'tu-1', remoteMcpIds: ['own-flow-mcp'] }) }))
  })

  it('declines remote MCP request', async () => {
    const user = userEvent.setup()

    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

    // Wait for the server card to load so the Deny button appears
    await waitFor(() => {
      expect(screen.getByText('Example MCP')).toBeInTheDocument()
    })

    // The DeclineButton renders the label "Deny"
    const denyButton = await screen.findByRole('button', { name: /Deny/i })
    await user.click(denyButton)

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('provide-remote-mcp'),
        expect.objectContaining({
          body: expect.stringContaining('"decline":true'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Declined')).toBeInTheDocument()
    })
  })

  it('shows connect card when no matching server exists', async () => {
    mockServerListResponse([])

    renderWithProviders(
      <RemoteMcpRequestItem
        {...defaultProps}
        url="https://new-server.example.com/sse"
      />
    )

    // When no servers match, the component shows an inline Connect button
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Connect/i })).toBeInTheDocument()
    })
  })

  it('uses the shared OAuth callback listener while waiting for web OAuth', async () => {
    const user = userEvent.setup()
    mockServerListResponse([])
    mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://auth.example.com/oauth' })

    renderWithProviders(
      <RemoteMcpRequestItem
        {...defaultProps}
        url="https://new-server.example.com/sse"
        authHint="oauth"
      />
    )

    await user.click(await screen.findByRole('button', { name: /Connect/i }))

    await waitFor(() => {
      expect(mockUseMcpOAuthListener).toHaveBeenCalledWith(true, expect.any(Function), 'flow-state')
    })

    const activeCall = mockUseMcpOAuthListener.mock.calls.find(([active]) => active === true)
    const onOAuthComplete = activeCall?.[1] as ((result: { success: boolean; error?: string }) => void) | undefined
    expect(onOAuthComplete).toBeDefined()

    act(() => {
      onOAuthComplete?.({ success: false, error: 'OAuth failed in popup' })
    })

    await waitFor(() => {
      expect(screen.getByText(/Error:.*OAuth failed in popup/)).toBeInTheDocument()
    })
  })

  it('shows error with prefix when provide fails', async () => {
    const user = userEvent.setup()

    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

    // Wait for the server card to load
    await waitFor(() => {
      expect(screen.getByText('Example MCP')).toBeInTheDocument()
    })

    // Mock the provide endpoint to fail
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/remote-mcps') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ servers: [defaultServer] }),
        })
      }
      if (path.startsWith('/api/policies/tool/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ policies: [] }),
        })
      }
      if (path.includes('provide-remote-mcp')) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: 'Server unavailable' }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    const allowButton = await screen.findByRole('button', { name: /Allow Access/i })
    await user.click(allowButton)

    // RequestError prefixes "Error: " before the message
    await waitFor(() => {
      expect(screen.getByText(/Error:.*Server unavailable/)).toBeInTheDocument()
    })
  })

  it('renders completed state with data-testid after granting access', async () => {
    const user = userEvent.setup()

    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Example MCP')).toBeInTheDocument()
    })

    const allowButton = await screen.findByRole('button', { name: /Allow Access/i })
    await user.click(allowButton)

    await waitFor(() => {
      expect(screen.getByTestId('remote-mcp-request-completed')).toBeInTheDocument()
    })
  })

  it('has remote-mcp-request testid in pending state', async () => {
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByTestId('remote-mcp-request')).toBeInTheDocument()
    })
  })

  describe('stale server needing re-auth', () => {
    const staleServer = {
      ...defaultServer,
      authType: 'oauth',
      status: 'auth_required',
      errorMessage: 'Token refresh failed',
    }

    beforeEach(() => {
      mockServerListResponse([staleServer])
    })

    it('shows re-auth pill and Reconnect instead of allowing access', async () => {
      renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText('Example MCP')).toBeInTheDocument()
      })

      expect(screen.getByText('Re-auth needed')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Reconnect/i })).toBeInTheDocument()
      // Nothing providable is selected, so Allow Access must be disabled
      expect(screen.getByRole('button', { name: /Allow Access/i })).toBeDisabled()
    })

    it('starts re-auth OAuth for the existing server on Reconnect', async () => {
      const user = userEvent.setup()
      mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://auth.example.com/oauth' })

      renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

      await user.click(await screen.findByRole('button', { name: /Reconnect/i }))

      await waitFor(() => {
        expect(mockInitiateOAuthMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ mcpId: 'mcp-1' })
        )
      })
      // Re-auth targets the existing server, never a new registration
      expect(mockInitiateOAuthMutateAsync).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.anything() })
      )

      await waitFor(() => {
        expect(screen.getByText(/Waiting for authorization/i)).toBeInTheDocument()
      })
    })

    it('enables Allow Access after re-auth completes and the server is active', async () => {
      const user = userEvent.setup()
      mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://auth.example.com/oauth' })

      renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

      await user.click(await screen.findByRole('button', { name: /Reconnect/i }))

      await waitFor(() => {
        expect(mockUseMcpOAuthListener).toHaveBeenCalledWith(true, expect.any(Function), 'flow-state')
      })

      // Server comes back active after OAuth
      mockServerListResponse([{ ...defaultServer, authType: 'oauth' }])

      const activeCall = mockUseMcpOAuthListener.mock.calls.find(([active]) => active === true)
      const onOAuthComplete = activeCall?.[1] as ((result: { success: boolean; error?: string }) => void) | undefined
      act(() => {
        onOAuthComplete?.({ success: true })
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Allow Access/i })).toBeEnabled()
      })
      expect(screen.queryByText('Re-auth needed')).not.toBeInTheDocument()
    })

    it('selects the reconnected server, not a sibling sharing the same URL', async () => {
      const user = userEvent.setup()
      const serverA = { ...defaultServer, id: 'mcp-a', name: 'Account A' }
      const serverB = { ...staleServer, id: 'mcp-b', name: 'Account B' }
      mockServerListResponse([serverA, serverB])
      mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://auth.example.com/oauth' })

      renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

      // Only the stale sibling offers Reconnect (exact name: the selectable row
      // is itself role=button and its accessible name contains the button text)
      await user.click(await screen.findByRole('button', { name: /^Reconnect$/ }))
      await waitFor(() => {
        expect(mockInitiateOAuthMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ mcpId: 'mcp-b' })
        )
      })

      // Both servers now active — a URL match alone would pick Account A
      mockServerListResponse([serverA, { ...serverB, status: 'active' }])
      const activeCall = mockUseMcpOAuthListener.mock.calls.find(([active]) => active === true)
      const onOAuthComplete = activeCall?.[1] as ((result: { success: boolean; error?: string }) => void) | undefined
      act(() => {
        onOAuthComplete?.({ success: true })
      })

      // Auto-selected Account A stays; reconnected Account B is added
      const allowButton = await screen.findByRole('button', { name: /Allow Access \(2\)/i })
      await user.click(allowButton)

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith(
          expect.stringContaining('provide-remote-mcp'),
          expect.objectContaining({ body: expect.stringContaining('mcp-b') })
        )
      })
    })

    it('recovers a bearer server via a new token, not OAuth', async () => {
      const user = userEvent.setup()
      mockServerListResponse([{ ...staleServer, authType: 'bearer' }])

      renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

      await user.click(await screen.findByRole('button', { name: /Reconnect/i }))

      // Token input appears instead of an OAuth popup
      const tokenInput = await screen.findByPlaceholderText('New bearer token')
      expect(mockInitiateOAuthMutateAsync).not.toHaveBeenCalled()

      // Server becomes active once the new token is saved and rediscovery runs
      mockServerListResponse([{ ...defaultServer, authType: 'bearer' }])
      await user.type(tokenInput, 'fresh-token')
      await user.click(screen.getByRole('button', { name: /Save Token/i }))

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/api/remote-mcps/mcp-1',
          expect.objectContaining({
            method: 'PATCH',
            body: expect.stringContaining('fresh-token'),
          })
        )
      })
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/remote-mcps/mcp-1/discover-tools',
        expect.objectContaining({ method: 'POST' })
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Allow Access/i })).toBeEnabled()
      })
    })

    it('recovers an unauthenticated server by re-probing, not OAuth', async () => {
      const user = userEvent.setup()
      mockServerListResponse([{ ...staleServer, authType: 'none', status: 'error', errorMessage: 'Connection failed' }])

      renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

      // Server is reachable again once re-probed
      const reconnectButton = await screen.findByRole('button', { name: /Reconnect/i })
      mockServerListResponse([defaultServer])
      await user.click(reconnectButton)

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/api/remote-mcps/mcp-1/discover-tools',
          expect.objectContaining({ method: 'POST' })
        )
      })
      expect(mockInitiateOAuthMutateAsync).not.toHaveBeenCalled()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Allow Access/i })).toBeEnabled()
      })
    })
  })

  describe('provider setup and advanced client options', () => {
    // The official Meta Ads row is the catalog entry that carries a setup guide.
    const META_URL = 'https://mcp.facebook.com/ads'

    it('shows the provider setup steps for a server that needs its own OAuth app', async () => {
      mockServerListResponse([])
      await act(async () => {
        renderWithProviders(
          <RemoteMcpRequestItem {...defaultProps} url={META_URL} name="Meta Ads (Official)" authHint="oauth" />
        )
      })

      await waitFor(() => expect(screen.getByTestId('mcp-setup-guide')).toBeTruthy())
      // The callback comes from the API, so it is the one the flow will send.
      expect(screen.getByTestId('mcp-setup-guide-redirect').textContent).toBe(
        'https://app.example.com/api/remote-mcps/oauth-callback'
      )
    })

    it('opens Advanced by default when the server cannot self-register a client', async () => {
      mockServerListResponse([])
      await act(async () => {
        renderWithProviders(
          <RemoteMcpRequestItem {...defaultProps} url={META_URL} name="Meta Ads (Official)" authHint="oauth" />
        )
      })

      await waitFor(() => expect(screen.getByTestId('mcp-request-advanced')).toBeTruthy())
      expect(screen.getByTestId('mcp-request-advanced').hasAttribute('open')).toBe(true)
    })

    it('prefills the client ID the agent supplied and sends it on connect', async () => {
      mockServerListResponse([])
      mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://auth.example.com/authorize' })
      await act(async () => {
        renderWithProviders(
          <RemoteMcpRequestItem
            {...defaultProps}
            url={META_URL}
            name="Meta Ads (Official)"
            authHint="oauth"
            clientId="2476112079565355"
          />
        )
      })

      const field = (await screen.findByTestId('mcp-request-client-id')) as HTMLInputElement
      expect(field.value).toBe('2476112079565355')

      await act(async () => {
        await userEvent.click(screen.getByRole('button', { name: /connect/i }))
      })

      expect(mockInitiateOAuthMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: '2476112079565355' })
      )
    })

    it('leaves the user free to correct what the agent supplied', async () => {
      mockServerListResponse([])
      mockInitiateOAuthMutateAsync.mockResolvedValue({ state: 'flow-state', redirectUrl: 'https://auth.example.com/authorize' })
      await act(async () => {
        renderWithProviders(
          <RemoteMcpRequestItem
            {...defaultProps}
            url={META_URL}
            name="Meta Ads (Official)"
            authHint="oauth"
            clientId="wrong-id"
          />
        )
      })

      const field = (await screen.findByTestId('mcp-request-client-id')) as HTMLInputElement
      await act(async () => {
        await userEvent.clear(field)
        await userEvent.type(field, 'corrected-id')
      })
      await act(async () => {
        await userEvent.click(screen.getByRole('button', { name: /connect/i }))
      })

      expect(mockInitiateOAuthMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'corrected-id' })
      )
    })

    it('shows no setup guide for a server that self-registers', async () => {
      mockServerListResponse([])
      await act(async () => {
        renderWithProviders(<RemoteMcpRequestItem {...defaultProps} authHint="oauth" />)
      })

      await waitFor(() => expect(screen.getByTestId('remote-mcp-request')).toBeTruthy())
      expect(screen.queryByTestId('mcp-setup-guide')).toBeNull()
      expect(screen.getByTestId('mcp-request-advanced').hasAttribute('open')).toBe(false)
    })
  })
})
