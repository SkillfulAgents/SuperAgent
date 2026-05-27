// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeConnections } from './home-connections'
import { renderWithProviders } from '@renderer/test/test-utils'

// Mock apiFetch so the real `useAgentConnectedAccounts` hook and
// `useDeleteConnectedAccount` mutation run end-to-end against a fake network.
// This is the level of integration that exercises the cache-key wiring —
// mocking the hooks would skip exactly the code we want to test.
const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

// HomeConnections calls setView({ kind: 'connections' }) for the
// "Manage Connections" button — not part of the delete flow we care about.
vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => ({
    setView: vi.fn(),
    setAgent: vi.fn(),
    consumePendingDraft: vi.fn(() => null),
  }),
}))

const ACCOUNT = {
  id: 'acc-1',
  providerConnectionId: 'conn-1',
            providerName: 'composio',
  toolkitSlug: 'github',
  displayName: 'My GitHub Account',
  status: 'active' as const,
  createdAt: new Date('2025-01-01').toISOString(),
  updatedAt: new Date('2025-01-01').toISOString(),
  mappingId: 'map-1',
  mappedAt: new Date('2025-01-01').toISOString(),
  provider: { slug: 'github', displayName: 'GitHub' },
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response
}

describe('HomeConnections — delete account flow', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
  })

  it('removes the deleted account from the agent-home list after global delete', async () => {
    // Backend state: starts with one account, becomes empty after DELETE.
    let accounts = [ACCOUNT]

    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'

      if (path === '/api/agents/test-agent/connected-accounts' && method === 'GET') {
        return Promise.resolve(jsonResponse({ accounts }))
      }
      if (path === '/api/agents/test-agent/remote-mcps' && method === 'GET') {
        return Promise.resolve(jsonResponse({ mcps: [] }))
      }
      if (path === '/api/connected-accounts/acc-1' && method === 'DELETE') {
        accounts = []
        return Promise.resolve(jsonResponse({}, true))
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    })

    const user = userEvent.setup()
    renderWithProviders(<HomeConnections agentSlug="test-agent" />)

    // Wait for initial load — the account row appears.
    expect(await screen.findByText('My GitHub Account')).toBeInTheDocument()

    // Open the row's actions menu, then trigger the global delete.
    await user.click(screen.getByTestId('integration-row-actions-oauth-acc-1'))
    await user.click(await screen.findByRole('button', { name: /delete/i }))

    // Confirm in the AlertDialog (button labeled "Delete for all agents").
    // Use `getAllByRole` because the menu item still exists in the DOM behind the dialog.
    const confirmButtons = await screen.findAllByRole('button', { name: /delete for all agents/i })
    // The last one is the AlertDialogAction (rendered in a portal on top).
    await user.click(confirmButtons[confirmButtons.length - 1])

    // The account row should disappear once the agent-scoped query is
    // invalidated and refetches the now-empty list. Without invalidation
    // of `['agent-connected-accounts']`, the cache stays stale and this fails.
    await waitFor(() => {
      expect(screen.queryByText('My GitHub Account')).not.toBeInTheDocument()
    })
    expect(screen.getByText('No connections yet')).toBeInTheDocument()

    // Sanity-check the network: the agent-scoped endpoint was hit at least
    // twice (initial load + post-delete refetch).
    const agentAccountCalls = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/agents/test-agent/connected-accounts' && (init?.method ?? 'GET') === 'GET'
    )
    expect(agentAccountCalls.length).toBeGreaterThanOrEqual(2)
  })
})
