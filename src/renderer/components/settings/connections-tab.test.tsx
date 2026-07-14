// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { ConnectionsTab } from './connections-tab'

const mockUseConnectionActivityStats = vi.fn()
vi.mock('@renderer/hooks/use-activity-stats', () => ({
  useConnectionActivityStats: (...args: unknown[]) => mockUseConnectionActivityStats(...args),
}))

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { defaultApiPolicy: 'review', defaultMcpPolicy: 'review' } }),
  useUpdateUserSettings: () => ({ mutate: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useConnectedAccounts: () => ({
    data: { accounts: [{
      id: 'account-a',
      providerConnectionId: 'provider-a',
      providerName: 'composio',
      toolkitSlug: 'github',
      displayName: 'Work GitHub',
      status: 'active',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }] },
    isLoading: false,
  }),
  useTriggerCountsPerAccount: () => ({ data: {} }),
}))

vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useRemoteMcps: () => ({
    data: { servers: [{
      id: 'mcp-a',
      name: 'Docs MCP',
      url: 'https://mcp.example.com',
      authType: 'none',
      status: 'active',
      errorMessage: null,
      tools: [],
      toolsDiscoveredAt: null,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    }] },
    isLoading: false,
  }),
}))

vi.mock('@renderer/hooks/use-oauth-reconnect', () => ({
  useOAuthReconnect: () => ({
    reconnect: vi.fn(),
    pendingAccountId: null,
    canCancelPendingReconnect: false,
    cancelReconnect: vi.fn(),
  }),
}))

vi.mock('@renderer/components/connections/connection-agent-count', () => ({
  ConnectionAgentCount: () => null,
}))

vi.mock('@renderer/components/connections/connections-list', () => ({
  NewIntegrationButton: () => null,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}))

describe('global Connections activity charts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseConnectionActivityStats.mockReturnValue({
      data: {
        days: 2,
        connectionById: {
          'account-account-a': [
            { date: '2026-07-08', succeeded: 2, failed: 0 },
            { date: '2026-07-09', succeeded: 1, failed: 1 },
          ],
          'mcp-mcp-a': [
            { date: '2026-07-08', succeeded: 0, failed: 0 },
            { date: '2026-07-09', succeeded: 4, failed: 0 },
          ],
        },
      },
    })
  })

  it('shows app-wide API and MCP usage beside the matching rows', () => {
    renderWithProviders(<ConnectionsTab />)

    expect(mockUseConnectionActivityStats).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('img', {
      name: 'Work GitHub activity: 4 calls over 2 days, 3 succeeded and 1 failed.',
    })).toBeInTheDocument()
    expect(screen.getByRole('img', {
      name: 'Docs MCP activity: 4 calls over 2 days, 4 succeeded and 0 failed.',
    })).toBeInTheDocument()
  })

  it('reserves chart space while activity is loading so rows do not shift', () => {
    mockUseConnectionActivityStats.mockReturnValue({ data: undefined, isPending: true })
    renderWithProviders(<ConnectionsTab />)

    expect(screen.getAllByTestId('activity-chart-skeleton')).toHaveLength(2)
    expect(screen.queryByRole('img', { name: /activity/i })).not.toBeInTheDocument()
  })

  it('does not let activity failure remove connection management rows', () => {
    mockUseConnectionActivityStats.mockReturnValue({ data: undefined, isError: true })
    renderWithProviders(<ConnectionsTab />)

    expect(screen.getByText('Work GitHub')).toBeInTheDocument()
    expect(screen.getByText('Docs MCP')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('activity-chart-skeleton')).not.toBeInTheDocument()
  })
})
