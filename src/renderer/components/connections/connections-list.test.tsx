// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { ConnectionsList } from './connections-list'
import { renderWithProviders } from '@renderer/test/test-utils'

const mockMutateAsync = vi.fn()

vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useConnectedAccounts: () => ({ data: { accounts: [] }, isLoading: false }),
  useAgentConnectedAccounts: () => ({
    data: {
      accounts: [{ kind: 'connected-account', toolkitSlug: 'slack' }],
    },
    isLoading: false,
  }),
  useAssignAccountsToAgent: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    variables: undefined,
  }),
  useRemoveAgentConnectedAccount: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    variables: undefined,
  }),
}))

vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useRemoteMcps: () => ({ data: { servers: [] }, isLoading: false }),
  useAgentRemoteMcps: () => ({
    data: { mcps: [{ kind: 'remote-mcp' }] },
    isLoading: false,
  }),
  useAssignMcpToAgent: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    variables: undefined,
  }),
  useRemoveMcpFromAgent: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    variables: undefined,
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

describe('ConnectionsList shared capabilities', () => {
  it('does not expose detail navigation or access controls for foreign links', () => {
    renderWithProviders(
      <ConnectionsList
        agentSlug="test-agent"
        detailRowKey={null}
        onDetailRowKeyChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Slack')).toBeInTheDocument()
    expect(screen.getByText('Shared MCP connection')).toBeInTheDocument()
    expect(screen.getAllByText('Connected by another member')).toHaveLength(2)
    expect(screen.getAllByText('Shared')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /connection details/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('rejects a synthetic foreign detail key', async () => {
    const onDetailRowKeyChange = vi.fn()

    renderWithProviders(
      <ConnectionsList
        agentSlug="test-agent"
        detailRowKey="foreign-account-slack-0"
        onDetailRowKeyChange={onDetailRowKeyChange}
      />,
    )

    await waitFor(() => {
      expect(onDetailRowKeyChange).toHaveBeenCalledWith(null)
    })
    expect(screen.getByText('Slack')).toBeInTheDocument()
    expect(screen.queryByText('Connection details')).not.toBeInTheDocument()
  })
})
