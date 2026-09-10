// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpReauthRequestItem } from './mcp-reauth-request-item'

vi.mock('./remote-mcp-request-item', () => ({
  RemoteMcpRequestItem: ({ url, replacement }: { url: string; replacement: { requestId: string; onCancel: () => void } }) => (
    <div data-testid="mcp-replacement-picker" data-url={url} data-request-id={replacement.requestId}>
      <button onClick={replacement.onCancel}>Cancel replacement</button>
    </div>
  ),
}))

const mockInitiateOAuth = vi.fn()
const mockApiFetch = vi.fn()
const mockNavigate = vi.fn()
const mockClose = vi.fn()
const mockDismiss = vi.fn()
let oauthComplete: ((result: { success: boolean; error?: string }) => void) | null = null
let mockCanManage = true

vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useInitiateMcpOAuth: () => ({ mutateAsync: (...args: unknown[]) => mockInitiateOAuth(...args) }),
  useCanManageRemoteMcp: () => ({ data: mockCanManage }),
}))

vi.mock('@renderer/hooks/use-mcp-oauth-listener', () => ({
  useMcpOAuthListener: (active: boolean, callback: typeof oauthComplete) => {
    oauthComplete = active ? callback : null
  },
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@renderer/lib/oauth-popup', () => ({
  prepareOAuthPopup: () => ({ navigate: mockNavigate, close: mockClose }),
}))

vi.mock('@renderer/lib/reauth-dismiss', () => ({
  dismissReauthRequest: (...args: unknown[]) => mockDismiss(...args),
}))

function renderItem(overrides: Partial<React.ComponentProps<typeof McpReauthRequestItem>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props: React.ComponentProps<typeof McpReauthRequestItem> = {
    proxyRequestId: 'proxy-1',
    mcpId: 'mcp-1',
    mcpName: 'Cal.com',
    authType: 'oauth',
    agentSlug: 'agent-1',
    onComplete: vi.fn(),
    ...overrides,
  }
  render(
    <QueryClientProvider client={queryClient}>
      <McpReauthRequestItem {...props} />
    </QueryClientProvider>,
  )
  return props
}

describe('McpReauthRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDismiss.mockResolvedValue(undefined)
    oauthComplete = null
    mockCanManage = true
  })

  it('starts OAuth for the existing MCP and completes after the callback', async () => {
    mockInitiateOAuth.mockResolvedValue({ redirectUrl: 'https://auth.example.com', state: 'state-1' })
    const props = renderItem()

    expect(screen.getByText('This request needs Cal.com, which requires re-authentication.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mcp-reauth-reconnect-btn'))

    await waitFor(() => expect(mockInitiateOAuth).toHaveBeenCalledWith({
      mcpId: 'mcp-1',
      electron: false,
    }))
    expect(mockNavigate).toHaveBeenCalledWith('https://auth.example.com')

    act(() => oauthComplete?.({ success: true }))
    expect(props.onComplete).toHaveBeenCalledOnce()
  })

  it('updates a bearer token, verifies the server, and resumes', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
    const props = renderItem({ authType: 'bearer' })

    fireEvent.change(screen.getByTestId('mcp-reauth-token-input'), {
      target: { value: 'new-token' },
    })
    fireEvent.click(screen.getByTestId('mcp-reauth-reconnect-btn'))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))
    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/remote-mcps/mcp-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'new-token' }),
    }))
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/remote-mcps/mcp-1/discover-tools', {
      method: 'POST',
    })
    expect(props.onComplete).toHaveBeenCalledOnce()
  })

  it('shows a waiting-only card in read-only mode', () => {
    renderItem({ readOnly: true })

    expect(screen.queryByTestId('mcp-reauth-reconnect-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-reauth-dismiss-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-reauth-replace-btn')).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for reconnection')).toBeInTheDocument()
  })

  it('lets a non-owner open the replacement picker and cancel back to the recovery card', async () => {
    mockCanManage = false
    renderItem()

    expect(screen.queryByTestId('mcp-reauth-reconnect-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-reauth-dismiss-btn')).toBeInTheDocument()
    expect(screen.getByText(/Replace it with a connection you own/)).toBeInTheDocument()
    mockApiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://my-mcp.example/mcp' })))
    fireEvent.click(screen.getByTestId('mcp-reauth-replace-btn'))
    expect(await screen.findByTestId('mcp-replacement-picker')).toHaveAttribute('data-url', 'https://my-mcp.example/mcp')
    expect(screen.getByTestId('mcp-replacement-picker')).toHaveAttribute('data-request-id', 'proxy-1')
    fireEvent.click(screen.getByText('Cancel replacement'))
    expect(screen.getByTestId('mcp-reauth-dismiss-btn')).toBeInTheDocument()
    expect(mockInitiateOAuth).not.toHaveBeenCalled()
  })

  it('dismisses the parked request and closes the card', async () => {
    mockCanManage = false
    const props = renderItem()

    fireEvent.click(screen.getByTestId('mcp-reauth-dismiss-btn'))

    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({
      agentSlug: 'agent-1',
      requestId: 'proxy-1',
      reason: undefined,
    }))
    await waitFor(() => expect(props.onComplete).toHaveBeenCalledOnce())
  })

  it('keeps the card open when the dismissal fails', async () => {
    mockCanManage = false
    mockDismiss.mockRejectedValue(new Error('Request not found'))
    const props = renderItem()

    fireEvent.click(screen.getByTestId('mcp-reauth-dismiss-btn'))

    expect(await screen.findByText(/Request not found/)).toBeInTheDocument()
    expect(props.onComplete).not.toHaveBeenCalled()
  })
})
