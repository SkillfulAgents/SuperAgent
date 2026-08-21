// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationRowActions } from './integration-row-actions'
import { useAgentConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { renderWithProviders } from '@renderer/test/test-utils'
import { isPublicAgentConnectedAccount } from '@shared/lib/agent-connections/public'

// Mock apiFetch so the real mutation hooks run end-to-end against a fake
// network. This is the level of integration that exercises the cache-key
// wiring — mocking the hooks would skip exactly the code we want to test.
const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
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

/**
 * Renders the agent-scoped account list alongside the actions. The regression
 * this guards: a global delete must invalidate the agent-scoped query
 * (`['agent-connected-accounts']`) so agent views drop the deleted account.
 */
function AgentAccountsProbe() {
  const { data } = useAgentConnectedAccounts('test-agent')
  const accounts = Array.isArray(data?.accounts) ? data.accounts : []
  return (
    <div data-testid="agent-accounts">
      {accounts.filter(isPublicAgentConnectedAccount).map((a) => a.displayName).join(',')}
    </div>
  )
}

describe('IntegrationRowActions — delete account flow', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
  })

  it('invalidates agent-scoped account queries after a global delete', async () => {
    // Backend state: starts with one account, becomes empty after DELETE.
    let accounts = [ACCOUNT]

    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'

      if (path === '/api/agents/test-agent/connected-accounts' && method === 'GET') {
        return Promise.resolve(jsonResponse({ accounts }))
      }
      if (path === '/api/connected-accounts/acc-1' && method === 'DELETE') {
        accounts = []
        return Promise.resolve(jsonResponse({}, true))
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    })

    const user = userEvent.setup()
    renderWithProviders(
      <>
        <IntegrationRowActions type="oauth" id="acc-1" name="My GitHub Account" toolkit="github" />
        <AgentAccountsProbe />
      </>,
    )

    // Initial load — the probe shows the account.
    await waitFor(() => {
      expect(screen.getByTestId('agent-accounts')).toHaveTextContent('My GitHub Account')
    })

    // Trigger the delete and confirm in the AlertDialog.
    await user.click(screen.getByTestId('integration-row-actions-delete-oauth-acc-1'))
    const confirmButtons = await screen.findAllByRole('button', { name: /^delete$/i })
    await user.click(confirmButtons[confirmButtons.length - 1])

    // The probe should empty out once `['agent-connected-accounts']` is
    // invalidated and refetches the now-empty list. Without invalidation the
    // cache stays stale and this fails.
    await waitFor(() => {
      expect(screen.getByTestId('agent-accounts')).toHaveTextContent('')
    })

    // Sanity-check the network: the agent-scoped endpoint was hit at least
    // twice (initial load + post-delete refetch).
    const agentAccountCalls = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/agents/test-agent/connected-accounts' && (init?.method ?? 'GET') === 'GET'
    )
    expect(agentAccountCalls.length).toBeGreaterThanOrEqual(2)
  })
})
