// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionsList } from './connections-list'
import { renderWithProviders } from '@renderer/test/test-utils'

const mockMutateAsync = vi.fn()
const mockRemoveSharedAccount = vi.fn()
const mockRemoveSharedMcp = vi.fn()

// Owner by default (the local-mode answer too); flipped per-test below.
let canAdminAgent = true

vi.mock('@renderer/context/user-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/context/user-context')>()
  return {
    ...actual,
    useUser: () => ({ ...actual.useUser(), canAdminAgent: () => canAdminAgent }),
  }
})

vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useConnectedAccounts: () => ({ data: { accounts: [] }, isLoading: false }),
  useAgentConnectedAccounts: () => ({
    data: {
      accounts: [{ kind: 'connected-account', toolkitSlug: 'slack', mappingId: 'map-a1' }],
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
  useRemoveAgentAccountMapping: () => ({
    mutateAsync: mockRemoveSharedAccount,
    isPending: false,
    variables: undefined,
  }),
}))

vi.mock('@renderer/hooks/use-remote-mcps', () => ({
  useRemoteMcps: () => ({ data: { servers: [] }, isLoading: false }),
  useAgentRemoteMcps: () => ({
    data: { mcps: [{ kind: 'remote-mcp', mappingId: 'map-m1' }] },
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
  useRemoveAgentMcpMapping: () => ({
    mutateAsync: mockRemoveSharedMcp,
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

function renderList(detailRowKey: string | null = null, onDetailRowKeyChange = vi.fn()) {
  return renderWithProviders(
    <ConnectionsList
      agentSlug="test-agent"
      detailRowKey={detailRowKey}
      detailView="details"
      onDetailViewChange={vi.fn()}
      onDetailRowKeyChange={onDetailRowKeyChange}
    />,
  )
}

describe('ConnectionsList shared capabilities', () => {
  beforeEach(() => {
    canAdminAgent = true
    mockRemoveSharedAccount.mockReset().mockResolvedValue(undefined)
    mockRemoveSharedMcp.mockReset().mockResolvedValue(undefined)
  })

  it('does not expose detail navigation or access controls for foreign links', () => {
    renderList()

    expect(screen.getByText('Slack')).toBeInTheDocument()
    expect(screen.getByText('Shared MCP connection')).toBeInTheDocument()
    expect(screen.getAllByText('Connected by another member')).toHaveLength(2)
    expect(screen.getAllByText('Shared')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /connection details/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('rejects a synthetic foreign detail key', async () => {
    const onDetailRowKeyChange = vi.fn()

    renderList('foreign-account-map-a1', onDetailRowKeyChange)

    await waitFor(() => {
      expect(onDetailRowKeyChange).toHaveBeenCalledWith(null)
    })
    expect(screen.getByText('Slack')).toBeInTheDocument()
    expect(screen.queryByText('Connection details')).not.toBeInTheDocument()
  })

  it('lets an agent owner unlink a shared account by its link id', async () => {
    const user = userEvent.setup()
    renderList()

    await user.click(screen.getByTestId('connection-shared-remove-map-a1'))
    // The confirm stands between the click and the mutation on purpose: only
    // the connection's owner can share it back.
    expect(mockRemoveSharedAccount).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('connection-shared-remove-confirm'))

    await waitFor(() => {
      expect(mockRemoveSharedAccount).toHaveBeenCalledWith({
        agentSlug: 'test-agent',
        mappingId: 'map-a1',
      })
    })
    expect(mockRemoveSharedMcp).not.toHaveBeenCalled()
  })

  it('routes a shared MCP row to the MCP unlink hook', async () => {
    const user = userEvent.setup()
    renderList()

    await user.click(screen.getByTestId('connection-shared-remove-map-m1'))
    await user.click(screen.getByTestId('connection-shared-remove-confirm'))

    await waitFor(() => {
      expect(mockRemoveSharedMcp).toHaveBeenCalledWith({
        agentSlug: 'test-agent',
        mappingId: 'map-m1',
      })
    })
    expect(mockRemoveSharedAccount).not.toHaveBeenCalled()
  })

  it('hides the unlink control from a member who does not own the agent', () => {
    canAdminAgent = false
    renderList()

    expect(screen.getAllByText('Shared')).toHaveLength(2)
    expect(screen.queryByTestId('connection-shared-remove-map-a1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-shared-remove-map-m1')).not.toBeInTheDocument()
  })
})
