// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RemoteMcpRequestItem } from './remote-mcp-request-item'
import { renderWithProviders } from '@renderer/test/test-utils'

const mockApiFetch = vi.fn()
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
    mutateAsync: vi.fn(),
    isPending: false,
  }),
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
    mockServerListResponse([defaultServer])
  })

  it('renders pending state with server name and reason', async () => {
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)
    expect(screen.getByText('MCP Access Request')).toBeInTheDocument()
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
})
