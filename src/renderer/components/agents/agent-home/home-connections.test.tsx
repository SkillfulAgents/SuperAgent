// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeConnections } from './home-connections'
import { renderWithProviders } from '@renderer/test/test-utils'

// Mock apiFetch so the real `useAgentConnectedAccounts` hook runs end-to-end
// against a fake network.
const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

// Capture navigate so we can assert the deep link into the connections page
// (the rows navigate directly).
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
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

describe('HomeConnections — row navigation', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
    mockNavigate.mockReset()

    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (path === '/api/agents/test-agent/connected-accounts' && method === 'GET') {
        return Promise.resolve(jsonResponse({ accounts: [ACCOUNT] }))
      }
      if (path === '/api/agents/test-agent/remote-mcps' && method === 'GET') {
        return Promise.resolve(jsonResponse({ mcps: [] }))
      }
      if (path.startsWith('/api/activity/agents/test-agent?days=14&tz=') && method === 'GET') {
        return Promise.resolve(jsonResponse({
          days: 2,
          generatedAt: '2026-07-09T12:00:00.000Z',
          cronByTaskId: {},
          webhookByTriggerId: {},
          connectionById: {
            'account-acc-1': [
              { date: '2026-07-08', succeeded: 2, failed: 1 },
              { date: '2026-07-09', succeeded: 1, failed: 0 },
            ],
          },
        }))
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    })
  })

  it('deep-links to the connection detail view when a row is activated', async () => {
    const user = userEvent.setup()
    renderWithProviders(<HomeConnections agentSlug="test-agent" />)

    // Wait for initial load — the account row appears (name = provider display name).
    expect(await screen.findByText('GitHub')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open GitHub connection details' }))

    // The row key matches the UnifiedRow key format used by the connections
    // page; source 'home' makes Back (and the header breadcrumb) skip the list.
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/agents/$slug/connections',
      params: { slug: 'test-agent' },
      search: { detail: 'account-acc-1', source: 'home' },
    })
  })

  it('opens the connections page (no deep link) from the Manage Connections button', async () => {
    const user = userEvent.setup()
    renderWithProviders(<HomeConnections agentSlug="test-agent" />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()

    await user.click(screen.getByTestId('home-connections-open-page'))

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents/$slug/connections', params: { slug: 'test-agent' } })
  })

  it('shows only this agent\'s activity for the matching connection', async () => {
    renderWithProviders(<HomeConnections agentSlug="test-agent" />)

    expect(await screen.findByRole('img', {
      name: 'GitHub activity: 4 calls over 2 days, 3 succeeded and 1 failed.',
    })).toBeInTheDocument()
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/activity/agents/test-agent?days=14&tz=${new Date().getTimezoneOffset()}`,
    )
  })
})
