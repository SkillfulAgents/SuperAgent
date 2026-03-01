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

const defaultProps = {
  toolUseId: 'tu-1',
  url: 'https://mcp.example.com/sse',
  name: 'Example MCP',
  reason: 'Need weather data tools',
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

describe('RemoteMcpRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock the initial server list fetch
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/remote-mcps') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              servers: [
                {
                  id: 'mcp-1',
                  name: 'Example MCP',
                  url: 'https://mcp.example.com/sse',
                  authType: 'none',
                  status: 'active',
                  tools: [{ name: 'get_weather', description: 'Get weather data' }],
                },
              ],
            }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
  })

  it('renders pending state with server name and URL', async () => {
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)
    expect(screen.getByText(/Example MCP/)).toBeInTheDocument()
    expect(screen.getByText('https://mcp.example.com/sse')).toBeInTheDocument()
    expect(screen.getByText('Need weather data tools')).toBeInTheDocument()
  })

  it('loads and displays matching server', async () => {
    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)
    await waitFor(() => {
      expect(screen.getByText('1 tools')).toBeInTheDocument()
    })
  })

  it('grants access to selected server', async () => {
    const user = userEvent.setup()

    renderWithProviders(<RemoteMcpRequestItem {...defaultProps} />)

    // Wait for server to load and be auto-selected
    await waitFor(() => {
      expect(screen.getByText('1 tools')).toBeInTheDocument()
    })

    // Click Grant Access
    await user.click(screen.getByText('Grant Access'))

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

    await user.click(screen.getByText('Decline'))

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

  it('shows register section when no matching server exists', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/remote-mcps') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ servers: [] }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    renderWithProviders(
      <RemoteMcpRequestItem
        {...defaultProps}
        url="https://new-server.example.com/sse"
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Register this MCP server:')).toBeInTheDocument()
    })
    expect(screen.getByText('Register')).toBeInTheDocument()
  })
})
